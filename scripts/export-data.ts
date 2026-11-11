/**
 * Export the corpus and derived analysis to a single SQLite file.
 *
 *   npm run export                       -> exports/reddit-insight-<date>.sqlite
 *   npm run export -- --out path.sqlite
 *   npm run export -- --no-selftext      smaller file, titles only
 *
 * SQLite rather than CSV or JSON because the data is relational — posts join to
 * extractions join to weekly aggregates — and a single file keeps those joins
 * intact, is queryable with plain SQL in every language without a server, and
 * holds real types instead of stringly-typed cells.
 *
 * Operational tables (batch bookkeeping, rate-limit counters, ingest cursors)
 * are deliberately excluded: they describe how the data was collected, not what
 * was collected. qa_history is excluded too, because it stores visitor IPs.
 */
import { config } from "dotenv";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getDb, toIsoDate } from "../src/lib/db";

config({ path: ".env.local", override: true });

const PAGE = 2000;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const NO_SELFTEXT = process.argv.includes("--no-selftext");
const OUT = arg(
  "--out",
  `exports/reddit-insight-${new Date().toISOString().slice(0, 10)}.sqlite`,
);

function log(m: string) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${m}\n`);
}

/**
 * Columns that are Postgres DATE rather than TIMESTAMPTZ. The driver hands both
 * back as JS Date at LOCAL midnight, so calling toISOString() on a date-only
 * value rolls it back a day for anyone east of UTC. These get toIsoDate().
 */
const DATE_ONLY = new Set(["week_start", "week_end", "day"]);

/** Postgres arrays and jsonb have no SQLite equivalent; store them as JSON text. */
function cell(v: unknown, column?: string): string | number | null {
  if (v === null || v === undefined) return null;
  if (column && DATE_ONLY.has(column)) return toIsoDate(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return String(v);
}

interface TableSpec {
  name: string;
  ddl: string;
  select: string;
  columns: string[];
  orderBy: string;
}

const TABLES: TableSpec[] = [
  {
    name: "posts",
    ddl: `CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      subreddit TEXT NOT NULL,
      created_utc INTEGER NOT NULL,
      created_iso TEXT NOT NULL,
      week_start TEXT NOT NULL,
      title TEXT NOT NULL,
      selftext TEXT,
      score INTEGER NOT NULL,
      num_comments INTEGER NOT NULL,
      permalink TEXT NOT NULL,
      link_flair_text TEXT,
      source TEXT NOT NULL
    )`,
    select: `SELECT id, subreddit, created_utc, week_start, title,
                    ${NO_SELFTEXT ? "'' AS selftext" : "selftext"},
                    score, num_comments, permalink, link_flair_text, source
             FROM posts`,
    columns: [
      "id", "subreddit", "created_utc", "created_iso", "week_start", "title",
      "selftext", "score", "num_comments", "permalink", "link_flair_text", "source",
    ],
    orderBy: "created_utc",
  },
  {
    name: "extractions",
    ddl: `CREATE TABLE extractions (
      post_id TEXT PRIMARY KEY REFERENCES posts(id),
      sentiment REAL NOT NULL,
      category TEXT NOT NULL,
      themes TEXT NOT NULL,
      summary TEXT NOT NULL,
      pain_points TEXT NOT NULL,
      model TEXT NOT NULL,
      extracted_at TEXT NOT NULL
    )`,
    select: `SELECT post_id, sentiment, category, themes, summary, pain_points, model, extracted_at FROM extractions`,
    columns: ["post_id", "sentiment", "category", "themes", "summary", "pain_points", "model", "extracted_at"],
    orderBy: "post_id",
  },
  {
    name: "post_comments",
    ddl: `CREATE TABLE post_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id),
      body TEXT NOT NULL,
      score INTEGER NOT NULL
    )`,
    select: `SELECT id, post_id, body, score FROM post_comments`,
    columns: ["id", "post_id", "body", "score"],
    orderBy: "id",
  },
  {
    name: "weekly_aggregates",
    ddl: `CREATE TABLE weekly_aggregates (
      week_start TEXT NOT NULL,
      subreddit TEXT NOT NULL,
      category TEXT NOT NULL,
      avg_sentiment REAL NOT NULL,
      post_count INTEGER NOT NULL,
      top_themes TEXT NOT NULL,
      PRIMARY KEY (week_start, subreddit, category)
    )`,
    select: `SELECT week_start, subreddit, category, avg_sentiment, post_count, top_themes FROM weekly_aggregates`,
    columns: ["week_start", "subreddit", "category", "avg_sentiment", "post_count", "top_themes"],
    orderBy: "week_start, subreddit, category",
  },
  {
    name: "weekly_reports",
    ddl: `CREATE TABLE weekly_reports (
      week_start TEXT PRIMARY KEY,
      week_end TEXT NOT NULL,
      whats_working TEXT NOT NULL,
      whats_not_working TEXT NOT NULL,
      suggestions TEXT NOT NULL,
      post_count INTEGER NOT NULL,
      avg_sentiment REAL,
      is_backfilled INTEGER NOT NULL,
      model TEXT NOT NULL,
      generated_at TEXT NOT NULL
    )`,
    select: `SELECT week_start, week_end, whats_working, whats_not_working, suggestions,
                    post_count, avg_sentiment, is_backfilled, model, generated_at FROM weekly_reports`,
    columns: ["week_start", "week_end", "whats_working", "whats_not_working", "suggestions",
              "post_count", "avg_sentiment", "is_backfilled", "model", "generated_at"],
    orderBy: "week_start",
  },
  {
    name: "insight_snapshots",
    ddl: `CREATE TABLE insight_snapshots (
      id INTEGER PRIMARY KEY,
      narrative TEXT NOT NULL,
      is_baseline INTEGER NOT NULL,
      weeks_covered INTEGER NOT NULL,
      generated_at TEXT NOT NULL
    )`,
    select: `SELECT id, narrative, is_baseline, weeks_covered, generated_at FROM insight_snapshots`,
    columns: ["id", "narrative", "is_baseline", "weeks_covered", "generated_at"],
    orderBy: "id",
  },
  {
    name: "fetched_days",
    ddl: `CREATE TABLE fetched_days (
      subreddit TEXT NOT NULL,
      day TEXT NOT NULL,
      post_count INTEGER NOT NULL,
      PRIMARY KEY (subreddit, day)
    )`,
    select: `SELECT subreddit, day, post_count FROM fetched_days`,
    columns: ["subreddit", "day", "post_count"],
    orderBy: "subreddit, day",
  },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("Missing DATABASE_URL in .env.local");
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const pg = getDb();
  const db = new DatabaseSync(OUT);

  // Bulk-load settings; the file is rewritten from scratch each run.
  db.exec("PRAGMA journal_mode = OFF");
  db.exec("PRAGMA synchronous = OFF");

  for (const t of TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${t.name}`);
    db.exec(t.ddl);

    const placeholders = t.columns.map(() => "?").join(",");
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${t.name} (${t.columns.join(",")}) VALUES (${placeholders})`,
    );

    let offset = 0;
    let written = 0;

    for (;;) {
      const rows = (await pg.query(
        `${t.select} ORDER BY ${t.orderBy} LIMIT ${PAGE} OFFSET ${offset}`,
      )) as Record<string, unknown>[];
      if (rows.length === 0) break;

      db.exec("BEGIN");
      for (const r of rows) {
        // created_iso is derived, not stored in Postgres — it makes the export
        // readable without converting epochs by hand.
        if (t.name === "posts") {
          r.created_iso = new Date(Number(r.created_utc) * 1000).toISOString();
        }
        insert.run(...t.columns.map((c) => cell(r[c], c)));
      }
      db.exec("COMMIT");

      written += rows.length;
      offset += PAGE;
      if (written % 20000 === 0) log(`  ${t.name}: ${written.toLocaleString()} rows`);
      if (rows.length < PAGE) break;
    }
    log(`${t.name}: ${written.toLocaleString()} rows`);
  }

  log("building indexes…");
  db.exec(`CREATE INDEX idx_posts_sub_week ON posts (subreddit, week_start)`);
  db.exec(`CREATE INDEX idx_posts_created ON posts (created_utc)`);
  db.exec(`CREATE INDEX idx_posts_score ON posts (score DESC)`);
  db.exec(`CREATE INDEX idx_extractions_category ON extractions (category)`);
  db.exec(`CREATE INDEX idx_extractions_sentiment ON extractions (sentiment)`);
  db.exec(`CREATE INDEX idx_comments_post ON post_comments (post_id)`);
  db.exec(`CREATE INDEX idx_agg_week ON weekly_aggregates (week_start)`);

  // A convenience view so the common join is one word.
  db.exec(`CREATE VIEW tagged_posts AS
    SELECT p.id, p.subreddit, p.created_iso, p.week_start, p.title, p.selftext,
           p.score, p.num_comments, p.permalink, p.link_flair_text,
           e.sentiment, e.category, e.themes, e.summary, e.pain_points
    FROM posts p JOIN extractions e ON e.post_id = p.id`);

  // Self-describing metadata, so the file explains itself years from now.
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const meta = db.prepare(`INSERT INTO _meta (key, value) VALUES (?, ?)`);
  const counts = (await pg.query(`SELECT
      (SELECT COUNT(*) FROM posts)::int AS posts,
      (SELECT COUNT(*) FROM extractions)::int AS tagged,
      (SELECT MIN(week_start)::text FROM weekly_aggregates) AS first_week,
      (SELECT MAX(week_start)::text FROM weekly_aggregates) AS last_week`)) as any[];

  const entries: [string, string][] = [
    ["exported_at", new Date().toISOString()],
    ["subreddits", "r/starbucks, r/starbucksbaristas"],
    ["post_source", "Arctic Shift (arctic-shift.photon-reddit.com), the maintained public Pushshift successor. Reddit's own API caps listings at ~1000 items per subreddit, so it cannot reach this far back."],
    ["coverage", `${counts[0].first_week} to ${counts[0].last_week}`],
    ["posts_total", String(counts[0].posts)],
    ["posts_tagged", String(counts[0].tagged)],
    ["sampling", "Every post in range is in `posts`. Only a sample is tagged in `extractions`: the top 60 per subreddit per week ranked by score + 2*num_comments, plus every post from weeks after the live weekly ingest began. Low-engagement posts are overwhelmingly one-line drink questions."],
    ["score_meaning", "posts.score is Reddit's net score: upvotes minus downvotes, as displayed by Reddit. It can be low for a heavily discussed but divisive thread, which is why ranking adds 2*num_comments. Reddit fuzzes vote counts slightly against manipulation, so treat it as approximate."],
    ["sentiment_meaning", "extractions.sentiment is a model judgment on a -1.0 (furious) to +1.0 (delighted) scale, where 0.0 is neutral or informational. It is unrelated to posts.score."],
    ["categories", "barista_experience, customer_experience, operational_efficiency, other"],
    ["json_columns", "themes, pain_points, top_themes, whats_working, whats_not_working, suggestions are JSON text (SQLite has no array/object type). Parse them, or query with SQLite's json_each()/json_extract()."],
    ["extraction_model", "claude-haiku-4-5"],
    ["synthesis_model", "claude-opus-5"],
    ["fetched_days_note", "One row per subreddit per day actually fetched. A day present with post_count 0 was genuinely quiet; a day absent was never fetched."],
    ["selftext_included", NO_SELFTEXT ? "no (--no-selftext)" : "yes"],
    ["excluded_tables", "Operational tables (batch_groups, rate_events, ingest_state) describe collection rather than data. qa_history is excluded because it stores visitor IP addresses."],
    ["license_note", "Post text and comments are public Reddit content, authored by redditors and subject to Reddit's terms. Redistribute accordingly."],
  ];
  db.exec("BEGIN");
  for (const [k, v] of entries) meta.run(k, v);
  db.exec("COMMIT");

  log("compacting…");
  db.exec("VACUUM");
  db.close();

  const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
  log(`DONE -> ${OUT} (${mb} MB)`);
}

main().catch((err) => {
  console.error("\nExport failed:", err);
  process.exit(1);
});
