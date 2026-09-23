/** Apply the schema directly (no dev server needed). Idempotent. */
import { config } from "dotenv";
import { getDb } from "../src/lib/db";
import { SCHEMA_STATEMENTS } from "../src/lib/schema";

config({ path: ".env.local" });

async function main(): Promise<void> {
  const sql = getDb();
  for (const stmt of SCHEMA_STATEMENTS) {
    await sql.query(stmt);
    console.log("  ok:", stmt.slice(0, 64).replace(/\s+/g, " "));
  }
  const tables = (await sql.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  )) as { table_name: string }[];
  console.log("\nTables:", tables.map((t) => t.table_name).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
