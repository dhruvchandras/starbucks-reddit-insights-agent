import { NextRequest, NextResponse } from "next/server";
import { listReports } from "@/lib/store";

export const maxDuration = 30;

/** Blog feed page. `before` is a week_start; results are strictly older. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const before = searchParams.get("before") ?? undefined;
  const limit = Math.min(Number(searchParams.get("limit") ?? "8") || 8, 26);

  if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    return NextResponse.json(
      { error: "`before` must be a YYYY-MM-DD week start." },
      { status: 400 },
    );
  }

  try {
    // Fetch one extra to determine whether another page exists.
    const rows = await listReports(limit + 1, before);
    const hasMore = rows.length > limit;

    return NextResponse.json({
      reports: rows.slice(0, limit),
      hasMore,
      nextCursor: hasMore ? rows[limit - 1].weekStart : null,
    });
  } catch (err) {
    console.error("[api/reports]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 },
    );
  }
}
