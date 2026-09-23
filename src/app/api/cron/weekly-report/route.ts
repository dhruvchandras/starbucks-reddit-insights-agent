import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { addDays, weekStart } from "@/lib/db";
import { generateWeeklyReport } from "@/lib/report";

export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Runs Mondays. Reports on the week that just ended (last Monday through
 * Sunday), not the partial week in progress.
 *
 * `?week=YYYY-MM-DD` overrides the target, which is how the "generate now"
 * button in tab 2 asks for the current partial week.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const override = searchParams.get("week");

  if (override && !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
    return NextResponse.json(
      { error: "`week` must be YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const target = override ?? addDays(weekStart(new Date()), -7);
  const started = Date.now();

  try {
    const report = await generateWeeklyReport(target, { isBackfilled: false });

    if (!report) {
      return NextResponse.json({
        ok: false,
        week: target,
        reason:
          "No extracted posts for that week. The daily ingest may not have run yet, or the week is outside the ingested range.",
      });
    }

    return NextResponse.json({
      ok: true,
      week: target,
      postCount: report.postCount,
      avgSentiment: report.avgSentiment,
      working: report.whatsWorking.length,
      notWorking: report.whatsNotWorking.length,
      suggestions: report.suggestions.length,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error("[cron/weekly-report] Anthropic", err.status, err.message);
      return NextResponse.json(
        { error: `Anthropic API error ${err.status}: ${err.message}`, week: target },
        { status: 502 },
      );
    }
    console.error("[cron/weekly-report]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Unknown error.",
        week: target,
      },
      { status: 500 },
    );
  }
}
