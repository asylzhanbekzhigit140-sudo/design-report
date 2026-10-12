/**
 * Негізгі процесс: database + Telegram бот + кесте.
 *   әр 15 мин     — YouGile sync + сұрақтарды жіберу
 *   дс 08:00      — өткен аптаның толық соңғы өтуі
 *   дс 09:00      — дизайнерлерге апталық есеп
 *   сс 10:00      — Excel басшыға, апта жабылады
 */
import cron from "node-cron";
import { connect, getSetting, setSetting } from "./db/db.js";
import { config } from "./config.js";
import { YouGileClient } from "./yougile/client.js";
import { syncAll } from "./services/sync.js";
import { createBot, notifyPending, sendWeekly, sendWeekStart, sendWeekNudge, sendToBoss, notifyAdmins, USER_COMMANDS, setAdminCommands, applyProfile, sendExcel, sendHrPrep } from "./bot/bot.js";
import { startWebServer } from "./web/server.js";
import { exportWeekToGitHub, githubEnabled } from "./services/figmaExport.js";
import { sendGoalMonthStart, autoImportGoals } from "./bot/goalsBot.js";
import { recalcOpenWeeks } from "./services/calcs.js";
import { weekOf } from "./time/week.js";
import { findNewTzIssues, tzIssuesText } from "./services/tzcheck.js";
import { publishOpenWeeks } from "./services/sheets.js";

const lastMonday = () => weekOf(weekOf(Date.now()).startMs - 1).monday;

async function main() {
  await connect(config.databaseUrl());
  const yg = new YouGileClient(config.yougileKey(), config.yougileBase, config.ygIntervalMs);

  let running = false;
  let lastSheetsError = "";
  const runSync = async (full = false) => {
    if (running) return "Синхронизация қазір жүріп жатыр.";
    running = true;
    try {
      const r = await syncAll(yg, { full });
      const asked = await notifyPending(bot);
      // Толық емес ТЗ туралы ескерту (жаңа тапсырмалар, бір рет)
      const issues = await findNewTzIssues();
      if (issues.length) await notifyAdmins(bot, tzIssuesText(issues), undefined, true);
      // Google Sheets: өзгеріс болса ғана жаңартылады
      let sheets = 0;
      try {
        sheets = await publishOpenWeeks();
        lastSheetsError = "";
      } catch (e: any) {
        console.error("sheets:", e.message);
        if (e.message !== lastSheetsError) await notifyAdmins(bot, `❌ Google Sheets: ${e.message}`);
        lastSheetsError = e.message;
      }
      return `✅ Sync: жаңа ${r.tasksNew}, өзгерген ${r.tasksChanged}, сұраныс ${r.requests}, сұрақ ${asked}, ТЗ ескерту ${issues.length}, кесте ${sheets}`;
    } catch (e: any) {
      const msg = `❌ Sync қатесі: ${e?.message ?? e}`;
      console.error(msg);
      await notifyAdmins(bot, msg);
      return msg;
    } finally {
      running = false;
    }
  };

  const bot = createBot(config.botToken(), { runSync: () => runSync(false) });
  await bot.init();
  await bot.api.setMyCommands(USER_COMMANDS);
  await setAdminCommands(bot);
  await applyProfile(bot);

  // Ережелер өзгерсе (жаңа нұсқа) — ашық апталарды бір рет қайта есептеу
  const RULES_VERSION = "2026-10-05-r12";
  if ((await getSetting<string>("rules_version", "")) !== RULES_VERSION) {
    const n = await recalcOpenWeeks("system:rules");
    await setSetting("rules_version", RULES_VERSION);
    if (n) await notifyAdmins(bot, `🔁 Ережелер жаңартылды («рилс/reels» → Рилс обложка). Ашық апталарда ${n} тапсырма қайта есептелді.`);
  }

  // Mini App сервері (Railway PORT береді)
  if (process.env.PORT || process.env.WEBAPP_URL)
    startWebServer({
      port: Number(process.env.PORT ?? 3000),
      botToken: config.botToken(),
      onExport: (tg, monday) => sendExcel(bot, tg, monday, `Апталық есеп: ${monday}`),
    });

  const tz = { timezone: config.tz };
  cron.schedule("*/15 * * * *", () => void runSync(false), tz);
  cron.schedule("0 8 * * 1", () => void runSync(true), tz);
  // HR есебіне дайындық: 21:45 sync (*/15 кестесінде бар), 21:50 жіберу
  cron.schedule("50 21 * * *", () => void sendHrPrep(bot).catch((e) => notifyAdmins(bot, `❌ HR тізімі: ${e.message}`)), tz);
  // Айлық мақсаттар кестеден: іске қосылғанда және дүйсенбі 09:30 — ботта мақсаты жоқтарға осы айдың мақсаттары өзі түседі
  const goalsImport = () =>
    autoImportGoals()
      .then((added) => { if (added.length) return notifyAdmins(bot, `🎯 Айлық мақсат кестесінен алынды:\n${added.join("\n")}`); })
      .catch((e) => console.error("goals import:", e.message));
  void goalsImport();
  cron.schedule("30 9 * * 1", () => void goalsImport(), tz);
  // Дүйсенбі: 10:00 жаңа айдың мақсаты жоқтарға еске салу
  cron.schedule("0 10 * * 1", () => void sendGoalMonthStart(bot).catch((e) => console.error("goal month:", e.message)), tz);
  // Дүйсенбі 12:15 «Апталық есепке дайынсың ба?» (тексеру → ұнаған жұмыс → айлық мақсат → 📤 жіберу), 12:45 ескерту
  cron.schedule("15 12 * * 1", () => void sendWeekStart(bot, lastMonday())
    .then((n) => notifyAdmins(bot, `📋 «Апталық есепке дайынсың ба?» ${n} дизайнерге жіберілді. 13:00-де Figma-ға жиналады.`))
    .catch((e) => notifyAdmins(bot, `❌ Апталық сауалнама: ${e.message}`)), tz);
  cron.schedule("45 12 * * 1", () => void sendWeekNudge(bot, lastMonday()).catch((e) => console.error("nudge:", e.message)), tz);
  // Figma апталық есебі: дүйсенбі 13:00 деректер GitHub-қа (Claude жоспарлы тапсырмасы ~13:16-да слайд жасайды).
  // Әр дизайнер «📤 Жіберу» басқанда да деректер жаңарады.
  cron.schedule("0 13 * * 1", () => {
    if (!githubEnabled()) return;
    void exportWeekToGitHub(lastMonday())
      .then((r) => notifyAdmins(bot, `🎨 Figma есебіне деректер дайын: ${r.label} · ${r.designers} дизайнер · ${r.images} сурет`))
      .catch((e) => notifyAdmins(bot, `❌ Figma деректері: ${e.message}`));
  }, tz);
  cron.schedule("0 9 * * 1", () => void sendWeekly(bot, lastMonday()).catch((e) => notifyAdmins(bot, `❌ Апталық есеп: ${e.message}`)), tz);
  cron.schedule("0 10 * * 2", () => void sendToBoss(bot, lastMonday()).catch((e) => notifyAdmins(bot, `❌ Басшыға жіберу: ${e.message}`)), tz);

  void runSync(false);
  console.log(`Бот іске қосылды: @${bot.botInfo.username}`);
  await bot.start({ drop_pending_updates: true });
}

main().catch((e) => {
  console.error("Іске қосу қатесі:", e);
  process.exit(1);
});
