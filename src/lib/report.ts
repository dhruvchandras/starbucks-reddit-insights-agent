import { addDays } from "./db";
import { SYNTH_MODEL, synthesizeWeek } from "./claude";
import {
  getAggregates,
  getWeekSamples,
  getWeekStats,
  recomputeAggregates,
  saveReport,
} from "./store";
import type { WeeklyReport } from "@/types";

/**
 * Generate and persist one week's report. Shared by the weekly cron and by the
 * backfill's back-issue pass so both produce identical output.
 */
export async function generateWeeklyReport(
  week: string,
  opts: { isBackfilled?: boolean; recompute?: boolean } = {},
): Promise<WeeklyReport | null> {
  if (opts.recompute !== false) {
    await recomputeAggregates(week);
  }

  const [aggregates, priorAggregates, samples, stats] = await Promise.all([
    getAggregates(week),
    getAggregates(addDays(week, -7)),
    getWeekSamples(week),
    getWeekStats(week),
  ]);

  if (samples.length === 0) {
    return null;
  }

  const synthesis = await synthesizeWeek({
    weekStart: week,
    weekEnd: addDays(week, 6),
    aggregates,
    priorAggregates,
    samples,
    isBackfilled: opts.isBackfilled ?? false,
  });

  const report: WeeklyReport = {
    weekStart: week,
    weekEnd: addDays(week, 6),
    whatsWorking: synthesis.whatsWorking,
    whatsNotWorking: synthesis.whatsNotWorking,
    suggestions: synthesis.suggestions,
    postCount: stats.postCount,
    avgSentiment: stats.avgSentiment,
    isBackfilled: opts.isBackfilled ?? false,
    generatedAt: new Date().toISOString(),
  };

  await saveReport(report, SYNTH_MODEL);
  return report;
}
