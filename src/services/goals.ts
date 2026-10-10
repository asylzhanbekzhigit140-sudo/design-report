/**
 * Айлық мақсаттар — «DESIGN | АЙЛЫҚ МАҚСАТТАР 2026-2027» кестесінің логикасы:
 *   Операционный және Стратегиялық мақсаттар; әрқайсысында Бастапқы · Мақсат · Факт · Конверсия · Дәлел.
 *   Конверсия = Факт ÷ Мақсат (100%-дан аспайды). Бөлім көрсеткіші = конверсиялардың орташасы.
 *   Ортақ көрсеткіш = бөлімдердің орташасы.
 * Дизайнер айдың басында мақсаттарын ботқа енгізеді, сенбі сайын фактіні жазады,
 * аптаның ұнаған жұмыстарын (сурет) жібереді. Бәрі апталық есепке өзі қосылады.
 */
import { q, audit } from "../db/db.js";
import { config } from "../config.js";
import { esc } from "./reports.js";

export const MAX_GOALS = 15;
export const MAX_LIKED = 3;

export type Kind = "op" | "strat";
export const KIND_NAME: Record<Kind, string> = { op: "Операционный мақсаттар", strat: "Стратегиялық мақсаттар" };

export type Goal = {
  id: number; designer_yid: string; month: string; kind: Kind; pos: number; title: string;
  base: number; target: number; is_percent: boolean;
};
export type GoalRow = Goal & { fact: number | null; proof: string | null; week_fact: number | null };

/** Апта дүйсенбісі түскен ай: «2026-10» */
export const monthOf = (monday: string) => monday.slice(0, 7);
const MONTHS = ["ҚАҢТАР", "АҚПАН", "НАУРЫЗ", "СӘУІР", "МАМЫР", "МАУСЫМ", "ШІЛДЕ", "ТАМЫЗ", "ҚЫРКҮЙЕК", "ҚАЗАН", "ҚАРАША", "ЖЕЛТОҚСАН"];
export const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1];
export const prevMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

// ---------- Есептеу (кестедегі формула) ----------
/** Нақты конверсия (дөңгелектемей) — орташа осыдан есептеледі, кестедегідей */
export const conversionRaw = (g: { target: number }, fact: number | null) =>
  fact === null || !(g.target > 0) ? 0 : Math.min(100, (fact / g.target) * 100);
export const conversion = (g: { target: number }, fact: number | null) => Math.round(conversionRaw(g, fact));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const avg = (xs: number[]) => Math.round(mean(xs));

export function summary(rows: GoalRow[]) {
  const sec = (k: Kind) => rows.filter((g) => g.kind === k).map((g) => conversionRaw(g, g.fact));
  const op = sec("op"), strat = sec("strat");
  const parts = [op, strat].filter((x) => x.length).map(mean);
  const all = rows.map((g) => conversion(g, g.fact));
  return {
    op: op.length ? avg(op) : null,
    strat: strat.length ? avg(strat) : null,
    overall: avg(parts),
    done: all.filter((c) => c >= 100).length,
    total: rows.length,
  };
}

export const fmtVal = (v: number | null, isPercent: boolean) =>
  v === null ? "—" : `${String(Math.round(v * 100) / 100).replace(".", ",")}${isPercent ? "%" : ""}`;

// ---------- Мәтінді талдау ----------
/** «Өнімділікті 95%-дан түсірмеу | 95%», «ERF 3.0-ге жеткізу | 3» → {title, target, isPercent} */
export function parseGoalLine(line: string): { title: string; target: number; isPercent: boolean } | null {
  let t = line.replace(/^\s*(\d+[.)]|[-•*–—])\s*/, "").trim();
  let target = 100, isPercent = true;
  const m = t.match(/\|\s*(\d+(?:[.,]\d+)?)\s*(%?)\s*$/);
  if (m) {
    target = Number(m[1].replace(",", "."));
    isPercent = m[2] === "%";
    t = t.slice(0, m.index).trim();
  }
  if (t.length < 2 || !(target > 0)) return null;
  return { title: t.slice(0, 250), target, isPercent };
}
export const parseGoalLines = (text: string) =>
  text.split(/\n+/).map(parseGoalLine).filter((x): x is NonNullable<ReturnType<typeof parseGoalLine>> => !!x);

/**
 * «100 80 50», «1) 100% 2) 80%», «1,66 7», «100 = 50» → [100, 80, 50] / [1.66, 7] / [100, null, 50].
 * Нөмірлеу («1)», «2.», «3 -») есепке алынбайды; «=» — өзгермеді (null).
 */
export function parseFacts(text: string): (number | null)[] {
  const cleaned = text
    .split(/\n/)
    .map((l) => l.replace(/^\s*\d+\s*[).:\-–]\s+/, "").replace(/(^|\s)\d+\s*[)\-–:]\s*(?=[\d=])/g, "$1"))
    .join(" ");
  return [...cleaned.matchAll(/=|\d+(?:[.,]\d+)?/g)].map((m) => (m[0] === "=" ? null : Number(m[0].replace(",", "."))));
}

/** «2 https://…», «5: сілтеме» → {2: "https://…", 5: "сілтеме"} */
export function parseProofs(text: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const l of text.split(/\n+/)) {
    const m = l.match(/^\s*(\d+)\s*[).:\-–]?\s+(.+)$/);
    if (m) out[Number(m[1])] = m[2].trim().slice(0, 500);
  }
  return out;
}

// ---------- Деректер ----------
export const goalsOf = (yid: string, month: string) =>
  q<Goal>("SELECT * FROM goals WHERE designer_yid=$1 AND month=$2 AND active ORDER BY CASE kind WHEN 'op' THEN 0 ELSE 1 END, pos, id", [yid, month]);

/** Айдың мақсаттары + берілген аптаға дейінгі соңғы факт + осы аптаның фактісі */
export function goalsWithProgress(yid: string, monday: string): Promise<GoalRow[]> {
  return q<GoalRow>(
    `SELECT g.*, lp.fact, lp.proof, wp.fact AS week_fact
       FROM goals g
       LEFT JOIN LATERAL (SELECT fact, proof FROM goal_progress p WHERE p.goal_id=g.id AND p.week <= $3 ORDER BY week DESC LIMIT 1) lp ON true
       LEFT JOIN goal_progress wp ON wp.goal_id=g.id AND wp.week=$3
      WHERE g.designer_yid=$1 AND g.month=$2 AND g.active
      ORDER BY CASE g.kind WHEN 'op' THEN 0 ELSE 1 END, g.pos, g.id`,
    [yid, monthOf(monday), monday],
  );
}

export async function addGoals(yid: string, month: string, kind: Kind, items: { title: string; target: number; isPercent: boolean }[], actor: string) {
  const cur = await goalsOf(yid, month);
  const take = items.slice(0, Math.max(0, MAX_GOALS - cur.length));
  let pos = cur.filter((g) => g.kind === kind).reduce((a, g) => Math.max(a, g.pos), 0);
  for (const it of take)
    await q("INSERT INTO goals (designer_yid, month, kind, pos, title, target, is_percent) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [yid, month, kind, ++pos, it.title, it.target, it.isPercent]);
  if (take.length) await audit(actor, "goals_add", `designer:${yid}`, { month, kind, items: take });
  return { added: take.length, skipped: items.length - take.length };
}

/** Өткен айдың мақсаттарын осы айға көшіру (фактісіз) */
export async function copyPrevMonth(yid: string, month: string, actor: string) {
  const prev = await q<{ month: string }>("SELECT month FROM goals WHERE designer_yid=$1 AND month < $2 AND active ORDER BY month DESC LIMIT 1", [yid, month]);
  if (!prev.length) return 0;
  const src = await goalsOf(yid, prev[0].month);
  for (const k of ["op", "strat"] as Kind[])
    await addGoals(yid, month, k, src.filter((g) => g.kind === k).map((g) => ({ title: g.title, target: g.target, isPercent: g.is_percent })), actor);
  return src.length;
}

export async function renameGoal(id: number, yid: string, line: string, actor: string) {
  const g = parseGoalLine(line);
  if (!g) return false;
  await q("UPDATE goals SET title=$3, target=$4, is_percent=$5 WHERE id=$1 AND designer_yid=$2", [id, yid, g.title, g.target, g.isPercent]);
  await audit(actor, "goal_edit", `goal:${id}`, g);
  return true;
}

export async function removeGoal(id: number, yid: string, actor: string) {
  await q("UPDATE goals SET active=false WHERE id=$1 AND designer_yid=$2", [id, yid]);
  await audit(actor, "goal_remove", `goal:${id}`);
}

export async function saveFacts(goals: { id: number }[], facts: number[], monday: string, actor: string) {
  for (let i = 0; i < goals.length; i++)
    await q(
      `INSERT INTO goal_progress (goal_id, week, fact, proof)
         VALUES ($1,$2,$3,(SELECT proof FROM goal_progress WHERE goal_id=$1 AND week <= $2 ORDER BY week DESC LIMIT 1))
       ON CONFLICT (goal_id, week) DO UPDATE SET fact=EXCLUDED.fact, updated_at=now()`,
      [goals[i].id, monday, facts[i]],
    );
  await audit(actor, "goal_facts", `week:${monday}`, { goals: goals.map((g) => g.id), facts });
}

export async function saveProof(goalId: number, monday: string, proof: string) {
  await q(
    `INSERT INTO goal_progress (goal_id, week, fact, proof)
       VALUES ($1,$2,COALESCE((SELECT fact FROM goal_progress WHERE goal_id=$1 AND week <= $2 ORDER BY week DESC LIMIT 1),0),$3)
     ON CONFLICT (goal_id, week) DO UPDATE SET proof=EXCLUDED.proof, updated_at=now()`,
    [goalId, monday, proof],
  );
}

export const likedOf = (yid: string, monday: string) =>
  q<{ id: number; file_id: string; caption: string | null }>("SELECT * FROM liked_works WHERE designer_yid=$1 AND week=$2 ORDER BY id", [yid, monday]);
export const addLiked = (yid: string, monday: string, fileId: string, caption: string | null) =>
  q("INSERT INTO liked_works (designer_yid, week, file_id, caption) VALUES ($1,$2,$3,$4)", [yid, monday, fileId, caption?.slice(0, 300) ?? null]);
export const clearLiked = (yid: string, monday: string) => q("DELETE FROM liked_works WHERE designer_yid=$1 AND week=$2", [yid, monday]);

// ---------- Мәтін ----------
const bar = (p: number) => "▰".repeat(Math.round(p / 10)) + "▱".repeat(10 - Math.round(p / 10));

/** Ботта көрсетілетін толық көрініс. Нөмірлеу — үздіксіз (факт осы ретпен жазылады). */
export function goalsText(rows: GoalRow[], monday: string) {
  const month = monthOf(monday);
  const head = `🎯 <b>${monthName(month)} — айлық мақсаттар</b>`;
  if (!rows.length) return `${head}\nӘлі мақсат енгізілмеген.`;
  const out = [head];
  let n = 0;
  for (const k of ["op", "strat"] as Kind[]) {
    const gs = rows.filter((g) => g.kind === k);
    if (!gs.length) continue;
    out.push(`\n<b>${KIND_NAME[k]}</b>`);
    for (const g of gs) {
      const c = conversion(g, g.fact);
      out.push(`${++n}. ${esc(g.title)}\n    мақсат ${fmtVal(g.target, g.is_percent)} · факт ${fmtVal(g.fact, g.is_percent)}\n    ${bar(c)} ${c}%${c >= 100 ? " ✅" : ""}${g.proof ? " 📎" : ""}`);
    }
  }
  const s = summary(rows);
  out.push(
    `\n${s.op !== null ? `Операционный: <b>${s.op}%</b>` : ""}${s.op !== null && s.strat !== null ? " · " : ""}${s.strat !== null ? `Стратегиялық: <b>${s.strat}%</b>` : ""}`,
    `<b>Ортақ көрсеткіш: ${s.overall}%</b> · орындалғаны ${s.done}/${s.total}`,
  );
  return out.join("\n");
}

/** Апталық есепке қосылатын қысқа жол */
export async function goalsBlock(yid: string, monday: string) {
  const rows = await goalsWithProgress(yid, monday);
  if (!rows.length) return "";
  const s = summary(rows);
  const liked = (await likedOf(yid, monday)).length;
  return `🎯 Айлық мақсат конверсиясы: <b>${s.overall}%</b> · орындалғаны ${s.done}/${s.total}${liked ? ` · ⭐ ұнаған жұмыс: ${liked}` : ""}`;
}

/** Админге: бөлім бойынша жиынтық жол */
export async function teamGoalsLine(monday: string) {
  const ds = await q<{ yougile_id: string }>("SELECT yougile_id FROM people WHERE role='designer' AND active AND yougile_id IS NOT NULL");
  let withGoals = 0, filled = 0;
  const overall: number[] = [];
  for (const d of ds) {
    const rows = await goalsWithProgress(d.yougile_id, monday);
    if (!rows.length) continue;
    withGoals++;
    if (rows.some((g) => g.week_fact !== null)) filled++;
    overall.push(summary(rows).overall);
  }
  if (!withGoals) return "🎯 Айлық мақсаттар әлі енгізілмеген.";
  return `🎯 Айлық мақсат: ${withGoals}/${ds.length} дизайнер енгізген · осы апта факт жазғаны ${filled} · бөлім конверсиясы ${avg(overall)}%`;
}

// ---------- Excel үшін сурет жүктеу ----------
export async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; ext: "jpeg" | "png" } | null> {
  try {
    const token = config.botToken();
    const r: any = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)).json();
    const path: string | undefined = r?.result?.file_path;
    if (!path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), ext: path.toLowerCase().endsWith(".png") ? "png" : "jpeg" };
  } catch {
    return null;
  }
}
