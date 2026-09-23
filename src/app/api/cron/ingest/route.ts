import { NextRequest, NextResponse } from "next/server";
import { extractBatch } from "@/lib/claude";
import { fetchComments, fetchDay } from "@/lib/arctic";
import { fetchNewPosts, fetchTopComments } from "@/lib/reddit";
import { addDays, weekStart } from "@/lib/db";
import {
  recomputeAggregates,
  selectUnextractedByIds,
  selectUnextractedTopPerWeek,
  setCursor,
  upsertComments,
  upsertExtractions,
  upsertPosts,
} from "@/lib/store";
import { SUBREDDITS } from "@/types";
import type { Post, PostComment, Subreddit } from "@/types";

export const maxDuration = 300;

const POSTS_PER_CALL = 20;
/** ~38 calls/week sequentially is ~420s; 8 at a time brings it to ~55s. */
const CONCURRENCY = 8;
/** Comment fetches are I/O-bound and independent, so run them wide. */
const COMMENT_CONCURRENCY = 6;
/** One extra day of overlap so a late-arriving post is never dropped. */
const LOOKBACK_DAYS = 8;
/** Comment enrichment is capped — it is the slowest part per post. */
const MAX_COMMENT_FETCHES = 80;
/** Headroom under Vercel's 300s cap so a slow run still persists its work. */
const TIME_BUDGET_MS = 260_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Arctic Shift runs under an hour behind live and needs no credentials, so it
 * is the primary source. Reddit's official API is the fallback, used only when
 * Arctic Shift fails outright AND credentials are configured.
 *
 * Fetching day by day is not incidental: `limit=auto` silently truncates on
 * multi-day windows (a week-long query returned 150 posts for a week that held
 * ~371), so a single week-wide request would quietly lose most of the corpus.
 */
async function fetchWeek(
  sub: Subreddit,
  days: string[],
): Promise<{ posts: Post[]; source: "arctic" | "reddit"; note?: string }> {
  const posts: Post[] = [];
  const failed: string[] = [];

  for (const day of days) {
    try {
      posts.push(...(await fetchDay(sub, day)));
    } catch {
      failed.push(day);
    }
  }

  if (failed.length < days.length) {
    return {
      posts,
      source: "arctic",
      note: failed.length ? `${failed.length} day(s) failed: ${failed.join(", ")}` : undefined,
    };
  }

  // Every day failed — Arctic Shift is down or blocking us.
  if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
    throw new Error(
      `Arctic Shift returned nothing for r/${sub} across all ${days.length} days, and no Reddit credentials are configured to fall back to. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to enable the fallback.`,
    );
  }

  const since = Math.floor(new Date(`${days[0]}T00:00:00Z`).getTime() / 1000);
  return { posts: await fetchNewPosts(sub, since), source: "reddit" };
}

async function fetchCommentsFor(
  post: Post,
  source: "arctic" | "reddit",
): Promise<PostComment[]> {
  return source === "arctic"
    ? fetchComments(post.id)
    : fetchTopComments(post.subreddit, post.id);
}

/** Tag groups with bounded concurrency, persisting each as it lands. */
async function tagGroups(
  groups: Post[][],
  commentsByPost: Map<string, PostComment[]>,
  deadline: number,
): Promise<{ tagged: number; usage: Record<string, number>; truncated: boolean }> {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let tagged = 0;
  let truncated = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      const i = cursor++;
      if (i >= groups.length) return;

      try {
        const res = await extractBatch(groups[i], commentsByPost);
        await upsertExtractions(res.extractions);
        tagged += res.extractions.length;
        usage.input += res.usage.input;
        usage.output += res.usage.output;
        usage.cacheRead += res.usage.cacheRead;
        usage.cacheCreate += res.usage.cacheCreate;
      } catch (err) {
        // One bad group must not sink the run — the sweep will retry it next week.
        console.warn(`[cron/ingest] group ${i} failed`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker),
  );
  return { tagged, usage, truncated };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Weekly ingest. Runs Mondays at 06:00 UTC, seven hours ahead of the report
 * cron so everything is tagged before synthesis reads it.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const result: Record<string, unknown> = { subreddits: {} };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const days = Array.from({ length: LOOKBACK_DAYS }, (_, i) =>
      addDays(today, -(LOOKBACK_DAYS - 1 - i)),
    );

    const allPosts: Post[] = [];
    const sources = new Map<Subreddit, "arctic" | "reddit">();

    for (const sub of SUBREDDITS) {
      const { posts, source, note } = await fetchWeek(sub, days);
      allPosts.push(...posts);
      sources.set(sub, source);
      (result.subreddits as Record<string, unknown>)[sub] = {
        fetched: posts.length,
        source,
        ...(note ? { note } : {}),
      };

      if (posts.length > 0) {
        await setCursor(sub, Math.max(...posts.map((p) => p.createdUtc)));
      }
    }

    result.window = `${days[0]} → ${days[days.length - 1]}`;

    if (allPosts.length > 0) {
      await upsertPosts(allPosts);
    }

    // Comments for posts with real discussion — where barista sentiment lives.
    const discussed = [...allPosts]
      .filter((p) => p.numComments >= 3)
      .sort((a, b) => b.numComments - a.numComments)
      .slice(0, MAX_COMMENT_FETCHES);

    const comments: PostComment[] = [];
    const byPost = new Map<string, PostComment[]>();

    // Fetched concurrently — done serially these alone cost ~55s of the budget.
    const commentDeadline = started + TIME_BUDGET_MS * 0.25;
    let commentCursor = 0;

    async function commentWorker(): Promise<void> {
      while (commentCursor < discussed.length && Date.now() < commentDeadline) {
        const p = discussed[commentCursor++];
        const c = await fetchCommentsFor(p, sources.get(p.subreddit) ?? "arctic");
        if (c.length > 0) {
          comments.push(...c);
          byPost.set(p.id, c);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(COMMENT_CONCURRENCY, discussed.length) }, commentWorker),
    );
    await upsertComments(comments);
    result.comments = comments.length;

    // Tag only what isn't tagged yet. The 8-day window overlaps the previous
    // run by a day, and a manual re-run would otherwise pay to redo the lot.
    const untagged = await selectUnextractedByIds(allPosts.map((p) => p.id));
    result.alreadyTagged = allPosts.length - untagged.length;

    const fresh = await tagGroups(chunk(untagged, POSTS_PER_CALL), byPost, deadline);

    // Self-healing sweep: anything from recent weeks that is still untagged,
    // whether from a failed group above or an earlier run that died mid-flight.
    // Without this, a crash between upsertPosts and tagging would orphan those
    // posts permanently — the cursor has already moved past them.
    const stragglers = (
      await selectUnextractedTopPerWeek(200)
    ).filter((p) => weekStart(p.createdUtc) >= addDays(today, -21));

    const swept = stragglers.length
      ? await tagGroups(chunk(stragglers, POSTS_PER_CALL), new Map(), deadline)
      : { tagged: 0, usage: {}, truncated: false };

    const weeks = [...new Set(allPosts.map((p) => weekStart(p.createdUtc)))].sort();
    if (weeks.length > 0) {
      await recomputeAggregates(weeks[0]);
    }

    return NextResponse.json({
      ...result,
      ok: true,
      posts: allPosts.length,
      tagged: fresh.tagged,
      sweptUntagged: swept.tagged,
      usage: fresh.usage,
      weeks,
      truncated: fresh.truncated || swept.truncated,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    console.error("[cron/ingest]", err);
    return NextResponse.json(
      {
        ...result,
        error: err instanceof Error ? err.message : "Unknown error.",
        elapsedMs: Date.now() - started,
      },
      { status: 500 },
    );
  }
}
