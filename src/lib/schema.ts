/**
 * Schema DDL, applied by POST /api/setup-db and by the backfill script.
 * Every statement is idempotent so it can be re-run safely.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS posts (
    id              TEXT PRIMARY KEY,
    subreddit       TEXT NOT NULL,
    created_utc     BIGINT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    selftext        TEXT NOT NULL DEFAULT '',
    score           INTEGER NOT NULL DEFAULT 0,
    num_comments    INTEGER NOT NULL DEFAULT 0,
    permalink       TEXT NOT NULL,
    link_flair_text TEXT,
    source          TEXT NOT NULL DEFAULT 'reddit',
    week_start      DATE NOT NULL,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE INDEX IF NOT EXISTS posts_week_idx ON posts (week_start)`,
  `CREATE INDEX IF NOT EXISTS posts_sub_week_idx ON posts (subreddit, week_start)`,
  `CREATE INDEX IF NOT EXISTS posts_created_idx ON posts (created_utc DESC)`,

  // Full-text search column that grounds the Q&A tab. Generated, so it can
  // never drift from the post body it indexes.
  `ALTER TABLE posts ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(selftext, '')), 'B')
    ) STORED`,
  `CREATE INDEX IF NOT EXISTS posts_search_idx ON posts USING GIN (search_tsv)`,

  `CREATE TABLE IF NOT EXISTS post_comments (
    id         TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    score      INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS post_comments_post_idx ON post_comments (post_id)`,

  `CREATE TABLE IF NOT EXISTS extractions (
    post_id      TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    sentiment    REAL NOT NULL,
    category     TEXT NOT NULL,
    themes       TEXT[] NOT NULL DEFAULT '{}',
    summary      TEXT NOT NULL DEFAULT '',
    pain_points  TEXT[] NOT NULL DEFAULT '{}',
    model        TEXT NOT NULL,
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS extractions_category_idx ON extractions (category)`,

  `CREATE TABLE IF NOT EXISTS weekly_aggregates (
    week_start    DATE NOT NULL,
    subreddit     TEXT NOT NULL,
    category      TEXT NOT NULL,
    avg_sentiment REAL NOT NULL,
    post_count    INTEGER NOT NULL,
    top_themes    JSONB NOT NULL DEFAULT '[]',
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (week_start, subreddit, category)
  )`,

  `CREATE TABLE IF NOT EXISTS weekly_reports (
    week_start        DATE PRIMARY KEY,
    week_end          DATE NOT NULL,
    whats_working     JSONB NOT NULL DEFAULT '[]',
    whats_not_working JSONB NOT NULL DEFAULT '[]',
    suggestions       JSONB NOT NULL DEFAULT '[]',
    post_count        INTEGER NOT NULL DEFAULT 0,
    avg_sentiment     REAL,
    is_backfilled     BOOLEAN NOT NULL DEFAULT false,
    model             TEXT NOT NULL DEFAULT '',
    generated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS insight_snapshots (
    id            SERIAL PRIMARY KEY,
    narrative     TEXT NOT NULL,
    is_baseline   BOOLEAN NOT NULL DEFAULT false,
    weeks_covered INTEGER NOT NULL DEFAULT 0,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS qa_history (
    id        SERIAL PRIMARY KEY,
    question  TEXT NOT NULL,
    answer    TEXT NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]',
    asked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  // The site is public, and both /api/ask and /api/insights/refresh spend real
  // Anthropic credits per call. Requests are metered here so a crawler cannot
  // run up the bill.
  `ALTER TABLE qa_history ADD COLUMN IF NOT EXISTS client_ip TEXT`,
  `CREATE INDEX IF NOT EXISTS qa_history_recent_idx ON qa_history (asked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS qa_history_ip_idx ON qa_history (client_ip, asked_at DESC)`,

  `CREATE TABLE IF NOT EXISTS rate_events (
    id        SERIAL PRIMARY KEY,
    bucket    TEXT NOT NULL,
    client_ip TEXT,
    at        TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS rate_events_lookup_idx ON rate_events (bucket, at DESC)`,

  // Maps each Batch API request back to the posts it covers.
  //
  // The Batches API returns results keyed by `custom_id`, and a positional id
  // ("g0", "g1", ...) is only meaningful to the process that built the batch.
  // When a backfill process died mid-poll, every completed — and billed —
  // result became unmappable, because the selection that produced the ordering
  // could no longer be reproduced. Persisting the mapping makes a submitted
  // batch recoverable by any later run.
  `CREATE TABLE IF NOT EXISTS batch_groups (
    batch_id   TEXT NOT NULL,
    custom_id  TEXT NOT NULL,
    post_ids   TEXT[] NOT NULL,
    applied    BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, custom_id)
  )`,
  `CREATE INDEX IF NOT EXISTS batch_groups_pending_idx ON batch_groups (applied, batch_id)`,

  // Ledger of days actually fetched from Arctic Shift, one row per
  // (subreddit, day).
  //
  // This exists because neither cheaper approach is correct. A forward-only
  // cursor marks history covered after a short run. MIN/MAX over `posts`
  // assumes the fetched range is contiguous — but interrupting a resumable job
  // mid-range is the normal case, and it leaves a hole that MIN/MAX reports as
  // covered. Only an explicit ledger distinguishes "fetched, genuinely quiet"
  // from "never fetched".
  `CREATE TABLE IF NOT EXISTS fetched_days (
    subreddit  TEXT NOT NULL,
    day        DATE NOT NULL,
    post_count INTEGER NOT NULL DEFAULT 0,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subreddit, day)
  )`,

  // Bookkeeping for the weekly ingest.
  //
  // `backfill_last_day` is retained for backwards compatibility but is no
  // longer read. It recorded only how far FORWARD a backfill run reached, so a
  // short run marked all history as covered and starved every longer run that
  // followed. Backfill coverage is now derived from `posts` itself — see
  // getCoverage() in src/lib/store.ts.
  `CREATE TABLE IF NOT EXISTS ingest_state (
    subreddit           TEXT PRIMARY KEY,
    last_post_utc       BIGINT NOT NULL DEFAULT 0,
    backfill_last_day   DATE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];
