/**
 * 0-қадам: YouGile API probe.
 *
 * Тек ОҚИДЫ (GET). YouGile-де ештеңе өзгертпейді.
 * Нәтиже: output/ папкасы
 *   - probe-summary.md  → осыны Claude-қа жіберіңіз
 *   - task.json, messages.json, structure.json → қажет болса ғана
 *
 * Іске қосу: npm run probe
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE = (process.env.YOUGILE_BASE_URL ?? "https://ru.yougile.com/api-v2").replace(/\/$/, "");
const KEY = process.env.YOUGILE_API_KEY;
const TASK_CODE = process.env.PROBE_TASK ?? "DES-3222";
const DESIGN_PROJECT = process.env.PROBE_DESIGN_PROJECT ?? "Design";
const DELAY_MS = Number(process.env.PROBE_DELAY_MS ?? 2000); // ≤ 30 сұраныс/мин — компанияның 50/мин шегінен әлдеқайда төмен
const OUT = "output";

if (!KEY) {
  console.error("YOUGILE_API_KEY жоқ. .env файлын толтырыңыз (README қараңыз).");
  process.exit(1);
}

type Res = { status: number; body: any; headers: Record<string, string> };

let requestCount = 0;
const md: string[] = [];
const say = (line = "") => {
  md.push(line);
  console.log(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string, params: Record<string, string | number> = {}): Promise<Res> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (requestCount > 0) await sleep(DELAY_MS);
    requestCount++;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (/limit|retry|remaining/i.test(k)) headers[k] = v;
    });
    if (res.status === 429) {
      console.warn(`429 rate limit (${path}) — 60 секунд күтемін...`);
      await sleep(60_000);
      continue;
    }
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* мәтін күйінде қалады */
    }
    return { status: res.status, body, headers };
  }
  return { status: 429, body: null, headers: {} };
}

/** limit/offset беттерін түгел жинау (құрылым үшін ғана) */
async function getAll(path: string): Promise<{ items: any[]; pagingShape: any; status: number }> {
  const items: any[] = [];
  let offset = 0;
  let pagingShape: any = null;
  for (let page = 0; page < 20; page++) {
    const r = await get(path, { limit: 1000, offset });
    if (r.status !== 200) return { items, pagingShape, status: r.status };
    pagingShape ??= r.body?.paging ?? null;
    const content: any[] = Array.isArray(r.body) ? r.body : r.body?.content ?? [];
    items.push(...content);
    if (!r.body?.paging?.next || content.length === 0) break;
    offset += content.length;
  }
  return { items, pagingShape, status: 200 };
}

const keysOf = (o: any) => (o && typeof o === "object" ? Object.keys(o).sort().join(", ") : "—");
const looksLikeMs = (n: unknown) =>
  typeof n === "number" && n > Date.parse("2020-01-01") && n < Date.parse("2035-01-01");
const iso = (n: unknown) => (looksLikeMs(n) ? new Date(n as number).toISOString() : String(n));
const FILE_HINT = /user-data|\/files?\/|\.(png|jpe?g|webp|gif|pdf|mp4|mov|psd|fig)\b/i;
const cut = (s: unknown, n = 400) => {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

async function main() {
  await mkdir(OUT, { recursive: true });
  say(`# YouGile API probe — ${new Date().toISOString()}`);
  say(`Base URL: ${BASE}`);
  say();

  // 1. Қызметкерлер
  const users = await getAll("/users");
  const userName = new Map<string, string>();
  for (const u of users.items) userName.set(u.id, u.realName ?? u.name ?? u.id);
  say(`## 1. Қызметкерлер`);
  say(`Статус: ${users.status}, саны: ${users.items.length}`);
  say(`Қызметкер өрістері: ${keysOf(users.items[0])}`);
  say(`Paging пішіні: \`${JSON.stringify(users.pagingShape)}\``);
  say();

  // 2–4. Құрылым: жоба » тақта » колонка
  const projects = await getAll("/projects");
  const boards = await getAll("/boards");
  const columns = await getAll("/columns");
  say(`## 2. Құрылым`);
  say(`Статус: projects ${projects.status}, boards ${boards.status}, columns ${columns.status}`);
  say(`Саны: ${projects.items.length} жоба, ${boards.items.length} тақта, ${columns.items.length} колонка`);
  say(`Project өрістері: ${keysOf(projects.items[0])}`);
  say(`Board өрістері: ${keysOf(boards.items[0])}`);
  say(`Column өрістері: ${keysOf(columns.items[0])}`);
  say();
  const colById = new Map(columns.items.map((c: any) => [c.id, c]));
  const boardById = new Map(boards.items.map((b: any) => [b.id, b]));
  const projectById = new Map(projects.items.map((p: any) => [p.id, p]));
  for (const p of projects.items.filter((p: any) => !p.deleted)) {
    say(`- **${p.title}**`);
    for (const b of boards.items.filter((b: any) => b.projectId === p.id && !b.deleted)) {
      const cols = columns.items.filter((c: any) => c.boardId === b.id && !c.deleted).map((c: any) => c.title);
      say(`  - ${b.title}: ${cols.join(" · ") || "—"}`);
    }
  }
  say();
  await writeFile(
    `${OUT}/structure.json`,
    JSON.stringify({ projects: projects.items, boards: boards.items, columns: columns.items }, null, 2),
  );

  // 5. Бір тапсырма
  say(`## 3. Тапсырма ${TASK_CODE}`);
  const t = await get(`/tasks/${encodeURIComponent(TASK_CODE)}`);
  say(`Статус: ${t.status}`);
  let task: any = null;
  if (t.status === 200 && t.body?.id) {
    task = t.body;
    await writeFile(`${OUT}/task.json`, JSON.stringify(task, null, 2));
    say(`Барлық өрістер: ${keysOf(task)}`);
    const col: any = colById.get(task.columnId);
    const board: any = col && boardById.get(col.boardId);
    const proj: any = board && projectById.get(board.projectId);
    say(`Орны: ${proj?.title ?? "?"} » ${board?.title ?? "?"} » ${col?.title ?? "?"}`);
    say(`Атауы: ${task.title}`);
    say(`completed: ${JSON.stringify(task.completed)}`);
    for (const [k, v] of Object.entries(task)) {
      if (/time|date|stamp|complet|deadline/i.test(k)) say(`- ${k}: \`${cut(JSON.stringify(v), 200)}\` ${looksLikeMs(v) ? `(${iso(v)})` : ""}`);
    }
    const assigned: string[] = task.assigned ?? [];
    say(`Орындаушылар: ${assigned.map((id) => userName.get(id) ?? id).join(", ") || "—"}`);
    say(`Жасаған: ${userName.get(task.createdBy) ?? task.createdBy ?? "—"}`);
  } else {
    say(`Тапсырма кодпен табылмады. Жауап: \`${cut(JSON.stringify(t.body), 300)}\``);
  }
  say();

  // 6. Тапсырма чаты
  say(`## 4. Чат хабарламалары`);
  if (task) {
    const m = await get(`/chats/${task.id}/messages`, { limit: 100 });
    const msgs: any[] = Array.isArray(m.body) ? m.body : m.body?.content ?? [];
    say(`Статус: ${m.status}, хабарлама саны: ${msgs.length}, paging: \`${JSON.stringify(m.body?.paging ?? null)}\``);
    say(`Хабарлама өрістері: ${keysOf(msgs[0])}`);
    say(`id уақыт белгісіне ұқсай ма: ${msgs.length ? msgs.every((x) => looksLikeMs(x.id)) : "?"}`);
    await writeFile(`${OUT}/messages.json`, JSON.stringify(m.body, null, 2));
    say();
    say(`| # | Кімнен | id → уақыт | Файл белгісі | Мәтін (қысқа) |`);
    say(`| --- | --- | --- | --- | --- |`);
    msgs.slice(0, 30).forEach((x, i) => {
      const raw = JSON.stringify(x);
      say(
        `| ${i + 1} | ${userName.get(x.fromUserId) ?? x.fromUserId} | ${iso(x.id)} | ${FILE_HINT.test(raw) ? "иә" : "—"} | ${cut(x.text, 80).replace(/\|/g, "/")} |`,
      );
    });
    say();
    const withFiles = msgs.filter((x) => FILE_HINT.test(JSON.stringify(x))).slice(0, 2);
    say(`### Файлы бар хабарламаның толық түрі (2 мысал)`);
    for (const x of withFiles) say("```json\n" + cut(JSON.stringify(x, null, 2), 2500) + "\n```");
    if (!withFiles.length) say("Файл белгісі бар хабарлама табылмады — messages.json-ды тексеру керек.");
  } else {
    say("Тапсырма табылмағандықтан өткізілді.");
  }
  say();

  // 7. Дизайнерлердің тапсырмалары көріне ме
  say(`## 5. Көрінуі: «${DESIGN_PROJECT}» жобасының мүшелері`);
  const design: any = projects.items.find((p: any) => p.title?.trim() === DESIGN_PROJECT);
  const members = design?.users ? Object.keys(design.users) : [];
  if (!members.length) say(`«${DESIGN_PROJECT}» жобасы немесе оның мүшелері табылмады.`);
  else {
    say(`| Қызметкер | Барлық тапсырма (paging.count) | Алғашқы 100-дің ішінде жабылғаны | Мысал орны |`);
    say(`| --- | --- | --- | --- |`);
    for (const id of members) {
      const r = await get("/task-list", { assignedTo: id, limit: 100 });
      const list: any[] = r.body?.content ?? [];
      const done = list.filter((x) => x.completed);
      const s = done[0] ?? list[0];
      const col: any = s && colById.get(s.columnId);
      const board: any = col && boardById.get(col.boardId);
      const proj: any = board && projectById.get(board.projectId);
      say(
        `| ${userName.get(id) ?? id} | ${r.status === 200 ? r.body?.paging?.count ?? list.length : "статус " + r.status} | ${done.length} | ${s ? `${proj?.title ?? "?"} » ${board?.title ?? "?"}` : "—"} |`,
      );
    }
  }
  say();

  // 8. Webhooks (тек оқу)
  const w = await get("/webhooks");
  say(`## 6. Webhooks`);
  say(`GET /webhooks статусы: ${w.status} (200 = рұқсат бар, 403 = әкімші құқығы керек)`);
  say();

  say(`## 7. Техникалық`);
  say(`Жалпы сұраныс саны: ${requestCount}`);
  say(`Rate-limit тақырыптары (соңғы): \`${JSON.stringify(w.headers)}\``);

  await writeFile(`${OUT}/probe-summary.md`, md.join("\n"));
  console.log(`\n✅ Дайын. ${OUT}/probe-summary.md файлын Claude-қа жіберіңіз.`);
}

main().catch((e) => {
  console.error("Қате:", e);
  process.exit(1);
});
