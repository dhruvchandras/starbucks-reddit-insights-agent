/**
 * Cheap sanity probe. Pulls real posts from Arctic Shift, tags them, prints the
 * result for eyeballing, and checks that prompt caching is actually working.
 * Needs only ANTHROPIC_API_KEY — no database.
 *
 *   npm run probe                    20 posts from r/starbucksbaristas
 *   npm run probe -- --sub starbucks --day 2026-09-15 --n 20
 */
import { config } from "dotenv";
import { fetchDay } from "../src/lib/arctic";
import { EXTRACT_MODEL, extractBatch } from "../src/lib/claude";
import type { Subreddit } from "../src/types";

config({ path: ".env.local" });

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY in .env.local");
    process.exit(1);
  }

  const sub = arg("--sub", "starbucksbaristas") as Subreddit;
  const day = arg("--day", new Date(Date.now() - 8 * 86400_000).toISOString().slice(0, 10));
  const n = Number(arg("--n", "20"));

  console.log(`Fetching r/${sub} for ${day}…`);
  const all = await fetchDay(sub, day);
  if (all.length === 0) {
    console.error("No posts returned. Try a different --day.");
    process.exit(1);
  }

  const posts = all
    .sort((a, b) => b.score + 2 * b.numComments - (a.score + 2 * a.numComments))
    .slice(0, n);

  console.log(`Tagging ${posts.length} posts with ${EXTRACT_MODEL}…\n`);

  const first = await extractBatch(posts);

  const byId = new Map(posts.map((p) => [p.id, p]));
  for (const e of first.extractions) {
    const p = byId.get(e.postId);
    const bar =
      e.sentiment > 0.15 ? "▲" : e.sentiment < -0.15 ? "▼" : "•";
    console.log(
      `${bar} ${e.sentiment.toFixed(2).padStart(5)}  ${e.category.padEnd(24)} ${p?.title.slice(0, 68)}`,
    );
    console.log(`         ${e.summary}`);
    console.log(
      `         themes: ${e.themes.join(", ") || "—"}${e.painPoints.length ? "  |  pain: " + e.painPoints.join("; ") : ""}`,
    );
    console.log(`         ${p?.permalink}\n`);
  }

  const missing = posts.length - first.extractions.length;
  console.log("─".repeat(76));
  console.log(
    `Coverage: ${first.extractions.length}/${posts.length} posts tagged${missing ? ` (${missing} MISSING)` : ""}`,
  );

  const dist = first.extractions.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});
  console.log("Category mix:", dist);

  const sentiments = first.extractions.map((e) => e.sentiment);
  const mean = sentiments.reduce((a, b) => a + b, 0) / (sentiments.length || 1);
  console.log(
    `Sentiment: mean ${mean.toFixed(2)}, range ${Math.min(...sentiments).toFixed(2)} to ${Math.max(...sentiments).toFixed(2)}`,
  );
  console.log(
    `Call 1 usage: ${first.usage.input} in / ${first.usage.output} out / cache write ${first.usage.cacheCreate} / cache read ${first.usage.cacheRead}`,
  );

  // Measured per-post rates — these drive the backfill's cost estimate.
  const perPost = {
    input: first.usage.input / first.extractions.length,
    output: first.usage.output / first.extractions.length,
  };
  console.log(
    `Per post: ~${perPost.input.toFixed(0)} input / ~${perPost.output.toFixed(0)} output tokens`,
  );

  const estimate = (n: number, batched: boolean) => {
    const raw = (perPost.input * n * 1.0 + perPost.output * n * 5.0) / 1_000_000;
    return batched ? raw / 2 : raw;
  };
  console.log(
    `Projected 19,000-post backfill: ~$${estimate(19_000, true).toFixed(2)} via the Batch API (~$${estimate(19_000, false).toFixed(2)} without).`,
  );

  console.log("\nChecking prompt caching…");
  const second = await extractBatch(posts.slice(0, 5));
  console.log(
    `Call 2 usage: ${second.usage.input} in / ${second.usage.output} out / cache read ${second.usage.cacheRead}`,
  );

  if (second.usage.cacheRead > 0) {
    console.log(
      `✓ Cache active — ${second.usage.cacheRead} tokens served at 10% cost.`,
    );
  } else {
    console.log(
      "· No cache entry, as expected: the rubric is ~700 tokens and Haiku 4.5\n" +
        "  needs a 4096-token prefix before it will cache anything. The figures\n" +
        "  above already assume no caching, so the estimate stands.",
    );
  }
}

main().catch((err) => {
  console.error("\nProbe failed:", err);
  process.exit(1);
});
