import fetch from "node-fetch";
import crypto from "node:crypto";

function baseUrl(serverPrefix) {
  return `https://${serverPrefix}.api.mailchimp.com/3.0`;
}

function authHeader(apiKey) {
  // Mailchimp accepts any string as the username with the API key as password.
  const token = Buffer.from(`anystring:${apiKey}`).toString("base64");
  return `Basic ${token}`;
}

export function subscriberHash(email) {
  return crypto
    .createHash("md5")
    .update(email.toLowerCase().trim())
    .digest("hex");
}

/**
 * Build a Mailchimp batch operation that upserts a contact (create-or-update)
 * and, in a second operation, applies/removes tags.
 * https://mailchimp.com/developer/marketing/api/list-members/add-or-update-list-member/
 * https://mailchimp.com/developer/marketing/api/list-member-tags/add-or-remove-member-tags/
 */
export function buildUpsertOperations({
  listId,
  email,
  mergeFields,
  tags,
  statusIfNew,
}) {
  const hash = subscriberHash(email);
  const ops = [];

  ops.push({
    method: "PUT",
    path: `/lists/${listId}/members/${hash}`,
    body: JSON.stringify({
      email_address: email,
      status_if_new: statusIfNew,
      merge_fields: mergeFields,
    }),
  });

  if (tags && tags.length > 0) {
    ops.push({
      method: "POST",
      path: `/lists/${listId}/members/${hash}/tags`,
      body: JSON.stringify({
        tags: tags.map((name) => ({ name, status: "active" })),
      }),
    });
  }

  return ops;
}

/**
 * Submit a batch of operations to Mailchimp's async Batch endpoint.
 * Mailchimp processes batches asynchronously; for a few hundred attendees
 * this usually completes within seconds to a couple of minutes.
 * https://mailchimp.com/developer/marketing/api/batch-operations/start-batch-operation/
 */
export async function runBatch({ apiKey, serverPrefix, operations }) {
  if (operations.length === 0) return null;

  const res = await fetch(`${baseUrl(serverPrefix)}/batches`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operations }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mailchimp batch submit failed ${res.status}: ${body}`);
  }
  return res.json(); // contains { id, status, ... } - poll /batches/{id} if you want completion status
}

/** Poll a batch until it finishes (optional, useful for the manual/pre-send run). */
export async function waitForBatch({ apiKey, serverPrefix, batchId, timeoutMs = 120000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl(serverPrefix)}/batches/${batchId}`, {
      headers: { Authorization: authHeader(apiKey) },
    });
    const data = await res.json();
    if (data.status === "finished") return data;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Batch ${batchId} did not finish within timeout`);
}
