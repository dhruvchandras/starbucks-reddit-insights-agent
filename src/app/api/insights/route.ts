import { NextResponse } from "next/server";
import { getAllAggregates, getLatestSnapshot } from "@/lib/store";
import { CATEGORIES } from "@/types";
import type { Category } from "@/types";

export const maxDuration = 60;

/** Read-only view for tab 3. The refresh button hits /api/insights/refresh. */
export async function GET() {
  try {
    const [aggregates, snapshot] = await Promise.all([
      getAllAggregates("all"),
      getLatestSnapshot(),
    ]);

    // Pivot to one row per week, one column per category, for the chart.
    const byWeek = new Map<string, Record<string, number | string>>();
    for (const a of aggregates) {
      const row = byWeek.get(a.weekStart) ?? { week: a.weekStart, total: 0 };
      row[a.category] = Number(a.avgSentiment.toFixed(3));
      row[`${a.category}_n`] = a.postCount;
      row.total = Number(row.total ?? 0) + a.postCount;
      byWeek.set(a.weekStart, row);
    }
    const series = [...byWeek.values()].sort((a, b) =>
      String(a.week).localeCompare(String(b.week)),
    );

    // Theme movement: last 4 weeks vs the 8 before, on the combined feed.
    const weeks = series.map((r) => String(r.week));
    const recentWeeks = new Set(weeks.slice(-4));
    const priorWeeks = new Set(weeks.slice(-12, -4));

    const recent = new Map<string, number>();
    const prior = new Map<string, number>();
    for (const a of aggregates) {
      const target = recentWeeks.has(a.weekStart)
        ? recent
        : priorWeeks.has(a.weekStart)
          ? prior
          : null;
      if (!target) continue;
      for (const t of a.topThemes) {
        target.set(t.theme, (target.get(t.theme) ?? 0) + t.count);
      }
    }

    const themeMovement = [...new Set([...recent.keys(), ...prior.keys()])]
      .map((theme) => {
        const now = recent.get(theme) ?? 0;
        const then = prior.get(theme) ?? 0;
        // Prior window is 8 weeks vs 4, so halve it to compare like with like.
        const thenRate = then / 2;
        return { theme, recent: now, prior: Math.round(thenRate), delta: now - thenRate };
      })
      .filter((t) => t.recent + t.prior >= 3)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 16);

    const categoryTotals = (CATEGORIES as readonly Category[]).map((c) => {
      const rows = aggregates.filter((a) => a.category === c);
      const n = rows.reduce((s, r) => s + r.postCount, 0);
      const weighted = rows.reduce((s, r) => s + r.avgSentiment * r.postCount, 0);
      return { category: c, postCount: n, avgSentiment: n ? weighted / n : 0 };
    });

    return NextResponse.json({
      series,
      themeMovement,
      categoryTotals,
      weekCount: series.length,
      narrative: snapshot?.narrative ?? null,
      narrativeGeneratedAt: snapshot?.generatedAt ?? null,
    });
  } catch (err) {
    console.error("[api/insights]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 },
    );
  }
}
