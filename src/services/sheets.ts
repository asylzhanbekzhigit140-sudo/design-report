/**
 * Апталық есепті Google Sheets-ке жариялау: әр аптаға бір парақ, жиындар формуламен.
 * Ашық апталар әр синхронизациядан кейін (өзгеріс болса) жаңартылады.
 */
import { q, one } from "../db/db.js";
import { weekRows, COUNTED, fmtItems } from "./reports.js";
import { PAN, INSTA, OTHER_TYPES } from "./excel.js";
import { subjectFor, DESIGNERS } from "../seed/catalog.js";
import { weekFromMonday, weekRangeText } from "../time/week.js";
import { SheetsClient, parseServiceAccount } from "./google.js";

type Cell = string | number;
const col = (n: number) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const STATUS: Record<string, string> = {
  ok: "авто", corrected: "түзетілген", ask_designer: "сұрақта", no_files: "файлсыз", needs_review: "тексеру", skipped: "өткізілді",
};

export async function buildWeekGrid(monday: string) {
  const rows = await weekRows(monday);
  const w = await one<{ label: string; status: string }>("SELECT label, status FROM weeks WHERE monday=$1", [monday]);
  const label = w?.label ?? monday;
  const people = await q<{ excel_name: string }>("SELECT excel_name FROM people WHERE role='designer'");
  const order = DESIGNERS.map((d) => d.excelName).filter((n) => people.some((p) => p.excel_name === n));

  const sum = new Map<string, number>();
  const subjects: Record<string, Set<string>> = { "ПӘН АКК": new Set(PAN), "ИНСТА АКК": new Set(INSTA) };
  for (const r of rows.filter((x) => COUNTED.has(x.status))) {
    const s = subjectFor(r.trace.location ?? null);
    subjects[s.sheet]?.add(s.name);
    for (const [k, v] of Object.entries(r.items)) sum.set(`${r.excel_name}|${s.sheet}|${s.name}|${k}`, (sum.get(`${r.excel_name}|${s.sheet}|${s.name}|${k}`) ?? 0) + v);
  }
  const get = (n: string, sheet: string, subj: string, wt: string) => sum.get(`${n}|${sheet}|${subj}|${wt}`) ?? 0;
  const byType = (n: string, wt: string, onlyOther = false) =>
    [...sum].filter(([k]) => k.startsWith(`${n}|${onlyOther ? "ӨЗГЕ|" : ""}`) && k.endsWith(`|${wt}`)).reduce((a, [, v]) => a + v, 0);

  const values: Cell[][] = [];
  const bold: number[] = [];
  const now = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  values.push([`DESIGN · ${label} · ${weekRangeText(weekFromMonday(monday))}`, `${w?.status === "sent" ? "🔒 жабылған" : "🟢 тірі"} · жаңартылды ${now}`]);
  bold.push(0);
  values.push([]);

  const block = (title: string, cols: string[], val: (n: string, c: string) => number) => {
    values.push([title]);
    bold.push(values.length - 1);
    values.push(["ДИЗАЙНЕРЛЕР", ...cols, "БАРЛЫҒЫ"]);
    bold.push(values.length - 1);
    const first = values.length + 1; // 1-ге негізделген жол нөмірі
    for (const n of order) {
      const r = values.length + 1;
      values.push([n, ...cols.map((c) => val(n, c)), `=SUM(B${r}:${col(cols.length)}${r})`]);
    }
    const last = values.length;
    values.push(["ПӘН БОЙЫНША", ...[...cols, "x"].map((_, j) => `=SUM(${col(j + 1)}${first}:${col(j + 1)}${last})`)]);
    bold.push(values.length - 1);
    values.push([]);
  };

  for (const sheet of ["ПӘН АКК", "ИНСТА АКК"]) {
    const cols = [...subjects[sheet]];
    block(`${sheet} · ПОСТ`, cols, (n, c) => get(n, sheet, c, "Пост"));
    block(`${sheet} · КАРУСЕЛЬ`, cols, (n, c) => get(n, sheet, c, "Карусель"));
  }
  block("ӨЗГЕ ЖҰМЫСТАР", [...OTHER_TYPES, "Пост (өзге)", "Карусель (өзге)"], (n, c) =>
    c === "Пост (өзге)" ? byType(n, "Пост", true) : c === "Карусель (өзге)" ? byType(n, "Карусель", true) : byType(n, c),
  );

  values.push(["ТАПСЫРМАЛАР"]);
  bold.push(values.length - 1);
  values.push(["Күні", "Дизайнер", "Пән/акк", "Тапсырма", "Файл", "Нәтиже", "Статус", "Ескерту"]);
  bold.push(values.length - 1);
  for (const r of rows)
    values.push([
      new Date(r.completed_at).toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" }),
      r.excel_name, subjectFor(r.trace.location ?? null).name, r.trace.title, r.file_count, fmtItems(r.items) || "—",
      (STATUS[r.status] ?? r.status) + (r.manual ? " (қолмен)" : "") + (r.is_supplement ? " (қосымша)" : ""),
      [...r.reasons, ...r.warnings].join("; "),
    ]);

  const signature = `${rows.length}|${rows.map((r) => `${r.id}:${r.status}:${JSON.stringify(r.items)}`).join(",")}|${w?.status}`;
  const day = monday.split("-").reverse().slice(0, 2).join(".");
  return { title: `${label} · ${day}`.slice(0, 90), values, bold, signature };
}

// ---------- Жариялау ----------
let client: SheetsClient | null | undefined;
const published = new Map<string, string>(); // monday → signature

export function sheetsClient(): SheetsClient | null {
  if (client !== undefined) return client;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "";
  const id = process.env.GOOGLE_SHEET_ID ?? "";
  const sa = raw && id ? parseServiceAccount(raw) : null;
  client = sa ? new SheetsClient(sa, id, process.env.GOOGLE_SHEETS_BASE || undefined, process.env.GOOGLE_TOKEN_URL || undefined) : null;
  return client;
}
export const resetSheetsClient = () => ((client = undefined), published.clear());
export const sheetUrl = () => (process.env.GOOGLE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}` : null);

/** Бір аптаны жариялау. force=false болса, өзгеріс жоқта ештеңе жасамайды */
export async function publishWeek(monday: string, force = false) {
  const c = sheetsClient();
  if (!c) return false;
  const g = await buildWeekGrid(monday);
  if (!force && published.get(monday) === g.signature) return false;
  await c.writeSheet(g.title, g.values, g.bold, 0);
  published.set(monday, g.signature);
  return true;
}

/** Ашық апталарды (және жаңа жабылғанды) жариялау */
export async function publishOpenWeeks(force = false) {
  if (!sheetsClient()) return 0;
  const weeks = await q<{ monday: string }>(
    "SELECT monday FROM weeks WHERE status='open' OR sent_at > now() - interval '2 days' ORDER BY monday",
  );
  let n = 0;
  for (const w of weeks) if (await publishWeek(w.monday, force)) n++;
  return n;
}
