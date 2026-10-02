/**
 * Есептеуге адам араласуы: дизайнер жауабы, түзету, қайтару, өткізіп жіберу.
 * Raw деректер өзгермейді; әр әрекет audit_log-қа жазылады.
 */
import { q, one, audit } from "../db/db.js";
import { applyAnswer, calcOptions } from "./sync.js";
import type { Calculation } from "../core/calculate.js";

export type CalcRow = {
  id: number; task_id: string; designer_yid: string; week: string; is_supplement: boolean;
  file_count: number; ask_count: number; rule_code: string | null; status: string;
  reasons: string[]; warnings: string[]; items: Record<string, number>; trace: any;
  manual: boolean; asked_at: string | null; answer: string | null;
};

export const getCalc = (id: number) => one<CalcRow>("SELECT * FROM calculations WHERE id=$1", [id]);

function toCalculation(r: CalcRow): Calculation {
  return {
    taskId: r.task_id, taskCode: r.trace.code, title: r.trace.title, location: r.trace.location ?? null,
    designerId: r.designer_yid, fileCount: r.file_count, status: "ok", reasons: r.reasons, warnings: r.warnings,
    ruleCode: r.rule_code ?? undefined, items: r.items,
    trace: { counted: r.trace.counted ?? [], ask: r.trace.ask ?? [], excluded: r.trace.excluded ?? [], candidates: r.trace.candidates ?? [] },
  };
}

/** answer: correction | extra | uploaded | manual:N */
export async function answerCalc(id: number, answer: string, actor: string) {
  const r = await getCalc(id);
  if (!r) throw new Error("Есептеу табылмады");
  const co = await calcOptions();
  const c = applyAnswer(toCalculation(r), answer, co, !!r.trace.secondary || r.is_supplement);
  const status = answer === "uploaded" ? r.status : c.status;
  await q(
    `UPDATE calculations SET answer=$2, status=$3, items=$4, file_count=$5, rule_code=$6, reasons=$7,
       manual=$8, updated_at=now() WHERE id=$1`,
    [id, answer, status, JSON.stringify(c.items), c.fileCount, c.ruleCode ?? null, c.reasons, answer.startsWith("manual:")],
  );
  await audit(actor, "answer", `calc:${id}`, { answer, before: r.items, after: c.items });
  return getCalc(id);
}

export async function correctCalc(id: number, newItems: Record<string, number>, reason: string, actor: string) {
  const r = await getCalc(id);
  if (!r) throw new Error("Есептеу табылмады");
  const clean = Object.fromEntries(Object.entries(newItems).filter(([, v]) => v > 0));
  const c = await one<{ id: number }>(
    `INSERT INTO corrections (calc_id, old_items, new_items, old_status, reason, made_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [id, JSON.stringify(r.items), JSON.stringify(clean), r.status, reason, actor],
  );
  await q("UPDATE calculations SET items=$2, status='corrected', updated_at=now() WHERE id=$1", [id, JSON.stringify(clean)]);
  await audit(actor, "correct", `calc:${id}`, { before: r.items, after: clean, reason });
  return c!.id;
}

export async function revertCorrection(correctionId: number, actor: string) {
  const c = await one<any>("SELECT * FROM corrections WHERE id=$1 AND reverted_at IS NULL", [correctionId]);
  if (!c) return false;
  await q("UPDATE calculations SET items=$2, status=$3, updated_at=now() WHERE id=$1", [c.calc_id, JSON.stringify(c.old_items), c.old_status]);
  await q("UPDATE corrections SET reverted_by=$2, reverted_at=now() WHERE id=$1", [correctionId, actor]);
  await audit(actor, "revert", `correction:${correctionId}`, { restored: c.old_items });
  return true;
}

export async function skipCalc(id: number, actor: string) {
  await q("UPDATE calculations SET status='skipped', items='{}', updated_at=now() WHERE id=$1", [id]);
  await audit(actor, "skip", `calc:${id}`);
}
