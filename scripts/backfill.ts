/**
 * One-time historical backfill.
 *
 * Reddit's own API stops at roughly 1000 posts per subreddit, so the 3-year
 * baseline comes from Arctic Shift (the maintained public Pushshift successor).
 * At ~107 posts/day across both subs (measured across 2023-2026) that is ~117k
 * posts, far too much to tag in full, so we keep the top N per subreddit per
 * week by engagement.
 *
 * Coverage is tracked per-day in `fetched_days`, so widening --years backfills
 * the newly-exposed history and an interrupt mid-range resumes exactly at the
 * days it never reached — including holes in the middle.
 *
 * Runs locally, not on Vercel: it takes tens of minutes and Vercel functions
 * cap at 300s. Resumable — safe to Ctrl-C and re-run.
 *
 *   npm run backfill -- --dry-run          count what would be fetched
 *   npm run backfill -- --limit 200        tag only 200 posts (cost probe)
 *   npm run backfill -- --years 3          how far back to go (default 3)
 *   npm run backfill -- --per-week 60      posts per sub per week (default 60)
 *   npm run backfill -- --sync             skip the Batch API (2x cost, no wait)
 *   npm run backfill -- --skip-fetch       reuse posts already in the DB
 *   npm run backfill -- --back-issues 12   weekly reports to write (default 12)
 */
import "dotenv/config";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { fetchDay, sleep } from "../src/lib/arctic";
import {
  EXTRACT_MODEL,
  buildExtractionParams,
  extractBatch,
  getClient,
  parseExtractionText,
  writeNarrative,
} from "../src/lib/claude";
import { generateWeeklyReport } from "../src/lib/report";
import { getDb, addDays } from "../src/lib/db";
import { SCHEMA_STATEMENTS } from "../src/lib/schema";
import {
  getAllAggregates,
  getFetchedDays,
  markDaysFetched,
  getWeeksNeedingReports,
  recomputeAggregates,
  saveSnapshot,
  selectUnextractedTopPerWeek,
  upsertExtractions,
  upsertPosts,
} from "../src/lib/store";
import { SUBREDDITS } from "../src/types";
import type { Post, Subreddit } from "../src/types";

config({ path: ".env.local", override: true });

// Haiku 4.5 list price; batch requests bill at half. Used for the running
// cost readout only — not authoritative billing.
const PRICE_IN = 1.0 / 1_000_000;
const PRICE_OUT = 5.0 / 1_000_000;
const PRICE_CACHE_READ = 0.1 / 1_000_000;
const PRICE_CACHE_WRITE = 1.25 / 1_000_000;

const POSTS_PER_REQUEST = 20;

// Measured against real r/starbucksbaristas posts via scripts/probe.ts.
// The rubric is well below Haiku 4.5's 4096-token minimum cacheable prefix,
// so no caching discount is assumed anywhere in these estimates.
const TOKENS_IN_PER_POST = 260;
const TOKENS_OUT_PER_POST = 85;

interface Args {
  dryRun: boolean;
  limit: number | null;
  years: number;
  perWeek: number;
  sync: boolean;
  skipFetch: boolean;
  backIssues: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const val = (flag: string): string | null => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : null;
  };
  return {
    dryRun: a.includes("--dry-run"),
    limit: val("--limit") ? Number(val("--limit")) : null,
    years: Number(val("--years") ?? 3),
    perWeek: Number(val("--per-week") ?? 60),
    sync: a.includes("--sync"),
    skipFetch: a.includes("--skip-fetch"),
    backIssues: Number(val("--back-issues") ?? 12),
  };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

function costSoFar(batched: boolean): number {
  const raw =
    usage.input * PRICE_IN +
    usage.output * PRICE_OUT +
    usage.cacheRead * PRICE_CACHE_READ +
    usage.cacheCreate * PRICE_CACHE_WRITE;
  return batched ? raw / 2 : raw;
}

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${msg}\n`);
}

// ─── Phase 0: schema ─────────────────────────────────────────────────────────

async function ensureSchema(): Promise<void> {
  const sql = getDb();
  for (const stmt of SCHEMA_STATEMENTS) await sql.query(stmt);
  log("schema applied");
}

// ─── Phase 1: fetch metadata from Arctic Shift ───────────────────────────────

/**
 * Days are fetched in small concurrent waves. Arctic Shift documents roughly
 * 120k requests/hour (~33/s); a wave of 6 with a pause between waves runs at
 * ~3/s — well inside that, and it turns a ~70 minute serial crawl into ~12.
 *
 * Each wave records its days in `fetched_days` only after the posts are
 * persisted, so an interrupt can never mark a day covered whose posts were
 * lost. Resume is per-wave and handles holes anywhere in the range.
 */
const DAY_CONCURRENCY = 6;

async function fetchDays(sub: Subreddit, days: string[]): Promise<number> {
  let total = 0;

  for (let i = 0; i < days.length; i += DAY_CONCURRENCY) {
    const wave = days.slice(i, i + DAY_CONCURRENCY);

    const results = await Promise.all(
      wave.map(async (day) => {
        try {
          return { day, posts: await fetchDay(sub, day) };
        } catch (err) {
          log(`r/${sub} ${day}: FAILED (${(err as Error).message}) — will retry on the next run`);
          return null;
        }
      }),
    );

    const ok = results.filter((r): r is { day: string; posts: Post[] } => r !== null);
    const posts = ok.flatMap((r) => r.posts);
    total += posts.length;

    // Persist posts BEFORE marking the days fetched. The reverse order would
    // let an interrupt between the two writes strand a day as "covered" with
    // nothing behind it.
    if (posts.length > 0) await upsertPosts(posts);
    await markDaysFetched(
      sub,
      ok.map((r) => ({ day: r.day, count: r.posts.length })),
    );

    const processed = Math.min(i + DAY_CONCURRENCY, days.length);
    if (processed % 90 < DAY_CONCURRENCY || processed === days.length) {
      log(`r/${sub}: ${wave[wave.length - 1]} (${processed}/${days.length} days, ${total} posts)`);
    }

    await sleep(150);
  }

  return total;
}

async function fetchHistory(args: Args): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const start = addDays(today, -Math.round(args.years * 365));
  let total = 0;

  for (const sub of SUBREDDITS as readonly Subreddit[]) {
    const fetched = await getFetchedDays(sub);

    const missing: string[] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) {
      if (!fetched.has(d)) missing.push(d);
    }

    const requested = missing.length + [...fetched].filter((d) => d >= start && d <= today).length;
    if (missing.length === 0) {
      log(`r/${sub}: all ${requested} days in ${start} → ${today} already fetched`);
      continue;
    }
    log(
      `r/${sub}: ${missing.length} of ${requested} days missing (${missing[0]} → ${missing[missing.length - 1]})`,
    );

    total += await fetchDays(sub, missing);
    log(`r/${sub}: metadata complete`);
  }

  return total;
}

// ─── Phase 2: extraction ─────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function extractSync(groups: Post[][]): Promise<number> {
  let done = 0;
  for (const [i, group] of groups.entries()) {
    const res = await extractBatch(group);
    await upsertExtractions(res.extractions);
    done += res.extractions.length;

    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.cacheRead += res.usage.cacheRead;
    usage.cacheCreate += res.usage.cacheCreate;

    if (i % 10 === 0 || i === groups.length - 1) {
      log(
        `extract ${i + 1}/${groups.length} groups | ${done} posts | $${costSoFar(false).toFixed(2)}`,
      );
    }
  }
  return done;
}

async function extractViaBatch(groups: Post[][]): Promise<number> {
  const client = getClient();
  const byCustomId = new Map<string, Post[]>();

  const requests = groups.map((group, i) => {
    const id = `g${i}`;
    byCustomId.set(id, group);
    return { custom_id: id, params: buildExtractionParams(group) };
  });

  log(`submitting ${requests.length} batch requests (~${groups.flat().length} posts)`);

  // The Batches API caps at 100k requests / 256MB per batch.
  let done = 0;
  for (const slice of chunk(requests, 10_000)) {
    const batch = await client.messages.batches.create({
      requests: slice as never,
    });
    log(`batch ${batch.id} submitted; polling…`);

    let status = batch;
    while (status.processing_status !== "ended") {
      await sleep(20_000);
      status = await client.messages.batches.retrieve(batch.id);
      const c = status.request_counts;
      log(
        `  ${status.processing_status} | done ${c.succeeded}/${slice.length} | errored ${c.errored} | processing ${c.processing}`,
      );
    }

    for await (const entry of await client.messages.batches.results(batch.id)) {
      const posts = byCustomId.get(entry.custom_id);
      if (!posts) continue;

      if (entry.result.type !== "succeeded") {
        log(`  ${entry.custom_id}: ${entry.result.type} — skipped`);
        continue;
      }

      const msg = entry.result.message;
      usage.input += msg.usage.input_tokens;
      usage.output += msg.usage.output_tokens;
      usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
      usage.cacheCreate += msg.usage.cache_creation_input_tokens ?? 0;

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const extractions = parseExtractionText(text, posts);
      if (extractions.length === 0) {
        log(`  ${entry.custom_id}: unparseable output — skipped`);
        continue;
      }
      await upsertExtractions(extractions);
      done += extractions.length;
    }
    log(`batch ${batch.id} applied: ${done} posts | $${costSoFar(true).toFixed(2)}`);
  }

  return done;
}

// ─── Phase 4: back-issues + baseline narrative ───────────────────────────────

async function writeBackIssues(count: number): Promise<number> {
  const weeks = await getWeeksNeedingReports(count);
  let written = 0;

  for (const week of weeks) {
    try {
      const report = await generateWeeklyReport(week, {
        isBackfilled: true,
        recompute: false,
      });
      if (report) {
        written++;
        log(`back-issue ${week}: ${report.postCount} posts`);
      } else {
        log(`back-issue ${week}: no samples, skipped`);
      }
    } catch (err) {
      log(`back-issue ${week}: FAILED (${(err as Error).message})`);
    }
  }
  return written;
}

async function writeBaselineNarrative(): Promise<void> {
  const aggregates = await getAllAggregates("all");
  if (aggregates.length === 0) {
    log("no aggregates — skipping baseline narrative");
    return;
  }

  const weeks = [...new Set(aggregates.map((a) => a.weekStart))].sort();
  const keep = new Set(
    weeks.length <= 80
      ? weeks
      : weeks.filter((_, i) => i % 2 === 0 || i >= weeks.length - 26),
  );

  const rows = aggregates
    .filter((a) => keep.has(a.weekStart) && a.category !== "other")
    .map((a) => ({
      weekStart: a.weekStart,
      category: a.category,
      avgSentiment: a.avgSentiment,
      postCount: a.postCount,
      topThemes: a.topThemes,
    }));

  const narrative = await writeNarrative(rows);
  await saveSnapshot(narrative, weeks.length, true);
  log(`baseline narrative written (${weeks.length} weeks)`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  for (const key of ["DATABASE_URL", "ANTHROPIC_API_KEY"]) {
    if (!process.env[key]) {
      console.error(`Missing ${key}. Copy .env.local.example to .env.local and fill it in.`);
      process.exit(1);
    }
  }

  log(
    `backfill starting | years=${args.years} per-week=${args.perWeek} mode=${args.sync ? "sync" : "batch"}${args.dryRun ? " DRY-RUN" : ""}`,
  );

  await ensureSchema();

  if (!args.skipFetch) {
    log("── phase 1: fetching history from Arctic Shift ──");
    const fetched = await fetchHistory(args);
    log(`phase 1 complete: ${fetched} posts seen`);
  } else {
    log("phase 1 skipped (--skip-fetch)");
  }

  log("── phase 2: selecting posts to tag ──");
  const selected = await selectUnextractedTopPerWeek(
    args.perWeek,
    args.limit ?? undefined,
  );
  log(`${selected.length} posts selected (top ${args.perWeek}/week/sub, untagged)`);

  if (args.dryRun) {
    const groups = Math.ceil(selected.length / POSTS_PER_REQUEST);
    // Rates measured with scripts/probe.ts against real posts from these subs.
    const estIn = selected.length * TOKENS_IN_PER_POST;
    const estOut = selected.length * TOKENS_OUT_PER_POST;
    const est = (estIn * PRICE_IN + estOut * PRICE_OUT) / (args.sync ? 1 : 2);
    log(
      `DRY RUN: ${groups} requests, ~${estIn.toLocaleString()} input / ~${estOut.toLocaleString()} output tokens.`,
    );
    log(
      `Estimated cost: $${est.toFixed(2)} (${args.sync ? "sync" : "batch, 50% off"}). Run scripts/probe.ts to re-measure the per-post rates.`,
    );
    return;
  }

  if (selected.length > 0) {
    log(`── phase 3: tagging with ${EXTRACT_MODEL} ──`);
    const groups = chunk(selected, POSTS_PER_REQUEST);
    const tagged = args.sync
      ? await extractSync(groups)
      : await extractViaBatch(groups);
    log(
      `phase 3 complete: ${tagged} posts tagged | $${costSoFar(!args.sync).toFixed(2)}`,
    );
  } else {
    log("phase 3 skipped: nothing left to tag");
  }

  log("── phase 4: recomputing aggregates ──");
  await recomputeAggregates();
  log("aggregates recomputed");

  if (args.backIssues > 0) {
    log(`── phase 5: writing ${args.backIssues} back-issues ──`);
    const written = await writeBackIssues(args.backIssues);
    log(`phase 5 complete: ${written} reports written`);
  }

  log("── phase 6: baseline narrative ──");
  await writeBaselineNarrative();

  log(
    `DONE. Extraction cost this run: ~$${costSoFar(!args.sync).toFixed(2)} (${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out / ${usage.cacheRead.toLocaleString()} cached).`,
  );
}

main().catch((err) => {
  console.error("\nBackfill failed:", err);
  process.exit(1);
});
