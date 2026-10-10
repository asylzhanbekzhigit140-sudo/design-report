// data.json + сурет хэштері → use_figma-ға дайын код бөліктері (әрқайсысы 3 дизайнер, < 50 000 таңба)
//   node scripts/figma-batches.mjs <data.json> <hashes.json|-> <out-dir>
// hashes.json: { "liked/Бекжігіт-1.jpg": "<imageHash>", ... } (upload_assets нәтижесінен)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [dataPath, hashPath, out] = process.argv.slice(2);
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const hashes = hashPath && hashPath !== "-" ? JSON.parse(readFileSync(hashPath, "utf8")) : {};
const gen = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "figma-week.js"), "utf8");
const page = data.label.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim(); // «4-АЙ 2-АПТА» → «4 ай 2 апта»
mkdirSync(out, { recursive: true });
const slim = (d) => ({
  name: d.name, fullName: d.fullName, tasks: d.tasks, totals: d.totals, works: d.works, notes: d.notes, conversion: d.conversion,
  liked: d.liked.map((l) => ({ caption: l.caption, imageHash: hashes[l.file] ?? null })),
  goals: d.goals.map((g) => ({ n: g.n, kind: g.kind, title: g.title, conversion: g.conversion })),
});
const files = [];
for (let i = 0; i < data.designers.length; i += 3) {
  const DATA = { page, reset: i === 0, startIndex: i, label: data.label, range: data.range, month: data.month, designers: data.designers.slice(i, i + 3).map(slim) };
  const code = `const DATA = ${JSON.stringify(DATA)};\n${gen}`;
  if (code.length > 49000) throw new Error(`Бөлік ${i / 3 + 1} тым үлкен (${code.length})`);
  const f = join(out, `batch-${i / 3 + 1}.js`);
  writeFileSync(f, code);
  files.push(f);
}
console.log(JSON.stringify({ page, label: data.label, designers: data.designers.length, batches: files }));
