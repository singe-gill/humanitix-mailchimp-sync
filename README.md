# Humanitix → Mailchimp Sync

Pulls attendees (and their checkout question answers) from Humanitix events
and creates/updates them as tagged contacts in a Mailchimp audience.

## How it decides what's "new"

Humanitix doesn't offer webhooks, so this works by **polling**: each run
fetches orders for your configured event(s) and only processes ones created
since the last successful run (tracked in `state.json`). It runs on a
schedule every 3 hours, and you can also trigger it manually at any time —
e.g. right before sending a campaign — via **Sync now** in the control panel
or the GitHub Actions "Run workflow" button, with no risk of double-processing.

Cancelled and refunded orders/tickets are skipped (see `excludeStatuses`
below). Partially refunded tickets are still synced on purpose — a partial
refund usually doesn't mean the person isn't coming.

## 1. Get your API keys

- **Humanitix**: Console → Account → Advanced → Public API key
- **Mailchimp**: Account → Extras → API keys. The key looks like
  `abc123...-us21` — the `us21` part is your server prefix.
- **Mailchimp List/Audience ID**: Audience → Settings → Audience name and
  defaults

## 2. Local setup (to test before automating)

```bash
npm install
cp .env.example .env      # fill in your keys
```

**Run discovery first** — this fetches one real order and prints its raw
JSON so we can confirm the checkout-question field names match what the code
expects:

```bash
npm run discover
```

Compare the output against the comments in `src/humanitix.js`
(`extractAttendees` function). Note that an order doesn't include its
tickets — those come from a separate endpoint and are linked back by
`ticket.orderId` — and checkout answers are `{questionId, value}` pairs whose
question text is looked up from the event. If your account's data looks
different, adjust the extraction logic in `src/humanitix.js`.

## 3. Configure the mapping

```bash
cp config.example.json config.json
```

Edit `config.json` (or use the control panel, below — it edits the same file):
- `emailRouting` — per ticket type: which checkout questions hold the
  attendee's email/first name/last name, which tag to apply, and optionally
  a `secondary` contact (e.g. a parent/carer) that's only created when their
  email differs from the attendee's. Ticket types are matched by name,
  case-insensitively. Ticket types with no rule get one contact per ticket,
  with the email auto-detected from any question mentioning "email", and no tag.
- `mergeFieldMap` — which checkout question answers become Mailchimp merge
  fields (name, company, job title, etc). **Create matching merge fields in
  Mailchimp first** (Audience → Settings → Audience fields) or the values
  will be silently dropped.
- `excludeStatuses` — order/ticket statuses to skip (case-insensitive,
  checked against both `status` and `financialStatus`). Defaults to
  `cancelled, canceled, refunded, void, voided`. Statuses seen on the live
  account so far: `cancelled`, `complete`, `free`, `paid`,
  `partiallyRefunded`, `refunded`.
- `tagRules` — legacy general-purpose tag rules (by event name, ticket type,
  or checkout answer). Still supported if you hand-edit `config.json`, but
  no longer shown in the control panel; per-ticket-type tags in
  `emailRouting` cover the usual case.

See `config.example.json` for a worked example of each.

## 4. Test run

```bash
npm run sync -- --full --dry-run
npm run sync -- --full --wait
```

`--dry-run` computes everything and prints what *would* be sent, but writes
nothing to Mailchimp and doesn't advance `state.json`. Locally it prints full
per-attendee detail; in GitHub Actions it only ever prints counts, because
this repo is public and so are its Actions logs. Mailchimp error-report links
are likewise only printed locally.
`--full` backfills every past attendee (first run only — otherwise it only
looks at orders since the last run). `--wait` makes it wait for the
Mailchimp batch to finish and print a pass/fail summary instead of just
firing and forgetting.

Check your Mailchimp audience to confirm contacts, merge fields, and tags
look right before automating.

## 5. Automate it

The included `.github/workflows/sync.yml` runs the sync every 3 hours
(`0 */3 * * *` — chosen to stay well inside GitHub Actions' free minutes, not
because of API limits) and also exposes a manual "Run workflow" button (with
full-backfill and dry-run options) in the GitHub Actions tab.
Use that, or **Sync now** in the control panel, right before sending a
campaign to guarantee the latest registrants are included.

To set it up:
1. Push this folder to a GitHub repo.
2. Repo → Settings → Secrets and variables → Actions → **Secrets** tab → add:
   `HUMANITIX_API_KEY`, `MAILCHIMP_API_KEY`, `MAILCHIMP_SERVER_PREFIX`
3. Same page → **Variables** tab → add: `HUMANITIX_EVENT_IDS`,
   `MAILCHIMP_LIST_ID`, `MAILCHIMP_STATUS_IF_NEW` — or just set these from
   the control panel (see below) instead of doing it by hand.
4. Commit your real `config.json` — it has no secrets in it, just mapping
   rules, and isn't gitignored.
5. The workflow commits `state.json` back to the repo after each run so the
   next run knows where it left off.

If you'd rather not use GitHub Actions, any scheduler that can run
`node src/sync.js` on a timer works (Cloudflare Workers Cron Triggers,
a Vercel/Render cron job, a Linux crontab on a small VPS, etc.) — just make
sure `state.json` persists between runs.

## 6. Control panel (edit settings without touching JSON or the repo)

`docs/index.html` is a self-contained page — no build step, no server — that
lets you edit the event IDs, Mailchimp list ID, and the question→field/tag
mapping rules through a form, and trigger a manual sync, all from the
browser. It talks directly to the GitHub API using a token you provide, so
there's nothing extra to host.

**Turn it on:**
1. Repo → Settings → Pages → Source: "Deploy from a branch" → Branch:
   your default branch, folder `/docs` → Save.
2. GitHub gives you a URL like `https://yourname.github.io/humanitix-mailchimp-sync/`.
   Open it.
3. Create a token: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   — fine-grained, **repository access limited to this one repo**, permissions:
   `Contents: Read and write`, `Actions: Read and write`, `Variables: Read
   and write`. Nothing else.
4. Paste `owner/repo` and the token into the page and hit Connect.

The token is stored only in your browser's local storage and is sent only
to `api.github.com` — never anywhere else. It never touches your Humanitix
or Mailchimp keys, which stay as repo Secrets and aren't exposed to this
page at all. Treat the token like a password anyway (it can write to this
repo) — don't share the page URL with the token pre-filled, and revoke it
from GitHub any time from Settings → Developer settings → Personal access
tokens.

From the control panel you can:
- Pick which Humanitix events to sync and your Mailchimp audience by name,
  via **Refresh events & audiences** — no more hunting for IDs. This runs
  its own small GitHub Actions job (`discover-accounts.yml`) that only needs
  your API keys (already set as Secrets), so it works even on a totally
  fresh setup before anything else is configured.
- Build merge-field rules and per-ticket-type email routing/tag rules with
  plain forms instead of hand-editing `config.json` (ticket types are
  dropdowns; questions, merge fields and tags are free text with autocomplete)
- Edit which statuses count as cancelled/refunded ("Skip cancelled/refunded
  tickets")
- Run a **Dry run** (preview only, writes nothing) or **Sync now** (with a
  full-backfill option) and watch its status in Recent Runs, which links to
  the full GitHub Actions log
- Click **Refresh options** to scan your recent orders for real checkout
  question text and ask Mailchimp what merge fields/tags already exist, so
  the question/field/tag inputs above offer autocomplete suggestions instead
  of you needing to go look up exact spellings. This runs as a separate
  GitHub Actions job (`discover-options.yml`) using your real API keys
  server-side — the browser only ever receives the resulting list of names,
  never the keys themselves — and writes the results to `docs/options.json`.
  Takes 30–60 seconds; the button polls until it's done. You can also just
  run `npm run discover-options` locally instead if you'd rather not wait.

Note the question/field/tag inputs are autocomplete, not locked dropdowns —
you can still type something not in the suggested list (e.g. a checkout
question from an event you haven't run Refresh options against yet, or a
brand-new Mailchimp merge field). If an event doesn't show up in the events
list, you can still add its ID manually in the "Other event IDs" field.
Refresh again after adding new events, checkout questions, or merge fields
so the suggestions stay current.

## A note on consent

Only sync attendees to Mailchimp who've actually agreed to be emailed.
`MAILCHIMP_STATUS_IF_NEW=subscribed` immediately makes new contacts
marketable — only use that if your checkout flow already has a clear opt-in
question. If it doesn't, use `pending` instead, which sends Mailchimp's
standard double opt-in confirmation email, or add an explicit "join our
newsletter" checkout question and gate tagging on that answer with a
legacy `tagRules` entry of type `questionAnswerEquals` (see `src/mapping.js`).

## Files

| File | Purpose |
|---|---|
| `src/humanitix.js` | Humanitix API client, attendee extraction, email routing, status filtering |
| `src/mailchimp.js` | Mailchimp API client (upsert + tagging via batch) |
| `src/mapping.js` | Builds merge fields; legacy `tagRules` engine |
| `src/sync.js` | Orchestrates everything, tracks incremental state |
| `src/discover.js` | One-off script to inspect real API response shape |
| `config.json` | Your mapping rules (committed; no secrets). `config.example.json` is a worked example |
| `state.json` | Auto-generated; tracks last synced timestamp per event |
| `docs/index.html` | Browser control panel (GitHub Pages) for settings + manual runs |
| `docs/options.json` | Auto-generated; discovered checkout questions / merge fields / tags for the control panel's autocomplete |
| `docs/accounts.json` | Auto-generated; discovered Humanitix events / Mailchimp audiences for the control panel's pickers |
| `src/discover-options.js` | Scans orders + Mailchimp to produce `docs/options.json` |
| `src/discover-accounts.js` | Lists events + audiences to produce `docs/accounts.json` |
| `.github/workflows/sync.yml` | Scheduled (3-hourly) + manual sync |
| `.github/workflows/discover-options.yml`, `discover-accounts.yml` | Manual-only jobs behind the control panel's Refresh buttons |
