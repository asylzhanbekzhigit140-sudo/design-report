/**
 * Құрғақ іске қосу: бір аптаның есебін YouGile-ден есептеп, файлға жазады.
 * Database, Telegram қолданылмайды. YouGile-де ештеңе өзгермейді.
 *
 *   npm run dry-run                    → өткен апта
 *   npm run dry-run -- 2026-09-21      → сол дүйсенбіден басталатын апта
 *
 * Нәтиже: output/dry-run-<дүйсенбі>.md (+ .json)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { YouGileClient, Structure, type YgTask } from "../src/yougile/client.js";
import { calculateTask, type Calculation } from "../src/core/calculate.js";
import { weekOf, weekFromMonday, weekLabel, weekRangeText, inWeek } from "../src/time/week.js";
import { DESIGNERS, RULES, ALLOWED_EXTS, CORRECTION_WORDS, MANY_FILES_LIMIT, subjectFor, WORK_TYPES } from "../src/seed/catalog.js";

const KEY = process.env.YOUGILE_API_KEY;
if (!KEY) {
  console.error("YOUGILE_API_KEY жоқ (.env).");
  process.exit(1);
}

const arg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const week = arg ? weekFromMonday(arg) : weekOf(weekOf(Date.now()).startMs - 1);
const label = weekLabel(week, process.env.REPORT_MONTH1);

const yg = new YouGileClient(KEY, process.env.YOUGILE_BASE_URL, Number(process.env.YG_INTERVAL_MS ?? 2000));
const log = (s: string) => console.log(s);

async function main() {
  log(`Апта: ${weekRangeText(week)} (${label})`);

  // 1. Дизайнерлер
  const users = await yg.users();
  const designerByYgId = new Map<string, (typeof DESIGNERS)[number]>();
  for (const d of DESIGNERS) {
    const u = users.find((x) => (x.realName ?? "").trim().toLowerCase() === d.yougileName.toLowerCase());
    if (u) designerByYgId.set(u.id, d);
    else log(`⚠️ YouGile-де табылмады: ${d.yougileName}`);
  }
  const designerIds = new Set(designerByYgId.keys());

  // 2. Құрылым
  const structure = new Structure(await yg.projects(), await yg.boards(), await yg.columns());

  // 3. Аптада жабылған тапсырмалар
  const tasks = new Map<string, YgTask>();
  for (const [id, d] of designerByYgId) {
    const list = await yg.tasksAssignedTo(id);
    const done = list.filter((t) => t.completed && !t.deleted && t.completedTimestamp && inWeek(t.completedTimestamp, week));
    done.forEach((t) => tasks.set(t.id, t));
    log(`  ${d.shortName}: ${list.length} тапсырма, осы аптада жабылғаны ${done.length}`);
  }

  // 4. Әр тапсырманы есептеу
  const calcs: Calculation[] = [];
  let i = 0;
  for (const t of tasks.values()) {
    i++;
    process.stdout.write(`\r  Чаттарды оқу: ${i}/${tasks.size}`);
    const msgs = await yg.messages(t.id);
    calcs.push(
      ...calculateTask(t, structure.locate(t.columnId), msgs, designerIds, {
        rules: RULES,
        allowedExts: ALLOWED_EXTS,
        correctionWords: CORRECTION_WORDS,
        manyFilesLimit: MANY_FILES_LIMIT,
      }),
    );
  }
  log("");

  // 5. Жиынтық: дизайнер → пән/акк → жұмыс түрі
  const md: string[] = [];
  const name = (id: string) => designerByYgId.get(id)?.shortName ?? id;
  md.push(`# Құрғақ есеп — ${weekRangeText(week)} (${label})`);
  md.push(`Тапсырма: ${tasks.size}, есептеу: ${calcs.length}, YouGile сұранысы: ${yg.requests}`);
  const counts = { ok: 0, needs_review: 0, ask_designer: 0 };
  calcs.forEach((c) => counts[c.status]++);
  md.push(`Автоматты: ${counts.ok} · Тексеру қажет: ${counts.needs_review} · Дизайнерден сұралады: ${counts.ask_designer}`);
  md.push("");

  for (const [id, d] of designerByYgId) {
    const mine = calcs.filter((c) => c.designerId === id && c.status !== "needs_review");
    if (!mine.length) continue;
    md.push(`## ${d.shortName} (${d.excelName})`);
    const bySubject = new Map<string, Record<string, number>>();
    for (const c of mine) {
      const s = subjectFor(c.location);
      const key = `${s.sheet} · ${s.name}`;
      const acc = bySubject.get(key) ?? {};
      for (const [wt, q] of Object.entries(c.items)) acc[wt] = (acc[wt] ?? 0) + q;
      bySubject.set(key, acc);
    }
    for (const [subj, items] of [...bySubject].sort()) {
      const parts = WORK_TYPES.filter((w) => items[w]).map((w) => `${w}: ${items[w]}`);
      md.push(`- **${subj}** — ${parts.join(", ") || "0"}`);
    }
    md.push("");
  }

  const review = calcs.filter((c) => c.status !== "ok");
  if (review.length) {
    md.push(`## ⚠️ Тексеру / сұрақ (${review.length})`);
    md.push(`| Код | Тапсырма | Дизайнер | Орны | Файл | Себебі |`);
    md.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const c of review) {
      const loc = c.location ? `${c.location.project} » ${c.location.board} » ${c.location.column}` : "—";
      md.push(`| ${c.taskCode} | ${c.title.replace(/\|/g, "/")} | ${name(c.designerId)} | ${loc} | ${c.fileCount}${c.trace.ask.length ? ` (+${c.trace.ask.length}?)` : ""} | ${c.reasons.join("; ")} |`);
    }
    md.push("");
  }

  md.push(`## Барлық тапсырма (trace)`);
  md.push(`| Код | Тапсырма | Дизайнер | Орны | Файл | Ереже | Нәтиже | Ескерту |`);
  md.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const c of [...calcs].sort((a, b) => name(a.designerId).localeCompare(name(b.designerId)))) {
    const loc = c.location ? `${c.location.project} » ${c.location.board} » ${c.location.column}` : "—";
    const res = Object.entries(c.items).map(([k, v]) => `${k} ${v}`).join(", ") || (c.status === "ok" ? "0" : "⚠️");
    md.push(`| ${c.taskCode} | ${c.title.replace(/\|/g, "/")} | ${name(c.designerId)} | ${loc} | ${c.fileCount} | ${c.ruleCode ?? "—"} | ${res} | ${c.warnings.join("; ")} |`);
  }

  await mkdir("output", { recursive: true });
  await writeFile(`output/dry-run-${week.monday}.md`, md.join("\n"));
  await writeFile(`output/dry-run-${week.monday}.json`, JSON.stringify(calcs, null, 2));
  log(`✅ Дайын: output/dry-run-${week.monday}.md`);
}

main().catch((e) => {
  console.error("\nҚате:", e.message ?? e);
  process.exit(1);
});
