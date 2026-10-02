/** Апталық Excel: қазіргі «DESIGN | АПТАЛЫҚ ОТЧЕТ» пішіні + ДЕТАЛЬ және ТЕКСЕРУ парақтары */
import ExcelJS from "exceljs";
import { q, one } from "../db/db.js";
import { weekRows, COUNTED, type ReportRow } from "./reports.js";
import { subjectFor, DESIGNERS, WORK_TYPES } from "../seed/catalog.js";
import { weekFromMonday, weekRangeText } from "../time/week.js";

export const PAN = ["ТАРИХ МС", "ДЖТ", "АҒЫЛШЫН", "МАТ", "ӘДЕБТІЛ", "БИОЛОГИЯ", "ГЕОГРАФИЯ", "ФИЗИКА", "ХИМИЯ", "РУСЛИТ", "ҚҰҚЫҚ", "ИНФО"];
export const INSTA = ["JUNIOR", "JUZ40 ONL", "COMM", "CAREER", "TEAM", "OYKOZ", "IELTS", "JUZ40 STORE"];
export const OTHER_TYPES = WORK_TYPES.filter((w) => w !== "Пост" && w !== "Карусель" && w !== "ҰБТ обложка");

const HEAD = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } } as const;
const TOTAL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F4F4" } } as const;
const col = (n: number) => {
  let s = "";
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Бір блок: жолдар — дизайнерлер, бағандар — columns, жиындар формуламен */
function block(ws: ExcelJS.Worksheet, row: number, title: string, columns: string[], names: string[], value: (name: string, c: string) => number) {
  ws.getCell(row, 1).value = title;
  ws.getCell(row, 1).font = { bold: true };
  row++;
  const header = ["ДИЗАЙНЕРЛЕР", ...columns, "БАРЛЫҒЫ"];
  header.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = HEAD;
  });
  const first = row + 1;
  names.forEach((n, i) => {
    const r = first + i;
    ws.getCell(r, 1).value = n;
    columns.forEach((c, j) => (ws.getCell(r, j + 2).value = value(n, c)));
    ws.getCell(r, columns.length + 2).value = { formula: `SUM(${col(1)}${r}:${col(columns.length)}${r})` };
  });
  const last = first + names.length - 1;
  const t = last + 1;
  ws.getCell(t, 1).value = "ПӘН БОЙЫНША";
  for (let j = 1; j <= columns.length + 1; j++) {
    ws.getCell(t, j + 1).value = { formula: `SUM(${col(j)}${first}:${col(j)}${last})` };
  }
  ws.getRow(t).eachCell((c) => {
    c.font = { bold: true };
    c.fill = TOTAL;
  });
  return t + 2;
}

export async function buildWeekWorkbook(monday: string): Promise<{ buffer: Buffer; filename: string }> {
  const rows = await weekRows(monday);
  const w = await one<{ label: string }>("SELECT label FROM weeks WHERE monday=$1", [monday]);
  const label = w?.label ?? monday;
  const people = await q<{ yougile_id: string; excel_name: string }>("SELECT yougile_id, excel_name FROM people WHERE role='designer'");
  const order = DESIGNERS.map((d) => d.excelName).filter((n) => people.some((p) => p.excel_name === n));
  const counted = rows.filter((r) => COUNTED.has(r.status));

  // дизайнер × пән × жұмыс түрі
  const sum = new Map<string, number>();
  const subjects = { "ПӘН АКК": new Set(PAN), "ИНСТА АКК": new Set(INSTA) } as Record<string, Set<string>>;
  for (const r of counted) {
    const s = subjectFor(r.trace.location ?? null);
    if (subjects[s.sheet]) subjects[s.sheet].add(s.name);
    for (const [k, v] of Object.entries(r.items)) {
      const key = `${r.excel_name}|${s.sheet}|${s.name}|${k}`;
      sum.set(key, (sum.get(key) ?? 0) + v);
    }
  }
  const get = (name: string, sheet: string, subj: string, wt: string) => sum.get(`${name}|${sheet}|${subj}|${wt}`) ?? 0;

  const wb = new ExcelJS.Workbook();
  wb.creator = "design-report";
  const title = `${label} · ${weekRangeText(weekFromMonday(monday))}`;

  for (const sheet of ["ПӘН АКК", "ИНСТА АКК"]) {
    const ws = wb.addWorksheet(sheet);
    ws.getCell(1, 1).value = title;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    const cols = [...subjects[sheet]];
    let r = block(ws, 3, "ПОСТ", cols, order, (n, c) => get(n, sheet, c, "Пост"));
    block(ws, r, "КАРУСЕЛЬ", cols, order, (n, c) => get(n, sheet, c, "Карусель"));
    ws.getColumn(1).width = 16;
  }

  // Басқа жұмыстар: барлық парақ бойынша жиын
  const other = wb.addWorksheet("ӨЗГЕ ЖҰМЫСТАР");
  other.getCell(1, 1).value = title;
  other.getCell(1, 1).font = { bold: true, size: 13 };
  const byType = (n: string, wt: string) =>
    [...sum].filter(([k]) => k.startsWith(`${n}|`) && k.endsWith(`|${wt}`)).reduce((a, [, v]) => a + v, 0);
  const otherPostCar = (n: string, wt: string) =>
    [...sum].filter(([k]) => k.startsWith(`${n}|ӨЗГЕ|`) && k.endsWith(`|${wt}`)).reduce((a, [, v]) => a + v, 0);
  block(other, 3, "ЖҰМЫС ТҮРЛЕРІ", [...OTHER_TYPES, "Пост (өзге)", "Карусель (өзге)"], order, (n, c) =>
    c === "Пост (өзге)" ? otherPostCar(n, "Пост") : c === "Карусель (өзге)" ? otherPostCar(n, "Карусель") : byType(n, c),
  );
  other.getColumn(1).width = 16;

  // СКРИН: тізім түрі
  const scr = wb.addWorksheet("СКРИН");
  scr.addRow([title]).font = { bold: true };
  scr.addRow(["ДИЗАЙНЕР", "ПӘН/АКК", "ПОСТ", "КАРУСЕЛЬ"]).eachCell((c) => ((c.font = { bold: true }), (c.fill = HEAD)));
  for (const n of order)
    for (const sheet of ["ПӘН АКК", "ИНСТА АКК"])
      for (const s of subjects[sheet]) {
        const p = get(n, sheet, s, "Пост"), k = get(n, sheet, s, "Карусель");
        if (p || k) scr.addRow([n, s, p, k]);
      }

  // ДЕТАЛЬ
  const det = wb.addWorksheet("ДЕТАЛЬ");
  const dh = ["Күні", "Дизайнер", "Бөлім", "Пән/акк", "Task ID", "Тапсырма", "Файл", "Ереже", ...WORK_TYPES, "Барлығы", "Статус", "Ескерту"];
  det.addRow(dh).eachCell((c) => ((c.font = { bold: true }), (c.fill = HEAD)));
  for (const r of rows) {
    const s = subjectFor(r.trace.location ?? null);
    const vals = WORK_TYPES.map((wt) => r.items[wt] ?? 0);
    det.addRow([
      new Date(r.completed_at).toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" }),
      r.excel_name, r.trace.location?.project ?? "", s.name, r.trace.code, r.trace.title, r.file_count, r.rule_code ?? "",
      ...vals, vals.reduce((a, b) => a + b, 0),
      statusName(r), [...r.reasons, ...r.warnings].join("; "),
    ]);
  }
  det.views = [{ state: "frozen", ySplit: 1 }];
  det.autoFilter = { from: "A1", to: `${col(dh.length - 1)}1` };

  // ТЕКСЕРУ
  const rev = wb.addWorksheet("ТЕКСЕРУ");
  rev.addRow(["Task ID", "Тапсырма", "Дизайнер", "Файл", "Себебі"]).eachCell((c) => ((c.font = { bold: true }), (c.fill = HEAD)));
  for (const r of rows.filter((x) => ["needs_review", "no_files", "ask_designer"].includes(x.status)))
    rev.addRow([r.trace.code, r.trace.title, r.excel_name, r.file_count, statusName(r) + ": " + r.reasons.join("; ")]);

  for (const ws of [det, rev]) ws.columns.forEach((c) => (c.width = 14));
  det.getColumn(6).width = 40;
  rev.getColumn(2).width = 40;
  rev.getColumn(5).width = 60;

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `DESIGN_${label.replace(/\s+/g, "_")}_${monday}.xlsx` };
}

function statusName(r: ReportRow) {
  return (
    { ok: "авто", corrected: "түзетілген", ask_designer: "сұрақта", no_files: "файлсыз", needs_review: "тексеру", skipped: "өткізілді" }[r.status] ??
    r.status
  ) + (r.manual ? " (қолмен)" : "") + (r.is_supplement ? " (қосымша)" : "");
}
