import { getDb, weekStart, addDays, toIsoDate } from "./db";
import type {
  Category,
  Extraction,
  Post,
  PostComment,
  Subreddit,
  WeeklyAggregate,
  WeeklyReport,
} from "@/types";
import type { RetrievedPost, WeekSample } from "./claude";

// ─── Posts ───────────────────────────────────────────────────────────────────

/**
 * Bulk upsert. Neon's HTTP driver has no COPY, so posts go in chunked
 * multi-row INSERTs; 200 rows keeps us well inside statement size limits.
 */
export async function upsertPosts(posts: Post[]): Promise<number> {
  if (posts.length === 0) return 0;
  const sql = getDb();
  let written = 0;

  for (let i = 0; i < posts.length; i += 200) {
    const chunk = posts.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((p, j) => {
      const b = j * 11;
      values.push(
        p.id,
        p.subreddit,
        p.createdUtc,
        p.title,
        p.selftext,
        p.score,
        p.numComments,
        p.permalink,
        p.linkFlairText,
        p.source,
        weekStart(p.createdUtc),
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
    });

    await sql.query(
      `INSERT INTO posts (id, subreddit, created_utc, title, selftext, score,
                          num_comments, permalink, link_flair_text, source, week_start)
       VALUES ${tuples.join(",")}
       ON CONFLICT (id) DO UPDATE SET
         score = EXCLUDED.score,
         num_comments = EXCLUDED.num_comments`,
      values,
    );
    written += chunk.length;
  }
  return written;
}

export async function upsertComments(comments: PostComment[]): Promise<void> {
  if (comments.length === 0) return;
  const sql = getDb();

  for (let i = 0; i < comments.length; i += 200) {
    const chunk = comments.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((c, j) => {
      const b = j * 4;
      values.push(c.id, c.postId, c.body, c.score);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
    });
    await sql.query(
      `INSERT INTO post_comments (id, post_id, body, score)
       VALUES ${tuples.join(",")}
       ON CONFLICT (id) DO UPDATE SET score = EXCLUDED.score`,
      values,
    );
  }
}

export async function upsertExtractions(rows: Extraction[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = getDb();

  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((e, j) => {
      const b = j * 7;
      values.push(
        e.postId,
        e.sentiment,
        e.category,
        e.themes,
        e.summary,
        e.painPoints,
        e.model,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    });
    await sql.query(
      `INSERT INTO extractions (post_id, sentiment, category, themes, summary, pain_points, model)
       VALUES ${tuples.join(",")}
       ON CONFLICT (post_id) DO UPDATE SET
         sentiment = EXCLUDED.sentiment,
         category = EXCLUDED.category,
         themes = EXCLUDED.themes,
         summary = EXCLUDED.summary,
         pain_points = EXCLUDED.pain_points,
         model = EXCLUDED.model,
         extracted_at = now()`,
      values,
    );
  }
}

// ─── Ingest cursors ──────────────────────────────────────────────────────────

export async function getCursor(subreddit: Subreddit): Promise<number> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT last_post_utc FROM ingest_state WHERE subreddit = $1`,
    [subreddit],
  )) as { last_post_utc: string }[];
  return rows[0] ? Number(rows[0].last_post_utc) : 0;
}

export async function setCursor(subreddit: Subreddit, utc: number): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO ingest_state (subreddit, last_post_utc)
     VALUES ($1, $2)
     ON CONFLICT (subreddit) DO UPDATE SET last_post_utc = GREATEST(ingest_state.last_post_utc, EXCLUDED.last_post_utc), updated_at = now()`,
    [subreddit, utc],
  );
}

/**
 * Days already fetched for a subreddit, as a set of YYYY-MM-DD strings.
 *
 * Two cheaper schemes were tried and both were wrong. A forward-only cursor
 * marks all history covered after a short run. MIN/MAX over `posts` assumes the
 * fetched range is contiguous, so an interrupt mid-range leaves a hole that
 * reads back as "covered" — and interrupting a resumable job is the normal
 * case, not an edge case. An explicit ledger is the only version that survives
 * both, and it also tells a genuinely quiet day apart from an unfetched one.
 */
export async function getFetchedDays(
  subreddit: Subreddit,
): Promise<Set<string>> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT day FROM fetched_days WHERE subreddit = $1`,
    [subreddit],
  )) as { day: unknown }[];
  return new Set(rows.map((r) => toIsoDate(r.day)));
}

// ─── Batch group mapping ─────────────────────────────────────────────────────

/**
 * Persist which posts each Batch API request covers, so a submitted batch can
 * be collected by a later process. Written immediately after submission — if
 * this is missing, the batch still runs and still bills, but its results can
 * never be attributed to posts.
 */
export async function saveBatchGroups(
  batchId: string,
  groups: { customId: string; postIds: string[] }[],
): Promise<void> {
  if (groups.length === 0) return;
  const sql = getDb();

  for (let i = 0; i < groups.length; i += 200) {
    const chunk = groups.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((g, j) => {
      const b = j * 3;
      values.push(batchId, g.customId, g.postIds);
      return `($${b + 1},$${b + 2},$${b + 3})`;
    });
    await sql.query(
      `INSERT INTO batch_groups (batch_id, custom_id, post_ids)
       VALUES ${tuples.join(",")}
       ON CONFLICT (batch_id, custom_id) DO NOTHING`,
      values,
    );
  }
}

/** Batch ids that were submitted but never fully collected. */
export async function getPendingBatchIds(): Promise<string[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT DISTINCT batch_id FROM batch_groups WHERE applied = false ORDER BY batch_id`,
  )) as { batch_id: string }[];
  return rows.map((r) => r.batch_id);
}

export async function getBatchGroups(
  batchId: string,
): Promise<Map<string, string[]>> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT custom_id, post_ids FROM batch_groups WHERE batch_id = $1`,
    [batchId],
  )) as { custom_id: string; post_ids: string[] }[];
  return new Map(rows.map((r) => [r.custom_id, r.post_ids]));
}

export async function markBatchApplied(
  batchId: string,
  customIds?: string[],
): Promise<void> {
  const sql = getDb();
  if (customIds && customIds.length > 0) {
    await sql.query(
      `UPDATE batch_groups SET applied = true WHERE batch_id = $1 AND custom_id = ANY($2)`,
      [batchId, customIds],
    );
  } else {
    await sql.query(
      `UPDATE batch_groups SET applied = true WHERE batch_id = $1`,
      [batchId],
    );
  }
}

/** Load posts by id, preserving the given order. */
export async function getPostsByIds(ids: string[]): Promise<Post[]> {
  if (ids.length === 0) return [];
  const sql = getDb();
  const rows = (await sql.query(`SELECT * FROM posts WHERE id = ANY($1)`, [
    ids,
  ])) as Record<string, unknown>[];

  const byId = new Map(rows.map((r) => [String(r.id), rowToPost(r)]));
  return ids.map((id) => byId.get(id)).filter((p): p is Post => p !== undefined);
}

/** Record days as fetched. Counts are kept for spotting anomalous days later. */
export async function markDaysFetched(
  subreddit: Subreddit,
  days: { day: string; count: number }[],
): Promise<void> {
  if (days.length === 0) return;
  const sql = getDb();

  for (let i = 0; i < days.length; i += 200) {
    const chunk = days.slice(i, i + 200);
    const values: unknown[] = [];
    const tuples = chunk.map((d, j) => {
      const b = j * 3;
      values.push(subreddit, d.day, d.count);
      return `($${b + 1},$${b + 2},$${b + 3})`;
    });
    await sql.query(
      `INSERT INTO fetched_days (subreddit, day, post_count)
       VALUES ${tuples.join(",")}
       ON CONFLICT (subreddit, day) DO UPDATE SET
         post_count = EXCLUDED.post_count,
         fetched_at = now()`,
      values,
    );
  }
}

// ─── Selection for extraction ────────────────────────────────────────────────

/**
 * Top N posts per (week, subreddit) that have no extraction yet, ranked by
 * engagement. This is the backfill's sampling rule: low-engagement posts in
 * these subs are overwhelmingly one-line drink questions, so ranking by
 * score + 2*comments concentrates spend on posts that carry an opinion.
 */
export async function selectUnextractedTopPerWeek(
  perWeekPerSub: number,
  limit?: number,
): Promise<Post[]> {
  const sql = getDb();
  // Rank over ALL posts, then drop the already-tagged ones. Ranking only the
  // untagged set would re-number the survivors on every run, so each resume
  // would dig a fresh N deeper into the tail instead of finishing the same N.
  const rows = (await sql.query(
    `SELECT * FROM (
       SELECT p.*, e.post_id AS extracted_id, ROW_NUMBER() OVER (
         PARTITION BY p.week_start, p.subreddit
         ORDER BY (p.score + 2 * p.num_comments) DESC, p.id
       ) AS rn
       FROM posts p
       LEFT JOIN extractions e ON e.post_id = p.id
     ) ranked
     WHERE rn <= $1 AND extracted_id IS NULL
     ORDER BY week_start DESC, rn
     ${limit ? "LIMIT " + Number(limit) : ""}`,
    [perWeekPerSub],
  )) as Record<string, unknown>[];

  return rows.map(rowToPost);
}

export async function selectUnextractedByIds(ids: string[]): Promise<Post[]> {
  if (ids.length === 0) return [];
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT p.* FROM posts p
     LEFT JOIN extractions e ON e.post_id = p.id
     WHERE e.post_id IS NULL AND p.id = ANY($1)`,
    [ids],
  )) as Record<string, unknown>[];
  return rows.map(rowToPost);
}

function rowToPost(r: Record<string, unknown>): Post {
  return {
    id: String(r.id),
    subreddit: String(r.subreddit) as Subreddit,
    createdUtc: Number(r.created_utc),
    title: String(r.title ?? ""),
    selftext: String(r.selftext ?? ""),
    score: Number(r.score ?? 0),
    numComments: Number(r.num_comments ?? 0),
    permalink: String(r.permalink),
    linkFlairText: (r.link_flair_text as string) ?? null,
    source: String(r.source) as "reddit" | "arctic",
  };
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

/**
 * Recompute weekly_aggregates from extractions. Deterministic SQL, no model
 * involved — this is what makes the tab 3 refresh button cheap.
 */
export async function recomputeAggregates(sinceWeek?: string): Promise<number> {
  const sql = getDb();
  const filter = sinceWeek ? `WHERE p.week_start >= $1` : "";
  const params = sinceWeek ? [sinceWeek] : [];

  // Per-subreddit rows.
  await sql.query(
    `INSERT INTO weekly_aggregates (week_start, subreddit, category, avg_sentiment, post_count, top_themes, computed_at)
     SELECT p.week_start,
            p.subreddit,
            e.category,
            AVG(e.sentiment)::real,
            COUNT(*)::int,
            COALESCE((
              SELECT jsonb_agg(t ORDER BY (t->>'count')::int DESC)
              FROM (
                SELECT jsonb_build_object('theme', theme, 'count', COUNT(*)) AS t
                FROM posts p2
                JOIN extractions e2 ON e2.post_id = p2.id
                CROSS JOIN LATERAL unnest(e2.themes) AS theme
                WHERE p2.week_start = p.week_start
                  AND p2.subreddit = p.subreddit
                  AND e2.category = e.category
                GROUP BY theme
                ORDER BY COUNT(*) DESC
                LIMIT 12
              ) s
            ), '[]'::jsonb),
            now()
     FROM posts p
     JOIN extractions e ON e.post_id = p.id
     ${filter}
     GROUP BY p.week_start, p.subreddit, e.category
     ON CONFLICT (week_start, subreddit, category) DO UPDATE SET
       avg_sentiment = EXCLUDED.avg_sentiment,
       post_count = EXCLUDED.post_count,
       top_themes = EXCLUDED.top_themes,
       computed_at = now()`,
    params,
  );

  // Combined "all" rows, which is what the charts and reports read.
  const res = (await sql.query(
    `INSERT INTO weekly_aggregates (week_start, subreddit, category, avg_sentiment, post_count, top_themes, computed_at)
     SELECT p.week_start,
            'all',
            e.category,
            AVG(e.sentiment)::real,
            COUNT(*)::int,
            COALESCE((
              SELECT jsonb_agg(t ORDER BY (t->>'count')::int DESC)
              FROM (
                SELECT jsonb_build_object('theme', theme, 'count', COUNT(*)) AS t
                FROM posts p2
                JOIN extractions e2 ON e2.post_id = p2.id
                CROSS JOIN LATERAL unnest(e2.themes) AS theme
                WHERE p2.week_start = p.week_start AND e2.category = e.category
                GROUP BY theme
                ORDER BY COUNT(*) DESC
                LIMIT 12
              ) s
            ), '[]'::jsonb),
            now()
     FROM posts p
     JOIN extractions e ON e.post_id = p.id
     ${filter}
     GROUP BY p.week_start, e.category
     ON CONFLICT (week_start, subreddit, category) DO UPDATE SET
       avg_sentiment = EXCLUDED.avg_sentiment,
       post_count = EXCLUDED.post_count,
       top_themes = EXCLUDED.top_themes,
       computed_at = now()
     RETURNING week_start`,
    params,
  )) as { week_start: string }[];

  return res.length;
}

export async function getAggregates(
  weekStartDate: string,
  subreddit: string = "all",
): Promise<WeeklyAggregate[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT * FROM weekly_aggregates WHERE week_start = $1 AND subreddit = $2`,
    [weekStartDate, subreddit],
  )) as Record<string, unknown>[];
  return rows.map(rowToAggregate);
}

export async function getAllAggregates(
  subreddit: string = "all",
): Promise<WeeklyAggregate[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT * FROM weekly_aggregates WHERE subreddit = $1 ORDER BY week_start ASC, category`,
    [subreddit],
  )) as Record<string, unknown>[];
  return rows.map(rowToAggregate);
}

function rowToAggregate(r: Record<string, unknown>): WeeklyAggregate {
  return {
    weekStart: toIsoDate(r.week_start),
    subreddit: String(r.subreddit) as WeeklyAggregate["subreddit"],
    category: String(r.category) as Category,
    avgSentiment: Number(r.avg_sentiment),
    postCount: Number(r.post_count),
    topThemes: (r.top_themes as { theme: string; count: number }[]) ?? [],
  };
}

// ─── Week samples for synthesis ──────────────────────────────────────────────

/**
 * The posts the synthesis model actually reads. Spread across categories and
 * across the sentiment range, so a week of loud complaints cannot crowd out
 * the positive signal entirely.
 */
export async function getWeekSamples(
  week: string,
  perCategory = 12,
): Promise<WeekSample[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT * FROM (
       SELECT p.permalink, p.subreddit, p.title, p.score,
              e.summary, e.sentiment, e.category, e.themes, e.pain_points,
              ROW_NUMBER() OVER (
                PARTITION BY e.category
                ORDER BY (p.score + 2 * p.num_comments) DESC
              ) AS rn
       FROM posts p
       JOIN extractions e ON e.post_id = p.id
       WHERE p.week_start = $1
     ) ranked
     WHERE rn <= $2
     ORDER BY category, rn`,
    [week, perCategory],
  )) as Record<string, unknown>[];

  return rows.map((r) => ({
    permalink: String(r.permalink),
    subreddit: String(r.subreddit),
    title: String(r.title),
    summary: String(r.summary ?? ""),
    sentiment: Number(r.sentiment),
    category: String(r.category),
    themes: (r.themes as string[]) ?? [],
    painPoints: (r.pain_points as string[]) ?? [],
    score: Number(r.score),
  }));
}

export async function getWeekStats(
  week: string,
): Promise<{ postCount: number; avgSentiment: number | null }> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT COUNT(*)::int AS n, AVG(e.sentiment)::real AS s
     FROM posts p JOIN extractions e ON e.post_id = p.id
     WHERE p.week_start = $1`,
    [week],
  )) as { n: number; s: number | null }[];
  return { postCount: rows[0]?.n ?? 0, avgSentiment: rows[0]?.s ?? null };
}

/** Weeks that have extractions but no written report yet, newest first. */
export async function getWeeksNeedingReports(limit: number): Promise<string[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT DISTINCT p.week_start
     FROM posts p
     JOIN extractions e ON e.post_id = p.id
     LEFT JOIN weekly_reports r ON r.week_start = p.week_start
     WHERE r.week_start IS NULL
     ORDER BY p.week_start DESC
     LIMIT $1`,
    [limit],
  )) as { week_start: string }[];
  return rows.map((r) => toIsoDate(r.week_start));
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export async function saveReport(r: WeeklyReport, model: string): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO weekly_reports
       (week_start, week_end, whats_working, whats_not_working, suggestions,
        post_count, avg_sentiment, is_backfilled, model, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (week_start) DO UPDATE SET
       week_end = EXCLUDED.week_end,
       whats_working = EXCLUDED.whats_working,
       whats_not_working = EXCLUDED.whats_not_working,
       suggestions = EXCLUDED.suggestions,
       post_count = EXCLUDED.post_count,
       avg_sentiment = EXCLUDED.avg_sentiment,
       is_backfilled = EXCLUDED.is_backfilled,
       model = EXCLUDED.model,
       generated_at = now()`,
    [
      r.weekStart,
      r.weekEnd,
      JSON.stringify(r.whatsWorking),
      JSON.stringify(r.whatsNotWorking),
      JSON.stringify(r.suggestions),
      r.postCount,
      r.avgSentiment,
      r.isBackfilled,
      model,
    ],
  );
}

/** Blog-feed page: newest first, optionally starting before a given week. */
export async function listReports(
  limit: number,
  before?: string,
): Promise<WeeklyReport[]> {
  const sql = getDb();
  const rows = (await sql.query(
    before
      ? `SELECT * FROM weekly_reports WHERE week_start < $2 ORDER BY week_start DESC LIMIT $1`
      : `SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT $1`,
    before ? [limit, before] : [limit],
  )) as Record<string, unknown>[];

  return rows.map((r) => ({
    weekStart: toIsoDate(r.week_start),
    weekEnd: toIsoDate(r.week_end),
    whatsWorking: (r.whats_working as WeeklyReport["whatsWorking"]) ?? [],
    whatsNotWorking: (r.whats_not_working as WeeklyReport["whatsNotWorking"]) ?? [],
    suggestions: (r.suggestions as WeeklyReport["suggestions"]) ?? [],
    postCount: Number(r.post_count ?? 0),
    avgSentiment: r.avg_sentiment === null ? null : Number(r.avg_sentiment),
    isBackfilled: Boolean(r.is_backfilled),
    generatedAt: new Date(String(r.generated_at)).toISOString(),
  }));
}

// ─── Insight snapshots ───────────────────────────────────────────────────────

export async function saveSnapshot(
  narrative: string,
  weeksCovered: number,
  isBaseline: boolean,
): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO insight_snapshots (narrative, weeks_covered, is_baseline) VALUES ($1,$2,$3)`,
    [narrative, weeksCovered, isBaseline],
  );
}

export async function getLatestSnapshot(): Promise<{
  narrative: string;
  generatedAt: string;
  weeksCovered: number;
} | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT narrative, generated_at, weeks_covered FROM insight_snapshots ORDER BY generated_at DESC LIMIT 1`,
  )) as Record<string, unknown>[];
  if (!rows[0]) return null;
  return {
    narrative: String(rows[0].narrative),
    generatedAt: new Date(String(rows[0].generated_at)).toISOString(),
    weeksCovered: Number(rows[0].weeks_covered ?? 0),
  };
}

// ─── Q&A retrieval ───────────────────────────────────────────────────────────

/**
 * Words too common in this corpus to narrow anything, plus ordinary English
 * stopwords Postgres keeps in a `|` query. "starbucks" and "barista" match
 * nearly every post here, so leaving them in dilutes the ranking.
 */
const NOISE_TERMS = new Set([
  "what", "whats", "which", "where", "when", "who", "why", "how", "does", "did",
  "are", "is", "was", "were", "the", "and", "for", "with", "about", "from",
  "this", "that", "they", "them", "their", "there", "here", "have", "has", "had",
  "been", "being", "you", "your", "our", "most", "more", "much", "many", "any",
  "get", "getting", "got", "can", "will", "would", "should", "could", "just",
  "like", "really", "going", "people", "think", "know", "say", "said", "tell",
  "starbucks", "barista", "baristas", "sub", "subreddit", "post", "posts",
]);

/** Significant search terms from a natural-language question. */
function queryTerms(question: string): string[] {
  const seen = new Set<string>();
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NOISE_TERMS.has(w))
    .filter((w) => (seen.has(w) ? false : (seen.add(w), true)))
    .slice(0, 12);
}

/**
 * Full-text retrieval over the corpus, ranked by relevance with a mild
 * engagement boost so a well-discussed thread outranks a passing mention.
 *
 * Two passes. `websearch_to_tsquery` ANDs every term, which is precise but
 * answers almost nothing asked in a full sentence — "what are baristas
 * complaining about, is understaffing getting worse" demanded all five stems in
 * one post and returned 2 results from a corpus of thousands. So the strict
 * pass runs first for precision, then an OR pass fills the remaining slots,
 * with `ts_rank` naturally floating posts that match more of the question.
 */
export async function searchPosts(
  question: string,
  limit = 40,
): Promise<RetrievedPost[]> {
  const sql = getDb();
  const toRetrieved = (r: Record<string, unknown>): RetrievedPost => ({
    ...rowToPost(r),
    summary: (r.summary as string) ?? null,
    sentiment:
      r.sentiment === null || r.sentiment === undefined ? null : Number(r.sentiment),
    category: (r.category as string) ?? null,
  });

  const strict = (await sql.query(
    `SELECT p.*, e.summary, e.sentiment, e.category,
            ts_rank(p.search_tsv, websearch_to_tsquery('english', $1)) AS rank
     FROM posts p
     LEFT JOIN extractions e ON e.post_id = p.id
     WHERE p.search_tsv @@ websearch_to_tsquery('english', $1)
     ORDER BY rank DESC, (p.score + 2 * p.num_comments) DESC
     LIMIT $2`,
    [question, limit],
  )) as Record<string, unknown>[];

  const out = strict.map(toRetrieved);
  if (out.length >= limit) return out;

  const terms = queryTerms(question);
  if (terms.length === 0) return out;

  const seen = new Set(out.map((p) => p.id));
  const loose = (await sql.query(
    `SELECT p.*, e.summary, e.sentiment, e.category,
            ts_rank(p.search_tsv, to_tsquery('english', $1)) AS rank
     FROM posts p
     LEFT JOIN extractions e ON e.post_id = p.id
     WHERE p.search_tsv @@ to_tsquery('english', $1)
       AND NOT (p.id = ANY($3))
     ORDER BY rank DESC, (p.score + 2 * p.num_comments) DESC
     LIMIT $2`,
    [terms.join(" | "), limit - out.length, [...seen]],
  )) as Record<string, unknown>[];

  return out.concat(loose.map(toRetrieved));
}

export async function saveQA(
  question: string,
  answer: string,
  citations: unknown[],
  clientIp?: string,
): Promise<void> {
  const sql = getDb();
  await sql.query(
    `INSERT INTO qa_history (question, answer, citations, client_ip) VALUES ($1,$2,$3,$4)`,
    [question, answer, JSON.stringify(citations), clientIp ?? null],
  );
}

export { weekStart, addDays, toIsoDate };
