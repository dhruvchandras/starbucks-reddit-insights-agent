# Starbucks Reddit Insight Agent

A private, read-only research tool that reads r/starbucks and r/starbucksbaristas and turns
them into synthesized insight. **It never posts to Reddit** — it requests no write scope and
calls no write endpoints.

Three tabs:

1. **Ask** — questions answered from the ingested corpus, with links to source threads.
2. **Weekly updates** — a blog-style feed, one entry per week: what's working, what's not,
   and 3 tactical suggestions each for barista experience, customer experience and
   operational efficiency.
3. **Over time** — sentiment and theme evolution across the whole corpus, with a refresh button.

## Setup

```bash
npm install
cp .env.local.example .env.local   # then fill it in
```

| Variable | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `DATABASE_URL` | Neon connection string (console.neon.tech) |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | **Optional.** reddit.com/prefs/apps → **script** app. Only used as a fallback if Arctic Shift is unreachable. |
| `REDDIT_USER_AGENT` | Optional, e.g. `web:reddit-insight-agent:v1.0 (by /u/yourname)` |
| `CRON_SECRET` | any random string; Vercel Cron sends it as a bearer token |

Reddit credentials use the `client_credentials` grant — **no password is ever needed or used.**
They are optional: Arctic Shift runs under an hour behind live and serves both history and
current data, so the app works with no Reddit app at all.

Apply the schema:

```bash
curl -X POST http://localhost:3007/api/setup-db
```

## Building the historical baseline

Reddit's own API stops at ~1000 posts per subreddit, so history comes from
[Arctic Shift](https://arctic-shift.photon-reddit.com), the maintained public Pushshift
successor. Three years is ~117,000 posts across both subs, so the backfill keeps the top 60
per subreddit per week by engagement (~18,700 posts).

Coverage is an explicit per-day ledger (`fetched_days`), not a cursor and not `MIN`/`MAX`
over `posts`. A forward-only cursor marks all history covered after a short run; `MIN`/`MAX`
assumes the fetched range is contiguous, so an interrupt mid-range leaves a hole that reads
back as covered. Both of those silently skipped years of history during development. The
ledger also distinguishes a genuinely quiet day from an unfetched one.

Batches are recoverable. Each Batch API request's post IDs are written to `batch_groups`
immediately after submission, before polling starts, so a run that dies mid-poll is resumed
by the next one. Without this, a positional `custom_id` ("g0", "g1", …) is meaningless
outside the process that created it, and completed — billed — results cannot be attributed
to any post. Every run collects unfinished batches before submitting new ones.

This runs **locally**, not on Vercel — it takes tens of minutes and Vercel functions cap at 300s.

```bash
npm run probe                  # sanity-check extraction quality on ~20 real posts, ~$0.01
npm run backfill -- --dry-run  # see the post count and cost estimate, spend nothing
npm run backfill               # the real run
```

Measured cost: **~$5 via the Batch API** (~$10 with `--sync`). It is resumable — Ctrl-C and
re-run picks up where it left off. Useful flags: `--years`, `--per-week`, `--limit`,
`--skip-fetch`, `--back-issues`.

The backfill also writes the most recent 12 weekly reports so tab 2 has back-issues to
scroll on day one. Those are marked "sampled baseline" in the UI, because they come from the
top-engagement sample rather than a full week's ingest.

## Ongoing operation

Two Vercel crons (`vercel.json`):

| Route | Schedule | What it does |
|---|---|---|
| `/api/cron/ingest` | Mondays 06:00 UTC | Pull the last 8 days + top comments from Arctic Shift, tag with Haiku 4.5 |
| `/api/cron/weekly-report` | Mondays 13:00 UTC | Synthesize the week that just ended with Opus 5 |

Both are weekly, seven hours apart so tagging finishes before synthesis reads it. Hobby
allows 100 crons at a minimum interval of once per day, so weekly is fine.

The ingest is deliberately **not** daily. The output is weekly, post scores keep maturing for
24-48h (and the sampling ranks by engagement, so settled numbers are better), and daily would
be seven chances to fail silently instead of one. The one real constraint — Vercel's 300s
function cap — is handled with bounded concurrency: ~38 tagging calls run 8 at a time,
measured at ~52s for a no-op run and ~120s for a full week.

It is also idempotent and self-healing: already-tagged posts are skipped, and a sweep at the
end tags anything from the last 3 weeks that an earlier failure left behind.

## Public deployment

The site is public and shareable. Two endpoints spend Anthropic credits per call, so both
are rate limited (counters live in Postgres, since Vercel instances do not share memory and
an in-memory counter resets on cold start):

| Endpoint | Per IP | Global | Window |
|---|---|---|---|
| `/api/ask` | 12 | 150 | 1 hour |
| `/api/insights/refresh` | 3 | 12 | 1 hour |

Limits fail open — a metering error returns the answer rather than taking the feature down.

## Models

- **Claude Haiku 4.5** tags each post (sentiment, category, themes, pain points).
- **Claude Opus 5** writes the weekly reports, answers questions, and writes the long-range narrative.

The extraction rubric carries a `cache_control` marker, but at ~700 tokens it sits below
Haiku 4.5's 4096-token minimum cacheable prefix, so no cache entry is created. This is
expected; all cost estimates already assume no caching.

## Local development

```bash
npm run dev     # http://localhost:3007
```

Cron routes require the secret:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3007/api/cron/ingest
```
