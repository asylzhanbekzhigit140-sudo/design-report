/**
 * Тапсырма чатын тексеру: неге файл саналмағанын көру үшін.
 *   npm run inspect                         → әдепкі 7 тапсырма (0 файл шыққандар)
 *   npm run inspect -- DES-3160 PRO-2027    → өз тізіміңіз
 * Нәтиже: output/inspect.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import { YouGileClient, Structure } from "../src/yougile/client.js";
import { parseFiles } from "../src/core/files.js";

const KEY = process.env.YOUGILE_API_KEY;
if (!KEY) {
  console.error("YOUGILE_API_KEY жоқ (.env).");
  process.exit(1);
}
const DEFAULT = ["DES-3160", "DES-3047", "PRO-2027", "ENG-110", "DES-3079", "DES-3174", "DES-3189"];
const codes = process.argv.slice(2).filter((a) => /^[A-ZА-Я]+-\d+$/i.test(a));
const list = codes.length ? codes : DEFAULT;

const yg = new YouGileClient(KEY, process.env.YOUGILE_BASE_URL, 2000);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

async function main() {
  const users = new Map((await yg.users()).map((u) => [u.id, u.realName ?? u.id]));
  const st = new Structure(await yg.projects(), await yg.boards(), await yg.columns());
  const md: string[] = ["# Чат тексеру"];

  for (const code of list) {
    process.stdout.write(`\r${code}...      `);
    let t;
    try {
      t = await yg.task(code);
    } catch (e: any) {
      md.push(`\n## ${code}\nТабылмады: ${e.message}`);
      continue;
    }
    const loc = st.locate(t.columnId);
    md.push(`\n## ${code} — ${t.title}`);
    md.push(`Орны: ${loc ? `${loc.project} » ${loc.board} » ${loc.column}` : "?"} · Орындаушы: ${(t.assigned ?? []).map((a) => users.get(a) ?? a).join(", ")}`);
    const msgs = (await yg.messages(t.id)).sort((a, b) => a.id - b.id);
    md.push(`Хабарлама саны: ${msgs.length}`);
    md.push(`| Уақыт | Кімнен | Файлдар | Сілтемелер | Мәтін |`);
    md.push(`| --- | --- | --- | --- | --- |`);
    for (const m of msgs) {
      const text = m.text ?? "";
      const files = parseFiles(m).map((f) => f.name);
      const links = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((x) => new URL(x[0]).hostname);
      const words = text.replace(/\/root\/#file:\S+/g, "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
      const odd = !files.length && /file|user-data|\/root\//i.test(text) ? ` RAW: ${cut(text, 200)}` : "";
      const time = new Date(m.id + 5 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
      md.push(
        `| ${time} | ${users.get(m.fromUserId) ?? m.fromUserId} | ${files.length ? `${files.length}: ${cut(files.join(", "), 120)}` : "—"} | ${[...new Set(links)].join(", ") || "—"} | ${cut(words, 100).replace(/\|/g, "/")}${odd.replace(/\|/g, "/")} |`,
      );
    }
  }
  await mkdir("output", { recursive: true });
  await writeFile("output/inspect.md", md.join("\n"));
  console.log("\n✅ Дайын: output/inspect.md");
}

main().catch((e) => {
  console.error("Қате:", e.message ?? e);
  process.exit(1);
});
