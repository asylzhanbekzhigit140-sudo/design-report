/**
 * Figma апталық есебіне арналған деректер жинағы.
 * Дүйсенбі 12:00 бот өткен аптаның деректерін GitHub репозиторийінің `reports` бұтағына салады:
 *   weeks/<monday>/data.json   — әр дизайнердің жұмыстары, ұнаған жұмыстары, апта қорытындысы, мақсаттары
 *   weeks/<monday>/liked/*.jpg — ұнаған жұмыстардың суреттері
 * Сосын Claude-тың жоспарлы тапсырмасы осы деректен «ЕСЕП | DSGN» файлында бәріне бірдей шаблонмен слайд жасайды.
 * `reports` бұтағына жазу Railway-дің main бұтағынан деплойына әсер етпейді.
 */
import { q, one, audit } from "../db/db.js";
import { weekRows, COUNTED } from "./reports.js";
import { subjectFor, DESIGNERS, FULL_NAMES, WORK_TYPES } from "../seed/catalog.js";
import { weekFromMonday, weekRangeText, weekLabel } from "../time/week.js";
import { config } from "../config.js";
import { goalsWithProgress, summary, conversion, likedOf, downloadTelegramFile, monthName, monthOf } from "./goals.js";

export type Notes = { problem: string | null; solution: string | null; achievement: string | null; idea: string | null };
export const NOTE_KEYS: (keyof Notes)[] = ["problem", "solution", "achievement", "idea"];
export const NOTE_NAMES: Record<keyof Notes, string> = { problem: "Орын алған мәселе", solution: "Шешімі", achievement: "Жетістік", idea: "Ұсыныс/идея" };

/** «Мәселе: …\nШешімі: …» немесе ретімен 4 жол; «-» — бос */
export function parseNotes(text: string): Notes {
  const out: Notes = { problem: null, solution: null, achievement: null, idea: null };
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const pref: [RegExp, keyof Notes][] = [[/^(орын алған )?мәселе/i, "problem"], [/^шешім/i, "solution"], [/^жетістік/i, "achievement"], [/^(ұсыныс|идея)/i, "idea"]];
  let positional = 0;
  for (const l of lines) {
    const hit = pref.find(([re]) => re.test(l));
    const key = hit ? hit[1] : NOTE_KEYS[positional++];
    if (!key) continue;
    const v = (hit ? l.replace(/^[^:—–-]*[:—–-]\s*/, "") : l).trim();
    out[key] = !v || /^[-–—]$/.test(v) ? null : v.slice(0, 500);
  }
  return out;
}

export const notesOf = (yid: string, monday: string) =>
  one<Notes>("SELECT problem, solution, achievement, idea FROM weekly_notes WHERE designer_yid=$1 AND week=$2", [yid, monday]);

export async function saveNotes(yid: string, monday: string, n: Notes) {
  await q(
    `INSERT INTO weekly_notes (designer_yid, week, problem, solution, achievement, idea) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (designer_yid, week) DO UPDATE SET problem=$3, solution=$4, achievement=$5, idea=$6, updated_at=now()`,
    [yid, monday, n.problem, n.solution, n.achievement, n.idea],
  );
}

const UNIT: Record<string, string> = { Пост: "пост", Карусель: "карусель" };

/** Слайдқа: «әдебтіл - 1 пост», «обложка - 4 шт» */
function workLines(items: Map<string, Record<string, number>>) {
  const out: string[] = [];
  for (const [subj, it] of items)
    for (const wt of WORK_TYPES) {
      const n = it[wt];
      if (!n) continue;
      out.push(UNIT[wt] ? `${subj.toLowerCase()} - ${n} ${UNIT[wt]}` : `${subj.toLowerCase()} ${wt.toLowerCase()} - ${n} шт`);
    }
  return out;
}

export async function buildWeekPayload(monday: string) {
  const w = weekFromMonday(monday);
  const label = (await one<{ label: string }>("SELECT label FROM weeks WHERE monday=$1", [monday]))?.label ?? weekLabel(w, config.month1);
  const people = await q<{ yougile_id: string; excel_name: string; name: string }>(
    "SELECT yougile_id, excel_name, name FROM people WHERE role='designer' AND active AND yougile_id IS NOT NULL",
  );
  const order = [...DESIGNERS.map((d) => people.find((p) => p.excel_name === d.excelName)).filter(Boolean), ...people.filter((p) => !DESIGNERS.some((d) => d.excelName === p.excel_name))] as typeof people;
  const all = await weekRows(monday);
  const designers: any[] = [];
  const images: { path: string; fileId: string }[] = [];
  for (const p of order) {
    const rows = all.filter((r) => r.designer_yid === p.yougile_id && COUNTED.has(r.status));
    const bySubj = new Map<string, Record<string, number>>();
    const totals: Record<string, number> = {};
    for (const r of rows) {
      const s = subjectFor(r.trace.location ?? null).name;
      const e = bySubj.get(s) ?? {};
      for (const [k, v] of Object.entries(r.items)) { e[k] = (e[k] ?? 0) + v; totals[k] = (totals[k] ?? 0) + v; }
      bySubj.set(s, e);
    }
    const goals = await goalsWithProgress(p.yougile_id, monday);
    const s = summary(goals);
    const liked = (await likedOf(p.yougile_id, monday)).map((l, i) => {
      const path = `liked/${p.excel_name}-${i + 1}.jpg`;
      images.push({ path, fileId: l.file_id });
      return { file: path, caption: l.caption };
    });
    designers.push({
      name: p.name,
      excelName: p.excel_name,
      fullName: FULL_NAMES[p.excel_name] ?? p.name.toUpperCase(),
      works: workLines(bySubj),
      totals,
      tasks: rows.length,
      liked,
      notes: (await notesOf(p.yougile_id, monday)) ?? { problem: null, solution: null, achievement: null, idea: null },
      goals: goals.map((g, i) => ({
        n: i + 1, kind: g.kind, title: g.title, target: g.target, fact: g.fact, isPercent: g.is_percent, conversion: conversion(g, g.fact), proof: g.proof,
      })),
      conversion: { op: s.op, strat: s.strat, overall: s.overall, done: s.done, total: s.total },
    });
  }
  return {
    payload: { monday, label, range: weekRangeText(w), month: monthName(monthOf(monday)), generatedAt: new Date().toISOString(), designers },
    images,
  };
}

// ---------- GitHub ----------
const GH = () => process.env.GITHUB_API || "https://api.github.com";
const ghRepo = () => process.env.GITHUB_REPO || "asylzhanbekzhigit140-sudo/design-report";
const ghBranch = () => process.env.GITHUB_REPORTS_BRANCH || "reports";
export const githubEnabled = () => !!process.env.GITHUB_TOKEN;

async function gh(path: string, init: RequestInit = {}) {
  const res = await fetch(`${GH()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) },
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ensureBranch() {
  const b = ghBranch();
  if ((await gh(`/repos/${ghRepo()}/branches/${b}`)).status === 200) return;
  const repo = await gh(`/repos/${ghRepo()}`);
  if (repo.status !== 200) throw new Error(`GitHub репозиторийі ашылмады (${repo.status}): токен рұқсатын тексеріңіз`);
  const main = await gh(`/repos/${ghRepo()}/git/ref/heads/${repo.body.default_branch}`);
  const r = await gh(`/repos/${ghRepo()}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${b}`, sha: main.body.object.sha }) });
  if (r.status >= 300) throw new Error(`«${b}» бұтағы жасалмады (${r.status})`);
}

async function putFile(path: string, content: Buffer, message: string) {
  const url = `/repos/${ghRepo()}/contents/${encodeURI(path)}`;
  const cur = await gh(`${url}?ref=${ghBranch()}`);
  const r = await gh(url, {
    method: "PUT",
    body: JSON.stringify({ message, content: content.toString("base64"), branch: ghBranch(), ...(cur.status === 200 ? { sha: cur.body.sha } : {}) }),
  });
  if (r.status >= 300) throw new Error(`${path}: GitHub ${r.status} ${r.body?.message ?? ""}`);
}

/** Аптаның деректерін GitHub-қа салу. Қайтарады: дизайнер, сурет саны */
export async function exportWeekToGitHub(monday: string, actor = "system") {
  if (!githubEnabled()) throw new Error("GITHUB_TOKEN орнатылмаған");
  await ensureBranch();
  const { payload, images } = await buildWeekPayload(monday);
  let uploaded = 0;
  for (const img of images) {
    const f = await downloadTelegramFile(img.fileId);
    if (!f) continue;
    await putFile(`weeks/${monday}/${img.path}`, f.buffer, `Апталық есеп ${monday}: ${img.path}`);
    uploaded++;
  }
  await putFile(`weeks/${monday}/data.json`, Buffer.from(JSON.stringify(payload, null, 2)), `Апталық есеп ${monday}: деректер`);
  await putFile("weeks/latest.txt", Buffer.from(monday + "\n"), `Апталық есеп ${monday}: соңғы апта`);
  await audit(actor, "figma_export", `week:${monday}`, { designers: payload.designers.length, images: uploaded });
  return { designers: payload.designers.length, images: uploaded, label: payload.label };
}
