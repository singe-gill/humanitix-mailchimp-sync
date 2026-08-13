// Run via the "Refresh events & audiences" button in the control panel
// (or manually: node src/discover-accounts.js). Lists every Humanitix event
// and Mailchimp audience on the account so the control panel can offer
// pickers by name instead of you needing to go find IDs.
//
// Unlike discover-options.js, this only needs your API keys - it doesn't
// need HUMANITIX_EVENT_IDS or MAILCHIMP_LIST_ID set yet, so it works before
// you've picked what to sync.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getAllEvents } from "./humanitix.js";
import { listAudiences } from "./mailchimp.js";

const { HUMANITIX_API_KEY, MAILCHIMP_API_KEY, MAILCHIMP_SERVER_PREFIX } = process.env;

async function main() {
  if (!HUMANITIX_API_KEY) {
    console.error("Missing HUMANITIX_API_KEY.");
    process.exit(1);
  }
  if (!MAILCHIMP_API_KEY || !MAILCHIMP_SERVER_PREFIX) {
    console.error("Missing MAILCHIMP_API_KEY / MAILCHIMP_SERVER_PREFIX.");
    process.exit(1);
  }

  console.log("Fetching Humanitix events...");
  const events = await getAllEvents(HUMANITIX_API_KEY);

  console.log("Fetching Mailchimp audiences...");
  const audiences = await listAudiences({
    apiKey: MAILCHIMP_API_KEY,
    serverPrefix: MAILCHIMP_SERVER_PREFIX,
  });

  const output = {
    updatedAt: new Date().toISOString(),
    events, // [{ id, name }]
    audiences, // [{ id, name, memberCount }]
  };

  const outPath = path.resolve("docs/accounts.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(
    `\nWrote ${outPath}: ${events.length} event(s), ${audiences.length} audience(s).`
  );
}

main().catch((err) => {
  console.error("Discovery failed:", err);
  process.exit(1);
});
