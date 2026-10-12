/** Апталық есеп: жиынтық және Telegram мәтіндері (HTML) */
import { q, one } from "../db/db.js";
import { subjectFor, WORK_TYPES, type SheetName } from "../seed/catalog.js";
import { weekFromMonday, weekRangeText } from "../time/week.js";

export type ReportRow = {
  id: number; task_id: string; designer_yid: string; designer: string; excel_name: string;
  status: string; items: Record<string, number>; file_count: number; ask_count: number;
  rule_code: string | null; reasons: string[]; warnings: string[]; trace: any;
  is_supplement: boolean; answer: string | null; manual: boolean; completed_at: string;
};

/** Жиынтыққа кіретін статустар (ask_designer — саналған бөлігі уақытша кіреді) */
export const COUNTED = new Set(["ok", "corrected", "ask_designer"]);
const OPEN = new Set(["ask_designer", "no_files", "needs_review"]);

/** Апта тапсырмалары: YouGile-ден есептелгендер + дизайнер өзі қосқан жұмыстар (id < 0, trace.added) */
export async function weekRows(monday: string, designerYid?: string): Promise<ReportRow[]> {
  const rows = await q<ReportRow>(
    `SELECT c.*, p.name AS designer, p.excel_name, t.completed_at
       FROM calculations c JOIN people p ON p.yougile_id=c.designer_yid JOIN tasks t ON t.yougile_id=c.task_id
      WHERE c.week=$1 AND ($2::text IS NULL OR c.designer_yid=$2)
      ORDER BY p.name, t.completed_at`,
    [monday, designerYid ?? null],
  );
  const added = await q<any>(
    `SELECT m.*, p.name AS designer, p.excel_name FROM manual_works m JOIN people p ON p.yougile_id=m.designer_yid
      WHERE m.week=$1 AND ($2::text IS NULL OR m.designer_yid=$2) ORDER BY m.id`,
    [monday, designerYid ?? null],
  );
  for (const m of added)
    rows.push({
      id: -m.id, task_id: `manual-${m.id}`, designer_yid: m.designer_yid, designer: m.designer, excel_name: m.excel_name,
      status: "ok", items: m.items, file_count: 0, ask_count: 0, rule_code: "ADDED", reasons: [], warnings: [],
      trace: { title: m.note || `${m.subject} (өзі қосты)`, location: m.loc ?? null, added: true, subject: m.subject },
      is_supplement: false, answer: null, manual: true, completed_at: m.created_at,
    });
  return rows;
}

export type Totals = Map<string, { sheet: SheetName; items: Record<string, number> }>;

export function totalsBySubject(rows: ReportRow[]): Totals {
  const m: Totals = new Map();
  for (const r of rows) {
    if (!COUNTED.has(r.status)) continue;
    const s = subjectFor(r.trace.location ?? null);
    const e = m.get(s.name) ?? { sheet: s.sheet, items: {} };
    for (const [k, v] of Object.entries(r.items)) e.items[k] = (e.items[k] ?? 0) + v;
    m.set(s.name, e);
  }
  return m;
}

/** Пән/аккаунт белгішелері */
const ICON: Record<string, string> = {
  "ТАРИХ МС": "🏛", ДЖТ: "🌐", АҒЫЛШЫН: "🇬🇧", МАТ: "📐", ӘДЕБТІЛ: "📖", БИОЛОГИЯ: "🧬", ГЕОГРАФИЯ: "🌍",
  ФИЗИКА: "⚛️", ХИМИЯ: "🧪", РУСЛИТ: "📚", ҚҰҚЫҚ: "⚖️", ИНФО: "💻", YOUTUBE: "🎬", "JUZ40 ONL": "📲",
  JUNIOR: "🧒", COMM: "🤝", CAREER: "💼", IELTS: "🎓", TEAM: "👥", OYKOZ: "💡", "JUZ40 STORE": "🛍",
};
export const icon = (subject: string) => ICON[subject] ?? (subject.startsWith("JUZENG") ? "🎓" : "📁");

export const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const subjectOf = (r: { trace: any }) => subjectFor(r.trace.location ?? null).name;
/** Тапсырманың адамға түсінікті атауы: «ТЗ атауы» · ПӘН */
export const taskName = (r: { trace: any }) => `«${r.trace.title}» · ${subjectOf(r)}`;

const SHORT: Record<string, string> = { "YouTube обложка": "YouTube обложка", "Таргет баннер": "таргет" };
export const fmtItems = (items: Record<string, number>) =>
  WORK_TYPES.filter((w) => items[w]).map((w) => `${items[w]} ${SHORT[w] ?? w.toLowerCase()}`).join(" · ");

const sumItems = (rows: ReportRow[]) => {
  const all: Record<string, number> = {};
  rows.filter((r) => COUNTED.has(r.status)).forEach((r) => Object.entries(r.items).forEach(([k, v]) => (all[k] = (all[k] ?? 0) + v)));
  return all;
};

const STATUS_NOTE: Record<string, string> = {
  ask_designer: "❓ түзету ме, қосымша ма — жауап күтуде",
  no_files: "📭 чатта файл жоқ",
  needs_review: "⚠️ тексеру қажет",
  corrected: "✏️ түзетілген",
  skipped: "⏭ есептен шығарылған",
};

const LINE = "━━━━━━━━━━━━━━";

/** Өткен аптамен салыстыру мәтіні */
export function compareText(rows: ReportRow[], prevRows: ReportRow[]) {
  const a = sumItems(rows), b = sumItems(prevRows);
  const parts = WORK_TYPES.filter((w) => a[w] || b[w]).map((w) => {
    const now = a[w] ?? 0, prev = b[w] ?? 0;
    const label = (SHORT[w] ?? w).toLowerCase() === "youtube обложка" ? "YouTube обложка" : (SHORT[w] ?? w).toLowerCase();
    if (!prev) return `${label} жаңа`;
    const p = Math.round(((now - prev) / prev) * 100);
    return `${label} ${p > 0 ? "↑" : p < 0 ? "↓" : "="}${p ? Math.abs(p) + "%" : ""}`;
  });
  return parts.length ? `📈 Өткен аптамен: ${parts.join(" · ")}` : "";
}

/** Дүйсенбідегі қысқа есеп */
export function designerReportText(name: string, monday: string, rows: ReportRow[], prevRows?: ReportRow[]) {
  const totals = totalsBySubject(rows);
  const out = [`📊 <b>${esc(name)}</b> · ${weekRangeText(weekFromMonday(monday))}`, LINE];
  if (!totals.size) out.push("Бұл аптада есептелген жұмыс жоқ.");
  for (const [subj, t] of [...totals].sort(([a], [b]) => a.localeCompare(b))) out.push(`${icon(subj)} <b>${esc(subj)}</b>\n      ${fmtItems(t.items)}`);
  out.push(LINE);
  const all = fmtItems(sumItems(rows));
  if (all) out.push(`<b>Барлығы:</b> ${all}`);
  if (prevRows) {
    const cmp = compareText(rows, prevRows);
    if (cmp) out.push(cmp);
  }
  const counted = rows.filter((r) => COUNTED.has(r.status) && !r.trace?.added).length;
  out.push(`✅ ${counted} тапсырма YouGile-ден автоматты есептелді`);
  const added = rows.filter((r) => r.trace?.added);
  if (added.length) out.push(`➕ Өзің қостың: ${added.map((r) => esc(`${r.trace.subject} — ${fmtItems(r.items)}`)).join("; ")}`);
  const open = rows.filter((r) => OPEN.has(r.status)).length;
  if (open) out.push(`⚠️ ${open} тапсырма шешілмеген — «Толығырақ»`);
  return out.join("\n");
}

/** «Толығырақ»: пән бойынша топтастырылған тапсырмалар */
export function designerDetailsText(rows: ReportRow[]) {
  if (!rows.length) return "Бұл аптада тапсырма жоқ.";
  const out: string[] = [];
  const bySubj = new Map<string, ReportRow[]>();
  rows.filter((r) => !OPEN.has(r.status)).forEach((r) => bySubj.set(subjectOf(r), [...(bySubj.get(subjectOf(r)) ?? []), r]));
  for (const [subj, rs] of [...bySubj].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${icon(subj)} <b>${esc(subj)}</b>`);
    for (const r of rs) {
      const note = STATUS_NOTE[r.status] ? ` <i>${STATUS_NOTE[r.status]}</i>` : "";
      out.push(`• ${esc(r.trace.title)} — ${r.file_count} файл → ${fmtItems(r.items) || "—"}${note}`);
    }
    out.push("");
  }
  const open = rows.filter((r) => OPEN.has(r.status));
  if (open.length) {
    out.push("<b>⚠️ Шешілмеген</b>");
    open.forEach((r) => out.push(`• ${esc(taskName(r))} — ${STATUS_NOTE[r.status]}`));
  }
  return out.join("\n").trim();
}

/** Админге/тексеруге: бір тапсырма бір жолда */
export function taskLine(r: ReportRow) {
  const note = STATUS_NOTE[r.status] ? ` ${STATUS_NOTE[r.status]}` : "";
  return `${esc(taskName(r))} — ${r.file_count} файл → ${fmtItems(r.items) || "—"}${note}`;
}

export async function adminSummaryText(monday: string) {
  const rows = await weekRows(monday);
  const w = await one<{ label: string; status: string }>("SELECT label, status FROM weeks WHERE monday=$1", [monday]);
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const out = [
    `📊 <b>DESIGN · ${weekRangeText(weekFromMonday(monday))}</b>${w?.label ? ` (${esc(w.label)})` : ""}${w?.status === "sent" ? " · 🔒 жабылған" : ""}`,
    LINE,
  ];
  const byDesigner = new Map<string, ReportRow[]>();
  rows.forEach((r) => byDesigner.set(r.designer, [...(byDesigner.get(r.designer) ?? []), r]));
  for (const [name, rs] of [...byDesigner].sort(([a], [b]) => a.localeCompare(b))) {
    const open = rs.filter((r) => OPEN.has(r.status)).length;
    out.push(`<b>${esc(name)}</b>${open ? ` · ⚠️${open}` : ""}\n   ${fmtItems(sumItems(rs)) || "—"}`);
  }
  out.push(LINE);
  out.push(`<b>Барлығы:</b> ${fmtItems(sumItems(rows)) || "—"}`);
  out.push(
    `✅ авто ${count("ok")} · ✏️ түзетілген ${count("corrected")} · ❓ сұрақта ${count("ask_designer")} · 📭 файлсыз ${count("no_files")} · ⚠️ тексеру ${count("needs_review")}`,
  );
  return out.join("\n");
}
