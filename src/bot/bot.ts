/**
 * Telegram бот. Дерек енгізу құралы емес: дайын есепті көрсетеді, батырмалармен түзетеді.
 * Рөлдер: admin (бәрін көреді), designer (тек өзінікін), viewer (басшы — тек Excel алады).
 */
import { Bot, InlineKeyboard, InputFile, Keyboard, type Context } from "grammy";
import { randomBytes } from "node:crypto";
import { q, one, audit } from "../db/db.js";
import { weekRows, designerReportText, designerDetailsText, taskLine, adminSummaryText, taskName, subjectOf, fmtItems, esc } from "../services/reports.js";
import { buildWeekWorkbook } from "../services/excel.js";
import { answerCalc, correctCalc, revertCorrection, skipCalc, getCalc, recalcOpenWeeks, type CalcRow } from "../services/calcs.js";
import { WORK_TYPES, subjectFor } from "../seed/catalog.js";
import { weekOf, weekRangeText, weekFromMonday } from "../time/week.js";
void weekRangeText;
import { config } from "../config.js";
import { askAI } from "../services/ai.js";
import { registerGoals, GOALS_BTN, clearGoalState } from "./goalsBot.js";
import { goalsBlock, teamGoalsLine } from "../services/goals.js";
import { publishOpenWeeks, publishWeek, sheetUrl, sheetsClient } from "../services/sheets.js";
import { designerCard, teamCard } from "../services/card.js";

export type Person = {
  id: number; role: "admin" | "designer" | "viewer"; name: string; yougile_id: string | null;
  telegram_id: number | null; is_admin: boolean; tg_username?: string | null;
};
export const isAdmin = (p?: Person | null) => !!p && (p.role === "admin" || p.is_admin);

type State =
  | { kind: "fixDraft"; calcId: number; items: Record<string, number> }
  | { kind: "fixNum"; calcId: number; wt: string; items?: Record<string, number> }
  | { kind: "fixReason"; calcId: number; items: Record<string, number> }
  | { kind: "manual"; calcId: number }
  | { kind: "msgPick"; selected: number[] }
  | { kind: "msgText"; recipients: number[] }
  | { kind: "msgConfirm"; recipients: number[]; chatId: number; messageId: number }
  | { kind: "reply"; toTg: number };
const state = new Map<number, State>();

const personByTg = (id: number) => one<Person>("SELECT * FROM people WHERE telegram_id=$1 AND active", [id]);
const lastMonday = () => weekOf(weekOf(Date.now()).startMs - 1).monday;
const mondayArg = (text?: string) => text?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? lastMonday();

/** Ұзын мәтінді 4000 таңбалық бөліктерге бөлу */
async function sendLong(ctx: Context, text: string, kb?: InlineKeyboard, html = false) {
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line).length > 3900) (parts.push(cur), (cur = ""));
    cur += line + "\n";
  }
  parts.push(cur);
  for (let i = 0; i < parts.length; i++)
    await ctx.reply(parts[i], {
      ...(i === parts.length - 1 && kb ? { reply_markup: kb } : {}),
      ...(html ? { parse_mode: "HTML" as const } : {}),
    });
}

const WEBAPP_URL = process.env.WEBAPP_URL?.replace(/\/$/, "") || "";

export function weeklyKeyboard(monday: string) {
  const kb = new InlineKeyboard().text("👀 Толығырақ", `rep:${monday}`).text("✏️ Қате бар", `err:${monday}`).row().text("✅ Бәрі дұрыс", `ok:${monday}`);
  if (WEBAPP_URL) kb.row().webApp("📱 Қосымшада ашу", WEBAPP_URL);
  return kb;
}

const prevMonday = (monday: string) => weekOf(weekFromMonday(monday).startMs - 1).monday;

/** Дизайнерге: сурет-карточка + мәтіндік есеп (батырмалармен) */
async function sendDesignerWeek(bot: Bot, chatId: number, p: Person, monday: string) {
  const rows = await weekRows(monday, p.yougile_id!);
  const prev = await weekRows(prevMonday(monday), p.yougile_id!);
  try {
    await bot.api.sendPhoto(chatId, new InputFile(designerCard(p.name, monday, rows, prev), "report.png"));
  } catch (e: any) {
    console.error("card:", e.message);
  }
  const goals = await goalsBlock(p.yougile_id!, monday).catch(() => "");
  await bot.api.sendMessage(chatId, designerReportText(p.name, monday, rows, prev) + (goals ? `\n${goals}` : ""), { parse_mode: "HTML", reply_markup: weeklyKeyboard(monday) });
}

/**
 * Тіркелген сәттегі «вау»: бот дизайнердің жұмысын бұрыннан біледі.
 * Сәлемдесу → өткен аптаның карточкасы → ашық тапсырмалар саны → қысқа тур.
 */
export async function welcomeDesigner(bot: Bot, chatId: number, p: Person) {
  const send = (text: string, extra: object = {}) => bot.api.sendMessage(chatId, text, { parse_mode: "HTML", ...extra }).catch(() => {});
  await send(`👋 <b>${esc(p.name)}, қош келдің!</b>\nМен YouGile-дегі жұмысыңды бұрыннан көріп отырмын — міне, өткен аптаң:`, { reply_markup: menu() });
  const last = weekOf(weekOf(Date.now()).startMs - 1).monday;
  const rows = await weekRows(last, p.yougile_id!);
  if (rows.length) await sendDesignerWeek(bot, chatId, p, last).catch((e) => console.error("welcome:", e.message));
  else await send("Өткен аптада ✓ болған тапсырмаң табылмады — бұл аптадан бастап бәрін өзім санаймын.");
  const open = await q<any>("SELECT deadline_at FROM open_tasks WHERE $1 = ANY(assigned)", [p.yougile_id]);
  const late = open.filter((o) => o.deadline_at && new Date(o.deadline_at).getTime() < Date.now()).length;
  const kb = new InlineKeyboard().text("📋 Ашық тапсырмаларым", "wl:tasks").text("❓ Не істей аласың?", "wl:help");
  if (WEBAPP_URL) kb.row().webApp("📱 Қосымшаны ашу", WEBAPP_URL);
  await send(
    [
      open.length ? `📋 Қазір YouGile-де <b>${open.length}</b> ашық тапсырмаң бар${late ? `, оның ${late}-нің мерзімі өтіп кеткен` : ""}.` : "📋 Қазір ашық тапсырмаң жоқ — тамаша!",
      "",
      "<b>Енді не болады:</b>",
      "• Дүйсенбі 09:00 — апталық есебің осылай өзі келеді",
      "• Күн сайын 21:50 — HR есебіне көшіруге дайын тізім",
      "• Есеп туралы кез келген сұрақты жай жаза бер, мысалы: <i>«осы аптада неше карусель жасадым?»</i>",
      "",
      "❗️ Жалғыз ереже: дайын файлды YouGile тапсырмасының <b>чатына</b> сал, сосын ✓ қой.",
    ].join("\n"),
    { reply_markup: kb },
  );
}

/** Админ/басшыға: жалпы карточка + мәтін */
async function sendTeamWeek(bot: Bot, chatId: number, monday: string) {
  const rows = await weekRows(monday);
  const prev = await weekRows(prevMonday(monday));
  try {
    await bot.api.sendPhoto(chatId, new InputFile(teamCard(monday, rows, prev), "team.png"));
  } catch (e: any) {
    console.error("card:", e.message);
  }
  const goals = await teamGoalsLine(monday).catch(() => "");
  const text = (await adminSummaryText(monday)) + (goals ? `\n${goals}` : "");
  await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", ...(WEBAPP_URL ? { reply_markup: new InlineKeyboard().webApp("📱 Қосымшада ашу", WEBAPP_URL) } : {}) });
}

export async function notifyAdmins(bot: Bot, text: string, kb?: InlineKeyboard, html = false) {
  for (const a of await q<Person>("SELECT * FROM people WHERE (role='admin' OR is_admin) AND telegram_id IS NOT NULL AND active"))
    await bot.api.sendMessage(a.telegram_id!, text, { ...(kb ? { reply_markup: kb } : {}), ...(html ? { parse_mode: "HTML" as const } : {}) }).catch(() => {});
}

export async function sendExcel(bot: Bot, chatId: number, monday: string, caption: string) {
  const { buffer, filename } = await buildWeekWorkbook(monday);
  await bot.api.sendDocument(chatId, new InputFile(buffer, filename), { caption });
}

// ---------- Боттың профилі ----------
export const PROFILE = {
  name: "JUZ40 Design · Есеп",
  short: "JUZ40 дизайн бөлімінің апталық есебі: YouGile-ден автоматты жиналады, Telegram-да тексеріледі.",
  description: `Сәлем! Бұл — JUZ40 дизайн бөлімінің есеп боты.

📊 Апталық есебің YouGile-ден автоматты жиналады — қолмен ештеңе толтырмайсың
📋 Ашық тапсырмаларың мен дедлайндарың бір жерде
✏️ Қате болса — бір батырмамен түзетесің
💬 Есебің туралы кез келген сұрақты жай жаза бер

Тіркелу үшін админнен шақыру сілтемесін ал.`,
};

export async function applyProfile(bot: Bot) {
  // Тек өзгерген болса жаңартамыз (Telegram жиі өзгертуге шектеу қояды)
  const cur = {
    short: (await bot.api.getMyShortDescription().catch(() => null))?.short_description,
    desc: (await bot.api.getMyDescription().catch(() => null))?.description,
    name: (await bot.api.getMyName().catch(() => null))?.name,
  };
  if (cur.short !== PROFILE.short) await bot.api.setMyShortDescription(PROFILE.short).catch((e) => console.error("profile:", e.message));
  if (cur.desc !== PROFILE.description) await bot.api.setMyDescription(PROFILE.description).catch((e) => console.error("profile:", e.message));
  if (cur.name !== PROFILE.name) await bot.api.setMyName(PROFILE.name).catch((e) => console.error("profile name:", e.message));
  if (WEBAPP_URL)
    await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "📱 Есеп", web_app: { url: WEBAPP_URL } } }).catch((e) => console.error("menu:", e.message));
}

// ---------- HR есебіне дайындық (juzhrm.kz интеграциясы болғанша) ----------
const YG_TASK_URL = process.env.YOUGILE_TASK_URL || "https://ru.yougile.com/team/my-tasks#{code}";
const HR_COMMENT = "Тапсырма орындалды. Дәлел скриншотта көрсетілген.";
const ALMATY = 5 * 3600_000;

/** Алматы бойынша күннің басы (UTC мс). day: "YYYY-MM-DD" немесе бос — бүгін */
export function almatyDayStart(day?: string) {
  if (day) return Date.parse(`${day}T00:00:00Z`) - ALMATY;
  const local = Date.now() + ALMATY;
  return Math.floor(local / 86400_000) * 86400_000 - ALMATY;
}

export async function hrPrepText(p: Person, dayStart: number) {
  const rows = await q<any>(
    `SELECT DISTINCT ON (t.yougile_id) t.code, t.title, t.completed_at, t.raw->'deadline'->>'deadline' AS deadline
       FROM calculations c JOIN tasks t ON t.yougile_id=c.task_id
      WHERE c.designer_yid=$1 AND t.completed_at >= to_timestamp($2/1000.0) AND t.completed_at < to_timestamp($3/1000.0)
      ORDER BY t.yougile_id, t.completed_at`,
    [p.yougile_id, dayStart, dayStart + 86400_000],
  );
  rows.sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
  const fmt = (ms: number) => new Date(ms).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  const dayLabel = new Date(dayStart + ALMATY).toISOString().slice(0, 10).split("-").reverse().slice(0, 2).join(".");
  if (!rows.length) return { count: 0, text: `🗂 ${dayLabel}: YouGile-де ✓ болған тапсырма табылмады.\n(Синхронизация 15 минут сайын жүреді — жақында жапқан болсаңыз, сәл кейін /hr қайта басыңыз.)` };
  const out = [`🗂 <b>HR есебіне дайын · ${dayLabel}</b> (${rows.length} тапсырма)`, "Атауын басып көшіріңіз, сілтеме арқылы чатты ашып скриншот алыңыз.", ""];
  rows.forEach((r, i) => {
    const dl = r.deadline ? `, дедлайн ${fmt(Number(r.deadline))}` : "";
    const url = YG_TASK_URL.replace("{code}", encodeURIComponent(r.code));
    out.push(`${i + 1}. <code>жасау: ${esc(r.title)}${dl}</code>\n    <a href="${esc(url)}">YouGile-де ашу</a>`);
  });
  out.push("", `Пікір: <code>${HR_COMMENT}</code>`);
  return { count: rows.length, text: out.join("\n") };
}

/** Күн сайын 21:50 — әр дизайнерге (тапсырмасы болса ғана) */
export async function sendHrPrep(bot: Bot) {
  const ds = await q<Person>("SELECT * FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND active");
  const day = almatyDayStart();
  for (const d of ds) {
    const r = await hrPrepText(d, day);
    if (r.count) await bot.api.sendMessage(d.telegram_id!, r.text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
  }
}

// ---------- Мәзір ----------
export const BTN = { week: "📊 Осы апта", last: "📅 Өткен апта", tasks: "📋 Ашық тапсырмаларым", help: "❓ Көмек" };
export const menu = () =>
  new Keyboard().text(BTN.week).text(BTN.last).row().text(BTN.tasks).text(GOALS_BTN).row().text(BTN.help).resized().persistent();

export const USER_COMMANDS = [
  { command: "me", description: "Осы аптадағы есебім" },
  { command: "hr", description: "HR есебіне дайын тізім (бүгін)" },
  { command: "last", description: "Өткен аптадағы есебім" },
  { command: "goals", description: "Айлық мақсаттарым" },
  { command: "tasks", description: "Ашық тапсырмаларым" },
  { command: "help", description: "Көмек және сұрақ мысалдары" },
];
export const ADMIN_COMMANDS = [
  ...USER_COMMANDS,
  { command: "msg", description: "Қызметкерлерге хабарлама жіберу" },
  { command: "weekly", description: "Админ: аптаның жиынтығы" },
  { command: "review", description: "Админ: тексеру кезегі" },
  { command: "export", description: "Админ: Excel" },
  { command: "sheet", description: "Админ: Google Sheets-ті жаңарту" },
  { command: "send_boss", description: "Админ: Excel-ді басшыға жіберу" },
  { command: "close_week", description: "Админ: аптаны жіберусіз жабу" },
  { command: "invite", description: "Админ: топқа тіркелу шақыруы" },
  { command: "user", description: "Админ: қызметкердің @username-і" },
  { command: "code", description: "Админ: жеке тіркеу сілтемесі" },
  { command: "people", description: "Админ: адамдар тізімі" },
  { command: "sync", description: "Админ: қазір синхронизация" },
  { command: "recalc", description: "Админ: ережелер бойынша қайта есептеу" },
  { command: "goals_team", description: "Админ: бөлімнің айлық мақсат конверсиясы" },
  { command: "import_goals", description: "Админ: мақсат кестесін (xlsx) жүктеу" },
  { command: "export_figma", description: "Админ: Figma есебіне деректерді салу" },
];

export const BOSS_COMMANDS = [{ command: "msg", description: "Қызметкерлерге хабарлама жіберу" }];

/** Админге — толық тізім, басшыға — /msg (тек олардың чатында көрінеді) */
export async function setAdminCommands(bot: Bot) {
  for (const a of await q<Person>("SELECT * FROM people WHERE (role IN ('admin','viewer') OR is_admin) AND telegram_id IS NOT NULL AND active"))
    await bot.api
      .setMyCommands(isAdmin(a) ? ADMIN_COMMANDS : BOSS_COMMANDS, { scope: { type: "chat", chat_id: a.telegram_id! } })
      .catch(() => {});
}

/** Хабарлама жібере алатындар: админ және басшы */
export const canMessage = (p?: Person | null) => !!p && (isAdmin(p) || p.role === "viewer");

async function pickKeyboard(selected: number[]) {
  const ds = await q<Person>("SELECT * FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND active ORDER BY name");
  const kb = new InlineKeyboard();
  ds.forEach((d, i) => {
    kb.text(`${selected.includes(d.id) ? "✅" : "▫️"} ${d.name}`, `mp:${d.id}`);
    if (i % 2) kb.row();
  });
  kb.row().text(selected.length === ds.length && ds.length ? "↩️ Ешкімді" : "👥 Барлығы", "mp:all").text(`➡️ Келесі (${selected.length})`, "mp:next");
  return { kb, count: ds.length };
}

const HELP = (admin: boolean) => `<b>Бот не істей алады</b>
${BTN.week} — осы аптадағы есебің (дүйсенбіден бүгінге дейін)
${BTN.last} — өткен аптаның есебі
${BTN.tasks} — YouGile-де әлі ✓ болмаған тапсырмаларың, дедлайнымен
${GOALS_BTN} — айлық мақсаттар: енгізу, сенбі сайын факт, дәлел, ұнаған жұмыстар
Есептің астындағы <b>✏️ Қате бар</b> — санды түзету

<b>Сұрақты жай мәтінмен жаза бер</b>, мысалы:
• Осы аптада Биологиядан неше карусель жасадым?
• 01.10 күні қандай тапсырмалар орындадым?
• «Мотив пост» неге 1 пост қана болып тұр?
• Дедлайны бүгін біткен тапсырмам бар ма?

<b>HR есебі:</b> күн сайын 21:50-де бот сол күні ✓ болған тапсырмаларыңның көшіруге дайын тізімін жібереді. Кез келген уақытта: /hr (немесе /hr 01.10)${admin ? "\n\n<b>Админ:</b> /invite /user /msg /weekly /review /export /send_boss /close_week /code /people /sync" : ""}

Есеп YouGile-ден автоматты жиналады: дайын файлды міндетті түрде тапсырма чатына сал.`;

export async function openTasksText(p: Person) {
  const all = isAdmin(p) && !p.yougile_id;
  const rows = await q<any>(
    "SELECT * FROM open_tasks WHERE ($1::text IS NULL OR $1 = ANY(assigned)) ORDER BY deadline_at NULLS LAST, created_at_yg",
    [all ? null : p.yougile_id],
  );
  if (!rows.length) return "✅ Ашық тапсырма жоқ.";
  const names = new Map((await q<any>("SELECT yougile_id, name FROM people WHERE role='designer'")).map((x) => [x.yougile_id, x.name]));
  const fmt = (d: string) => new Date(d).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const out = [`📋 <b>Ашық тапсырмалар: ${rows.length}</b>`];
  for (const o of rows.slice(0, 60)) {
    const subj = subjectFor(o.project ? { project: o.project, board: o.board, column: o.column_name } : null).name;
    const late = o.deadline_at && new Date(o.deadline_at).getTime() < Date.now();
    const dl = o.deadline_at ? ` — ${late ? "🔴 мерзімі өткен " : "⏰ "}${fmt(o.deadline_at)}` : "";
    const who = all ? ` · ${(o.assigned as string[]).map((id) => names.get(id)).filter(Boolean).join(", ")}` : "";
    out.push(`• «${esc(o.title)}» · ${esc(subj)}${esc(who)}${dl}`);
  }
  if (rows.length > 60) out.push(`…тағы ${rows.length - 60}`);
  return out.join("\n");
}

export function createBot(token: string, hooks: { runSync: () => Promise<string> }) {
  const bot = new Bot(token);

  // Айлық мақсаттар (өз хабарлама ағыны бар — негізгі диалогтардан бұрын тіркеледі)
  registerGoals(bot, { clearMain: (tg) => state.delete(tg), hasMain: (tg) => state.has(tg), isAdmin });

  // ---------- Тіркелу ----------
  bot.command("start", async (ctx) => {
    const code = ctx.match?.trim();
    const tg = ctx.from!.id;
    const me = await personByTg(tg);
    if (!code) {
      return me
        ? ctx.reply(`Сәлем, ${me.name}! Төмендегі мәзірді пайдалан немесе сұрағыңды жаз.`, { reply_markup: menu() })
        : ctx.reply("Сәлем! Бұл JUZ40 дизайн бөлімінің есеп боты. Тіркелу үшін админнен жеке сілтеме сұраңыз.");
    }
    if (code === "join") {
      if (me) return ctx.reply(`Сіз бұрын тіркелгенсіз, ${me.name}.`, { reply_markup: menu() });
      const uname = (ctx.from!.username ?? "").toLowerCase();
      const p = uname
        ? await one<Person>("SELECT * FROM people WHERE lower(tg_username)=$1 AND telegram_id IS NULL AND active AND role IN ('designer','viewer')", [uname])
        : undefined;
      if (p) {
        await q("UPDATE people SET telegram_id=$2, link_code=NULL WHERE id=$1", [p.id, tg]);
        await audit(`tg:${tg}`, "linked_by_username", `people:${p.id}`, { username: uname });
        if (p.role === "viewer") await setAdminCommands(bot);
        if (p.role === "designer") {
          await welcomeDesigner(bot, tg, { ...p, telegram_id: tg });
          return notifyAdmins(bot, `🔗 ${p.name} тіркелді (@${uname}).`);
        }
        await ctx.reply(
          p.role === "viewer"
            ? `✅ ${p.name}, тіркелдіңіз! Апталық Excel сейсенбі 10:00-де келеді.\nҚызметкерлерге хабарлама: /msg`
            : `✅ ${p.name}, тіркелдіңіз! Апталық есебің дүйсенбі 09:00-де келеді.\nТөмендегі мәзірді пайдалан немесе сұрағыңды жай жаз.`,
          p.role === "viewer" ? undefined : { reply_markup: menu() },
        );
        return notifyAdmins(bot, `🔗 ${p.name} тіркелді (@${uname}).`);
      }
      // Username сәйкес келмеді → админ растайды
      const free = await q<Person>("SELECT * FROM people WHERE telegram_id IS NULL AND active AND role IN ('designer','viewer') ORDER BY role, name");
      const kb = new InlineKeyboard();
      free.forEach((f, i) => {
        kb.text(`${f.role === "viewer" ? "👔 " : ""}${f.name}`, `ap:${f.id}:${tg}`);
        if (i % 2) kb.row();
      });
      kb.row().text("❌ Қабылдамау", `apn:${tg}`);
      await notifyAdmins(
        bot,
        `🙋 Тіркелу сұрауы: ${ctx.from!.first_name ?? ""} ${ctx.from!.last_name ?? ""} ${uname ? "@" + uname : "(username жоқ)"}\nБұл кім? Таңдаңыз:`,
        kb,
      );
      return ctx.reply("Сұрауыңыз админге жіберілді. Растағаннан кейін бот өзі хабар береді.");
    }
    if (code === config.adminSetupCode()) {
      const hasAdmin = await one("SELECT 1 FROM people WHERE (role='admin' OR is_admin) AND active");
      if (hasAdmin) return ctx.reply("Админ бұрын тіркелген.");
      await q("INSERT INTO people (role, name, telegram_id) VALUES ('admin',$1,$2)", [ctx.from!.first_name ?? "Admin", tg]);
      await audit(`tg:${tg}`, "admin_registered", "people");
      await setAdminCommands(bot);
      return ctx.reply("✅ Сіз админ ретінде тіркелдіңіз.\nКомандалар: /weekly /review /export /send_boss /close_week /code /people /sync\nӨзіңіз дизайнер болсаңыз: /code АТЫҢЫЗ → сілтемені өзіңіз басыңыз.\nЕсеп туралы кез келген сұрақты жай мәтінмен жазуға болады.");
    }
    const p = await one<Person & { link_code_at: string }>("SELECT * FROM people WHERE link_code=$1", [code]);
    if (!p || Date.now() - new Date(p.link_code_at).getTime() > 7 * 86400_000) return ctx.reply("Код жарамсыз немесе ескірген. Админнен жаңасын сұраңыз.");
    let makeAdmin = false;
    if (me && me.id !== p.id) {
      // Тек-админ аккаунты дизайнер жолымен біріктіріледі: адам әрі админ, әрі дизайнер болады
      if (me.role === "admin" && !me.yougile_id && p.role === "designer") {
        await q("UPDATE people SET telegram_id=NULL, active=false WHERE id=$1", [me.id]);
        makeAdmin = true;
      } else return ctx.reply("Бұл Telegram аккаунты басқа адамға тіркелген.");
    }
    await q("UPDATE people SET telegram_id=$2, link_code=NULL, is_admin=(is_admin OR $3) WHERE id=$1", [p.id, tg, makeAdmin]);
    await audit(`tg:${tg}`, "linked", `people:${p.id}`);
    if (makeAdmin || p.role === "viewer") await setAdminCommands(bot);
    if (p.role === "designer") {
      await welcomeDesigner(bot, tg, { ...p, telegram_id: tg });
      if (makeAdmin) await ctx.reply("Админ құқығыңыз сақталды.");
      return notifyAdmins(bot, `🔗 ${p.name} Telegram-ға тіркелді.`);
    }
    await ctx.reply(
      `✅ ${p.name}, тіркелдіңіз! ${p.role === "viewer" ? "Апталық Excel сейсенбі 10:00-де келеді.\nҚызметкерлерге хабарлама жіберу: /msg" : "Апталық есебің дүйсенбі 09:00-де келеді.\nТөмендегі мәзірді пайдалан немесе есебің туралы сұрақты жай жаз, мысалы: «осы аптада неше карусель жасадым?»"}${makeAdmin ? "\nАдмин құқығыңыз сақталды." : ""}`,
      p.role === "viewer" ? undefined : { reply_markup: menu() },
    );
    await notifyAdmins(bot, `🔗 ${p.name} Telegram-ға тіркелді.`);
  });

  // ---------- Рөл тексеру ----------
  const admin = async (ctx: Context) => {
    const p = await personByTg(ctx.from!.id);
    if (!isAdmin(p)) {
      await ctx.reply("Бұл команда тек админге.");
      return null;
    }
    return p;
  };

  // ---------- Админ командалары ----------
  bot.command("code", async (ctx) => {
    const a = await admin(ctx);
    if (!a) return;
    const arg = ctx.match?.trim();
    if (!arg) return ctx.reply("Қолдану: /code Асылжан  немесе  /code басшы Темірлан");
    let p: Person | undefined;
    const boss = arg.match(/^басшы\s+(.+)$/i);
    if (boss) {
      p = await one<Person>("SELECT * FROM people WHERE role='viewer' AND lower(name)=lower($1)", [boss[1]]);
      if (!p) p = await one<Person>("INSERT INTO people (role, name) VALUES ('viewer',$1) RETURNING *", [boss[1]]);
    } else {
      p = await one<Person>("SELECT * FROM people WHERE role='designer' AND (lower(name)=lower($1) OR lower(excel_name)=lower($1))", [arg]);
    }
    if (!p) return ctx.reply("Адам табылмады. Дизайнерлер тізімі: /people");
    const code = randomBytes(4).toString("hex");
    await q("UPDATE people SET link_code=$2, link_code_at=now() WHERE id=$1", [p.id, code]);
    const link = `https://t.me/${bot.botInfo.username}?start=${code}`;
    await ctx.reply(`${p.name} үшін тіркеу сілтемесі (7 күн жарамды):\n${link}\n\nСілтемені тек сол адамға жіберіңіз.`);
  });

  bot.command("user", async (ctx) => {
    if (!(await admin(ctx))) return;
    const m = ctx.match?.trim().match(/^(.+?)\s+@?([A-Za-z0-9_]{4,})$/);
    if (!m) return ctx.reply("Қолдану: /user Жания @zhaniya_k   (басшыға: /user басшы Темірлан @username)");
    const boss = m[1].match(/^басшы\s+(.+)$/i);
    let p: Person | undefined;
    if (boss) {
      p = await one<Person>("SELECT * FROM people WHERE role='viewer' AND lower(name)=lower($1)", [boss[1]]);
      if (!p) p = await one<Person>("INSERT INTO people (role, name) VALUES ('viewer',$1) RETURNING *", [boss[1]]);
    } else p = await one<Person>("SELECT * FROM people WHERE role='designer' AND (lower(name)=lower($1) OR lower(excel_name)=lower($1))", [m[1]]);
    if (!p) return ctx.reply("Адам табылмады. Тізім: /people");
    await q("UPDATE people SET tg_username=$2 WHERE id=$1", [p.id, m[2].toLowerCase()]);
    await ctx.reply(`✅ ${p.name} → @${m[2].toLowerCase()}. Ол шақыру сілтемесін басқанда автоматты тіркеледі.`);
  });

  bot.command("invite", async (ctx) => {
    if (!(await admin(ctx))) return;
    const link = `https://t.me/${bot.botInfo.username}?start=join`;
    await ctx.reply(
      `👋 <b>JUZ40 Design есеп боты</b>\n\nАпталық есебіңді YouGile-ден автоматты жинап береді, ашық тапсырмаларыңды көрсетеді, сұрақтарыңа жауап береді.\n\nТөмендегі батырманы басып, <b>Start</b> бас — бот сені өзі таниды.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().url("🚀 Ботқа тіркелу", link) },
    );
    if (ctx.chat?.type === "private")
      await ctx.reply("☝️ Осы хабарламаны дизайнерлер тобына жіберіңіз (Forward) немесе ботты топқа қосып, сол жерде /invite жазыңыз.");
  });

  bot.callbackQuery(/^ap:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await admin(ctx))) return;
    const [pid, tg] = [Number(ctx.match[1]), Number(ctx.match[2])];
    if (await personByTg(tg)) return ctx.reply("Бұл Telegram аккаунты бұрын тіркелген.");
    const p = await one<Person>("UPDATE people SET telegram_id=$2, link_code=NULL WHERE id=$1 AND telegram_id IS NULL RETURNING *", [pid, tg]);
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!p) return ctx.reply("Бұл адам бұрын тіркелген.");
    await audit(`tg:${ctx.from.id}`, "linked_by_admin", `people:${p.id}`, { tg });
    if (p.role === "viewer") await setAdminCommands(bot);
    if (p.role === "designer") {
      await welcomeDesigner(bot, tg, { ...p, telegram_id: tg });
      return ctx.reply(`✅ ${p.name} тіркелді.`);
    }
    await bot.api
      .sendMessage(tg, `✅ ${p.name}, тіркелдіңіз!${p.role === "viewer" ? " Апталық Excel сейсенбі 10:00-де келеді. Хабарлама: /msg" : " Төмендегі мәзірді пайдалан немесе сұрағыңды жай жаз."}`, p.role === "viewer" ? undefined : { reply_markup: menu() })
      .catch(() => {});
    await ctx.reply(`✅ ${p.name} тіркелді.`);
  });

  bot.callbackQuery(/^apn:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await admin(ctx))) return;
    await ctx.editMessageReplyMarkup().catch(() => {});
    await bot.api.sendMessage(Number(ctx.match[1]), "Тіркелу сұрауыңыз қабылданбады. Сұрақ болса, админге хабарласыңыз.").catch(() => {});
    await ctx.reply("❌ Қабылданбады.");
  });

  bot.command("people", async (ctx) => {
    if (!(await admin(ctx))) return;
    const ps = await q<Person>("SELECT * FROM people WHERE active ORDER BY role, name");
    await ctx.reply(ps.map((p) => `${p.telegram_id ? "✅" : "⏳"} ${p.name} (${p.role})${p.tg_username ? " @" + p.tg_username : ""}`).join("\n") || "Бос");
  });

  bot.command("weekly", async (ctx) => {
    if (!(await admin(ctx))) return;
    await sendTeamWeek(bot, ctx.chat!.id, mondayArg(ctx.match));
  });

  bot.command("review", async (ctx) => {
    if (!(await admin(ctx))) return;
    const monday = mondayArg(ctx.match);
    const rows = (await weekRows(monday)).filter((r) => ["needs_review", "no_files", "ask_designer"].includes(r.status));
    if (!rows.length) return ctx.reply("✅ Тексеру кезегі бос.");
    for (const r of rows.slice(0, 20)) {
      const kb = new InlineKeyboard().text("✏️ Санды қою", `fix:${r.id}`).text("⏭ Есептемеу", `skip:${r.id}`);
      await ctx.reply(`<b>${esc(r.designer)}</b>: ${taskLine(r)}\n<i>${esc(r.reasons.join("; "))}</i>`, { reply_markup: kb, parse_mode: "HTML" });
    }
    if (rows.length > 20) await ctx.reply(`…тағы ${rows.length - 20}. Толық тізім Excel-дің ТЕКСЕРУ парағында.`);
  });

  bot.command("export", async (ctx) => {
    if (!(await admin(ctx))) return;
    const monday = mondayArg(ctx.match);
    await sendExcel(bot, ctx.chat!.id, monday, `Апталық есеп: ${monday}`);
  });

  bot.command("recalc", async (ctx) => {
    if (!(await admin(ctx))) return;
    const n = await recalcOpenWeeks(`tg:${ctx.from!.id}`);
    await ctx.reply(`✅ Ашық апталар жаңа ережелермен қайта есептелді: ${n} тапсырма өзгерді.\nДизайнер түзеткен тапсырмалар өзгертілген жоқ.`);
  });

  bot.command("sheet", async (ctx) => {
    if (!(await admin(ctx))) return;
    if (!sheetsClient()) return ctx.reply("Google Sheets қосылмаған (GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID).");
    try {
      const n = await publishOpenWeeks(true);
      await ctx.reply(`✅ Жаңартылды (${n} апта): ${sheetUrl()}`);
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });

  bot.command("send_boss", async (ctx) => {
    if (!(await admin(ctx))) return;
    const n = await sendToBoss(bot, mondayArg(ctx.match));
    await ctx.reply(n ? `✅ Басшыға жіберілді (${n}).` : "Тіркелген басшы жоқ. /code басшы Темірлан");
  });

  bot.command("close_week", async (ctx) => {
    if (!(await admin(ctx))) return;
    const monday = ctx.match?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!monday) return ctx.reply("Қолдану: /close_week 2026-09-21 — аптаны басшыға жібермей жабады (ескертулер тоқтайды).");
    const r = await one("UPDATE weeks SET status='sent', sent_at=now() WHERE monday=$1 RETURNING monday", [monday]);
    await audit(`tg:${ctx.from!.id}`, "week_closed", `week:${monday}`);
    await ctx.reply(r ? `🔒 ${monday} аптасы жабылды (басшыға жіберілмеді).` : "Ондай апта жоқ.");
  });

  bot.command("sync", async (ctx) => {
    if (!(await admin(ctx))) return;
    await ctx.reply("⏳ Синхронизация басталды…");
    await ctx.reply(await hooks.runSync());
  });

  // ---------- Дизайнер: апталық есеп батырмалары ----------
  bot.callbackQuery(/^rep:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await personByTg(ctx.from.id);
    if (!p?.yougile_id) return;
    const rows = await weekRows(ctx.match[1], p.yougile_id);
    await sendLong(ctx, designerDetailsText(rows), weeklyKeyboard(ctx.match[1]), true);
  });

  bot.callbackQuery(/^ok:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Рақмет!" });
    const p = await personByTg(ctx.from.id);
    if (!p?.yougile_id) return;
    await q("UPDATE weekly_reports SET status='confirmed', confirmed_at=now() WHERE week=$1 AND designer_yid=$2", [ctx.match[1], p.yougile_id]);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply("✅ Есеп расталды.");
  });

  bot.callbackQuery(/^err:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await personByTg(ctx.from.id);
    if (!p?.yougile_id) return;
    const rows = await weekRows(ctx.match[1], p.yougile_id);
    const kb = new InlineKeyboard();
    rows.slice(0, 40).forEach((r) => kb.text(`${r.trace.title} · ${subjectOf(r)}`.slice(0, 60), `fix:${r.id}`).row());
    await ctx.reply("Қай тапсырмада қате бар?", { reply_markup: kb });
  });

  // Түзету: тапсырма → жоба (бірнеше түрді өзгертуге, 0 қоюға болады) → тексеру → себеп
  const sum = (it: Record<string, number>) => Object.values(it).reduce((a, b) => a + (b || 0), 0);
  const draftOf = (tg: number, c: CalcRow) => {
    const s0 = state.get(tg);
    return (s0 && "items" in s0 && s0.calcId === c.id && s0.items ? { ...s0.items } : { ...c.items }) as Record<string, number>;
  };
  async function showDraft(ctx: Context, c: CalcRow, items: Record<string, number>, edit = false) {
    state.set(ctx.from!.id, { kind: "fixDraft", calcId: c.id, items });
    const kb = new InlineKeyboard();
    WORK_TYPES.forEach((wt, i) => {
      const v = items[wt] ?? 0;
      kb.text(`${v ? "● " : ""}${wt}: ${v}`, `fw:${c.id}:${i}`);
      if (i % 2) kb.row();
    });
    kb.row().text("🧹 Бәрін 0", `fz:${c.id}`).text("↩️ Бастапқы", `fr:${c.id}`);
    kb.row().text("✅ Сақтау", `fs:${c.id}`).text("✖ Болдырмау", `fx:${c.id}`);
    const changed = JSON.stringify(Object.fromEntries(Object.entries(items).filter(([, v]) => v))) !== JSON.stringify(c.items);
    const text =
      `${taskName(c)} — чатта ${c.file_count} файл.\n` +
      `Бұрын: ${fmtItems(c.items) || "—"}\n` +
      `Жаңа: ${fmtItems(items) || "—"}${changed ? " ✏️" : ""}\n\n` +
      `Өзгертетін жұмыс түрін басыңыз. Керек емес түрге 0 жазыңыз — ол өшіріледі. Бірнеше түрді қатар өзгертуге болады, соңында «✅ Сақтау».`;
    if (edit) return ctx.editMessageText(text, { reply_markup: kb }).catch(() => ctx.reply(text, { reply_markup: kb }));
    return ctx.reply(text, { reply_markup: kb });
  }
  async function own(ctx: Context, id: number) {
    const p = await personByTg(ctx.from!.id);
    const c = await getCalc(id);
    if (!p || !c || (!isAdmin(p) && c.designer_yid !== p.yougile_id)) return null;
    return c;
  }

  bot.callbackQuery(/^cv:(\d+):(r|ok)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (!c) return;
    await ctx.editMessageReplyMarkup().catch(() => {});
    await q("UPDATE cover_checks SET answer=$2 WHERE calc_id=$1", [c.id, ctx.match[2]]);
    if (ctx.match[2] === "ok") return ctx.reply("✅ Жақсы, пост + карусель болып қалды.");
    const items = { "Рилс обложка": c.file_count };
    const id = await correctCalc(c.id, items, "Бәрі рилс обложка (растау батырмасы)", `tg:${ctx.from.id}`);
    await ctx.reply(`✅ Түзетілді: ${fmtItems(items)}`);
    const who = (await personByTg(ctx.from.id))?.name ?? "";
    await notifyAdmins(bot, `🎬 ${who}: ${taskName(c)} → ${fmtItems(items)} (бұрын: ${fmtItems(c.items)})`, new InlineKeyboard().text("↩️ Қайтару", `rv:${id}`));
  });

  bot.callbackQuery(/^fix:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (c) await showDraft(ctx, c, { ...c.items });
  });

  bot.callbackQuery(/^fw:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (!c) return;
    const wt = WORK_TYPES[Number(ctx.match[2])];
    const items = draftOf(ctx.from.id, c);
    state.set(ctx.from.id, { kind: "fixNum", calcId: c.id, wt, items });
    const kb = new InlineKeyboard()
      .text(`Барлық ${c.file_count} файл — ${wt}`, `fa:${c.id}:${ctx.match[2]}`).row()
      .text("0 — өшіру", `fn:${c.id}:${ctx.match[2]}:0`).text("↩️ Артқа", `fb:${c.id}`);
    await ctx.reply(
      `«${wt}» — қазір ${items[wt] ?? 0}. Дұрыс санын жазыңыз (0–500).\n\nНемесе: «Барлық ${c.file_count} файл — ${wt}» — басқа түрлер 0 болады.`,
      { reply_markup: kb },
    );
  });

  // «Барлығы осы түр»: басқасын 0, бұл түрге файл саны
  bot.callbackQuery(/^fa:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (!c) return;
    await showDraft(ctx, c, { [WORK_TYPES[Number(ctx.match[2])]]: c.file_count });
  });
  bot.callbackQuery(/^fn:(\d+):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (!c) return;
    const items = draftOf(ctx.from.id, c);
    items[WORK_TYPES[Number(ctx.match[2])]] = Number(ctx.match[3]);
    await showDraft(ctx, c, items);
  });
  bot.callbackQuery(/^fb:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (c) await showDraft(ctx, c, draftOf(ctx.from.id, c));
  });
  bot.callbackQuery(/^fz:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (c) await showDraft(ctx, c, {}, true);
  });
  bot.callbackQuery(/^fr:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[1]));
    if (c) await showDraft(ctx, c, { ...c.items }, true);
  });
  bot.callbackQuery(/^fx:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    state.delete(ctx.from.id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply("Түзету болдырылмады, ештеңе өзгерген жоқ.");
  });

  // Сақтау: өзгеріс бар ма, жиыны файл санына сәйкес пе — тексеріп барып себеп сұрайды
  bot.callbackQuery(/^fs(y?):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await own(ctx, Number(ctx.match[2]));
    if (!c) return;
    const items = Object.fromEntries(Object.entries(draftOf(ctx.from.id, c)).filter(([, v]) => v > 0));
    if (JSON.stringify(items) === JSON.stringify(c.items)) return ctx.reply("Өзгеріс жоқ — сандар бұрынғыдай.");
    if (!ctx.match[1] && sum(items) !== c.file_count) {
      state.set(ctx.from.id, { kind: "fixDraft", calcId: c.id, items });
      return ctx.reply(
        `⚠️ Жаңа жиыны — ${sum(items)} жұмыс, ал чатта ${c.file_count} файл.\n${fmtItems(items) || "—"}\n\nБұл дұрыс па? (мысалы, бір файлда бірнеше жұмыс болса — дұрыс)`,
        { reply_markup: new InlineKeyboard().text("Иә, сақтау", `fsy:${c.id}`).text("✏️ Түзету", `fb:${c.id}`) },
      );
    }
    await ctx.editMessageReplyMarkup().catch(() => {});
    state.set(ctx.from.id, { kind: "fixReason", calcId: c.id, items });
    await ctx.reply(`Жаңа: ${fmtItems(items) || "—"}\nСебебін қысқаша жазыңыз (мысалы: «бәрі рилс обложка»):`);
  });

  // Сұрақ: түзету ме, қосымша ма
  bot.callbackQuery(/^ans:(\d+):(c|e)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await personByTg(ctx.from.id);
    const c = await getCalc(Number(ctx.match[1]));
    if (!p || !c || (!isAdmin(p) && c.designer_yid !== p.yougile_id)) return;
    const r = await answerCalc(c.id, ctx.match[2] === "c" ? "correction" : "extra", `tg:${ctx.from.id}`);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply(`✅ Сақталды: ${fmtItems(r?.items ?? {}) || "—"}`);
  });

  // Файлсыз тапсырма
  bot.callbackQuery(/^up:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = await getCalc(Number(ctx.match[1]));
    if (!c) return;
    await q("UPDATE tasks SET content_hash='' WHERE yougile_id=$1", [c.task_id]);
    await q("UPDATE calculations SET asked_at=NULL WHERE id=$1", [c.id]);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply("Рақмет! 15 минут ішінде чатты қайта тексеремін.");
  });

  bot.callbackQuery(/^man:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    state.set(ctx.from.id, { kind: "manual", calcId: Number(ctx.match[1]) });
    await ctx.reply("Неше файл (бет) жібердіңіз? Тек санын жазыңыз:");
  });

  // Админ: өткізу, түзетуді қайтару
  bot.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await admin(ctx))) return;
    await skipCalc(Number(ctx.match[1]), `tg:${ctx.from.id}`);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply("⏭ Есептен шығарылды.");
  });

  bot.callbackQuery(/^rv:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await admin(ctx))) return;
    const ok = await revertCorrection(Number(ctx.match[1]), `tg:${ctx.from.id}`);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply(ok ? "↩️ Түзету қайтарылды." : "Түзету табылмады немесе бұрын қайтарылған.");
  });

  // ---------- Хабарлама жіберу (админ, басшы) ----------
  bot.command("cancel", async (ctx) => {
    state.delete(ctx.from!.id);
    await ctx.reply("Болдырмадым.");
  });

  bot.command("msg", async (ctx) => {
    const p = await personByTg(ctx.from!.id);
    if (!canMessage(p)) return ctx.reply("Бұл команда тек админ мен басшыға.");
    const { kb, count } = await pickKeyboard([]);
    if (!count) return ctx.reply("Әзірге ботқа тіркелген қызметкер жоқ.");
    state.set(ctx.from!.id, { kind: "msgPick", selected: [] });
    await ctx.reply("Кімге жібереміз? Белгілеп, «Келесі» басыңыз.", { reply_markup: kb });
  });

  bot.callbackQuery(/^mp:(\d+|all|next)$/, async (ctx) => {
    const s = state.get(ctx.from.id);
    if (s?.kind !== "msgPick") return ctx.answerCallbackQuery({ text: "Қайтадан /msg басыңыз" });
    const v = ctx.match[1];
    if (v === "next") {
      if (!s.selected.length) return ctx.answerCallbackQuery({ text: "Кемінде бір адамды таңдаңыз" });
      await ctx.answerCallbackQuery();
      state.set(ctx.from.id, { kind: "msgText", recipients: s.selected });
      await ctx.editMessageReplyMarkup().catch(() => {});
      return ctx.reply(`${s.selected.length} адамға. Енді хабарламаны жіберіңіз — мәтін, фото, файл немесе дауыс. Болдырмау: /cancel`);
    }
    await ctx.answerCallbackQuery();
    if (v === "all") {
      const ds = await q<{ id: number }>("SELECT id FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND active");
      s.selected = s.selected.length === ds.length ? [] : ds.map((d) => d.id);
    } else {
      const id = Number(v);
      s.selected = s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id];
    }
    await ctx.editMessageReplyMarkup({ reply_markup: (await pickKeyboard(s.selected)).kb }).catch(() => {});
  });

  bot.callbackQuery(/^ms:(ok|no)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = state.get(ctx.from.id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (s?.kind !== "msgConfirm" || ctx.match[1] === "no") {
      state.delete(ctx.from.id);
      return ctx.reply("Жіберілмеді.");
    }
    state.delete(ctx.from.id);
    const sender = await personByTg(ctx.from.id);
    const rs = await q<Person>("SELECT * FROM people WHERE id = ANY($1) AND telegram_id IS NOT NULL AND active", [s.recipients]);
    let ok = 0;
    for (const r of rs) {
      try {
        await bot.api.sendMessage(r.telegram_id!, `📢 <b>${esc(sender?.name ?? "Админ")}</b> хабарламасы:`, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("↩️ Жауап беру", `rp:${ctx.from.id}`),
        });
        await bot.api.copyMessage(r.telegram_id!, s.chatId, s.messageId);
        ok++;
      } catch {
        /* бот бұғатталған т.б. */
      }
    }
    await audit(`tg:${ctx.from.id}`, "broadcast", "people", { to: rs.map((r) => r.name), delivered: ok });
    await ctx.reply(`✅ Жіберілді: ${ok}/${rs.length}${ok < rs.length ? " (кейбіреуі ботты бұғаттаған болуы мүмкін)" : ""}`);
  });

  bot.callbackQuery(/^rp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    state.set(ctx.from.id, { kind: "reply", toTg: Number(ctx.match[1]) });
    await ctx.reply("Жауабыңызды жазыңыз (мәтін, фото немесе файл). Болдырмау: /cancel");
  });

  // Хабарлама/жауап мазмұнын ұстау — кез келген түрдегі хабарлама (мәтін, фото, файл, дауыс)
  bot.on("message", async (ctx, next) => {
    const s = state.get(ctx.from.id);
    if (ctx.message.text?.startsWith("/")) return next();
    if (ctx.message.text && Object.values(BTN).includes(ctx.message.text)) {
      state.delete(ctx.from.id);
      clearGoalState(ctx.from.id);
      return next();
    }
    if (s?.kind === "msgText") {
      state.set(ctx.from.id, { kind: "msgConfirm", recipients: s.recipients, chatId: ctx.chat.id, messageId: ctx.message.message_id });
      const names = (await q<{ name: string }>("SELECT name FROM people WHERE id = ANY($1) ORDER BY name", [s.recipients])).map((x) => x.name);
      return ctx.reply(`Жоғарыдағы хабарламаны жіберейін бе?\nКімге: ${names.join(", ")}`, {
        reply_markup: new InlineKeyboard().text("✅ Жіберу", "ms:ok").text("❌ Болдырмау", "ms:no"),
      });
    }
    if (s?.kind === "reply") {
      state.delete(ctx.from.id);
      const me = await personByTg(ctx.from.id);
      try {
        await bot.api.sendMessage(s.toTg, `↩️ <b>${esc(me?.name ?? ctx.from.first_name ?? "Қызметкер")}</b> жауабы:`, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("↩️ Жауап беру", `rp:${ctx.from.id}`),
        });
        await bot.api.copyMessage(s.toTg, ctx.chat.id, ctx.message.message_id);
        await audit(`tg:${ctx.from.id}`, "reply", "people", { to: s.toTg });
        return ctx.reply("✅ Жауабыңыз жіберілді.");
      } catch {
        return ctx.reply("Жіберу мүмкін болмады.");
      }
    }
    return next();
  });

  // ---------- Мәзір батырмалары және командалар ----------
  const myWeek = async (ctx: Context, monday: string) => {
    const p = await personByTg(ctx.from!.id);
    if (!p) return ctx.reply("Сіз тіркелмегенсіз. Админнен жеке сілтеме сұраңыз.");
    await ctx.replyWithChatAction("upload_photo");
    if (!p.yougile_id) return sendTeamWeek(bot, ctx.chat!.id, monday);
    await sendDesignerWeek(bot, ctx.chat!.id, p, monday);
  };
  const thisMonday = () => weekOf(Date.now()).monday;
  const onTasks = async (ctx: Context) => {
    const p = await personByTg(ctx.from!.id);
    if (!p) return ctx.reply("Сіз тіркелмегенсіз. Админнен жеке сілтеме сұраңыз.");
    await sendLong(ctx, await openTasksText(p), undefined, true);
  };
  const onHelp = async (ctx: Context) => {
    const p = await personByTg(ctx.from!.id);
    await ctx.reply(HELP(isAdmin(p)), { parse_mode: "HTML", ...(p && p.role !== "viewer" ? { reply_markup: menu() } : {}) });
  };
  bot.callbackQuery("wl:tasks", async (ctx) => (await ctx.answerCallbackQuery(), onTasks(ctx)));
  bot.callbackQuery("wl:help", async (ctx) => (await ctx.answerCallbackQuery(), onHelp(ctx)));
  bot.command("welcome", async (ctx) => {
    // Админ өзіне алдын ала көру үшін: дизайнер тіркелгенде не көретінін көрсетеді
    const p = await personByTg(ctx.from!.id);
    if (!p?.yougile_id) return ctx.reply("Алдымен /code АТЫҢЫЗ арқылы дизайнер ретінде тіркеліңіз.");
    await welcomeDesigner(bot, ctx.chat!.id, p);
  });
  bot.hears(BTN.week, (ctx) => myWeek(ctx, thisMonday()));
  bot.hears(BTN.last, (ctx) => myWeek(ctx, lastMonday()));
  bot.hears(BTN.tasks, onTasks);
  bot.hears(BTN.help, onHelp);
  bot.command("me", (ctx) => myWeek(ctx, thisMonday()));
  bot.command("last", (ctx) => myWeek(ctx, lastMonday()));
  bot.command("tasks", onTasks);
  bot.command("help", onHelp);
  bot.command("hr", async (ctx) => {
    const p = await personByTg(ctx.from!.id);
    if (!p?.yougile_id) return ctx.reply("Бұл команда дизайнерлерге арналған.");
    const m = ctx.match?.match(/(\d{1,2})\.(\d{1,2})/);
    const day = m ? `${new Date().getFullYear()}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined;
    const r = await hrPrepText(p, almatyDayStart(day));
    await ctx.reply(r.text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  bot.command("menu", async (ctx) => ctx.reply("Мәзір:", { reply_markup: menu() }));

  // ---------- Мәтіндік жауаптар (көп қадамды диалог) ----------
  bot.on("message:text", async (ctx) => {
    const s = state.get(ctx.from.id);
    const text = ctx.message.text.trim();
    if (!s) {
      if (text.startsWith("/")) return;
      const p = await personByTg(ctx.from.id);
      if (!p) return ctx.reply("Сіз әлі тіркелмегенсіз. Админнен жеке тіркеу сілтемесін сұраңыз — сонда есебіңді көріп, сұрақ қоя аласыз.");
      if (p.role === "viewer") return ctx.reply("Апталық Excel сейсенбі 10:00-де автоматты келеді.\nҚызметкерлерге хабарлама жіберу: /msg");
      await ctx.replyWithChatAction("typing");
      const answer = await askAI(
        { id: p.id, name: p.name, yougile_id: p.yougile_id, isAdmin: isAdmin(p), telegram_id: ctx.from.id },
        text,
      ).catch((e) => (console.error("ai", e), "AI жауап бере алмады."));
      return sendLong(ctx, answer);
    }

    if (s.kind === "fixNum" || s.kind === "manual") {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0 || n > 500) return ctx.reply("Тек 0–500 аралығындағы сан жазыңыз.");
      const c = await getCalc(s.calcId);
      if (!c) return state.delete(ctx.from.id);
      if (s.kind === "manual") {
        state.delete(ctx.from.id);
        const r = await answerCalc(c.id, `manual:${n}`, `tg:${ctx.from.id}`);
        await ctx.reply(`✅ Сақталды (қолмен енгізілді): ${fmtItems(r?.items ?? {}) || "—"}`);
        return notifyAdmins(bot, `✍️ ${taskName(c)}: файл чатта жоқ, дизайнер ${n} деп енгізді.`);
      }
      return showDraft(ctx, c, { ...(s.items ?? c.items), [s.wt]: n });
    }

    if (s.kind === "fixReason") {
      state.delete(ctx.from.id);
      const c = await getCalc(s.calcId);
      if (!c) return;
      const id = await correctCalc(c.id, s.items, text, `tg:${ctx.from.id}`);
      await ctx.reply(`✅ Түзетілді: ${fmtItems(s.items) || "—"}`);
      const who = (await personByTg(ctx.from.id))?.name ?? "";
      await notifyAdmins(
        bot,
        `✏️ ${who} түзетті: ${taskName(c)}\n${fmtItems(c.items) || "—"} → ${fmtItems(s.items) || "—"}\nСебебі: ${text}`,
        new InlineKeyboard().text("↩️ Қайтару", `rv:${id}`),
      );
    }
  });

  bot.catch((e) => console.error("bot error:", e.error));
  return bot;
}

/** Excel-ді басшыға жіберу және аптаны жабу */
export async function sendToBoss(bot: Bot, monday: string) {
  const viewers = await q<Person>("SELECT * FROM people WHERE role IN ('viewer') AND telegram_id IS NOT NULL AND active");
  await q("UPDATE weeks SET status='sent', sent_at=now() WHERE monday=$1", [monday]);
  const link = sheetUrl();
  if (link) await publishWeek(monday, true).catch((e) => console.error("sheets:", e.message));
  for (const v of viewers) await sendTeamWeek(bot, v.telegram_id!, monday).catch(() => {});
  for (const v of viewers)
    await sendExcel(bot, v.telegram_id!, monday, `DESIGN апталық есеп · ${monday}${link ? `\nТірі кесте: ${link}` : ""}`);
  await audit("system", "week_sent", `week:${monday}`, { viewers: viewers.length });
  return viewers.length;
}

/** Дизайнерлерге апталық есеп */
export async function sendWeekly(bot: Bot, monday: string) {
  const ds = await q<Person>("SELECT * FROM people WHERE role='designer' AND telegram_id IS NOT NULL AND active");
  for (const d of ds) {
    await sendDesignerWeek(bot, d.telegram_id!, d, monday).catch((e) => console.error("weekly:", d.name, e.message));
    await q("INSERT INTO weekly_reports (week, designer_yid) VALUES ($1,$2) ON CONFLICT DO NOTHING", [monday, d.yougile_id]);
  }
  for (const a of await q<Person>("SELECT * FROM people WHERE (role='admin' OR is_admin) AND telegram_id IS NOT NULL AND active"))
    await sendTeamWeek(bot, a.telegram_id!, monday).catch((e) => console.error("weekly admin:", e.message));
}

/** Шешілмеген сұрақтарды дизайнерлерге жіберу (әрқайсысы бір рет) */
export async function notifyPending(bot: Bot) {
  // Екіұшты «обложка»: пост+карусель деп саналды — дизайнерден бір батырмамен растау
  const covers = await q<any>(
    `SELECT c.*, p.telegram_id FROM calculations c
       JOIN weeks w ON w.monday=c.week JOIN people p ON p.yougile_id=c.designer_yid
       LEFT JOIN cover_checks k ON k.calc_id=c.id
      WHERE w.status='open' AND k.calc_id IS NULL AND c.status='ok' AND c.rule_code IN ('R1','R2')
        AND c.trace->>'title' ILIKE '%обложк%' AND p.telegram_id IS NOT NULL AND p.active LIMIT 20`,
  );
  for (const c of covers) {
    await q("INSERT INTO cover_checks (calc_id) VALUES ($1) ON CONFLICT DO NOTHING", [c.id]);
    await bot.api
      .sendMessage(c.telegram_id, `🎬 ${taskName(c)} — ${c.file_count} файл.\nМен «${fmtItems(c.items)}» деп санадым. Бұл рилс обложка ма, әлде пост пен карусель ме?`, {
        reply_markup: new InlineKeyboard()
          .text(`🎬 Бәрі рилс обложка (${c.file_count})`, `cv:${c.id}:r`).row()
          .text("✅ Пост + карусель — дұрыс", `cv:${c.id}:ok`).row()
          .text("✏️ Басқаша", `fix:${c.id}`),
      })
      .catch(() => {});
  }

  const rows = await q<any>(
    `SELECT c.*, p.telegram_id, t.completed_at FROM calculations c
       JOIN people p ON p.yougile_id=c.designer_yid JOIN tasks t ON t.yougile_id=c.task_id JOIN weeks w ON w.monday=c.week
      WHERE c.status IN ('ask_designer','no_files') AND c.asked_at IS NULL AND w.status='open'
        AND p.telegram_id IS NOT NULL AND t.completed_at < now() - interval '20 minutes'
        AND t.completed_at > now() - interval '2 days'`,
  );
  for (const r of rows) {
    const head = taskName(r);
    const msg =
      r.status === "no_files"
        ? {
            text: `📭 ${head} жабылды, бірақ чатта файл жоқ.\nДайын файлдарды тапсырма чатына салыңыз.`,
            kb: new InlineKeyboard().text("📎 Салдым", `up:${r.id}`).row().text("✍️ Чатқа салу мүмкін емес — санын жазамын", `man:${r.id}`),
          }
        : {
            text: `❓ ${head}: ${r.reasons.join(" ")}`,
            kb: new InlineKeyboard().text("Түзету", `ans:${r.id}:c`).text("Қосымша жұмыс", `ans:${r.id}:e`),
          };
    await bot.api.sendMessage(r.telegram_id, msg.text, { reply_markup: msg.kb }).catch(() => {});
    await q("UPDATE calculations SET asked_at=now() WHERE id=$1", [r.id]);
  }
  return rows.length;
}
