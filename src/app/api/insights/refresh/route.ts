import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { writeNarrative } from "@/lib/claude";
import { getAllAggregates, recomputeAggregates, saveSnapshot } from "@/lib/store";

export const maxDuration = 300;

/**
 * Tab 3's refresh button.
 *
 * This deliberately never re-ingests history. It recomputes aggregates from
 * stored extractions (pure SQL) and writes one narrative from them. The 3-year
 * baseline was built once by scripts/backfill.mjs; refreshing is seconds and
 * cents, not hours and dollars.
 */
export async function POST() {
  try {
    await recomputeAggregates();

    const aggregates = await getAllAggregates("all");
    if (aggregates.length === 0) {
      return NextResponse.json(
        {
          error:
            "No aggregates yet. Run `npm run backfill` to build the historical baseline first.",
        },
        { status: 409 },
      );
    }

    // Send the model a downsampled table — 156 weeks x 4 categories is a lot of
    // rows, and weekly granularity beyond ~80 weeks adds noise, not signal.
    const weeks = [...new Set(aggregates.map((a) => a.weekStart))].sort();
    const keep = new Set(
      weeks.length <= 80 ? weeks : weeks.filter((_, i) => i % 2 === 0 || i >= weeks.length - 26),
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
    await saveSnapshot(narrative, weeks.length, false);

    return NextResponse.json({
      ok: true,
      narrative,
      weeksCovered: weeks.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Rate limited by the Anthropic API. Try again shortly." },
        { status: 429 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Anthropic API error ${err.status}: ${err.message}` },
        { status: 502 },
      );
    }
    console.error("[api/insights/refresh]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 },
    );
  }
}
