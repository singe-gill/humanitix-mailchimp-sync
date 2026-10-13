// Run this FIRST: node src/discover.js
// It fetches one real order from each configured event and prints it raw,
// so you can confirm the field names src/humanitix.js is looking for
// (checkout question labels, answer shapes, etc.) actually match your account.

import "dotenv/config";
import { getAllOrders } from "./humanitix.js";

const apiKey = process.env.HUMANITIX_API_KEY;
const eventIds = (process.env.HUMANITIX_EVENT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!apiKey || eventIds.length === 0) {
  console.error(
    "Set HUMANITIX_API_KEY and HUMANITIX_EVENT_IDS in your .env file first."
  );
  process.exit(1);
}

for (const eventId of eventIds) {
  console.log(`\n=== Event ${eventId} ===`);
  try {
    const orders = await getAllOrders(apiKey, eventId, { pageSize: 1 });
    if (orders.length === 0) {
      console.log("No orders found for this event yet.");
      continue;
    }
    console.log("Raw shape of one order (full JSON):\n");
    console.log(JSON.stringify(orders[0], null, 2));
  } catch (err) {
    console.error(`Failed to fetch orders for ${eventId}:`, err.message);
  }
}

console.log(
  "\n--- Next step ---\n" +
    "Compare the JSON above to what src/humanitix.js's extractAttendees() " +
    "function expects (see the comments in that file). If your " +
    "data looks different, adjust the extraction logic there. Note orders " +
    "don't include tickets - those come from a separate endpoint."
);
