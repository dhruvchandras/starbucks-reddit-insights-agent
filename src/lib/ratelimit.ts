import { NextRequest } from "next/server";
import { getDb } from "./db";

/**
 * Rate limiting for the two endpoints that spend Anthropic credits.
 *
 * The site is deliberately public and shareable, so the threat is not a
 * malicious user — it is a crawler, a hot-linked share, or someone holding down
 * the refresh button, any of which bills real money. Limits are set generously
 * enough that a human reading the site will never see one.
 *
 * Counters live in Postgres rather than memory because Vercel functions are
 * per-instance and an in-memory counter resets on every cold start, which makes
 * it useless exactly when traffic arrives.
 */

export interface Limit {
  bucket: string;
  /** Max requests allowed from a single IP in the window. */
  perIp: number;
  /** Max requests allowed from everyone combined, as an abuse backstop. */
  global: number;
  windowMinutes: number;
}

export const ASK_LIMIT: Limit = {
  bucket: "ask",
  perIp: 12,
  global: 150,
  windowMinutes: 60,
};

/**
 * Refresh is capped hard: it recomputes every aggregate and writes a fresh
 * Opus narrative, and the underlying data only changes once a week, so there is
 * no legitimate reason to run it often.
 */
export const REFRESH_LIMIT: Limit = {
  bucket: "refresh",
  perIp: 3,
  global: 12,
  windowMinutes: 60,
};

/** Best-effort client IP. Vercel sets x-forwarded-for at the edge. */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export interface RateResult {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

export async function checkRateLimit(
  limit: Limit,
  ip: string,
): Promise<RateResult> {
  const sql = getDb();

  try {
    const rows = (await sql.query(
      `SELECT
         COUNT(*) FILTER (WHERE client_ip = $2)::int AS mine,
         COUNT(*)::int AS total
       FROM rate_events
       WHERE bucket = $1 AND at > now() - ($3 || ' minutes')::interval`,
      [limit.bucket, ip, String(limit.windowMinutes)],
    )) as { mine: number; total: number }[];

    const mine = rows[0]?.mine ?? 0;
    const total = rows[0]?.total ?? 0;
    const retry = limit.windowMinutes * 60;

    if (mine >= limit.perIp) {
      return {
        ok: false,
        reason: `That's ${limit.perIp} requests in the last ${limit.windowMinutes} minutes from this address — the limit, since each one calls a paid model. Try again a bit later.`,
        retryAfterSeconds: retry,
      };
    }
    if (total >= limit.global) {
      return {
        ok: false,
        reason: `This tool is at its hourly cap across all visitors. Try again a bit later.`,
        retryAfterSeconds: retry,
      };
    }
    return { ok: true };
  } catch (err) {
    // A metering failure must not take the feature down. Log and allow.
    console.warn("[ratelimit] check failed, allowing request", err);
    return { ok: true };
  }
}

/** Record a request against the bucket. Call only when work is actually done. */
export async function recordRateEvent(bucket: string, ip: string): Promise<void> {
  try {
    const sql = getDb();
    await sql.query(
      `INSERT INTO rate_events (bucket, client_ip) VALUES ($1, $2)`,
      [bucket, ip],
    );
    // Opportunistic cleanup so the table cannot grow without bound.
    if (Math.random() < 0.02) {
      await sql.query(`DELETE FROM rate_events WHERE at < now() - interval '2 days'`);
    }
  } catch (err) {
    console.warn("[ratelimit] record failed", err);
  }
}
