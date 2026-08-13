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
} from "./humanitix.js";
import { listMergeFields, listTags } from "./mailchimp.js";

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

  for (const eventId of eventIds) {
    console.log(`Scanning event ${eventId}...`);
    const event = await getEvent(HUMANITIX_API_KEY, eventId).catch(() => null);
    const questionLabelMap = event ? buildQuestionLabelMap(event) : {};
    console.log(`  Resolved ${Object.keys(questionLabelMap).length} question label(s) from event data.`);

    const orders = await getAllOrders(HUMANITIX_API_KEY, eventId);
    const tickets = await getAllTickets(HUMANITIX_API_KEY, eventId);
    console.log(`  ${orders.length} order(s), ${tickets.length} ticket(s).`);
    const ticketsByOrderId = groupTicketsByOrderId(tickets);

    // Recent orders are enough to discover the question set - no need to
    // read every historical order for this. Cap it for speed.
    const sample = orders.slice(-200);
    let attendeesSeen = 0;
    for (const order of sample) {
      const ticketsForOrder = ticketsByOrderId.get(order._id || order.id) || [];
      const attendees = extractAttendees(order, ticketsForOrder, questionLabelMap);
      attendeesSeen += attendees.length;
      for (const attendee of attendees) {
        for (const qa of attendee.answers) {
          questionSet.add(qa.question);
        }
      }
    }
    console.log(`  ${attendeesSeen} attendee(s) scanned, ${questionSet.size} unique question(s) found so far.`);
  }

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
    mergeFields, // [{ tag, name }]
    tags: tags.sort(),
  };

  const outPath = path.resolve("docs/options.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(
    `\nWrote ${outPath}: ${output.checkoutQuestions.length} question(s), ` +
      `${output.mergeFields.length} merge field(s), ${output.tags.length} tag(s).`
  );
}

main().catch((err) => {
  console.error("Discovery failed:", err);
  process.exit(1);
});
