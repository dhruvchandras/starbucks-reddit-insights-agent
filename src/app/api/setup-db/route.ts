import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { SCHEMA_STATEMENTS } from "@/lib/schema";

export const maxDuration = 60;

/** Idempotent schema apply. Safe to re-run. */
export async function POST() {
  const sql = getDb();
  const applied: string[] = [];

  for (const stmt of SCHEMA_STATEMENTS) {
    await sql.query(stmt);
    applied.push(stmt.slice(0, 60).replace(/\s+/g, " ") + "...");
  }

  return NextResponse.json({ ok: true, statements: applied.length, applied });
}
