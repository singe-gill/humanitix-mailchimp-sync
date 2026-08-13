import fetch from "node-fetch";

const BASE_URL = "https://api.humanitix.com/v1";

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
 * NOTE: field names below (page/pageSize/total, orders array shape) are based
 * on Humanitix's documented conventions but haven't been verified against a
 * live account. Run `npm run discover` first — if pagination or the response
 * shape looks different, adjust this function accordingly.
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
 * exhausted. Unconfirmed against a live account yet - if this 404s or
 * returns nothing, extractAttendees() falls back to treating each order's
 * buyer as a single attendee instead.
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

/**
 * Extract a flat list of "attendees" for one order, combining that order's
 * own once-per-order answers with each linked ticket's per-attendee
 * answers. Tickets live at a separate endpoint from orders (see
 * getAllTickets) - pass in just the tickets belonging to this order
 * (typically via ticket.orderId === order._id).
 *
 * questionLabelMap (from buildQuestionLabelMap) resolves questionId-only
 * answers to their actual question text.
 *
 * Each attendee's email is resolved in this order: an explicit ticket.email
 * field if present, then a ticket-level answer whose question text mentions
 * "email" (common when the checkout form collects each attendee's own email
 * as a custom question rather than a dedicated field), then finally the
 * order buyer's email as a last resort.
 */
export function extractAttendees(order, ticketsForOrder = [], questionLabelMap = {}) {
  const attendees = [];
  const tickets = ticketsForOrder.length > 0 ? ticketsForOrder : (order.tickets || order.attendees || []);

  const orderLevelQA = [
    ...extractQA(order.additionalFields, questionLabelMap),
    ...extractQA(order.customFieldAnswers, questionLabelMap),
    ...extractQA(order.answers, questionLabelMap),
  ];

  function findEmailInQA(qa) {
    const hit = qa.find((x) => /e-?mail/i.test(x.question));
    return hit && hit.answer ? String(hit.answer) : null;
  }

  if (tickets.length > 0) {
    for (const ticket of tickets) {
      const ticketQA = [
        ...extractQA(ticket.additionalFields, questionLabelMap),
        ...extractQA(ticket.customFieldAnswers, questionLabelMap),
        ...extractQA(ticket.answers, questionLabelMap),
        ...extractQA(ticket.fields, questionLabelMap),
      ];

      const email =
        ticket.email ||
        ticket.attendeeEmail ||
        findEmailInQA(ticketQA) ||
        order.email ||
        order.buyerEmail;
      if (!email) continue;

      attendees.push({
        email: String(email).toLowerCase().trim(),
        firstName: ticket.firstName || ticket.attendeeFirstName || "",
        lastName: ticket.lastName || ticket.attendeeLastName || "",
        orderId: order._id || order.id,
        ticketId: ticket._id || ticket.id,
        createdAt: order.createdAt || order.orderDate,
        answers: [...orderLevelQA, ...ticketQA],
      });
    }
  } else if (order.email) {
    // No linked tickets found for this order - fall back to syncing the
    // buyer using just the order-level answers.
    attendees.push({
      email: String(order.email).toLowerCase().trim(),
      firstName: order.firstName || "",
      lastName: order.lastName || "",
      orderId: order._id || order.id,
      createdAt: order.createdAt || order.orderDate,
      answers: orderLevelQA,
    });
  }

  return attendees;
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
