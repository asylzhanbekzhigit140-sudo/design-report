/**
 * Telegram Mini App: статикалық бет + JSON API.
 * Әр сұраныс Telegram initData қолтаңбасымен тексеріледі (HMAC-SHA256, бот токені арқылы).
 * Дизайнер тек өз деректерін көреді; админ мен басшы — барлығын.
 */
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { q, one } from "../db/db.js";
import { weekRows, COUNTED, icon, fmtItems, type ReportRow } from "../services/reports.js";
import { subjectFor } from "../seed/catalog.js";
import { weekOf, weekFromMonday, weekRangeText } from "../time/week.js";

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 86400_000;

export type WebPerson = { id: number; name: string; role: string; yougile_id: string | null; is_admin: boolean; telegram_id: number };

/** Telegram WebApp initData тексеру. Дұрыс болса user.id қайтарады */
export function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): number | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc.length !== hash.length || !timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const auth = Number(params.get("auth_date") ?? 0);
  if (!auth || Date.now() / 1000 - auth > maxAgeSec) return null;
  try {
    return Number(JSON.parse(params.get("user") ?? "{}").id) || null;
  } catch {
    return null;
  }
}

const GROUPS: [string, string[]][] = [
  ["Пост", ["Пост"]],
  ["Карусель", ["Карусель"]],
  ["Обложка", ["YouTube обложка", "Обложка", "ҰБТ обложка"]],
  ["Басқа", ["Таргет баннер", "Баннер", "Раздатка", "Презентация"]],
];
const groups = (rows: ReportRow[]) => {
  const t: Record<string, number> = {};
  rows.filter((r) => COUNTED.has(r.status)).forEach((r) => Object.entries(r.items).forEach(([k, v]) => (t[k] = (t[k] ?? 0) + v)));
  return Object.fromEntries(GROUPS.map(([g, ks]) => [g, ks.reduce((a, k) => a + (t[k] ?? 0), 0)]));
};
const STATUS: Record<string, string> = {
  ok: "авто", corrected: "түзетілген", ask_designer: "сұрақта", no_files: "файлсыз", needs_review: "тексеру", skipped: "өткізілді",
};
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;

/** Кімнің деректерін көрсету: дизайнер — өзі; админ/басшы — сұралған дизайнер немесе барлығы (null) */
function scope(p: WebPerson, requested: string | null): string | null {
  const full = p.is_admin || p.role === "admin" || p.role === "viewer";
  if (!full) return p.yougile_id ?? "__none__";
  return requested || null;
}

export async function apiWeek(p: WebPerson, monday: string, designer: string | null) {
  const who = scope(p, designer);
  const rows = await weekRows(monday, who ?? undefined);
  const prev = await weekRows(weekOf(weekFromMonday(monday).startMs - 1).monday, who ?? undefined);
  const bySubj = new Map<string, Record<string, number>>();
  rows.filter((r) => COUNTED.has(r.status)).forEach((r) => {
    const s = subjectFor(r.trace.location ?? null).name;
    const e = bySubj.get(s) ?? {};
    Object.entries(r.items).forEach(([k, v]) => (e[k] = (e[k] ?? 0) + v));
    bySubj.set(s, e);
  });
  return {
    monday, range: weekRangeText(weekFromMonday(monday)),
    totals: groups(rows), prev: groups(prev),
    subjects: [...bySubj].map(([name, items]) => ({ name, icon: icon(name), text: fmtItems(items), total: Object.values(items).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total),
    tasks: rows.map((r) => ({
      title: r.trace.title, subject: subjectFor(r.trace.location ?? null).name, designer: r.designer,
      files: r.file_count, result: fmtItems(r.items) || "—", status: STATUS[r.status] ?? r.status,
      problem: ["ask_designer", "no_files", "needs_review"].includes(r.status), date: fmtDate(r.completed_at),
    })),
  };
}

export async function apiTrend(p: WebPerson, designer: string | null, weeks = 8) {
  const who = scope(p, designer);
  const out: Record<string, string | number>[] = [];
  let m = weekOf(Date.now()).startMs;
  const mondays: string[] = [];
  for (let i = 0; i < weeks; i++) {
    mondays.unshift(weekOf(m).monday);
    m -= 7 * DAY;
  }
  for (const monday of mondays) out.push({ monday, label: monday.slice(8, 10) + "." + monday.slice(5, 7), ...groups(await weekRows(monday, who ?? undefined)) });
  return out;
}

export async function apiOpen(p: WebPerson, designer: string | null) {
  const who = scope(p, designer);
  const rows = await q<any>(
    "SELECT * FROM open_tasks WHERE ($1::text IS NULL OR $1 = ANY(assigned)) ORDER BY deadline_at NULLS LAST, created_at_yg",
    [who],
  );
  const names = new Map((await q<any>("SELECT yougile_id, name FROM people WHERE role='designer'")).map((x) => [x.yougile_id, x.name]));
  return rows.map((o) => ({
    title: o.title,
    subject: subjectFor(o.project ? { project: o.project, board: o.board, column: o.column_name } : null).name,
    who: (o.assigned as string[]).map((id) => names.get(id)).filter(Boolean).join(", "),
    deadline: fmtDate(o.deadline_at),
    overdue: !!o.deadline_at && new Date(o.deadline_at).getTime() < Date.now(),
  }));
}

export function startWebServer(opts: { port: number; botToken: string; onExport?: (tg: number, monday: string) => Promise<void> }) {
  let page: string | null = null;
  const send = (res: http.ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        page ??= await readFile(join(here, "../../assets/webapp/index.html"), "utf8");
        return send(res, 200, page, "text/html; charset=utf-8");
      }
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

      const tg = verifyInitData(String(req.headers["x-init-data"] ?? ""), opts.botToken);
      if (!tg) return send(res, 401, { error: "Telegram арқылы ашыңыз" });
      const p = await one<WebPerson>("SELECT * FROM people WHERE telegram_id=$1 AND active", [tg]);
      if (!p) return send(res, 403, { error: "Сіз тіркелмегенсіз. Админнен сілтеме сұраңыз." });
      const full = p.is_admin || p.role === "admin" || p.role === "viewer";
      const designer = url.searchParams.get("designer");
      const monday = url.searchParams.get("monday")?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? weekOf(Date.now()).monday;

      switch (url.pathname) {
        case "/api/me": {
          const designers = full ? await q("SELECT yougile_id AS id, name FROM people WHERE role='designer' AND active ORDER BY name") : [];
          const weeks = await q("SELECT monday, label, status FROM weeks ORDER BY monday DESC LIMIT 12");
          return send(res, 200, { name: p.name, full, admin: p.is_admin || p.role === "admin", designers, weeks });
        }
        case "/api/week":
          return send(res, 200, await apiWeek(p, monday, designer));
        case "/api/trend":
          return send(res, 200, await apiTrend(p, designer));
        case "/api/open":
          return send(res, 200, await apiOpen(p, designer));
        case "/api/export":
          if (req.method !== "POST" || !(p.is_admin || p.role === "admin")) return send(res, 403, { error: "тек админ" });
          await opts.onExport?.(tg, monday);
          return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not found" });
    } catch (e: any) {
      console.error("web:", e);
      return send(res, 500, { error: "server error" });
    }
  });
  server.listen(opts.port, () => console.log(`Mini App сервері: :${opts.port}`));
  return server;
}
