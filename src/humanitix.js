import fetch from "node-fetch";

const BASE_URL = "https://api.humanitix.com/v1";

// Default status values (case-insensitive) treated as "not a real attendee,
// don't sync". "cancelled" and "refunded" are confirmed against the live
// account (along with complete/free/paid/partiallyRefunded, which are
// deliberately NOT excluded); "canceled", "void" and "voided" are defensive
// guesses never actually seen. Override via config.json's "excludeStatuses",
// and check docs/options.json's "ticketStatuses" (from Refresh options) to see
// the actual values your account uses.
export const DEFAULT_EXCLUDED_STATUSES = ["cancelled", "canceled", "refunded", "void", "voided"];

function headers(apiKey) {
  return {
    "x-api-key": apiKey,
    Accept: "application/json",
  };
}

async function get(path, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers(apiKey) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Humanitix API ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

/** Fetch a single event's details (mainly used to get its name for tagging). */
export async function getEvent(apiKey, eventId) {
  return get(`/events/${eventId}`, apiKey);
}

/**
 * Build a map of questionId -> human-readable question text by walking the
 * event object. Humanitix's order/ticket "additionalFields" only carry a
 * questionId + value - the actual question text lives somewhere in the
 * event's own question definitions. We don't rely on a specific key name
 * (e.g. "additionalQuestions") since that hasn't been confirmed - instead
 * this recursively scans the whole event object for anything shaped like
 * { _id or id, question or label or title or name } and indexes it.
 */
export function buildQuestionLabelMap(eventObj) {
  const map = {};
  function walk(node) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === "object") {
      const id = node._id || node.id;
      const label = node.question || node.label || node.title || node.name;
      if (id && typeof label === "string") {
        map[id] = label;
      }
      for (const key of Object.keys(node)) walk(node[key]);
    }
  }
  walk(eventObj);
  return map;
}

/** Fetch ALL events on the account (for picking which ones to sync), paginating until exhausted. */
export async function getAllEvents(apiKey, { pageSize = 100 } = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await get(`/events?page=${page}&pageSize=${pageSize}`, apiKey);
    const events = data.events || data.data || [];
    all.push(...events);
    if (events.length < pageSize) break;
    page += 1;
    if (page > 100) break; // safety valve
  }
  return all.map((e) => ({ id: e._id || e.id, name: e.name || e.eventName || "(untitled event)" }));
}

/**
 * Fetch ALL orders for an event, paginating until exhausted.
 * Orders do NOT embed their tickets - fetch those separately with
 * getAllTickets() and link them back via ticket.orderId.
 */
export async function getAllOrders(apiKey, eventId, { pageSize = 100 } = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await get(
      `/events/${eventId}/orders?page=${page}&pageSize=${pageSize}`,
      apiKey
    );
    const orders = data.orders || data.data || [];
    all.push(...orders);
    if (orders.length < pageSize) break;
    page += 1;
    if (page > 500) break; // safety valve
  }
  return all;
}

/**
 * Fetch ALL tickets for an event (individual attendees), paginating until
 * exhausted. Confirmed working against the live account. If an order has no
 * tickets, extractAttendees() falls back to treating the order's buyer as a
 * single attendee.
 */
export async function getAllTickets(apiKey, eventId, { pageSize = 100 } = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await get(
      `/events/${eventId}/tickets?page=${page}&pageSize=${pageSize}`,
      apiKey
    );
    const tickets = data.tickets || data.data || [];
    all.push(...tickets);
    if (tickets.length < pageSize) break;
    page += 1;
    if (page > 500) break; // safety valve
  }
  return all;
}

function extractQA(items, questionLabelMap) {
  const qa = [];
  if (!Array.isArray(items)) return qa;
  for (const item of items) {
    const answer =
      item.answer !== undefined
        ? item.answer
        : item.value !== undefined
        ? item.value
        : item.response;
    if (answer === undefined) continue;

    let question = item.question || item.label || item.name || item.title;
    if (!question && item.questionId) {
      question = questionLabelMap[item.questionId] || `Question ${item.questionId}`;
    }
    if (question) {
      qa.push({ question: String(question), answer });
    }
  }
  return qa;
}

function findQA(qaList, questionText) {
  if (!questionText) return undefined;
  const target = questionText.trim().toLowerCase();
  const hit = qaList.find((x) => x.question.trim().toLowerCase() === target);
  return hit ? hit.answer : undefined;
}

function splitFullName(fullName) {
  const trimmed = String(fullName || "").trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { firstName: trimmed, lastName: "" };
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1).trim() };
}

function makeContact({ email, firstName, lastName, orderId, ticketId, createdAt, answers, ticketTypeName, ticketTypeTag }) {
  return {
    email: String(email).toLowerCase().trim(),
    firstName: firstName || "",
    lastName: lastName || "",
    orderId,
    ticketId,
    createdAt,
    answers,
    ticketTypeName: ticketTypeName || "",
    ticketTypeTag: ticketTypeTag || "",
  };
}

/**
 * Build the contact(s) for one ticket, given emailRouting rules from
 * config.json. A rule matches by ticket.ticketTypeName (case-insensitive,
 * exact match). Rules can produce either one contact ("primary" only) or
 * two ("primary" + "secondary", e.g. attendee + parent/guardian) - the
 * secondary is only included if its resolved email differs from the
 * primary's. Tickets whose type doesn't match any rule fall back to
 * the pre-existing single-contact, auto-detected-email behaviour.
 */
function resolveTicketContacts(ticket, allQA, order, emailRoutingRules) {
  const ticketTypeName = ticket.ticketTypeName || ticket.ticketType || "";
  const rule = (emailRoutingRules || []).find(
    (r) => r.ticketType && r.ticketType.trim().toLowerCase() === ticketTypeName.trim().toLowerCase()
  );

  const shared = {
    orderId: order._id || order.id,
    ticketId: ticket._id || ticket.id,
    createdAt: order.createdAt || order.orderDate,
    answers: allQA,
    ticketTypeName,
    ticketTypeTag: rule?.tag || "",
  };

  if (!rule) {
    // Default behaviour: ticket.email if present, else a ticket-level
    // answer whose question text mentions "email", else the order buyer's.
    const emailHit = allQA.find((x) => /e-?mail/i.test(x.question));
    const email =
      ticket.email || ticket.attendeeEmail || (emailHit && emailHit.answer) || order.email || order.buyerEmail;
    if (!email) return [];
    return [
      makeContact({
        ...shared,
        email,
        firstName: ticket.firstName || ticket.attendeeFirstName || "",
        lastName: ticket.lastName || ticket.attendeeLastName || "",
      }),
    ];
  }

  const contacts = [];

  const primaryEmail = findQA(allQA, rule.primary?.emailQuestion) || ticket.email;
  if (primaryEmail) {
    contacts.push(
      makeContact({
        ...shared,
        email: primaryEmail,
        firstName: findQA(allQA, rule.primary?.firstNameQuestion) || ticket.firstName || "",
        lastName: findQA(allQA, rule.primary?.lastNameQuestion) || ticket.lastName || "",
      })
    );
  }

  if (rule.secondary?.emailQuestion) {
    const secondaryEmail = findQA(allQA, rule.secondary.emailQuestion);
    const isDifferent =
      secondaryEmail &&
      (!primaryEmail || String(secondaryEmail).trim().toLowerCase() !== String(primaryEmail).trim().toLowerCase());
    if (isDifferent) {
      const fullName = findQA(allQA, rule.secondary.fullNameQuestion);
      const { firstName, lastName } = splitFullName(fullName);
      contacts.push(makeContact({ ...shared, email: secondaryEmail, firstName, lastName }));
    }
  }

  return contacts;
}

/**
 * Extract a flat list of "attendees" (Mailchimp contacts to sync) for one
 * order, combining that order's own once-per-order answers with each
 * linked ticket's per-attendee answers. Tickets live at a separate endpoint
 * from orders (see getAllTickets) - pass in just the tickets belonging to
 * this order (typically via ticket.orderId === order._id).
 *
 * questionLabelMap (from buildQuestionLabelMap) resolves questionId-only
 * answers to their actual question text.
 *
 * emailRoutingRules (config.json's "emailRouting", optional) lets you
 * override, per ticket type, which question holds the email/name and
 * whether a second contact (e.g. a parent/guardian) should also be synced
 * when their email differs from the attendee's own. Ticket types not
 * covered by a rule use the default single-contact, auto-detected-email
 * behaviour.
 *
 * excludedStatuses (config.json's "excludeStatuses", optional, defaults to
 * DEFAULT_EXCLUDED_STATUSES) - orders/tickets whose status or financialStatus
 * matches one of these (case-insensitive) are skipped entirely: a matching
 * order skips the whole order, a matching ticket skips just that ticket.
 *
 * Returns { attendees, skipped } where skipped is the count of tickets that
 * were excluded for having a matching status.
 */
export function extractAttendees(order, ticketsForOrder = [], questionLabelMap = {}, emailRoutingRules = [], excludedStatuses = DEFAULT_EXCLUDED_STATUSES) {
  const attendees = [];
  let skipped = 0;
  const excludedSet = new Set((excludedStatuses || []).map((s) => String(s).toLowerCase()));
  function isExcluded(...values) {
    return values.some((v) => v !== undefined && v !== null && excludedSet.has(String(v).toLowerCase()));
  }

  const tickets = ticketsForOrder.length > 0 ? ticketsForOrder : (order.tickets || order.attendees || []);

  if (isExcluded(order.status, order.financialStatus)) {
    return { attendees: [], skipped: Math.max(tickets.length, 1) };
  }

  const orderLevelQA = [
    ...extractQA(order.additionalFields, questionLabelMap),
    ...extractQA(order.customFieldAnswers, questionLabelMap),
    ...extractQA(order.answers, questionLabelMap),
  ];

  if (tickets.length > 0) {
    for (const ticket of tickets) {
      if (isExcluded(ticket.status, ticket.financialStatus)) {
        skipped += 1;
        continue;
      }
      const ticketQA = [
        ...extractQA(ticket.additionalFields, questionLabelMap),
        ...extractQA(ticket.customFieldAnswers, questionLabelMap),
        ...extractQA(ticket.answers, questionLabelMap),
        ...extractQA(ticket.fields, questionLabelMap),
      ];
      const allQA = [...orderLevelQA, ...ticketQA];
      attendees.push(...resolveTicketContacts(ticket, allQA, order, emailRoutingRules));
    }
  } else if (order.email) {
    // No linked tickets found for this order - fall back to syncing the
    // buyer using just the order-level answers.
    attendees.push(
      makeContact({
        email: order.email,
        firstName: order.firstName || "",
        lastName: order.lastName || "",
        orderId: order._id || order.id,
        createdAt: order.createdAt || order.orderDate,
        answers: orderLevelQA,
      })
    );
  }

  return { attendees, skipped };
}

/** Group a flat ticket list by the order they belong to. */
export function groupTicketsByOrderId(tickets) {
  const map = new Map();
  for (const ticket of tickets) {
    const orderId = ticket.orderId || ticket.order_id;
    if (!orderId) continue;
    if (!map.has(orderId)) map.set(orderId, []);
    map.get(orderId).push(ticket);
  }
  return map;
}
