// Run via the "Refresh options" button in the control panel (or manually:
// node src/discover-options.js). Scans recent orders for real checkout
// question text, and asks Mailchimp what merge fields and tags already
// exist, then writes docs/options.json so the control panel can offer
// dropdowns instead of free-typed field names.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getAllOrders, getAllTickets, getEvent, buildQuestionLabelMap, extractAttendees } from "./humanitix.js";
import { listMergeFields, listTags } from "./mailchimp.js";

const {
  HUMANITIX_API_KEY,
  HUMANITIX_EVENT_IDS,
  MAILCHIMP_API_KEY,
  MAILCHIMP_SERVER_PREFIX,
  MAILCHIMP_LIST_ID,
} = process.env;

function redactPII(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/"[^"]*@[^"]*"/g, '"[redacted-email]"')
    .replace(/"\+?[0-9][0-9\-\s().]{6,}"/g, '"[redacted-phone]"');
}

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
  let loggedSample = false;

  for (const eventId of eventIds) {
    console.log(`Scanning orders for event ${eventId}...`);
    const event = await getEvent(HUMANITIX_API_KEY, eventId).catch(() => null);
    const questionLabelMap = event ? buildQuestionLabelMap(event) : {};
    console.log(`  Resolved ${Object.keys(questionLabelMap).length} question label(s) from event data.`);

    const orders = await getAllOrders(HUMANITIX_API_KEY, eventId);
    console.log(`  ${orders.length} order(s) found.`);
    // Recent orders are enough to discover the question set - no need to
    // read every historical order for this. Cap it for speed.
    const sample = orders.slice(-200);
    for (const order of sample) {
      for (const attendee of extractAttendees(order, questionLabelMap)) {
        for (const qa of attendee.answers) {
          questionSet.add(qa.question);
        }
      }
    }

    // Diagnostic: try the tickets endpoint too (unconfirmed against a live
    // account) so we can see whether individual ticket-holder answers (e.g.
    // per-attendee dietary requirements) live there separately from orders.
    try {
      const tickets = await getAllTickets(HUMANITIX_API_KEY, eventId, { pageSize: 5 });
      if (tickets.length > 0) {
        console.log("\n--- DIAGNOSTIC: tickets endpoint sample (emails/phones redacted) ---");
        const dump = redactPII(tickets[0]);
        console.log(dump.length > 4000 ? dump.slice(0, 4000) + "\n...[truncated]" : dump);
        console.log("--- END DIAGNOSTIC ---\n");
      } else {
        console.log("  Tickets endpoint returned no results for this event.");
      }
    } catch (err) {
      console.log(`  Tickets endpoint not available: ${err.message}`);
    }

    // Diagnostic: if we found orders but still no questions after label
    // resolution, dump the raw shape of one order (PII redacted) plus the
    // event object so we can see where the checkout answers actually live.
    if (!loggedSample && orders.length > 0 && questionSet.size === 0) {
      loggedSample = true;
      console.log("\n--- DIAGNOSTIC: still no checkout questions found. Raw order (emails/phones redacted) ---");
      const dump = redactPII(orders[orders.length - 1]);
      console.log(dump.length > 6000 ? dump.slice(0, 6000) + "\n...[truncated]" : dump);
      console.log("--- Raw event object ---");
      console.log(JSON.stringify(event, null, 2).slice(0, 4000));
      console.log("--- END DIAGNOSTIC ---\n");
    }
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
