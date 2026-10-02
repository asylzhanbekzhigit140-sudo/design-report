import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// BIGINT (telegram_id, message_id) → number
pg.types.setTypeParser(20, (v) => Number(v));
// DATE → "YYYY-MM-DD" жолы күйінде (уақыт белдеуінсіз)
pg.types.setTypeParser(1082, (v) => v);

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) throw new Error("DB іске қосылмаған");
  return pool;
}

export async function connect(url: string) {
  pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: /localhost|127\.0\.0\.1|\/tmp|railway\.internal/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  const here = dirname(fileURLToPath(import.meta.url));
  await pool.query(await readFile(join(here, "schema.sql"), "utf8"));
  return pool;
}

export async function close() {
  await pool?.end();
  pool = null;
}

export const q = <T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) =>
  db().query<T>(sql, params).then((r) => r.rows);

export const one = async <T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) =>
  (await q<T>(sql, params))[0] as T | undefined;

export async function audit(actor: string, action: string, entity: string, data?: unknown) {
  await q("INSERT INTO audit_log (actor, action, entity, data) VALUES ($1,$2,$3,$4)", [actor, action, entity, data ?? null]);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await one<{ value: T }>("SELECT value FROM settings WHERE key=$1", [key]);
  return r ? r.value : fallback;
}
