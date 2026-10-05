/**
 * Апталық есептің сурет-карточкасы: SVG → PNG (resvg). Қаріп — PT Sans (қазақ әріптері толық).
 * Эмодзи суретте көрсетілмейді (қаріпте жоқ), сондықтан белгілер SVG пішіндерімен салынады.
 */
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COUNTED, type ReportRow } from "./reports.js";
import { subjectFor } from "../seed/catalog.js";
import { weekFromMonday, weekRangeText } from "../time/week.js";

const here = dirname(fileURLToPath(import.meta.url));
const FONTS = ["PT_Sans-Web-Regular.ttf", "PT_Sans-Web-Bold.ttf"].map((f) => join(here, "../../assets/fonts", f));

const C = {
  bg: "#0E1525", panel: "#172036", line: "#24304A", text: "#F5F7FB", muted: "#93A0B8",
  accent: "#7C5CFF", accent2: "#29B6F6", up: "#34D399", down: "#F87171", bar: "#3B4A6B",
};
const TILE_COLORS = ["#7C5CFF", "#29B6F6", "#F59E0B", "#34D399"];

const x = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Жұмыс түрлерін 4 тақтаға топтау */
const GROUPS: { label: string; types: string[] }[] = [
  { label: "Пост", types: ["Пост"] },
  { label: "Карусель", types: ["Карусель"] },
  { label: "Обложка", types: ["YouTube обложка", "Рилс обложка", "Обложка", "ҰБТ обложка"] },
  { label: "Басқа", types: ["Таргет баннер", "Баннер", "Раздатка", "Презентация"] },
];

export function sumTypes(rows: ReportRow[]) {
  const all: Record<string, number> = {};
  rows.filter((r) => COUNTED.has(r.status)).forEach((r) => Object.entries(r.items).forEach(([k, v]) => (all[k] = (all[k] ?? 0) + v)));
  return all;
}
const groupTotals = (t: Record<string, number>) => GROUPS.map((g) => g.types.reduce((a, k) => a + (t[k] ?? 0), 0));

/** Өткен аптамен салыстыру: +12% / −5% / жаңа */
export function delta(now: number, prev: number): { text: string; dir: 1 | -1 | 0 } | null {
  if (!prev && !now) return null;
  if (!prev) return { text: "жаңа", dir: 1 };
  const p = Math.round(((now - prev) / prev) * 100);
  if (p === 0) return { text: "0%", dir: 0 };
  return { text: `${p > 0 ? "+" : "−"}${Math.abs(p)}%`, dir: p > 0 ? 1 : -1 };
}

const arrow = (cx: number, cy: number, dir: 1 | -1 | 0, color: string) =>
  dir === 0 ? "" : dir > 0
    ? `<path d="M${cx - 7} ${cy + 5} L${cx} ${cy - 6} L${cx + 7} ${cy + 5} Z" fill="${color}"/>`
    : `<path d="M${cx - 7} ${cy - 5} L${cx} ${cy + 6} L${cx + 7} ${cy - 5} Z" fill="${color}"/>`;

type CardInput = {
  kicker: string; title: string; subtitle: string;
  tiles: { label: string; value: number; delta: ReturnType<typeof delta> }[];
  rowsTitle: string;
  rows: { name: string; detail: string; total: number }[];
  bars?: boolean;
  footer: string;
};

export function cardSvg(c: CardInput) {
  const W = 1080, pad = 64, tileW = (W - pad * 2 - 3 * 20) / 4;
  const rowsShown = c.rows.slice(0, 14);
  const rowH = 76, listTop = 560;
  const H = listTop + 60 + rowsShown.length * rowH + (c.rows.length > 14 ? 40 : 0) + 120;
  const max = Math.max(1, ...rowsShown.map((r) => r.total));
  const parts: string[] = [];

  parts.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  parts.push(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.accent}"/><stop offset="1" stop-color="${C.accent2}"/></linearGradient></defs>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="10" fill="url(#g)"/>`);
  parts.push(`<text x="${pad}" y="104" font-size="26" font-weight="bold" fill="${C.accent2}" letter-spacing="3">${x(c.kicker)}</text>`);
  parts.push(`<text x="${pad}" y="178" font-size="68" font-weight="bold" fill="${C.text}">${x(cut(c.title, 24))}</text>`);
  parts.push(`<text x="${pad}" y="230" font-size="32" fill="${C.muted}">${x(c.subtitle)}</text>`);

  c.tiles.forEach((t, i) => {
    const tx = pad + i * (tileW + 20), ty = 290;
    parts.push(`<rect x="${tx}" y="${ty}" width="${tileW}" height="200" rx="24" fill="${C.panel}"/>`);
    parts.push(`<rect x="${tx}" y="${ty}" width="8" height="200" rx="4" fill="${TILE_COLORS[i]}"/>`);
    parts.push(`<text x="${tx + 32}" y="${ty + 56}" font-size="26" fill="${C.muted}">${x(t.label)}</text>`);
    parts.push(`<text x="${tx + 32}" y="${ty + 136}" font-size="72" font-weight="bold" fill="${C.text}">${t.value}</text>`);
    if (t.delta) {
      const col = t.delta.dir > 0 ? C.up : t.delta.dir < 0 ? C.down : C.muted;
      parts.push(arrow(tx + 40, ty + 170, t.delta.dir, col));
      parts.push(`<text x="${tx + (t.delta.dir ? 56 : 32)}" y="${ty + 178}" font-size="24" fill="${col}">${x(t.delta.text)}</text>`);
    }
  });

  parts.push(`<text x="${pad}" y="${listTop}" font-size="28" font-weight="bold" fill="${C.text}">${x(c.rowsTitle)}</text>`);
  rowsShown.forEach((r, i) => {
    const y = listTop + 50 + i * rowH;
    const barMax = W - pad * 2;
    parts.push(`<rect x="${pad}" y="${y}" width="${barMax}" height="${rowH - 14}" rx="16" fill="${C.panel}"/>`);
    if (c.bars !== false) parts.push(`<rect x="${pad}" y="${y}" width="${Math.max(16, (barMax * r.total) / max)}" height="${rowH - 14}" rx="16" fill="${C.bar}"/>`);
    parts.push(`<text x="${pad + 24}" y="${y + 41}" font-size="28" font-weight="bold" fill="${C.text}">${x(cut(r.name, 22))}</text>`);
    parts.push(`<text x="${W - pad - 24}" y="${y + 41}" font-size="26" fill="${C.text}" text-anchor="end">${x(cut(r.detail, 44))}</text>`);
  });
  if (c.rows.length > 14)
    parts.push(`<text x="${pad}" y="${listTop + 50 + 14 * rowH + 24}" font-size="24" fill="${C.muted}">…тағы ${c.rows.length - 14}</text>`);

  parts.push(`<line x1="${pad}" y1="${H - 100}" x2="${W - pad}" y2="${H - 100}" stroke="${C.line}" stroke-width="2"/>`);
  parts.push(`<text x="${pad}" y="${H - 52}" font-size="26" fill="${C.muted}">${x(c.footer)}</text>`);
  parts.push(`<text x="${W - pad}" y="${H - 52}" font-size="26" font-weight="bold" fill="${C.muted}" text-anchor="end">JUZ40 · DESIGN</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="PT Sans">${parts.join("")}</svg>`;
}

export function renderPng(svg: string): Buffer {
  const r = new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "PT Sans" }, fitTo: { mode: "original" } });
  return Buffer.from(r.render().asPng());
}

const SHORT: Record<string, string> = {
  Пост: "пост", Карусель: "карусель", "YouTube обложка": "YT обл.", "Рилс обложка": "рилс обл.", Обложка: "обложка", "Таргет баннер": "таргет",
  Баннер: "баннер", Раздатка: "раздатка", Презентация: "преза", "ҰБТ обложка": "ҰБТ обл.",
};
const detail = (items: Record<string, number>) =>
  Object.entries(items).filter(([, v]) => v).map(([k, v]) => `${v} ${SHORT[k] ?? k}`).join(" · ");
const tiles = (now: Record<string, number>, prev: Record<string, number>) => {
  const a = groupTotals(now), b = groupTotals(prev);
  return GROUPS.map((g, i) => ({ label: g.label, value: a[i], delta: delta(a[i], b[i]) }));
};
const total = (items: Record<string, number>) => Object.values(items).reduce((s, v) => s + v, 0);

/** Дизайнердің апталық карточкасы */
export function designerCard(name: string, monday: string, rows: ReportRow[], prevRows: ReportRow[]) {
  const bySubj = new Map<string, Record<string, number>>();
  rows.filter((r) => COUNTED.has(r.status)).forEach((r) => {
    const s = subjectFor(r.trace.location ?? null).name;
    const e = bySubj.get(s) ?? {};
    Object.entries(r.items).forEach(([k, v]) => (e[k] = (e[k] ?? 0) + v));
    bySubj.set(s, e);
  });
  const open = rows.filter((r) => ["ask_designer", "no_files", "needs_review"].includes(r.status)).length;
  const counted = rows.filter((r) => COUNTED.has(r.status)).length;
  return renderPng(cardSvg({
    kicker: "АПТАЛЫҚ ЕСЕП",
    title: name,
    subtitle: weekRangeText(weekFromMonday(monday)),
    tiles: tiles(sumTypes(rows), sumTypes(prevRows)),
    rowsTitle: "Пәндер мен аккаунттар",
    rows: [...bySubj].map(([n, it]) => ({ name: n, detail: detail(it), total: total(it) })).sort((a, b) => b.total - a.total),
    footer: `${counted} тапсырма автоматты есептелді${open ? ` · ${open} шешілмеген` : ""}`,
  }));
}

/** Админ/басшыға арналған жалпы карточка */
export function teamCard(monday: string, rows: ReportRow[], prevRows: ReportRow[]) {
  const byD = new Map<string, Record<string, number>>();
  rows.filter((r) => COUNTED.has(r.status)).forEach((r) => {
    const e = byD.get(r.designer) ?? {};
    Object.entries(r.items).forEach(([k, v]) => (e[k] = (e[k] ?? 0) + v));
    byD.set(r.designer, e);
  });
  const open = rows.filter((r) => ["ask_designer", "no_files", "needs_review"].includes(r.status)).length;
  return renderPng(cardSvg({
    kicker: "DESIGN БӨЛІМІ",
    title: "Апталық жиынтық",
    subtitle: weekRangeText(weekFromMonday(monday)),
    tiles: tiles(sumTypes(rows), sumTypes(prevRows)),
    rowsTitle: "Дизайнерлер",
    bars: false, // адамдарды салыстыру әсері болмасын
    rows: [...byD].map(([n, it]) => ({ name: n, detail: detail(it), total: total(it) })).sort((a, b) => a.name.localeCompare(b.name)),
    footer: `${rows.filter((r) => COUNTED.has(r.status)).length} тапсырма есептелді${open ? ` · ${open} шешілмеген` : ""}`,
  }));
}
