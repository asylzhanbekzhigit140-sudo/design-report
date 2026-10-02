/**
 * Database + sync + Excel интеграциялық тесті. DATABASE_URL берілмесе өткізіледі.
 *   DATABASE_URL=postgres://... npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import ExcelJS from "exceljs";
import { connect, close, q, one } from "../src/db/db.js";
import { YouGileClient } from "../src/yougile/client.js";
import { syncAll } from "../src/services/sync.js";
import { answerCalc, correctCalc, revertCorrection } from "../src/services/calcs.js";
import { weekRows, designerReportText } from "../src/services/reports.js";
import { buildWeekWorkbook } from "../src/services/excel.js";
import { weekOf } from "../src/time/week.js";
import { buildContext, askAI } from "../src/services/ai.js";
import { openTasksText, hrPrepText, almatyDayStart } from "../src/bot/bot.js";
import { publishWeek, resetSheetsClient } from "../src/services/sheets.js";
import { findNewTzIssues } from "../src/services/tzcheck.js";
import { generateKeyPairSync, createHmac } from "node:crypto";
import { startWebServer, verifyInitData } from "../src/web/server.js";

const URL_ = process.env.DATABASE_URL;
const skip = !URL_;

const ME = "u-asyl", MKT = "u-mkt";
const enc = (n: string) => encodeURIComponent(encodeURIComponent(n)) + "%3Fpreviews%5B%5D%3D-256";
let k = 0;
const f = (n: string) => `/root/#file:/user-data/00000000-0000-0000-0000-${String(++k).padStart(12, "0")}/${enc(n)}`;
const now = Date.now();
const thisMon = weekOf(now);
const done = Math.max(thisMon.startMs + 3600e3, now - 2 * 3600e3);

const tasks: any[] = [
  { id: "t1", title: "Ақпараттық пост (2)", columnId: "c1", completed: true, completedTimestamp: done, assigned: [ME], idTaskProject: "DES-1" },
  { id: "t2", title: "МАТФИЗ КОМБО", columnId: "c2", completed: true, completedTimestamp: done, assigned: [ME], idTaskProject: "PRO-1" },
  { id: "t3", title: "айфоон", columnId: "c1", completed: true, completedTimestamp: done, assigned: [ME], idTaskProject: "DES-2" },
  { id: "t5", title: "Митоз мейоз", columnId: "c1", completed: false, assigned: [ME], idTaskProject: "DES-5", deadline: { deadline: now + 86400e3 } },
];
const ZH = "u-zh";
const zhTasks: any[] = [
  { id: "t9", title: "Жанияның құпия посты", columnId: "c1", completed: true, completedTimestamp: done, assigned: [ZH], idTaskProject: "DES-9" },
];
const msgs: Record<string, any[]> = {
  t1: [{ id: done - 9000, fromUserId: MKT, text: "ТЗ: қате болмасын" }, { id: done - 5000, fromUserId: ME, text: [f("a.png"), f("b.png"), f("c.png"), f("d.png")].join(" ") }],
  t2: [{ id: done - 5000, fromUserId: ME, text: [f("y1.png"), f("y2.png")].join(" ") }, { id: done - 4000, fromUserId: MKT, text: "2-сін түзетші" }, { id: done - 3000, fromUserId: ME, text: f("y3.png") }],
  t3: [{ id: done - 9000, fromUserId: MKT, text: "ТЗ мәтіні" }],
  t9: [{ id: done - 5000, fromUserId: ZH, text: [f("z1.png"), f("z2.png")].join(" ") }],
};
let server: http.Server;

before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const p = u.pathname.replace("/api-v2", "");
    const page = (c: any[]) => ({ paging: { count: c.length, next: false }, content: c });
    let b: any = {};
    if (p === "/users") b = page([{ id: ME, realName: "Asylzhan" }, { id: ZH, realName: "Жания Абубакирова" }, { id: MKT, realName: "Marketing JUZ40uly" }]);
    else if (p === "/projects") b = page([{ id: "p1", title: "Marketing" }, { id: "p2", title: "Product" }]);
    else if (p === "/boards") b = page([{ id: "b1", title: "Пән акк", projectId: "p1" }, { id: "b2", title: "YouTube", projectId: "p2" }]);
    else if (p === "/columns") b = page([{ id: "c1", title: "Англ", boardId: "b1" }, { id: "c2", title: "ТЗ", boardId: "b2" }]);
    else if (p === "/task-list") b = page(u.searchParams.get("assignedTo") === ME ? tasks : u.searchParams.get("assignedTo") === ZH ? zhTasks : []);
    else if (p.startsWith("/chats/")) b = page(msgs[p.split("/")[2]] ?? []);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  }).listen(4557);
  await connect(URL_!);
  await q("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await close();
  await connect(URL_!);
});
after(async () => {
  if (skip) return;
  server.close();
  await close();
});

test("sync → есептеу → жауап → түзету → Excel", { skip }, async () => {
  const yg = new YouGileClient("x", "http://localhost:4557/api-v2", 1);
  const r1 = await syncAll(yg);
  assert.equal(r1.tasksNew, 4);
  const rows = await weekRows(thisMon.monday);
  const by = (code: string) => rows.find((r) => r.trace.code === code)!;
  assert.deepEqual(by("DES-1").items, { Пост: 1, Карусель: 3 });
  assert.equal(by("DES-1").status, "ok");
  assert.equal(by("PRO-1").status, "ask_designer");
  assert.equal(by("PRO-1").ask_count, 1);
  assert.equal(by("DES-2").status, "no_files");

  // Қайталанған sync дубликат жасамайды
  const r2 = await syncAll(yg);
  assert.equal(r2.tasksNew, 0);
  assert.equal((await q("SELECT count(*)::int n FROM calculations"))[0].n, 4);

  // Дизайнер: «Қосымша жұмыс» → 3 обложка
  const a = await answerCalc(by("PRO-1").id, "extra", "test");
  assert.deepEqual(a!.items, { "YouTube обложка": 3 });
  assert.equal(a!.status, "ok");
  // Файлсыз: қолмен 5 → 1 пост + 4 карусель
  const m = await answerCalc(by("DES-2").id, "manual:5", "test");
  assert.deepEqual(m!.items, { Пост: 1, Карусель: 4 });
  assert.equal(m!.manual, true);

  // Жауап кейінгі sync-те сақталады
  tasks[1].title = "МАТФИЗ КОМБО 2"; // хэш өзгереді → чат қайта оқылады
  await syncAll(yg);
  const again = (await weekRows(thisMon.monday)).find((r) => r.trace.code === "PRO-1")!;
  assert.deepEqual(again.items, { "YouTube обложка": 3 });

  // Түзету және қайтару
  const cid = await correctCalc(by("DES-1").id, { Пост: 1, Карусель: 2 }, "бір файл қайталанған", "test");
  let d1 = await one("SELECT items, status FROM calculations WHERE id=$1", [by("DES-1").id]);
  assert.deepEqual(d1.items, { Пост: 1, Карусель: 2 });
  assert.equal(d1.status, "corrected");
  await syncAll(yg, { full: true }); // түзету sync-те өшпейді
  d1 = await one("SELECT items FROM calculations WHERE id=$1", [by("DES-1").id]);
  assert.deepEqual(d1.items, { Пост: 1, Карусель: 2 });
  assert.equal(await revertCorrection(cid, "admin"), true);
  d1 = await one("SELECT items, status FROM calculations WHERE id=$1", [by("DES-1").id]);
  assert.deepEqual(d1.items, { Пост: 1, Карусель: 3 });

  // Мәтін және Excel
  const text = designerReportText("Асылжан", thisMon.monday, await weekRows(thisMon.monday, ME));
  assert.match(text, /🇬🇧 <b>АҒЫЛШЫН<\/b>\n      2 пост · 7 карусель/);
  assert.match(text, /Барлығы:<\/b> 2 пост · 7 карусель · 3 YouTube обложка/);
  const { buffer } = await buildWeekWorkbook(thisMon.monday);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["ПӘН АКК", "ИНСТА АКК", "ӨЗГЕ ЖҰМЫСТАР", "СКРИН", "ДЕТАЛЬ", "ТЕКСЕРУ"]);
  const pan = wb.getWorksheet("ПӘН АКК")!;
  const header = pan.getRow(4).values as any[];
  const col = header.indexOf("АҒЫЛШЫН");
  const asylRow = [...Array(20).keys()].map((i) => pan.getRow(5 + i)).find((r) => r.getCell(1).value === "Бекжігіт")!;
  assert.equal(asylRow.getCell(col).value, 2); // пост: DES-1 + қолмен енгізілген DES-2
  assert.equal(wb.getWorksheet("ДЕТАЛЬ")!.rowCount, 5);

  // AI контексті: дизайнер тек өзінікін көреді, админ барлығын
  const mine = await buildContext({ id: 1, name: "Асылжан", yougile_id: ME, isAdmin: false, telegram_id: 1 });
  assert.match(mine, /DES-1/);
  assert.match(mine, /Қазір ашық тапсырмалар.*: 1\n«Митоз мейоз» \| пән\/акк: АҒЫЛШЫН/);
  assert.doesNotMatch(mine, /DES-9|құпия/);
  const all = await buildContext({ id: 1, name: "Админ", yougile_id: null, isAdmin: true, telegram_id: 1 });
  assert.match(all, /DES-9/);
  const ot = await openTasksText({ id: 1, role: "designer", name: "Асылжан", yougile_id: ME, telegram_id: 1, is_admin: false });
  assert.match(ot, /Ашық тапсырмалар: 1/);
  assert.match(ot, /«Митоз мейоз» · АҒЫЛШЫН — ⏰/);
  // Толық емес ТЗ: Митоз мейоз — дедлайн бар, ереже бар → ескертусіз; қайта шақыру бос
  assert.equal((await findNewTzIssues()).length, 0);

  // Google Sheets: mock сервер
  const calls: { method: string; url: string; body: any }[] = [];
  const gs = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data && req.headers["content-type"]?.includes("json") ? JSON.parse(data) : data;
      calls.push({ method: req.method!, url: decodeURIComponent(req.url!), body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/token") return res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      if (req.method === "GET") return res.end(JSON.stringify({ sheets: [] }));
      if (req.url!.endsWith(":batchUpdate") && body.requests?.[0]?.addSheet) return res.end(JSON.stringify({ replies: [{ addSheet: { properties: { sheetId: 7 } } }] }));
      res.end("{}");
    });
  }).listen(4558);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "b@x", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  process.env.GOOGLE_SHEET_ID = "SHEET";
  process.env.GOOGLE_SHEETS_BASE = "http://localhost:4558/v4";
  process.env.GOOGLE_TOKEN_URL = "http://localhost:4558/token";
  resetSheetsClient();
  assert.equal(await publishWeek(thisMon.monday), true);
  assert.equal(await publishWeek(thisMon.monday), false); // өзгеріс жоқ → қайта жазылмайды
  const put = calls.find((c) => c.method === "PUT")!;
  assert.match(put.url, /\/spreadsheets\/SHEET\/values\/'.+'!A1\?valueInputOption=USER_ENTERED/);
  const flat = put.body.values.flat().join("|");
  assert.match(flat, /ПӘН АКК · ПОСТ/);
  assert.match(flat, /=SUM\(B\d+:/);
  assert.match(flat, /Ақпараттық пост \(2\)/);
  gs.close();

  // Mini App API: дұрыс initData, дизайнер тек өзін көреді
  const TOKEN = "123:TEST";
  const initData = (tgId: number, token = TOKEN) => {
    const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: tgId, first_name: "A" }) });
    const dc = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(token).digest();
    p.set("hash", createHmac("sha256", secret).update(dc).digest("hex"));
    return p.toString();
  };
  assert.equal(verifyInitData(initData(555), TOKEN), 555);
  assert.equal(verifyInitData(initData(555, "999:FAKE"), TOKEN), null);
  await q("UPDATE people SET telegram_id=555 WHERE yougile_id=$1", [ME]);
  const web = startWebServer({ port: 4559, botToken: TOKEN });
  const get = async (path: string, id = 555) => {
    const r = await fetch(`http://localhost:4559${path}`, { headers: { "X-Init-Data": initData(id) } });
    return { status: r.status, body: await r.json() as any };
  };
  assert.equal((await get("/api/me", 999)).status, 403);
  assert.equal((await fetch("http://localhost:4559/api/me")).status, 401);
  const meRes = await get("/api/me");
  assert.equal(meRes.body.full, false);
  const wk = await get(`/api/week?monday=${thisMon.monday}&designer=${ZH}`); // басқа адамды сұраса да — тек өзі
  assert.ok(wk.body.tasks.every((t: any) => t.designer === "Асылжан"));
  assert.equal(wk.body.totals["Пост"], 2);
  assert.equal((await get("/api/trend")).body.length, 8);
  assert.equal((await get("/api/open")).body[0].title, "Митоз мейоз");
  const html = await (await fetch("http://localhost:4559/")).text();
  assert.match(html, /telegram-web-app\.js/);
  web.close();

  // Сурет-карточка PNG
  const { designerCard } = await import("../src/services/card.js");
  const png = designerCard("Асылжан", thisMon.monday, await weekRows(thisMon.monday, ME), []);
  assert.equal(png.subarray(1, 4).toString(), "PNG");

  // HR тізімі: тапсырма жабылған күн бойынша
  const doneDay = new Date(done + 5 * 3600e3).toISOString().slice(0, 10);
  const hr = await hrPrepText({ id: 1, role: "designer", name: "Асылжан", yougile_id: ME, telegram_id: 1, is_admin: false }, almatyDayStart(doneDay));
  assert.equal(hr.count, 3);
  assert.match(hr.text, /<code>жасау: Ақпараттық пост \(2\)<\/code>/);
  assert.match(hr.text, /my-tasks#DES-1/);
  assert.match(hr.text, /Тапсырма орындалды\. Дәлел скриншотта көрсетілген\./);

  assert.equal(await askAI({ id: 1, name: "x", yougile_id: ME, isAdmin: false, telegram_id: 1 }, "сәлем"), "AI-сұрақтар әлі қосылмаған.");
});
