/**
 * Боттағы айлық мақсаттар ағыны:
 *   🎯 Мақсаттарым → мақсат қосу (операционный / стратегиялық), өткен айдан көшіру, өзгерту, өшіру;
 *   сенбі 12:00 → факт сұрау (бір хабарламамен, ретімен) → дәлел (міндетті емес) → ұнаған жұмыстар (сурет);
 *   админ → /import_goals (кестенің xlsx файлынан осы айдың мақсаттарын жүктеу), /goals_team.
 */
import { Bot, InlineKeyboard, type Context } from "grammy";
import ExcelJS from "exceljs";
import { q, one } from "../db/db.js";
import { weekOf } from "../time/week.js";
import { esc } from "../services/reports.js";
import { PICK, pickBySubject, findSubject, otherSubject, parseWorkItems, itemsText } from "../services/reportLabels.js";
import { parseNotes, saveNotes, notesOf, NOTE_KEYS, NOTE_NAMES, exportWeekToGitHub, githubEnabled } from "../services/figmaExport.js";
import {
  goalsWithProgress, goalsText, addGoals, copyPrevMonth, renameGoal, removeGoal, saveFacts, saveProof,
  likedOf, addLiked, clearLiked, parseGoalLines, parseFacts, parseProofs, conversion, fmtVal, summary,
  monthOf, monthName, MAX_LIKED, KIND_NAME, type Kind, type GoalRow,
} from "../services/goals.js";

type P = { id: number; name: string; yougile_id: string | null; telegram_id: number | null; role: string; is_admin: boolean; excel_name?: string };
type GState =
  | { kind: "gAdd"; goal: Kind }
  | { kind: "gEdit"; id: number }
  | { kind: "gFacts"; monday: string }
  | { kind: "gFactsOk"; monday: string; ids: number[]; facts: number[] }
  | { kind: "gOne"; monday: string; goalId: number }
  | { kind: "gProof"; monday: string }
  | { kind: "gLike"; monday: string }
  | { kind: "gNotes"; monday: string }
  | { kind: "wAdd"; monday: string; subject?: string }
  | { kind: "wAddOk"; monday: string; subject: string; loc: any; items: Record<string, number> };
const gstate = new Map<number, GState>();
export const clearGoalState = (tg: number) => gstate.delete(tg);

export const GOALS_BTN = "🎯 Мақсаттарым";
/** Ағымдағы апта (мақсат қосу, ай анықтау) */
const curMonday = () => weekOf(Date.now()).monday;
/**
 * Есеп аптасы: факт, ұнаған жұмыс, қорытынды осы аптаға жазылады.
 * Дүйсенбі 12:00-ге дейін — өткен апта (Figma есебі 12:00-де жиналады), одан кейін — ағымдағы апта.
 */
export const REPORT_CUTOFF_HOUR = 13; // дүйсенбі 13:00 — Figma деректері жиналады
export function reportMonday(ms = Date.now()) {
  const local = new Date(ms + 5 * 3600_000);
  const isMonMorning = local.getUTCDay() === 1 && local.getUTCHours() < REPORT_CUTOFF_HOUR;
  return isMonMorning ? weekOf(weekOf(ms).startMs - 1).monday : weekOf(ms).monday;
}
const thisMonday = () => reportMonday();
/**
 * «Есепке дайынмын» ағыны (дүйсенбі 12:15): дизайнер қай аптаны толтырып жатқаны.
 * Ағын ішінде барлық қадам (ұнаған жұмыс, қорытынды, мақсат) осы аптаға жазылады.
 */
const wizard = new Map<number, string>();
export const startWizard = (tg: number, monday: string) => wizard.set(tg, monday);
export const inWizard = (tg: number) => wizard.has(tg);
const weekFor = (tg: number) => wizard.get(tg) ?? thisMonday();
let clearMainRef: (tg: number) => void = () => {};

/** ⭐ Ұнаған жұмыс сұрауы (ағын ішінде — 2-қадам) */
export async function likedPrompt(bot: Bot, chatId: number, tg: number, p: { yougile_id: string | null }) {
  const monday = weekFor(tg);
  const n = (await likedOf(p.yougile_id!, monday)).length;
  clearMainRef(tg);
  gstate.set(tg, { kind: "gLike", monday });
  await bot.api.sendMessage(
    chatId,
    (inWizard(tg) ? "2️⃣ <b>Ұнаған жұмыстар</b>\n" : "") +
      `⭐ Осы аптада ұнаған жұмысыңды жібер — ${MAX_LIKED} суретке дейін (фото ретінде). Астына қысқа сипаттама жазуға болады.${n ? `\nҚазір жіберілгені: ${n}.` : ""}`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ Дайын", "gld").text(n ? "🗑 Жіберілгенін тазалау" : "Өткізу", n ? "glc" : "gld") },
  );
}
const personByTg = (id: number) => one<P>("SELECT * FROM people WHERE telegram_id=$1 AND active", [id]);

const ADD_HELP = (k: Kind) =>
  `<b>${KIND_NAME[k]}</b> — әр жолға бір мақсат жаз:\n\n` +
  `<code>Өнімділікті 95%-дан түсірмеу | 95%\nИнстаграм жүргізу (1 пост, 1 рилс)\nERF көрсеткішін 3.0-ге жеткізу | 3</code>\n\n` +
  `«| 95%» — мақсат мәні. Жазбасаң — 100%. Сандық мақсатқа «| 3» деп % белгісіз жаз.`;

function goalsKeyboard(rows: GoalRow[]) {
  const kb = new InlineKeyboard().text("➕ Операционный", "ga:op").text("➕ Стратегиялық", "ga:strat").row();
  if (!rows.length) kb.text("📋 Өткен айдағыдай көшіру", "gc").row();
  else kb.text("📈 Фактіні жазу", "gf").text("📎 Дәлел қосу", "gp").row().text("⭐ Ұнаған жұмыс", "gl").text("📝 Апта қорытындысы", "gn").row().text("✏️ Өзгерту / өшіру", "ge");
  return kb;
}

async function showGoals(bot: Bot, chatId: number, p: P, monday = thisMonday()) {
  const rows = await goalsWithProgress(p.yougile_id!, monday);
  await bot.api.sendMessage(chatId, goalsText(rows, monday), { parse_mode: "HTML", reply_markup: goalsKeyboard(rows), link_preview_options: { is_disabled: true } });
}

/** Әр мақсат — жеке батырма. ✔ — осы аптада толтырылған */
function factsKeyboard(rows: GoalRow[]) {
  const kb = new InlineKeyboard();
  rows.forEach((g, i) => {
    const mark = g.week_fact !== null ? "✔" : "▫️";
    kb.text(`${mark} ${i + 1}. ${g.title}`.slice(0, 44) + ` — ${conversion(g, g.fact)}%`, `gq:${g.id}`).row();
  });
  kb.text("✅ Дайын — конверсияны есептеу", "gfd");
  return kb;
}
function factsListText(rows: GoalRow[], monday: string) {
  const s = summary(rows);
  const filled = rows.filter((g) => g.week_fact !== null).length;
  return [
    `📈 <b>${monthName(monthOf(monday))} — айлық мақсатты толтыр</b>`,
    "Әр мақсатты басып, қазір шамамен қанша орындалғанын жаз.",
    "",
    `Осы апта толтырылғаны: <b>${filled}/${rows.length}</b> · ағымдағы конверсия: <b>${s.overall}%</b>`,
  ].join("\n");
}
export async function sendFactsList(bot: Bot, chatId: number, yid: string, monday: string, intro = "") {
  const rows = await goalsWithProgress(yid, monday);
  if (!rows.length) return false;
  await bot.api.sendMessage(chatId, (intro ? intro + "\n\n" : "") + factsListText(rows, monday), { parse_mode: "HTML", reply_markup: factsKeyboard(rows) });
  return true;
}

function factsPrompt(rows: GoalRow[], monday: string) {
  const out = [`📈 <b>${monthName(monthOf(monday))} — мақсаттардың фактісі</b>`, "Шамамен қанша орындалды? Ретімен, бос орынмен жаз.", ""];
  rows.forEach((g, i) =>
    out.push(`${i + 1}. ${esc(g.title)}\n    мақсат ${fmtVal(g.target, g.is_percent)}${g.fact !== null ? ` · қазір ${fmtVal(g.fact, g.is_percent)}` : ""}`));
  out.push(
    "",
    `Мысалы (${rows.length} сан): <code>${rows.map((g) => (g.is_percent ? (g.fact ?? 50) : g.fact ?? 1)).join(" ")}</code>`,
    "Пайыздық мақсатқа — пайыз (80), сандық мақсатқа — сан (1,66). Өзгермегенге <code>=</code> қой.",
  );
  return out.join("\n");
}

/** Сенбі 19:00 — әр дизайнерге «айлық мақсатыңды толтыр» (мақсаты жоқтарға — енгізуді еске салу) */
export async function sendGoalCheckin(bot: Bot) {
  const monday = thisMonday();
  const ds = await q<P>("SELECT * FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND yougile_id IS NOT NULL AND active");
  for (const d of ds) {
    try {
      const ok = await sendFactsList(bot, d.telegram_id!, d.yougile_id!, monday, "🌙 Апта аяқталды! Айлық мақсатыңды толтырып жібер — дүйсенбі есебіне өзі түседі.");
      if (!ok)
        await bot.api.sendMessage(d.telegram_id!, `🎯 ${monthName(monthOf(monday))} айының мақсаттары әлі енгізілмеген. Енгізіп қойсаң, есепке өзі қосылады.`,
          { reply_markup: goalsKeyboard([]) });
    } catch { /* бот бұғатталған */ }
  }
}

/** Дүйсенбі 08:00 — өткен аптаға әлі толтырмағандарға соңғы ескерту (Figma есебі 12:00-де жиналады) */
export async function sendGoalReminder(bot: Bot) {
  const monday = thisMonday();
  const ds = await q<P>("SELECT * FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND yougile_id IS NOT NULL AND active");
  for (const d of ds) {
    const rows = await goalsWithProgress(d.yougile_id!, monday);
    if (!rows.length || rows.every((g) => g.week_fact !== null)) continue;
    await sendFactsList(bot, d.telegram_id!, d.yougile_id!, monday, "☀️ Қайырлы таң! Апталық есеп 12:00-де жиналады — айлық мақсатыңды толтырып үлгер.").catch(() => {});
  }
}

/** Дүйсенбі 10:00 — осы айдың мақсаты жоқтарға (айдың алғашқы апталарында) еске салу */
export async function sendGoalMonthStart(bot: Bot) {
  const monday = curMonday();
  if (Number(monday.slice(8, 10)) > 14) return;
  const ds = await q<P>("SELECT * FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND yougile_id IS NOT NULL AND active");
  for (const d of ds) {
    const rows = await goalsWithProgress(d.yougile_id!, monday);
    if (rows.length) continue;
    await bot.api.sendMessage(d.telegram_id!, `🎯 Жаңа ай — ${monthName(monthOf(monday))}! Айлық мақсаттарыңды енгіз. Өткен айдағыдай болса — бір батырма.`,
      { reply_markup: goalsKeyboard(rows) }).catch(() => {});
  }
}

// ---------- Кестеден импорт (xlsx) ----------
export const GOALS_SHEET_ID = () => process.env.GOALS_SHEET_ID || "1wP-9kvsXPwUg6XZ500RZ--q4e_Dt3H8eHnnKgd2cP0Y";

/** «DESIGN БӨЛІМІ | Айлық мақсат конверсиясы» кестесін xlsx етіп жүктеу (сілтеме бойынша қарауға ашық болса) */
export async function fetchGoalsSheet(): Promise<Buffer> {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${GOALS_SHEET_ID()}/export?format=xlsx`, { redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.subarray(0, 2).toString() !== "PK")
    throw new Error("кесте ашылмады — Google Sheets-те «Настройки доступа → Все, у кого есть ссылка → Читатель» болуы керек (немесе xlsx файлды ботқа «/import_goals» қолтаңбасымен жіберіңіз)");
  return buf;
}

/** Ботта мақсаты жоқ дизайнерлерге осы айдың мақсаттарын кестеден автоматты алу */
export async function autoImportGoals(actor = "system") {
  const monday = weekOf(Date.now()).monday;
  const report = await importGoalsXlsx(await fetchGoalsSheet(), monthOf(monday), monday, actor);
  return report.filter((l) => l.startsWith("✅"));
}
const cellNum = (c: ExcelJS.Cell): { v: number | null; pct: boolean } => {
  let v: any = c.value;
  if (v && typeof v === "object" && "result" in v) v = v.result;
  if (v === null || v === undefined || v === "") return { v: null, pct: false };
  const fmtPct = String(c.numFmt ?? "").includes("%");
  if (typeof v === "number") return fmtPct ? { v: Math.round(v * 10000) / 100, pct: true } : { v, pct: false };
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(%?)$/);
  if (!m) return { v: null, pct: false };
  return { v: Number(m[1].replace(",", ".")), pct: m[2] === "%" };
};
const cellText = (c: ExcelJS.Cell) => {
  const v: any = c.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return String(v.text ?? v.hyperlink ?? v.result ?? (v.richText ? v.richText.map((x: any) => x.text).join("") : ""));
  return String(v);
};

export async function importGoalsXlsx(buffer: Buffer, month: string, monday: string, actor: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const people = await q<P & { excel_name: string }>("SELECT * FROM people WHERE role='designer' AND active AND yougile_id IS NOT NULL");
  const M = monthName(month);
  const report: string[] = [];
  for (const ws of wb.worksheets) {
    const sheet = ws.name.trim().toLowerCase();
    const p = people.find((x) => sheet.startsWith(x.excel_name.toLowerCase()));
    if (!p) continue;
    const exists = await q("SELECT 1 FROM goals WHERE designer_yid=$1 AND month=$2 AND active LIMIT 1", [p.yougile_id, month]);
    if (exists.length) { report.push(`⏭ ${p.name}: ${M} мақсаттары ботта бар — өзгертілмеді`); continue; }
    let inBlock = false, kind: Kind = "op", cols = { base: 0, target: 0, fact: 0, proof: 0 };
    const items: { kind: Kind; title: string; base: number; target: number; pct: boolean; fact: number | null; proof: string }[] = [];
    ws.eachRow((row) => {
      const texts: string[] = [];
      row.eachCell({ includeEmpty: true }, (c, i) => (texts[i] = cellText(c).trim()));
      const line = texts.join(" ");
      if (new RegExp(`^\\s*${M}\\s*-\\s*АЙЛЫҚ МАҚСАТТАР КОНВЕРСИЯСЫ`, "i").test(texts.find((t) => t) ?? "")) { inBlock = true; return; }
      if (!inBlock) return;
      if (/Ортақ көрсеткіш/i.test(line) && items.length) { inBlock = false; return; }
      const baseIdx = texts.findIndex((t) => /Бастапқы көрсеткіш/i.test(t ?? ""));
      if (baseIdx > 0) {
        kind = /Стратегиялық/i.test(line) ? "strat" : "op";
        cols = { base: baseIdx, target: baseIdx + 1, fact: baseIdx + 2, proof: baseIdx + 4 };
        return;
      }
      if (!cols.base) return;
      const title = texts[cols.base - 1];
      const no = texts[cols.base - 2];
      if (!title || !/^\d+$/.test(no ?? "")) return;
      const t = cellNum(row.getCell(cols.target)), f = cellNum(row.getCell(cols.fact)), b = cellNum(row.getCell(cols.base));
      if (!(t.v! > 0)) return;
      items.push({ kind, title: title.slice(0, 250), base: b.v ?? 0, target: t.v!, pct: t.pct, fact: f.v, proof: cellText(row.getCell(cols.proof)).trim() });
    });
    if (!items.length) { report.push(`— ${p.name}: «${M}» блогы табылмады немесе бос`); continue; }
    let pos = { op: 0, strat: 0 };
    for (const it of items) {
      const g = await one<{ id: number }>(
        "INSERT INTO goals (designer_yid, month, kind, pos, title, base, target, is_percent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [p.yougile_id, month, it.kind, ++pos[it.kind], it.title, it.base, it.target, it.pct],
      );
      if (it.fact !== null || it.proof)
        await q("INSERT INTO goal_progress (goal_id, week, fact, proof) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [g!.id, monday, it.fact ?? 0, it.proof || null]);
    }
    report.push(`✅ ${p.name}: ${items.length} мақсат (${items.filter((x) => x.kind === "op").length} оп. · ${items.filter((x) => x.kind === "strat").length} страт.)`);
  }
  await q("INSERT INTO audit_log (actor, action, entity, data) VALUES ($1,'goals_import',$2,$3)", [actor, `month:${month}`, JSON.stringify(report)]);
  return report;
}

// ---------- Обработчиктер ----------
export function registerGoals(bot: Bot, deps: {
  clearMain: (tg: number) => void; hasMain: (tg: number) => boolean; isAdmin: (p: any) => boolean;
  resendWeek: (chatId: number, p: P, monday: string) => Promise<void>;
}) {
  clearMainRef = deps.clearMain;
  const me = async (ctx: Context) => {
    const p = await personByTg(ctx.from!.id);
    if (!p?.yougile_id) {
      await ctx.reply(p ? "Мақсаттар дизайнерлерге арналған." : "Сіз тіркелмегенсіз. Админнен сілтеме сұраңыз.");
      return null;
    }
    return p;
  };
  const open = async (ctx: Context) => {
    const p = await me(ctx);
    if (p) await showGoals(bot, ctx.chat!.id, p);
  };
  const start = (ctx: Context, s: GState) => {
    deps.clearMain(ctx.from!.id);
    gstate.set(ctx.from!.id, s);
  };

  bot.hears(GOALS_BTN, (ctx) => (gstate.delete(ctx.from!.id), open(ctx)));
  bot.command("goals", open);
  bot.callbackQuery("gv", async (ctx) => (await ctx.answerCallbackQuery(), open(ctx)));

  bot.callbackQuery(/^ga:(op|strat)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await me(ctx))) return;
    start(ctx, { kind: "gAdd", goal: ctx.match[1] as Kind });
    await ctx.reply(ADD_HELP(ctx.match[1] as Kind), { parse_mode: "HTML" });
  });

  bot.callbackQuery("gc", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const n = await copyPrevMonth(p.yougile_id!, monthOf(curMonday()), `tg:${ctx.from.id}`);
    await ctx.reply(n ? `✅ Өткен айдан ${n} мақсат көшірілді. Керек емесін «✏️ Өзгерту / өшіру» арқылы алып таста.` : "Өткен айда мақсат табылмады — жаңадан енгіз.");
    await showGoals(bot, ctx.chat!.id, p);
  });

  bot.callbackQuery("gf", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    if (!(await sendFactsList(bot, ctx.chat!.id, p.yougile_id!, weekFor(ctx.from!.id)))) await ctx.reply("Алдымен мақсат енгіз.");
  });

  // Бір мақсатты толтыру
  bot.callbackQuery(/^gq:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const monday = weekFor(ctx.from!.id);
    const rows = await goalsWithProgress(p.yougile_id!, monday);
    const i = rows.findIndex((g) => g.id === Number(ctx.match[1]));
    if (i < 0) return;
    const g = rows[i];
    start(ctx, { kind: "gOne", monday, goalId: g.id });
    const kb = new InlineKeyboard();
    if (g.is_percent) [0, 25, 50, 75, 100].forEach((v) => kb.text(`${v}%`, `gqv:${g.id}:${v}`));
    kb.row();
    if (g.fact !== null) kb.text(`Өзгеріссіз (${fmtVal(g.fact, g.is_percent)})`, `gqv:${g.id}:same`);
    kb.text("↩️ Тізімге", "gf");
    await ctx.reply(
      `<b>${i + 1}. ${esc(g.title)}</b>\nМақсат: ${fmtVal(g.target, g.is_percent)} · қазір: ${fmtVal(g.fact, g.is_percent)}\n\n` +
        (g.is_percent ? "Қанша пайыз орындалды? Батырманы бас немесе санын жаз (мысалы 80)." : "Қазіргі мәнін жаз (мысалы 1,66)."),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });
  const saveOne = async (ctx: Context, p: P, goalId: number, monday: string, value: number | "same") => {
    const rows = await goalsWithProgress(p.yougile_id!, monday);
    const g = rows.find((x) => x.id === goalId);
    if (!g) return;
    const v = value === "same" ? g.fact ?? 0 : value;
    await saveFacts([{ id: g.id }], [v], monday, `tg:${ctx.from!.id}`);
    gstate.delete(ctx.from!.id);
    const after = await goalsWithProgress(p.yougile_id!, monday);
    const left = after.filter((x) => x.week_fact === null).length;
    await ctx.reply(`✔ «${esc(g.title.slice(0, 60))}» — ${fmtVal(v, g.is_percent)} → <b>${conversion(g, v)}%</b>${left ? ` · қалды: ${left}` : " · бәрі толтырылды!"}`, { parse_mode: "HTML" });
    await bot.api.sendMessage(ctx.chat!.id, factsListText(after, monday), { parse_mode: "HTML", reply_markup: factsKeyboard(after) });
  };
  bot.callbackQuery(/^gqv:(\d+):(\d+|same)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    await ctx.editMessageReplyMarkup().catch(() => {});
    await saveOne(ctx, p, Number(ctx.match[1]), weekFor(ctx.from!.id), ctx.match[2] === "same" ? "same" : Number(ctx.match[2]));
  });

  // Дайын — жалпы конверсия, сосын ұнаған жұмыс
  bot.callbackQuery("gfd", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const monday = weekFor(ctx.from!.id);
    const rows = await goalsWithProgress(p.yougile_id!, monday);
    const s = summary(rows);
    const left = rows.filter((g) => g.week_fact === null).length;
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply(
      [
        `🎯 <b>${monthName(monthOf(monday))} — айлық мақсат конверсиясы: ${s.overall}%</b>`,
        `${s.op !== null ? `Операционный: ${s.op}%` : ""}${s.op !== null && s.strat !== null ? " · " : ""}${s.strat !== null ? `Стратегиялық: ${s.strat}%` : ""}`,
        `Орындалғаны: ${s.done}/${s.total}`,
        left ? `\n⚠️ ${left} мақсат осы апта толтырылмады — бұрынғы мәні алынады.` : "",
        "\nДүйсенбі Figma есебіне осы сандар түседі.",
      ].filter(Boolean).join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: inWizard(ctx.from.id)
          ? new InlineKeyboard().text("📤 Есепті жіберу", "wzs").row().text("📎 Дәлел қосу", "gp").text("↩️ Мақсаттар", "gf")
          : new InlineKeyboard().text("⭐ Ұнаған жұмыс →", "gl").text("📎 Дәлел қосу", "gp").row().text("📤 Есепті жіберу", "wzs"),
      },
    );
  });

  // 📤 Есепті жіберу — апталық есеп дайын: белгі қойылады, деректер GitHub-қа (Figma) жаңартылады, админге хабар
  bot.callbackQuery("wzs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const monday = weekFor(ctx.from.id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await q(
      `INSERT INTO weekly_reports (week, designer_yid, status, confirmed_at, submitted_at) VALUES ($1,$2,'confirmed',now(),now())
       ON CONFLICT (week, designer_yid) DO UPDATE SET submitted_at=now()`,
      [monday, p.yougile_id],
    ).catch((e) => console.error("submit:", e.message));
    wizard.delete(ctx.from.id);
    gstate.delete(ctx.from.id);
    const rows = await goalsWithProgress(p.yougile_id!, monday);
    const liked = (await likedOf(p.yougile_id!, monday)).length;
    await ctx.reply(
      `✅ <b>Есебің жіберілді!</b> Рақмет, ${esc(p.name)}.\n` +
        `Жұмыстар · ${liked} ұнаған жұмыс · айлық мақсат ${rows.length ? summary(rows).overall + "%" : "—"} — бәрі Figma есебіне түседі.`,
      { parse_mode: "HTML" },
    );
    if (githubEnabled()) void exportWeekToGitHub(monday, `tg:${ctx.from.id}`).catch((e) => console.error("export:", e.message));
    // Админдерге: кім жіберді, неше адам қалды
    const ds = await q<{ name: string; submitted: boolean }>(
      `SELECT p.name, (w.submitted_at IS NOT NULL) AS submitted FROM people p
         LEFT JOIN weekly_reports w ON w.designer_yid=p.yougile_id AND w.week=$1
        WHERE p.role='designer' AND p.active AND p.telegram_id IS NOT NULL ORDER BY p.name`,
      [monday],
    );
    const done = ds.filter((d) => d.submitted).length;
    const left = ds.filter((d) => !d.submitted).map((d) => d.name);
    const admins = await q<P>("SELECT * FROM people WHERE (role='admin' OR is_admin) AND telegram_id IS NOT NULL AND active");
    for (const a of admins)
      await bot.api.sendMessage(a.telegram_id!, `📤 ${p.name} апталық есебін жіберді (${done}/${ds.length}).` + (left.length ? `\nҚалғаны: ${left.join(", ")}` : "\n🎉 Барлығы жіберді!"))
        .catch(() => {});
  });

  bot.callbackQuery(/^gfs$|^gfr$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = gstate.get(ctx.from.id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (s?.kind !== "gFactsOk") return;
    if (ctx.match[0] === "gfr") {
      gstate.set(ctx.from.id, { kind: "gFacts", monday: s.monday });
      return ctx.reply("Қайта жаз — ретімен, бос орынмен.");
    }
    await saveFacts(s.ids.map((id) => ({ id })), s.facts, s.monday, `tg:${ctx.from.id}`);
    gstate.delete(ctx.from.id);
    await ctx.reply("✅ Сақталды. Дәлел сілтемесін қосасың ба?", {
      reply_markup: new InlineKeyboard().text("📎 Иә, қосамын", "gp").text("Жоқ, келесі →", "gl"),
    });
  });

  bot.callbackQuery("gp", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const rows = await goalsWithProgress(p.yougile_id!, weekFor(ctx.from!.id));
    if (!rows.length) return ctx.reply("Алдымен мақсат енгіз.");
    start(ctx, { kind: "gProof", monday: weekFor(ctx.from!.id) });
    await ctx.reply(
      "📎 Дәлелді мақсат нөмірімен, әр жолға бір жаз:\n\n<code>2 https://vt.tiktok.com/...\n11 https://www.figma.com/...</code>\n\n" +
        rows.map((g, i) => `${i + 1}. ${esc(g.title)}${g.proof ? " 📎" : ""}`).join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().text("Өткізу →", "gl") },
    );
  });

  bot.callbackQuery("gl", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (p) await likedPrompt(bot, ctx.chat!.id, ctx.from.id, p);
  });
  /** Қорытындыдан кейін: ағын ішінде — 3-қадам (мақсат), әйтпесе мақсаттар мәзірі */
  const afterNotes = async (ctx: Context, p: P) => {
    const tg = ctx.from!.id;
    if (!inWizard(tg)) {
      await ctx.reply("✅ Аптаның деректері дайын. Рақмет!");
      return showGoals(bot, ctx.chat!.id, p);
    }
    const ok = await sendFactsList(bot, ctx.chat!.id, p.yougile_id!, weekFor(tg), "3️⃣ <b>Айлық мақсат</b> — әр мақсатты басып, пайызын жаңарт. Соңында «✅ Дайын».");
    if (!ok) await ctx.reply("3️⃣ Бұл айға мақсатың енгізілмеген. Есепті жібере бер:", { reply_markup: new InlineKeyboard().text("📤 Есепті жіберу", "wzs") });
  };
  const notesPrompt = async (ctx: Context) => {
    const p = await me(ctx);
    if (!p) return;
    const monday = weekFor(ctx.from!.id);
    const cur = await notesOf(p.yougile_id!, monday);
    start(ctx, { kind: "gNotes", monday });
    await ctx.reply(
      (inWizard(ctx.from!.id) ? "2️⃣ <b>Апта қорытындысы</b>\n" : "") + "📝 <b>Апта қорытындысы</b> — апталық есептің слайдына шығады. Төрт жолмен жаз, жоқ болса «-»:\n\n" +
        "<code>Мәселе: …\nШешімі: …\nЖетістік: …\nҰсыныс: …</code>" +
        (cur ? "\n\nҚазір:\n" + NOTE_KEYS.map((k) => `${NOTE_NAMES[k]}: ${esc(cur[k] ?? "-")}`).join("\n") : ""),
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Өткізу →", "gns") },
    );
  };
  bot.callbackQuery("gn", async (ctx) => (await ctx.answerCallbackQuery(), notesPrompt(ctx)));
  bot.callbackQuery("gld", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    await notesPrompt(ctx);
  });
  bot.callbackQuery("gns", async (ctx) => {
    await ctx.answerCallbackQuery();
    gstate.delete(ctx.from.id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    const p = await personByTg(ctx.from.id);
    if (p?.yougile_id) await afterNotes(ctx, p);
  });

  // ➕ Тапсырма қосу — YouGile-де жоқ жұмыс («Құқық 2 пост 5 карусель»)
  const subjectsKb = (monday: string) => {
    const kb = new InlineKeyboard();
    PICK.forEach((s, i) => { kb.text(s.label, `wsu:${i}`); if (i % 3 === 2) kb.row(); });
    return kb.row().text("🗑 Қосқанымды өшіру", `wdl:${monday}`);
  };
  bot.callbackQuery(/^wa:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const monday = ctx.match[1];
    if (!wizard.has(ctx.from.id)) wizard.set(ctx.from.id, monday);
    start(ctx, { kind: "wAdd", monday });
    await ctx.reply(
      "➕ <b>YouGile-де жоқ жұмысты қосу</b>\nПәнді таңда да, санын жаз — немесе бірден бір жолмен жаз:\n\n" +
        "<code>Құқық 2 пост 5 карусель</code>\n<code>YouTube 3 обложка</code>\n<code>HR 2 баннер</code>\n\nТүрлері: пост, карусель, обложка, рилс, таргет, баннер, раздатка, презентация.",
      { parse_mode: "HTML", reply_markup: subjectsKb(monday) },
    );
  });
  bot.callbackQuery(/^wsu:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = gstate.get(ctx.from.id);
    const pick = PICK[Number(ctx.match[1])];
    if (!pick || s?.kind !== "wAdd") return;
    gstate.set(ctx.from.id, { kind: "wAdd", monday: s.monday, subject: pick.label });
    await ctx.reply(`<b>${pick.label}</b> — қанша жасадың? Мысалы: <code>2 пост 5 карусель</code>`, { parse_mode: "HTML" });
  });
  bot.callbackQuery(/^wao$|^war$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    const s = gstate.get(ctx.from.id);
    if (s?.kind !== "wAddOk") return;
    if (ctx.match[0] === "war") {
      gstate.set(ctx.from.id, { kind: "wAdd", monday: s.monday });
      return ctx.reply("Қайта жаз: пән + саны, мысалы «Құқық 2 пост 5 карусель».");
    }
    const p = await me(ctx);
    if (!p) return;
    await q("INSERT INTO manual_works (designer_yid, week, subject, loc, items) VALUES ($1,$2,$3,$4,$5)",
      [p.yougile_id, s.monday, s.subject, JSON.stringify(s.loc), JSON.stringify(s.items)]);
    gstate.delete(ctx.from.id);
    await ctx.reply(`✅ Қосылды: ${esc(itemsText(s.subject, s.items))}. Жаңартылған есеп:`, { parse_mode: "HTML" });
    await deps.resendWeek(ctx.chat!.id, p, s.monday);
  });
  bot.callbackQuery(/^wdl:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const list = await q<any>("SELECT * FROM manual_works WHERE designer_yid=$1 AND week=$2 ORDER BY id", [p.yougile_id, ctx.match[1]]);
    if (!list.length) return ctx.reply("Бұл аптада өзің қосқан жұмыс жоқ.");
    const kb = new InlineKeyboard();
    list.forEach((m) => kb.text(`🗑 ${itemsText(m.subject, m.items)}`.slice(0, 60), `wdx:${m.id}`).row());
    await ctx.reply("Қайсысын өшіреміз?", { reply_markup: kb });
  });
  bot.callbackQuery(/^wdx:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const m = await one<any>("DELETE FROM manual_works WHERE id=$1 AND designer_yid=$2 RETURNING *", [Number(ctx.match[1]), p.yougile_id]);
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!m) return;
    await ctx.reply(`🗑 Өшірілді: ${esc(itemsText(m.subject, m.items))}`, { parse_mode: "HTML" });
    await deps.resendWeek(ctx.chat!.id, p, String(m.week instanceof Date ? m.week.toISOString().slice(0, 10) : m.week).slice(0, 10));
  });

  // Админ: Figma апталық есебіне деректерді қазір салу
  bot.command("export_figma", async (ctx) => {
    const p = await personByTg(ctx.from!.id);
    if (!deps.isAdmin(p)) return ctx.reply("Бұл команда тек админге.");
    if (!githubEnabled()) return ctx.reply("GITHUB_TOKEN орнатылмаған — Railway Variables-қа қосыңыз.");
    const monday = String(ctx.match ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? weekOf(weekOf(Date.now()).startMs - 1).monday;
    await ctx.reply(`⏳ ${monday} аптасының деректерін GitHub-қа салып жатырмын…`);
    try {
      const r = await exportWeekToGitHub(monday, `tg:${ctx.from!.id}`);
      await ctx.reply(`✅ ${r.label}: ${r.designers} дизайнер, ${r.images} сурет. Figma есебін жасауға дайын.`);
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });
  bot.callbackQuery("glc", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    await clearLiked(p.yougile_id!, weekFor(ctx.from!.id));
    await ctx.reply("Тазаланды. Жаңа суреттерді жібер.");
  });

  bot.callbackQuery("ge", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    const rows = await goalsWithProgress(p.yougile_id!, weekFor(ctx.from!.id));
    const kb = new InlineKeyboard();
    rows.forEach((g, i) => kb.text(`${i + 1}. ${g.title}`.slice(0, 60), `ge:${g.id}`).row());
    kb.text("↩️ Артқа", "gv");
    await ctx.reply("Қай мақсатты өзгертеміз?", { reply_markup: kb });
  });
  bot.callbackQuery(/^ge:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const g = await one<any>("SELECT * FROM goals WHERE id=$1", [Number(ctx.match[1])]);
    if (!g) return;
    await ctx.reply(`«${esc(g.title)}» · мақсат ${fmtVal(g.target, g.is_percent)}`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("✏️ Атауын/мәнін өзгерту", `gr:${g.id}`).text("🗑 Өшіру", `gd:${g.id}`).row().text("↩️ Артқа", "ge"),
    });
  });
  bot.callbackQuery(/^gr:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await me(ctx))) return;
    start(ctx, { kind: "gEdit", id: Number(ctx.match[1]) });
    await ctx.reply("Жаңа мәтінін жаз (мақсат мәні болса — соңына «| 95%»):");
  });
  bot.callbackQuery(/^gd:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await me(ctx);
    if (!p) return;
    await removeGoal(Number(ctx.match[1]), p.yougile_id!, `tg:${ctx.from.id}`);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply("🗑 Өшірілді.");
    await showGoals(bot, ctx.chat!.id, p);
  });

  // Админ: бөлімнің жиынтығы
  bot.command("goals_team", async (ctx) => {
    const p = await personByTg(ctx.from!.id);
    if (!deps.isAdmin(p)) return ctx.reply("Бұл команда тек админге.");
    const monday = thisMonday();
    const ds = await q<P>("SELECT * FROM people WHERE role='designer' AND active AND yougile_id IS NOT NULL ORDER BY name");
    const out = [`🎯 <b>${monthName(monthOf(monday))} — айлық мақсат конверсиясы</b>`, ""];
    const all: number[] = [];
    for (const d of ds) {
      const rows = await goalsWithProgress(d.yougile_id!, monday);
      if (!rows.length) { out.push(`⏳ ${esc(d.name)} — мақсат енгізілмеген`); continue; }
      const s = summary(rows);
      all.push(s.overall);
      out.push(`${rows.some((g) => g.week_fact !== null) ? "✅" : "⚪️"} ${esc(d.name)} — <b>${s.overall}%</b> (${s.done}/${s.total})`);
    }
    if (all.length) out.push("", `<b>Жалпы: ${Math.round(all.reduce((a, b) => a + b, 0) / all.length)}%</b>`, "✅ — осы апта факт жазған");
    await ctx.reply(out.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("import_goals", async (ctx) => {
    const p = await personByTg(ctx.from!.id);
    if (!deps.isAdmin(p)) return ctx.reply("Бұл команда тек админге.");
    const month = String(ctx.match ?? "").match(/\d{4}-\d{2}/)?.[0] ?? monthOf(curMonday());
    await ctx.reply(`⏳ ${monthName(month)} айының мақсаттарын Google Sheets кестесінен алып жатырмын…`);
    try {
      const report = await importGoalsXlsx(await fetchGoalsSheet(), month, curMonday(), `tg:${ctx.from!.id}`);
      await ctx.reply(report.join("\n") || "Дизайнер парақтары табылмады.");
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });

  // Хабарламалар: мәтін, фото, файл
  bot.on("message", async (ctx, next) => {
    const tg = ctx.from.id;
    const m = ctx.message;

    // Админ: /import_goals — xlsx файлының қолтаңбасы
    if (m.document && /^\/import_goals/.test(m.caption ?? "")) {
      const p = await personByTg(tg);
      if (!deps.isAdmin(p)) return ctx.reply("Бұл команда тек админге.");
      const month = (m.caption ?? "").match(/\d{4}-\d{2}/)?.[0] ?? monthOf(curMonday());
      await ctx.reply(`⏳ ${monthName(month)} айының мақсаттарын жүктеп жатырмын…`);
      try {
        const f = await ctx.api.getFile(m.document.file_id);
        const res = await fetch(`https://api.telegram.org/file/bot${bot.token}/${f.file_path}`);
        const report = await importGoalsXlsx(Buffer.from(await res.arrayBuffer()), month, curMonday(), `tg:${tg}`);
        return ctx.reply(report.join("\n") || "Дизайнер парақтары табылмады (парақ аты тегінен басталуы керек, мысалы «Бекжігіт Асылжан»).");
      } catch (e: any) {
        return ctx.reply(`❌ Файлды оқу мүмкін болмады: ${e.message}`);
      }
    }

    const s = gstate.get(tg);
    if (!s || deps.hasMain(tg)) return next(); // негізгі диалог (түзету, хабарлама) басым
    if (m.text?.startsWith("/")) { gstate.delete(tg); return next(); }

    if (s.kind === "gLike") {
      const photo = m.photo?.at(-1)?.file_id ?? (m.document?.mime_type?.startsWith("image/") ? m.document.file_id : undefined);
      if (!photo) {
        if (m.text) { gstate.delete(tg); return next(); }
        return ctx.reply("Сурет (фото немесе сурет-файл) жібер.");
      }
      const p = await personByTg(tg);
      if (!p?.yougile_id) return;
      const have = (await likedOf(p.yougile_id, s.monday)).length;
      if (have >= MAX_LIKED) return ctx.reply(`Аптасына ${MAX_LIKED} сурет. Ауыстырғың келсе — «🗑 Жіберілгенін тазалау».`);
      await addLiked(p.yougile_id, s.monday, photo, m.caption ?? null);
      return ctx.reply(`⭐ Қосылды (${have + 1}/${MAX_LIKED}).${have + 1 < MAX_LIKED ? " Тағы жібере аласың." : ""}`, {
        reply_markup: new InlineKeyboard().text("✅ Дайын", "gld"),
      });
    }

    if (!m.text) return next();
    const text = m.text.trim();
    const p = await personByTg(tg);
    if (!p?.yougile_id) { gstate.delete(tg); return next(); }

    if (s.kind === "wAdd" || s.kind === "wAddOk") {
      const found = findSubject(text);
      const subject = found?.label ?? (s.kind === "wAdd" ? s.subject : undefined);
      const items = parseWorkItems(text, subject);
      if (!Object.keys(items).length) {
        if (s.kind === "wAdd" && !s.subject) { gstate.delete(tg); return next(); } // бұл сұрақ болуы мүмкін
        return ctx.reply("Санын түрімен жаз, мысалы «2 пост 5 карусель» немесе «3 обложка».");
      }
      let pick: { label: string; loc: any } | undefined = subject ? pickBySubject(subject) : undefined;
      if (!pick) {
        // Тізімде жоқ пән: сандардан бұрынғы сөз — пәннің атауы («Junior Camp 2 баннер» → «Junior Camp»)
        const name = text.split(/\d/)[0].replace(/[-—:,]+$/, "").trim();
        if (!name) return ctx.reply("Қай пән/аккаунт? Батырмадан таңда немесе алдына жаз: «Құқық 2 пост».");
        pick = otherSubject(name.slice(0, 40));
      }
      gstate.set(tg, { kind: "wAddOk", monday: s.monday, subject: pick.label, loc: pick.loc, items });
      return ctx.reply(`➕ <b>${esc(itemsText(pick.label, items))}</b>\nЕсепке қосамын ба?`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✅ Қосу", "wao").text("✏️ Қайта жазу", "war"),
      });
    }

    if (s.kind === "gAdd") {
      const items = parseGoalLines(text);
      if (!items.length) return ctx.reply("Мақсат табылмады. Әр жолға бір мақсат жаз.");
      gstate.delete(tg);
      const r = await addGoals(p.yougile_id, monthOf(curMonday()), s.goal, items, `tg:${tg}`);
      await ctx.reply(`✅ ${r.added} мақсат қосылды.${r.skipped ? ` ${r.skipped} мақсат сыймады (ең көбі 15).` : ""}`);
      return showGoals(bot, ctx.chat!.id, p);
    }

    if (s.kind === "gEdit") {
      gstate.delete(tg);
      const ok = await renameGoal(s.id, p.yougile_id, text, `tg:${tg}`);
      await ctx.reply(ok ? "✅ Өзгертілді." : "Мәтін тым қысқа.");
      return showGoals(bot, ctx.chat!.id, p);
    }

    if (s.kind === "gOne") {
      const v = Number(text.replace("%", "").replace(",", ".").trim());
      if (!Number.isFinite(v) || v < 0 || v > 100000) return ctx.reply("Тек сан жаз, мысалы 80 немесе 1,66.");
      return saveOne(ctx, p, s.goalId, s.monday, v);
    }

    if (s.kind === "gFacts" || s.kind === "gFactsOk") {
      const monday = s.monday;
      const rows = await goalsWithProgress(p.yougile_id, monday);
      const parsed = parseFacts(text);
      if (!parsed.length) { gstate.delete(tg); return next(); } // сан жоқ — бұл сұрақ, фактіні кейін «📈» арқылы жазады
      if (parsed.length !== rows.length)
        return ctx.reply(`${rows.length} сан керек, ал ${parsed.length} табылды. Ретімен, бос орынмен қайта жаз.`);
      const values = parsed.map((v, i) => (v === null ? rows[i].fact ?? 0 : v));
      const preview = rows.map((g, i) => `${i + 1}. ${esc(g.title.slice(0, 50))} — ${fmtVal(values[i], g.is_percent)} → <b>${conversion(g, values[i])}%</b>`);
      const s2 = summary(rows.map((g, i) => ({ ...g, fact: values[i] })));
      gstate.set(tg, { kind: "gFactsOk", monday, ids: rows.map((g) => g.id), facts: values });
      return ctx.reply([...preview, "", `<b>Ортақ көрсеткіш: ${s2.overall}%</b>`].join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✅ Сақтау", "gfs").text("✏️ Қайта жазу", "gfr"),
      });
    }

    if (s.kind === "gNotes") {
      const n = parseNotes(text);
      await saveNotes(p.yougile_id, s.monday, n);
      gstate.delete(tg);
      await ctx.reply("📝 Сақталды:\n" + NOTE_KEYS.map((k) => `${NOTE_NAMES[k]}: ${esc(n[k] ?? "-")}`).join("\n"), { parse_mode: "HTML" });
      return afterNotes(ctx, p);
    }

    if (s.kind === "gProof") {
      const rows = await goalsWithProgress(p.yougile_id, s.monday);
      const proofs = parseProofs(text);
      const nums = Object.keys(proofs).map(Number).filter((n) => n >= 1 && n <= rows.length);
      if (!nums.length) return ctx.reply("Формат: мақсат нөмірі + сілтеме, мысалы «2 https://…».");
      for (const n of nums) await saveProof(rows[n - 1].id, s.monday, proofs[n]);
      gstate.delete(tg);
      return ctx.reply(`📎 ${nums.length} дәлел сақталды.`, { reply_markup: new InlineKeyboard().text("⭐ Ұнаған жұмыс →", "gl").text("🎯 Мақсаттарым", "gv") });
    }
    return next();
  });
}
