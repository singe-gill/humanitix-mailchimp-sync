// Run via the "Refresh options" button in the control panel (or manually:
// node src/discover-options.js). Scans recent orders + tickets for real
// checkout question text, and asks Mailchimp what merge fields and tags
// already exist, then writes docs/options.json so the control panel can
// offer dropdowns instead of free-typed field names.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  getAllOrders,
  getAllTickets,
  getEvent,
  buildQuestionLabelMap,
  groupTicketsByOrderId,
  extractAttendees,
  DEFAULT_EXCLUDED_STATUSES,
} from "./humanitix.js";
import { listMergeFields, listTags } from "./mailchimp.js";

const CONFIG_PATH = path.resolve("config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

const {
  HUMANITIX_API_KEY,
  HUMANITIX_EVENT_IDS,
  MAILCHIMP_API_KEY,
  MAILCHIMP_SERVER_PREFIX,
  MAILCHIMP_LIST_ID,
} = process.env;

async function main() {
  if (!HUMANITIX_API_KEY || !HUMANITIX_EVENT_IDS) {
    console.error("Missing HUMANITIX_API_KEY / HUMANITIX_EVENT_IDS.");
    process.exit(1);
  }
  if (!MAILCHIMP_API_KEY || !MAILCHIMP_SERVER_PREFIX || !MAILCHIMP_LIST_ID) {
    console.error("Missing Mailchimp env vars.");
    process.exit(1);
  }

  const eventIds = HUMANITIX_EVENT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const questionSet = new Set();
  const ticketTypeSet = new Set();
  const statusSet = new Set();
  const config = loadConfig();
  let totalSkipped = 0;

  for (const eventId of eventIds) {
    console.log(`Scanning event ${eventId}...`);
    const event = await getEvent(HUMANITIX_API_KEY, eventId).catch(() => null);
    const questionLabelMap = event ? buildQuestionLabelMap(event) : {};
    console.log(`  Resolved ${Object.keys(questionLabelMap).length} question label(s) from event data.`);

    const orders = await getAllOrders(HUMANITIX_API_KEY, eventId);
    const tickets = await getAllTickets(HUMANITIX_API_KEY, eventId);
    console.log(`  ${orders.length} order(s), ${tickets.length} ticket(s).`);
    const ticketsByOrderId = groupTicketsByOrderId(tickets);

    for (const ticket of tickets) {
      const typeName = ticket.ticketTypeName || ticket.ticketType;
      if (typeName) ticketTypeSet.add(typeName);
      if (ticket.status) statusSet.add(ticket.status);
      if (ticket.financialStatus) statusSet.add(ticket.financialStatus);
    }
    for (const order of orders) {
      if (order.status) statusSet.add(order.status);
      if (order.financialStatus) statusSet.add(order.financialStatus);
    }

    // Recent orders are enough to discover the question set - no need to
    // read every historical order for this. Cap it for speed.
    const sample = orders.slice(-200);
    let attendeesSeen = 0;
    for (const order of sample) {
      const ticketsForOrder = ticketsByOrderId.get(order._id || order.id) || [];
      const { attendees, skipped } = extractAttendees(
        order,
        ticketsForOrder,
        questionLabelMap,
        config.emailRouting || [],
        config.excludeStatuses || DEFAULT_EXCLUDED_STATUSES
      );
      attendeesSeen += attendees.length;
      totalSkipped += skipped;
      for (const attendee of attendees) {
        for (const qa of attendee.answers) {
          questionSet.add(qa.question);
        }
      }
    }
    console.log(`  ${attendeesSeen} attendee(s) scanned (after email routing), ${questionSet.size} unique question(s) found so far.`);
  }

  console.log(`\nSkipped ${totalSkipped} cancelled/refunded ticket(s) total (using excludeStatuses: ${JSON.stringify(config.excludeStatuses || DEFAULT_EXCLUDED_STATUSES)}).`);
  console.log(`Distinct status values seen across your account: ${JSON.stringify(Array.from(statusSet).sort())}`);
  console.log("If a cancelled/refunded ticket used a status not in excludeStatuses above, add it via config.json's \"excludeStatuses\".");

  console.log("Fetching Mailchimp merge fields...");
  const mergeFields = await listMergeFields({
    apiKey: MAILCHIMP_API_KEY,
    serverPrefix: MAILCHIMP_SERVER_PREFIX,
    listId: MAILCHIMP_LIST_ID,
  });

  console.log("Fetching Mailchimp tags...");
  const tags = await listTags({
    apiKey: MAILCHIMP_API_KEY,
    serverPrefix: MAILCHIMP_SERVER_PREFIX,
    listId: MAILCHIMP_LIST_ID,
  });

  const output = {
    updatedAt: new Date().toISOString(),
    checkoutQuestions: Array.from(questionSet).sort(),
    ticketTypes: Array.from(ticketTypeSet).sort(),
    ticketStatuses: Array.from(statusSet).sort(),
    mergeFields, // [{ tag, name }]
    tags: tags.sort(),
  };

  const outPath = path.resolve("docs/options.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(
    `\nWrote ${outPath}: ${output.checkoutQuestions.length} question(s), ` +
      `${output.ticketTypes.length} ticket type(s), ${output.mergeFields.length} merge field(s), ${output.tags.length} tag(s).`
  );
}

main().catch((err) => {
  console.error("Discovery failed:", err);
  process.exit(1);
});
