import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getAllOrders, getAllTickets, getEvent, buildQuestionLabelMap, groupTicketsByOrderId, extractAttendees } from "./humanitix.js";
import { buildUpsertOperations, runBatch, waitForBatch } from "./mailchimp.js";
import { buildMergeFields, buildTags } from "./mapping.js";

const STATE_PATH = path.resolve("state.json");
const CONFIG_PATH = path.resolve("config.json");

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function main() {
  const {
    HUMANITIX_API_KEY,
    HUMANITIX_EVENT_IDS,
    MAILCHIMP_API_KEY,
    MAILCHIMP_SERVER_PREFIX,
    MAILCHIMP_LIST_ID,
    MAILCHIMP_STATUS_IF_NEW,
  } = process.env;

  if (
    !HUMANITIX_API_KEY ||
    !HUMANITIX_EVENT_IDS ||
    !MAILCHIMP_API_KEY ||
    !MAILCHIMP_SERVER_PREFIX ||
    !MAILCHIMP_LIST_ID
  ) {
    console.error("Missing required environment variables. Check .env against .env.example.");
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("config.json not found. Copy config.example.json to config.json and edit it.");
    process.exit(1);
  }

  const config = loadJson(CONFIG_PATH, {});
  const state = loadJson(STATE_PATH, { lastSyncByEvent: {} });
  const eventIds = HUMANITIX_EVENT_IDS.split(",").map((s) => s.trim()).filter(Boolean);

  // Full sync overrides incremental state - pass --full on the command line
  // for a one-off backfill of every attendee, ever.
  const fullSync = process.argv.includes("--full");

  // Dry run: compute everything, write nothing to Mailchimp, don't advance
  // the sync checkpoint (so a real run afterward still picks up everyone).
  const dryRun = process.argv.includes("--dry-run");
  // Print full per-attendee detail (emails, names, checkout answers) to the
  // console/log. Off by default when running in GitHub Actions, since a
  // public repo's Actions logs are publicly visible - pass --show-details
  // to opt in explicitly, or just run this locally where it's always safe.
  const isCI = process.env.GITHUB_ACTIONS === "true";
  const showDetails = process.argv.includes("--show-details") || !isCI;

  let allOperations = [];
  let previewRecords = [];
  let attendeeCount = 0;

  for (const eventId of eventIds) {
    console.log(`\nFetching event ${eventId}...`);
    const event = await getEvent(HUMANITIX_API_KEY, eventId).catch(() => null);
    const eventName = event?.name || event?.eventName || undefined;
    const questionLabelMap = event ? buildQuestionLabelMap(event) : {};

    const lastSync = fullSync ? null : state.lastSyncByEvent[eventId];
    console.log(
      lastSync
        ? `Incremental sync — only orders created after ${lastSync}`
        : "Full sync — fetching all orders for this event"
    );

    const orders = await getAllOrders(HUMANITIX_API_KEY, eventId);
    console.log(`Found ${orders.length} total orders.`);

    const tickets = await getAllTickets(HUMANITIX_API_KEY, eventId);
    console.log(`Found ${tickets.length} total tickets.`);
    const ticketsByOrderId = groupTicketsByOrderId(tickets);

    const cutoff = lastSync ? new Date(lastSync).getTime() : 0;
    let newestSeen = lastSync ? new Date(lastSync).getTime() : 0;

    for (const order of orders) {
      const createdAt = order.createdAt || order.orderDate;
      const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
      if (createdMs && createdMs > newestSeen) newestSeen = createdMs;
      if (cutoff && createdMs && createdMs <= cutoff) continue; // already synced

      const ticketsForOrder = ticketsByOrderId.get(order._id || order.id) || [];
      const attendees = extractAttendees(order, ticketsForOrder, questionLabelMap, config.emailRouting || []);
      for (const attendee of attendees) {
        if (!attendee.email) continue;
        attendeeCount += 1;

        const mergeFields = buildMergeFields(attendee, config.mergeFieldMap || []);
        const tags = buildTags(attendee, config.tagRules || [], eventName);

        if (dryRun) {
          previewRecords.push({
            event: eventName || eventId,
            email: attendee.email,
            firstName: attendee.firstName,
            lastName: attendee.lastName,
            mergeFields,
            tags,
          });
          continue;
        }

        const ops = buildUpsertOperations({
          listId: MAILCHIMP_LIST_ID,
          email: attendee.email,
          mergeFields,
          tags,
          statusIfNew: MAILCHIMP_STATUS_IF_NEW || "subscribed",
        });
        allOperations.push(...ops);
      }
    }

    // Only advance the checkpoint on a real (non-dry-run, non-full) run, and
    // only if we actually saw something newer, so a full backfill run
    // doesn't skip future incremental runs, and a dry run never advances
    // the checkpoint at all.
    if (!fullSync && !dryRun) {
      state.lastSyncByEvent[eventId] = new Date(
        Math.max(newestSeen, cutoff)
      ).toISOString();
    }
  }

  if (dryRun) {
    console.log(`\n=== DRY RUN — nothing was sent to Mailchimp, state.json was not updated ===`);
    console.log(`${attendeeCount} attendee(s) would be synced.\n`);

    const tagCounts = new Map();
    const fieldCounts = new Map();
    for (const rec of previewRecords) {
      for (const tag of rec.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      for (const key of Object.keys(rec.mergeFields)) {
        if (rec.mergeFields[key]) fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
      }
    }

    console.log("Tags that would be applied:");
    if (tagCounts.size === 0) console.log("  (none)");
    for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tag}: ${count} attendee(s)`);
    }

    console.log("\nMerge fields that would be populated:");
    if (fieldCounts.size === 0) console.log("  (none)");
    for (const [field, count] of [...fieldCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${field}: ${count} attendee(s)`);
    }

    if (showDetails) {
      console.log("\nPer-attendee detail:");
      for (const rec of previewRecords) {
        console.log(
          `  ${rec.email} (${rec.firstName} ${rec.lastName}) — ${rec.event}\n` +
            `    merge fields: ${JSON.stringify(rec.mergeFields)}\n` +
            `    tags: ${rec.tags.join(", ") || "(none)"}`
        );
      }
    } else {
      console.log(
        "\nPer-attendee detail (emails, names, checkout answers) is hidden here because " +
          "this ran in GitHub Actions, where logs may be publicly visible. Run " +
          "`node src/sync.js --full --dry-run` locally to see full detail safely, or pass " +
          "--show-details if you're confident this repo/log is private."
      );
    }

    const previewPath = path.resolve("dry-run-preview.json");
    fs.writeFileSync(previewPath, JSON.stringify(previewRecords, null, 2));
    console.log(`\nFull preview written to ${previewPath}` + (isCI ? " (on the runner - not retrievable unless uploaded as an artifact)." : "."));
    console.log("\nNothing was written to Mailchimp. Re-run without --dry-run when you're happy with this.");
    return;
  }

  console.log(`\n${attendeeCount} attendee(s) to sync, ${allOperations.length} Mailchimp operation(s).`);

  if (allOperations.length === 0) {
    console.log("Nothing new to sync.");
    return;
  }

  // Mailchimp batch endpoint accepts up to 500 operations per batch.
  const BATCH_SIZE = 500;
  for (let i = 0; i < allOperations.length; i += BATCH_SIZE) {
    const chunk = allOperations.slice(i, i + BATCH_SIZE);
    console.log(`Submitting batch of ${chunk.length} operation(s)...`);
    const batch = await runBatch({
      apiKey: MAILCHIMP_API_KEY,
      serverPrefix: MAILCHIMP_SERVER_PREFIX,
      operations: chunk,
    });
    console.log(`Batch ${batch.id} submitted, status: ${batch.status}`);

    if (process.argv.includes("--wait")) {
      console.log("Waiting for batch to finish (--wait passed)...");
      const finished = await waitForBatch({
        apiKey: MAILCHIMP_API_KEY,
        serverPrefix: MAILCHIMP_SERVER_PREFIX,
        batchId: batch.id,
      });
      console.log(
        `Batch finished: ${finished.completed_operations}/${finished.total_operations} ops, ${finished.errored_operations} error(s).`
      );
      if (finished.errored_operations > 0) {
        console.log(`See error details at: ${finished.response_body_url}`);
      }
    }
  }

  saveState(state);
  console.log("\nDone. State saved to state.json.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
