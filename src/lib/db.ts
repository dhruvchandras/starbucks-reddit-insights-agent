import { neon } from "@neondatabase/serverless";

/**
 * Vercel's Neon integration names the injected variable after whatever prefix
 * you chose when installing it, so accept the common spellings rather than
 * forcing one. Pooled connections are preferred — the HTTP driver opens a
 * connection per query, which exhausts a direct endpoint quickly.
 */
const URL_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "STORAGE_URL",
  "DATABASE_POSTGRES_URL",
  "NEON_DATABASE_URL",
] as const;

/**
 * Resolved at call time (not module load) so env vars are available in every
 * Vercel runtime and in the local backfill script.
 */
export function getDb() {
  const named = URL_KEYS.map((k) => process.env[k]).find(Boolean);

  // Last resort: any *_URL holding a postgres DSN, so an unexpected prefix
  // from the Vercel integration still works instead of failing opaquely.
  const discovered =
    named ??
    Object.entries(process.env).find(
      ([k, v]) => k.endsWith("_URL") && v?.startsWith("postgres"),
    )?.[1];

  if (!discovered) {
    throw new Error(
      `No database connection string found. Set DATABASE_URL (or one of: ${URL_KEYS.slice(1).join(", ")}).`,
    );
  }
  return neon(discovered);
}

/** Monday 00:00 UTC of the week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d * 1000) : new Date(d);
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay(): 0=Sun..6=Sat. Shift back to Monday.
  const dow = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - dow);
  return utc.toISOString().slice(0, 10);
}

/**
 * Normalize a Postgres DATE to YYYY-MM-DD.
 *
 * The Neon driver hands back a JS Date built at LOCAL midnight, so
 * `String(d)` yields "Mon Sep 21 2026 ..." and `toISOString()` shifts the
 * calendar day backwards for anyone east of UTC. Local getters are the only
 * reading that survives both — a Postgres DATE carries no timezone.
 */
export function toIsoDate(v: unknown): string {
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable date: ${s}`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
