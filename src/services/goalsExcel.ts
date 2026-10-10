/**
 * Апталық Excel-ге айлық мақсат парақтары:
 *   АЙЛЫҚ МАҚСАТ · АЙЛЫҚ МАҚСАТ % · МАҚСАТ КОНВЕРСИЯСЫ · ОРЫНДАЛҒАН МАҚСАТТАР · ҰНАҒАН ЖҰМЫСТАР
 * Пішіні «DESIGN | АЙЛЫҚ МАҚСАТТАР 2026-2027» кестесімен бірдей.
 */
import type ExcelJS from "exceljs";
import { q } from "../db/db.js";
import { DESIGNERS, FULL_NAMES } from "../seed/catalog.js";
import {
  goalsWithProgress, likedOf, summary, conversion, monthOf, monthName, KIND_NAME, downloadTelegramFile,
  type Kind, type GoalRow,
} from "./goals.js";

const HEAD = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } } as const;
const TOTAL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F4F4" } } as const;
const OK = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDFF5E8" } } as const;
const pct = "0%";

type P = { yougile_id: string; excel_name: string; name: string };
const fullName = (p: P) => FULL_NAMES[p.excel_name] ?? p.name.toUpperCase();
const val = (v: number | null, isPercent: boolean) => (v === null ? null : isPercent ? v / 100 : v);

function header(ws: ExcelJS.Worksheet, row: number, cells: string[]) {
  cells.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = HEAD;
  });
}

export async function addGoalSheets(wb: ExcelJS.Workbook, monday: string, opts: { images?: boolean } = {}) {
  const month = monthOf(monday);
  const M = monthName(month);
  const people = await q<P>("SELECT yougile_id, excel_name, name FROM people WHERE role='designer' AND active AND yougile_id IS NOT NULL");
  const order = DESIGNERS.map((d) => people.find((p) => p.excel_name === d.excelName)).filter((p): p is P => !!p);
  for (const p of people) if (!order.includes(p)) order.push(p);
  const data = new Map<string, GoalRow[]>();
  for (const p of order) data.set(p.yougile_id, await goalsWithProgress(p.yougile_id, monday));

  // 1. АЙЛЫҚ МАҚСАТ — тізім
  const list = wb.addWorksheet("АЙЛЫҚ МАҚСАТ");
  list.addRow([`${M} — АЙЛЫҚ МАҚСАТТАР`]).font = { bold: true, size: 13 };
  header(list, 2, ["Дизайнер", "Түрі", "№", "Мақсат", "Мақсат мәні"]);
  for (const p of order) {
    let n = { op: 0, strat: 0 };
    for (const g of data.get(p.yougile_id)!) {
      const r = list.addRow([fullName(p), g.kind === "op" ? "Операционный" : "Стратегиялық", ++n[g.kind], g.title, val(g.target, g.is_percent)]);
      if (g.is_percent) r.getCell(5).numFmt = pct;
    }
  }
  list.columns = [{ width: 34 }, { width: 14 }, { width: 5 }, { width: 70 }, { width: 12 }];
  list.getColumn(4).alignment = { wrapText: true, vertical: "top" };

  // 2. АЙЛЫҚ МАҚСАТ % — әр дизайнерге кестедегідей блок
  const full = wb.addWorksheet("АЙЛЫҚ МАҚСАТ %");
  let r = 1;
  for (const p of order) {
    const rows = data.get(p.yougile_id)!;
    full.getCell(r, 1).value = `${fullName(p)} — ${M} АЙЛЫҚ МАҚСАТТАР КОНВЕРСИЯСЫ`;
    full.getCell(r, 1).font = { bold: true, size: 12 };
    r++;
    if (!rows.length) {
      full.getCell(r, 1).value = "Мақсат енгізілмеген";
      full.getCell(r, 1).font = { italic: true, color: { argb: "FF888888" } };
      r += 2;
      continue;
    }
    for (const k of ["op", "strat"] as Kind[]) {
      const gs = rows.filter((g) => g.kind === k);
      if (!gs.length) continue;
      header(full, r, [KIND_NAME[k], "", "Бастапқы көрсеткіш", "Мақсат", "Факт", "Конверсия", "Дәлел"]);
      r++;
      const first = r;
      gs.forEach((g, i) => {
        const row = full.getRow(r);
        row.values = [i + 1, g.title, val(g.base, g.is_percent), val(g.target, g.is_percent), val(g.fact, g.is_percent), conversion(g, g.fact) / 100, g.proof ?? ""];
        if (g.is_percent) [3, 4, 5].forEach((c) => (row.getCell(c).numFmt = pct));
        row.getCell(6).numFmt = pct;
        if (conversion(g, g.fact) >= 100) row.getCell(6).fill = OK;
        if (g.proof?.startsWith("http")) row.getCell(7).value = { text: g.proof, hyperlink: g.proof };
        r++;
      });
      full.getCell(r, 2).value = `${KIND_NAME[k]}:`;
      full.getCell(r, 6).value = { formula: `AVERAGE(F${first}:F${r - 1})` };
      full.getCell(r, 6).numFmt = pct;
      full.getRow(r).eachCell((c) => ((c.font = { bold: true }), (c.fill = TOTAL)));
      r++;
    }
    const s = summary(rows);
    full.getCell(r, 2).value = "Ортақ көрсеткіш:";
    full.getCell(r, 6).value = s.overall / 100;
    full.getCell(r, 6).numFmt = pct;
    full.getRow(r).eachCell((c) => (c.font = { bold: true }));
    r += 3;
  }
  full.columns = [{ width: 5 }, { width: 70 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 50 }];
  full.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  // 3. МАҚСАТ КОНВЕРСИЯСЫ — дашбордтағыдай жиынтық
  const conv = wb.addWorksheet("МАҚСАТ КОНВЕРСИЯСЫ");
  conv.addRow([`${M} АЙЛЫҚ МАҚСАТТАР КОНВЕРСИЯСЫ`]).font = { bold: true, size: 13 };
  header(conv, 2, ["Дизайнер", "Операционный", "Стратегиялық", "Ортақ көрсеткіш", "Орындалғаны", "Барлық мақсат"]);
  const filledRows: number[] = [];
  for (const p of order) {
    const rows = data.get(p.yougile_id)!;
    const s = summary(rows);
    const row = conv.addRow([fullName(p), s.op === null ? null : s.op / 100, s.strat === null ? null : s.strat / 100, rows.length ? s.overall / 100 : null, s.done, s.total]);
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = pct));
    if (rows.length) filledRows.push(row.number);
  }
  const tot = conv.addRow(["ЖАЛПЫ"]);
  if (filledRows.length) tot.getCell(4).value = { formula: `AVERAGE(${filledRows.map((n) => `D${n}`).join(",")})` };
  tot.getCell(4).numFmt = pct;
  tot.eachCell((c) => ((c.font = { bold: true }), (c.fill = TOTAL)));
  conv.columns = [{ width: 38 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 13 }, { width: 13 }];

  // 4. ОРЫНДАЛҒАН МАҚСАТТАР — конверсиясы 100% болғандар
  const done = wb.addWorksheet("ОРЫНДАЛҒАН МАҚСАТТАР");
  done.addRow([`${M} — ОРЫНДАЛҒАН МАҚСАТТАР`]).font = { bold: true, size: 13 };
  header(done, 2, ["Дизайнер", "Түрі", "Мақсат", "Факт", "Конверсия", "Дәлел"]);
  for (const p of order)
    for (const g of data.get(p.yougile_id)!.filter((g) => conversion(g, g.fact) >= 100)) {
      const row = done.addRow([fullName(p), g.kind === "op" ? "Операционный" : "Стратегиялық", g.title, val(g.fact, g.is_percent), 1, g.proof ?? ""]);
      if (g.is_percent) row.getCell(4).numFmt = pct;
      row.getCell(5).numFmt = pct;
    }
  done.columns = [{ width: 34 }, { width: 14 }, { width: 70 }, { width: 10 }, { width: 12 }, { width: 50 }];
  done.getColumn(3).alignment = { wrapText: true, vertical: "top" };

  // 5. ҰНАҒАН ЖҰМЫСТАР — суреттерімен
  const liked = wb.addWorksheet("ҰНАҒАН ЖҰМЫСТАР");
  liked.addRow(["ҰНАҒАН ЖҰМЫСТАР"]).font = { bold: true, size: 13 };
  header(liked, 2, ["Дизайнер", "Сипаттама", "Сурет"]);
  liked.columns = [{ width: 34 }, { width: 40 }, { width: 40 }];
  let lr = 3;
  for (const p of order)
    for (const w of await likedOf(p.yougile_id, monday)) {
      liked.getCell(lr, 1).value = fullName(p);
      liked.getCell(lr, 2).value = w.caption ?? "";
      liked.getCell(lr, 2).alignment = { wrapText: true, vertical: "top" };
      const img = opts.images === false ? null : await downloadTelegramFile(w.file_id);
      if (img) {
        const id = wb.addImage({ buffer: img.buffer as any, extension: img.ext });
        liked.addImage(id, { tl: { col: 2, row: lr - 1 }, ext: { width: 270, height: 270 } });
        liked.getRow(lr).height = 205;
      } else liked.getCell(lr, 3).value = "(сурет жүктелмеді)";
      lr++;
    }
  if (lr === 3) liked.getCell(3, 1).value = "Бұл аптада ұнаған жұмыс жіберілмеген";
}
