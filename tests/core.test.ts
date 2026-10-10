import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFiles, countFiles } from "../src/core/files.js";
import { applyRules, evalExpr, cleanTitle } from "../src/core/rules.js";
import { calculateTask } from "../src/core/calculate.js";
import { weekOf, weekLabel, weekRangeText, weekFromMonday } from "../src/time/week.js";
import { RULES, ALLOWED_EXTS, CORRECTION_WORDS, subjectFor } from "../src/seed/catalog.js";
import { tzReasons } from "../src/services/tzcheck.js";
import { signJwt } from "../src/services/google.js";
import { generateKeyPairSync, createVerify } from "node:crypto";

const ME = "9252f87e-70fd-42fb-9248-80203c82907a";
const MKT = "mkt-user";
const enc = (name: string) => encodeURIComponent(encodeURIComponent(name)) + "%3Fpreviews%5B%5D%3D-256-preview%40270x360";
let n = 0;
const file = (name: string) => `/root/#file:/user-data/00000000-0000-0000-0000-${String(++n).padStart(12, "0")}/${enc(name)}`;
const opts = { allowedExts: ALLOWED_EXTS, correctionWords: CORRECTION_WORDS };

test("нақты YouGile пішіміндегі файл атауын оқиды", () => {
  // probe-тан алынған нақты мәтін
  const text = "/root/#file:/user-data/6df2c12b-196d-4660-917e-af470cddc24f/%25D1%2582%25D0%25B0%25D0%25BF%25D1%2581%25D1%258B%25D1%2580%25D0%25BC%25D0%25B0%25D0%25BA%25D0%25B0%25D1%25802.png%3Fpreviews%5B%5D%3D-256-preview%40270x360";
  const f = parseFiles({ id: 1, fromUserId: ME, text });
  assert.equal(f.length, 1);
  assert.equal(f[0].name, "тапсырмакар2.png");
  assert.equal(f[0].ext, "png");
  assert.equal(f[0].uuid, "6df2c12b-196d-4660-917e-af470cddc24f");
});

test("DES-3222: «Давай» түзету емес — барлық файл саналады", () => {
  const msgs = [
    { id: 1, fromUserId: MKT, text: "1-БЕТ ӨЗІҢДІ ТЕКСЕРІП КӨР" },
    { id: 2, fromUserId: ME, text: [file("тапсырмакар.png"), file("тапсырма карусель 2.png"), file("тапсырма карусель 3.png")].join(" ") },
    { id: 3, fromUserId: ME, text: file("тапсырмакар2.png") },
    { id: 4, fromUserId: ME, text: "соңғы бетіне дұрыс жауаптарын қосайын ба" },
    { id: 5, fromUserId: MKT, text: "Давай" },
    { id: 6, fromUserId: ME, text: file("тапсырма 11карусель.png") },
    { id: 7, fromUserId: ME, text: file("тапсырма 12карусель.png") },
  ];
  const r = countFiles(msgs, new Set([ME]), opts);
  assert.equal(r.byDesigner.get(ME)!.counted.length, 6);
  assert.equal(r.byDesigner.get(ME)!.ask.length, 0);
  assert.equal(r.correctionMessage, undefined);
});

test("түзету сұралса, кейінгі файлдар сұраққа түседі; қайталанған атау саналмайды", () => {
  const msgs = [
    { id: 1, fromUserId: ME, text: [file("1.png"), file("2.png"), file("3.png")].join(" ") },
    { id: 2, fromUserId: MKT, text: "2-слайдты түзетіп жіберші" },
    { id: 3, fromUserId: ME, text: file("2 v2.png") },
    { id: 4, fromUserId: ME, text: file("3.png") },
    { id: 5, fromUserId: ME, text: file("notes.txt") },
  ];
  const r = countFiles(msgs, new Set([ME]), opts);
  const d = r.byDesigner.get(ME)!;
  assert.equal(d.counted.length, 3);
  assert.deepEqual(d.ask.map((f) => f.name), ["2 v2.png"]);
  assert.deepEqual(r.excluded.map((e) => e.reason).sort(), ["duplicate-name", "extension"]);
});

test("ТЗ ішіндегі «қате», «өзгерт» сөздері түзету сұрауы емес", () => {
  const msgs = [
    { id: 1, fromUserId: MKT, text: "ТЗ: мәтінді өзгертпей сал, қате болмасын" },
    { id: 2, fromUserId: ME, text: [file("p1.png"), file("p2.png")].join(" ") },
    { id: 3, fromUserId: ME, text: file("p3.png") },
  ];
  const d = countFiles(msgs, new Set([ME]), opts).byDesigner.get(ME)!;
  assert.equal(d.counted.length, 3);
  assert.equal(d.ask.length, 0);
});

test("формула қауіпсіз", () => {
  assert.equal(evalExpr("N-1", 17), 16);
  assert.equal(evalExpr("N-1", 0), 0);
  assert.equal(evalExpr("1", 5), 1);
  assert.throws(() => evalExpr("process.exit()", 1));
});

test("ережелер: R1, R2, R3, R4b, R7 басымдығы, R3b тексеру", () => {
  const loc = (project: string, board: string, column: string) => ({ project, board, column });
  const ok = (r: ReturnType<typeof applyRules>) => (r.status === "ok" ? r.items : r.reason);
  assert.deepEqual(ok(applyRules(RULES, loc("Marketing", "Пән акк", "Англ"), "Ақпараттық пост (2)", 17)), { Пост: 1, Карусель: 16 });
  assert.deepEqual(ok(applyRules(RULES, loc("Marketing", "Проект", "IELTS"), "Мотив пост", 5)), { Пост: 1, Карусель: 4 });
  assert.deepEqual(ok(applyRules(RULES, loc("Product", "YouTube", "ТЗ"), "МАТФИЗ КОМБО", 3)), { "YouTube обложка": 3 });
  assert.deepEqual(ok(applyRules(RULES, loc("Marketing", "Проект", "Таргет"), "Күзгі акция", 5)), { "Таргет баннер": 5 });
  assert.deepEqual(ok(applyRules(RULES, loc("Product", "YouTube", "ТЗ"), "ielts handouts", 4)), { Раздатка: 4 });
  assert.deepEqual(ok(applyRules(RULES, loc("Marketing", "Пән акк", "Биология"), "Таргет био", 2)), { "Таргет баннер": 2 });
  assert.deepEqual(ok(applyRules(RULES, loc("Marketing", "Проект", "Youtube"), "22.09 влог обложка", 1)), { "YouTube обложка": 1 });
  assert.deepEqual(ok(applyRules(RULES, loc("Marketing", "Пән акк", "География"), "Обложка (2)", 6)), { Пост: 1, Карусель: 5 });
  assert.deepEqual(ok(applyRules(RULES, loc("JUZENG", "Marketing", "IELTS"), "обложка Амина", 1)), { Обложка: 1 });
  assert.deepEqual(ok(applyRules(RULES, loc("JUZENG", "Marketing", "IELTS"), "нәтиже пост", 7)), { Пост: 1, Карусель: 6 });
  assert.deepEqual(ok(applyRules(RULES, loc("JUZENG", "Marketing", "IELTS"), "Ішкіге баннер 24.09", 2)), { Баннер: 2 });
  assert.deepEqual(ok(applyRules(RULES, loc("HR", "ПРОФ", "ТЗ"), "ПОСТ 8", 7)), { Пост: 1, Карусель: 6 });
  assert.deepEqual(ok(applyRules(RULES, loc("Design", "Dashboard", "ӨЗ ТЗ"), "преза вебинар 130 бет", 1)), { Презентация: 1 });
  assert.equal(applyRules(RULES, loc("JUZENG", "Marketing", "IELTS"), "6 чек-лист. 22.09", 10).status, "review");
  assert.equal(cleanTitle("КОМБО НҰСҚА ТАЛДАУ (5)"), "комбо нұсқа талдау");
});

test("есептеу: 0 файл → тексеру, орын белгісіз → тексеру", () => {
  const base = { id: "t1", title: "Мем пост", assigned: [ME], completed: true, completedTimestamp: 0 };
  const o = { rules: RULES, ...opts, manyFilesLimit: 60 };
  const c1 = calculateTask(base, { project: "Marketing", board: "Пән акк", column: "Англ" }, [], new Set([ME]), o);
  assert.equal(c1[0].status, "needs_review");
  const c2 = calculateTask(base, null, [{ id: 1, fromUserId: ME, text: file("a.png") }], new Set([ME]), o);
  assert.equal(c2[0].status, "needs_review");
  const c3 = calculateTask(base, { project: "Marketing", board: "Пән акк", column: "Англ" }, [{ id: 1, fromUserId: ME, text: [file("a.png"), file("b.png")].join(" ") }], new Set([ME]), o);
  assert.equal(c3[0].status, "ok");
  assert.deepEqual(c3[0].items, { Пост: 1, Карусель: 1 });
});

test("екі дизайнер: пост бірінші жіберген дизайнерге, екіншісіне тек карусель", () => {
  const OTHER = "nurbol";
  const o = { rules: RULES, ...opts, manyFilesLimit: 60 };
  const t = { id: "t2", title: "жазба пост / жоспар", assigned: [ME, OTHER], completed: true, completedTimestamp: 0 };
  const msgs = [
    { id: 1, fromUserId: OTHER, text: [file("o1.png"), file("o2.png"), file("o3.png")].join(" ") },
    { id: 2, fromUserId: ME, text: [file("m1.png"), file("m2.png")].join(" ") },
  ];
  const c = calculateTask(t, { project: "Marketing", board: "Пән акк", column: "Физика" }, msgs, new Set([ME, OTHER]), o);
  const by = Object.fromEntries(c.map((x) => [x.designerId, x.items]));
  assert.deepEqual(by[OTHER], { Пост: 1, Карусель: 2 });
  assert.deepEqual(by[ME], { Карусель: 2 });
});

test("апта Алматы бойынша: жексенбі 23:59 мен дүйсенбі 00:00", () => {
  const sun = Date.parse("2026-09-27T18:59:00Z"); // Алматы: жс 23:59
  const mon = Date.parse("2026-09-27T19:00:00Z"); // Алматы: дс 00:00
  assert.equal(weekOf(sun).monday, "2026-09-21");
  assert.equal(weekOf(mon).monday, "2026-09-28");
  const w = weekFromMonday("2026-09-21");
  assert.equal(weekRangeText(w), "21–27 қыркүйек");
  assert.equal(weekLabel(weekFromMonday("2026-10-05"), "2026-08-01"), "3-АЙ 1-АПТА");
  assert.deepEqual(subjectFor({ project: "Marketing", board: "Пән акк", column: "Дүниежүзі тарихы" }), { name: "ДЖТ", sheet: "ПӘН АКК" });
});

test("толық емес ТЗ: дедлайн жоқ, ереже жоқ", () => {
  const base = { title: "Мотив пост", project: "Marketing", board: "Пән акк", column_name: "Биология", deadline_at: "2026-10-03T12:00:00Z" };
  assert.deepEqual(tzReasons(base), []);
  assert.deepEqual(tzReasons({ ...base, deadline_at: null }), ["дедлайн жоқ"]);
  assert.match(tzReasons({ ...base, project: "JUZENG", board: "Marketing", column_name: "IELTS", title: "6 чек-лист" }).join(), /ереже табылмайды/);
  assert.deepEqual(tzReasons({ ...base, project: null }), ["орны белгісіз"]);
});

test("Google JWT RS256 қолтаңбасы дұрыс", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = signJwt({ client_email: "bot@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, "scope", "aud", 1000);
  const [h, b, sig] = jwt.split(".");
  const ok = createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  assert.equal(ok, true);
  assert.equal(JSON.parse(Buffer.from(b, "base64").toString()).iss, "bot@x.iam.gserviceaccount.com");
});

test("Marketing-тегі обложка → рилс обложка; Youtube колонкасы бұрынғыдай", () => {
  const items = (loc: any, title: string, n: number) => (applyRules(RULES, loc, title, n) as any).items;
  const comm = { project: "Marketing", board: "Проект", column: "Comm" };
  assert.deepEqual(items(comm, "Обложкалар < cmty (2)", 5), { Пост: 1, Карусель: 4 }); // екіұшты → растау сұралады
  assert.deepEqual(items(comm, "Рилс обложкалар", 5), { "Рилс обложка": 5 });
  assert.deepEqual(items(comm, "Reels шапка", 3), { "Рилс обложка": 3 });
  assert.deepEqual(items({ project: "Marketing", board: "Проект", column: "Youtube" }, "Обложка", 2), { "YouTube обложка": 2 });
  assert.deepEqual(items({ project: "Marketing", board: "Пән акк", column: "Биология" }, "Мотив пост", 4), { Пост: 1, Карусель: 3 });
  assert.deepEqual(items({ project: "Product", board: "YouTube", column: "ТЗ" }, "обложка", 2), { "YouTube обложка": 2 });
});

test("айлық мақсат: мәтінді талдау және конверсия (кестедегі формула)", async () => {
  const { parseGoalLine, parseFacts, parseProofs, conversion, summary } = await import("../src/services/goals.js");
  assert.deepEqual(parseGoalLine("1. Өнімділікті 95%-дан түсірмеу | 95%"), { title: "Өнімділікті 95%-дан түсірмеу", target: 95, isPercent: true });
  assert.deepEqual(parseGoalLine("ERF көрсеткішін 3.0-ге жеткізу | 3"), { title: "ERF көрсеткішін 3.0-ге жеткізу", target: 3, isPercent: false });
  assert.deepEqual(parseGoalLine("- Инстаграм жүргізу (1 пост, 1 рилс)"), { title: "Инстаграм жүргізу (1 пост, 1 рилс)", target: 100, isPercent: true });
  assert.deepEqual(parseFacts("100 80 = 1,66"), [100, 80, null, 1.66]);
  assert.deepEqual(parseFacts("1) 100%\n2) 72%\n3) 1.66"), [100, 72, 1.66]);
  assert.deepEqual(parseFacts("1-100 2-50"), [100, 50]);
  assert.deepEqual(parseProofs("2 https://vt.tiktok.com/a\n11: дәлел"), { 2: "https://vt.tiktok.com/a", 11: "дәлел" });
  // Кестедегі мысалдар: 96% / 95% мақсат → 100%; 30%/30% → 100%; 1,66/3 → 55%; 72/100 → 72%
  assert.equal(conversion({ target: 95 }, 96), 100);
  assert.equal(conversion({ target: 30 }, 30), 100);
  assert.equal(conversion({ target: 3 }, 1.66), 55);
  assert.equal(conversion({ target: 100 }, 72), 72);
  // Асылжан, тамыз: оп. 100,100,100,100,100,93,100,72,66 → 92%; страт. 100% → ортақ 96%
  const g = (kind: string, fact: number) => ({ kind, target: 100, fact }) as any;
  const s = summary([...[100, 100, 100, 100, 100, 93, 100, 72, 66].map((f) => g("op", f)), g("strat", 100)]);
  assert.deepEqual([s.op, s.strat, s.overall], [92, 100, 96]);
});

test("апта қорытындысы: префикспен және ретімен", async () => {
  const { parseNotes } = await import("../src/services/figmaExport.js");
  assert.deepEqual(parseNotes("Мәселе: файл кеш келді\nШешімі: ертерек сұрадым\nЖетістік: -\nҰсыныс: шаблон жасау"),
    { problem: "файл кеш келді", solution: "ертерек сұрадым", achievement: null, idea: "шаблон жасау" });
  assert.deepEqual(parseNotes("-\n-\nIELTS обложкалары бекітілді\n-"), { problem: null, solution: null, achievement: "IELTS обложкалары бекітілді", idea: null });
});
