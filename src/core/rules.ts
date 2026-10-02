/**
 * Business Rules Engine.
 * Ереже = шарттар + нәтиже формуласы + деңгей (кіші сан = нақтырақ = басым).
 *   1 — орын толық (жоба + тақта + колонка)
 *   2 — атаудағы кілт сөз (бөліммен немесе бөлімсіз)
 *   3 — жоба + тақта
 *   4 — жалпы
 * Бір деңгейде нәтижесі әртүрлі екі ереже сәйкес келсе — болжамаймыз, «Тексеру қажет».
 */
import type { Location } from "../yougile/client.js";

export type Output = { workType: string; expr: string };

export type Rule = {
  code: string;
  level: 1 | 2 | 3 | 4;
  description: string;
  when: {
    project?: string;
    board?: string;
    columns?: string[];
    /** атауда кездесетін сөздер (кез келгені) */
    titleAny?: string[];
  };
  /** outputs бос болса — ереже «Тексеру қажет» деп белгілейді */
  outputs: Output[];
  reviewReason?: string;
  active?: boolean;
};

export type RuleResult =
  | { status: "ok"; rule: Rule; items: Record<string, number>; candidates: string[] }
  | { status: "review"; reason: string; rule?: Rule; candidates: string[] };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** «Ақпараттық пост (2)» → «ақпараттық пост» */
export const cleanTitle = (t: string) => norm(t.replace(/\(\s*\d+\s*\)/g, " "));

/** Қауіпсіз формула: «1», «N», «N-1», «N-2», «3». eval жоқ. */
export function evalExpr(expr: string, n: number): number {
  const m = expr.replace(/\s+/g, "").match(/^(N|\d+)(?:-(\d+))?$/i);
  if (!m) throw new Error(`Рұқсат етілмеген формула: ${expr}`);
  const base = m[1].toUpperCase() === "N" ? n : Number(m[1]);
  return Math.max(0, base - (m[2] ? Number(m[2]) : 0));
}

function matches(rule: Rule, loc: Location | null, title: string): boolean {
  const w = rule.when;
  if (w.project && (!loc || norm(loc.project) !== norm(w.project))) return false;
  if (w.board && (!loc || norm(loc.board) !== norm(w.board))) return false;
  if (w.columns && (!loc || !w.columns.some((c) => norm(c) === norm(loc.column)))) return false;
  if (w.titleAny && !w.titleAny.some((k) => cleanTitle(title).includes(norm(k)))) return false;
  return true;
}

const sameOutputs = (a: Rule, b: Rule) =>
  JSON.stringify([...a.outputs].sort((x, y) => x.workType.localeCompare(y.workType))) ===
  JSON.stringify([...b.outputs].sort((x, y) => x.workType.localeCompare(y.workType)));

/**
 * Бір тапсырмада бірнеше дизайнер болса: тұрақты бөлік (мысалы «1 пост») тек бірінші файл жіберген
 * дизайнерге беріледі; қалғандарына «N−k» өрнегі «N» болып есептеледі (бәрі карусель).
 */
export function secondaryExpr(expr: string): string {
  const e = expr.replace(/\s+/g, "").toUpperCase();
  if (/^\d+$/.test(e)) return "0";
  if (/^N-\d+$/.test(e)) return "N";
  return expr;
}

export function applyRules(rules: Rule[], loc: Location | null, title: string, n: number, secondary = false): RuleResult {
  const hits = rules.filter((r) => r.active !== false && matches(r, loc, title)).sort((a, b) => a.level - b.level);
  const candidates = hits.map((r) => `${r.code} (деңгей ${r.level})`);

  if (!hits.length) return { status: "review", reason: "Ешбір ереже сәйкес келмеді", candidates };

  const top = hits.filter((r) => r.level === hits[0].level);
  if (top.some((r) => !sameOutputs(r, top[0])))
    return { status: "review", reason: `Бір деңгейде бірнеше ереже: ${top.map((r) => r.code).join(", ")}`, candidates };

  const rule = top[0];
  if (!rule.outputs.length)
    return { status: "review", reason: rule.reviewReason ?? `${rule.code}: қолмен тексеру`, rule, candidates };

  const items: Record<string, number> = {};
  for (const o of rule.outputs) {
    const q = evalExpr(secondary ? secondaryExpr(o.expr) : o.expr, n);
    if (q > 0 || !secondary) items[o.workType] = (items[o.workType] ?? 0) + q;
  }
  return { status: "ok", rule, items, candidates };
}
