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
 * Extract a flat list of "attendees" from a raw Humanitix order object.
 * Each attendee record carries: email, firstName, lastName, orderId,
 * createdAt, and a list of {question, answer} pairs gathered from every
 * place Humanitix might put checkout-question answers.
 *
 * This function is intentionally defensive/liberal in what it accepts,
 * because the exact shape can vary by account/question type. Run
 * `npm run discover` and compare against a real order to confirm.
 */
export function extractAttendees(order) {
  const attendees = [];
  const tickets = order.tickets || order.attendees || [];

  for (const ticket of tickets) {
    const email =
      ticket.email || ticket.attendeeEmail || order.email || order.buyerEmail;
    if (!email) continue;

    const qa = [];

    // Common shapes Humanitix (and similar ticketing platforms) use for
    // custom checkout question answers:
    const candidateArrays = [
      ticket.additionalFields,
      ticket.customFieldAnswers,
      ticket.answers,
      ticket.fields,
      order.additionalFields,
      order.customFieldAnswers,
      order.answers,
    ].filter(Array.isArray);

    for (const arr of candidateArrays) {
      for (const item of arr) {
        const question =
          item.question || item.label || item.name || item.title;
        const answer =
          item.answer !== undefined
            ? item.answer
            : item.value !== undefined
            ? item.value
            : item.response;
        if (question !== undefined && answer !== undefined) {
          qa.push({ question: String(question), answer });
        }
      }
    }

    attendees.push({
      email: String(email).toLowerCase().trim(),
      firstName: ticket.firstName || ticket.attendeeFirstName || "",
      lastName: ticket.lastName || ticket.attendeeLastName || "",
      orderId: order._id || order.id,
      createdAt: order.createdAt || order.orderDate,
      answers: qa,
    });
  }

  return attendees;
}
