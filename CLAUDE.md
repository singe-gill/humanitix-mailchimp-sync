# Humanitix → Mailchimp Attendee Sync

Syncs Humanitix event attendees — including per-ticket checkout question answers — into Mailchimp as tagged, merge-field-populated contacts. Built for Singe to automate a previously manual process, with a no-code control panel so the mapping rules don't require touching JSON or code.

## Architecture

- **Repo**: `singegill/humanitix-mailchimp-sync` on GitHub — **private**, and under the `singegill` account (no hyphen), not `singe-gill`. If `git`/`gh` says "Repository not found", the wrong account is active in `gh` (`gh auth switch`).

- **Execution**: GitHub Actions, scheduled cron (currently every 3 hours) + manual `workflow_dispatch` trigger
- **Control panel**: a single static page (`docs/index.html`), hosted via GitHub Pages, that talks directly to the GitHub REST API from the browser using a user-supplied fine-grained PAT. No backend server.
- **Config storage**:
  - Sensitive (API keys) → GitHub Actions **Secrets** (write-only — deliberately never exposed to the browser or control panel)
  - Non-sensitive (event IDs, Mailchimp list ID, opt-in status) → GitHub Actions **Variables** (readable, so the control panel can display/edit them)
  - Mapping rules (merge fields, tag/email routing) → `config.json`, committed to the repo, edited via the control panel or by hand

### Why this shape
Humanitix has **no webhook support** — polling is the only option for detecting new registrations. Rather than building separate "real-time" and "scheduled" systems, one poller does both: it runs on a schedule *and* exposes a manual trigger for "sync right before I send a campaign."

## Key architectural discoveries (from real API responses, not docs)

Humanitix's public API docs are JS-rendered and didn't scrape reliably, so most of the data shape was reverse-engineered against a live account during this build:

- **Orders and tickets are separate endpoints.** An order's JSON does *not* embed a `tickets` array — `getAllTickets()` hits a different endpoint entirely and results are linked back via `ticket.orderId`.
- **Checkout answers are `{questionId, value}` pairs**, not `{question, answer}`. The question *text* lives in the event object's own (undocumented-shape) question definitions. `buildQuestionLabelMap()` in `src/humanitix.js` resolves this by recursively scanning the whole event object for anything shaped like `{_id/id, question/label/title/name}`, rather than assuming a specific key name.
- **Order-level vs ticket-level questions are genuinely separate sets** — a checkout form can ask something once per order (e.g. "how did you hear about us?") and other things once per ticket/attendee (e.g. dietary requirements). Both get merged per attendee.
- **No dedicated ticket-level email field** — an attendee's own email is often just another question answer (e.g. "This persons email"), not a structured field. Default behavior auto-detects this by matching question text against `/e-?mail/i`; email-routing rules (below) let you specify it explicitly per ticket type.

## Config schema (`config.json`)

```jsonc
{
  "excludeStatuses": ["cancelled", "canceled", "refunded", "void", "voided"],

  "emailRouting": [
    {
      "ticketType": "Team member",
      "tag": "Staff",
      "primary": {
        "emailQuestion": "This persons email",
        "firstNameQuestion": "This persons first name",
        "lastNameQuestion": "This persons last name"
      }
      // no "secondary" -> exactly one contact per ticket
    },
    {
      "ticketType": "Camper",
      "tag": "Camp Attendee",
      "primary": { "emailQuestion": "...", "firstNameQuestion": "...", "lastNameQuestion": "..." },
      "secondary": {
        "emailQuestion": "Account contact email (Parent/Carer)",
        "fullNameQuestion": "Account contact name (Parent/Carer)"
        // full name split on first space -> firstName/lastName
        // secondary contact ONLY created if its email differs from primary's
      }
    }
  ],

  "mergeFieldMap": [
    { "source": "firstName", "mergeTag": "FNAME" },
    { "source": "lastName", "mergeTag": "LNAME" },
    { "source": "question", "match": "Company", "mergeTag": "COMPANY" }
  ],

  "tagRules": []
  // legacy general-purpose tag rule engine (static/eventName/ticketType/
  // ticketTypeEquals/questionAnswer/questionAnswerEquals types) - still
  // supported by src/mapping.js for backward compatibility / hand-editing,
  // but no longer exposed in the control panel UI. Tags are now set per
  // ticket type via emailRouting[].tag instead (simpler for this use case).
}
```

Ticket types with no `emailRouting` entry fall back to: one contact per ticket, auto-detected email, no tag. `ticketType` matching is case-insensitive.

The live `config.json` currently routes Camp No Fear: `Camper` → tag `CNF 2027 Camper` (with parent/carer secondary), `Team Member` → tag `CNF 2027 Team Member`. It has no `excludeStatuses` key, so the code default applies. Its `mergeFieldMap` maps FNAME/LNAME twice (from `firstName`/`lastName`, then from the "This persons first/last name" questions); later rules win, so the question answers take priority when present.

## Files

| File | Purpose |
|---|---|
| `src/humanitix.js` | Humanitix API client: orders, tickets, events, question-label resolution, email routing logic, status filtering |
| `src/mailchimp.js` | Mailchimp API client: batch upsert, tags, merge fields, audiences (all via Basic auth + server-prefix subdomain) |
| `src/mapping.js` | Legacy tag-rule engine + merge-field builder |
| `src/sync.js` | Main orchestrator — incremental (`state.json` checkpoint) or `--full`, `--dry-run`, `--show-details` |
| `src/discover.js` | One-off: dumps one raw order for manual schema inspection |
| `src/discover-options.js` | Scans orders/tickets → `docs/options.json` (checkout questions, ticket types, ticket statuses seen, Mailchimp merge fields, Mailchimp tags) |
| `src/discover-accounts.js` | Lists Humanitix events + Mailchimp audiences → `docs/accounts.json` (needs only Secrets, works before any Variables are set) |
| `docs/index.html` | Control panel — connect via PAT, pick events/audience by name, build merge-field/email-routing/tag rules, dry run, sync now, view run history |
| `docs/options.json`, `docs/accounts.json` | Auto-generated by the discovery workflows, read by the control panel |
| `config.json` / `config.example.json` | Mapping rules (see schema above) |
| `state.json` | Auto-generated; last-synced timestamp per event, for incremental syncing |
| `.github/workflows/sync.yml` | Scheduled + manual sync trigger |
| `.github/workflows/discover-options.yml`, `discover-accounts.yml` | Manual-only discovery triggers |

## Key decisions & rationale

- **Batch API for Mailchimp writes** (not per-contact loops) — Mailchimp's own recommended pattern for bulk operations, well under their 10-concurrent-connection limit.
- **Dry-run mode is privacy-aware by default**: full per-attendee detail (emails, names, checkout answers like dietary/medical info) only prints when run locally, or with an explicit `--show-details` flag — not by default in GitHub Actions, since a public repo's Actions logs are publicly visible to anyone. The repo is now private, but the guard is kept as a precaution (and in case it's ever made public again).
- **Sync schedule**: started at every 10 minutes, reduced to hourly, settled on **every 3 hours** (`0 */3 * * *`). Not driven by API rate limits (Humanitix: 200 req/min; Mailchimp: 10 concurrent connections — neither is close to being hit at this event's scale) but by **GitHub Actions minutes**: a private repo's free tier is 2,000 min/month, and 10-minute polling (~4,320 runs/month) risked exceeding that, while 3-hourly (~240 runs/month) leaves comfortable headroom. The manual "Sync now" / "Dry run" buttons cover anything time-sensitive.
- **Ticket-type fields in the UI are real `<select>` dropdowns** (small closed set, populated from `docs/accounts.json`/`options.json`); checkout-question/merge-field/tag fields stay as free-text with autocomplete (open-ended sets) but got a visible chevron added so the autocomplete affordance isn't invisible.
- **Cancelled/refunded filtering** checks `order.status`, `order.financialStatus`, `ticket.status`, `ticket.financialStatus` case-insensitively against `config.excludeStatuses`. A whole-order match skips every ticket in it; a ticket-level match skips just that ticket.
- **`partiallyRefunded` tickets are synced, not excluded, by design.** It's a real status (confirmed via Refresh options) but isn't in the default `excludeStatuses` list. A partial refund (e.g. a discount adjustment or a refund on one add-on) doesn't reliably mean the person isn't attending, unlike a full cancellation/refund — so the default errs toward not silently dropping a real attendee from camp communications. If this is wrong for a specific event, add `"partiallyRefunded"` to that event's `excludeStatuses` in `config.json` (editable via the control panel's "Skip cancelled/refunded tickets" section) rather than changing the global default.

## Open questions / not yet verified

- **Team-member email routing has less real-world verification than camper routing** — logic was tested against synthetic data matching the real ticket shape, but not yet run against actual team-member tickets in a live dry run.

Resolved since last write-up, kept here only as a pointer to where the evidence lives: `excludeStatuses` defaults are now confirmed against real discovered statuses in `docs/options.json` (`cancelled`, `complete`, `free`, `paid`, `partiallyRefunded`, `refunded` all seen live); `getAllEvents()`/discover-accounts is confirmed working (`docs/accounts.json` has real data); cancelled-ticket filtering and the 3-hourly schedule are both deployed on `main` (commit `99ddbf1`), not queued.

## Testing approach used throughout

Given the API's undocumented shape, most fixes were verified two ways before shipping:
1. **Live diagnostics** — temporary logging added to discovery scripts to dump real (PII-redacted) API responses into the GitHub Actions log, confirming actual field names/shapes.
2. **Isolated unit tests** — synthetic data built to match the confirmed real shape, run through the actual extraction/mapping functions with `console.assert`, to catch logic errors before they touched live Mailchimp data.

This pattern is worth continuing for any further changes to the extraction/routing logic, given how much of Humanitix's API had to be inferred rather than documented.
