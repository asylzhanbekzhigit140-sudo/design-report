/**
 * Бір тапсырманы есептеу: файлдар → ереже → нәтиже + trace.
 * Әр дизайнерге бөлек Calculation жасалады.
 */
import { countFiles, type ChatMessage, type ExcludedFile, type ParsedFile } from "./files.js";
import { applyRules, type Rule } from "./rules.js";
import type { Location, YgTask } from "../yougile/client.js";

export type CalcStatus = "ok" | "needs_review" | "ask_designer";

export type Calculation = {
  taskId: string;
  taskCode: string;
  title: string;
  location: Location | null;
  designerId: string;
  completedAt?: number;
  fileCount: number;
  status: CalcStatus;
  reasons: string[];
  warnings: string[];
  ruleCode?: string;
  items: Record<string, number>;
  trace: {
    counted: ParsedFile[];
    ask: ParsedFile[];
    excluded: ExcludedFile[];
    candidates: string[];
    correctionMessage?: string;
  };
};

export type CalcOptions = {
  rules: Rule[];
  allowedExts: string[];
  correctionWords: string[];
  manyFilesLimit: number;
};

export function calculateTask(
  task: YgTask,
  loc: Location | null,
  messages: ChatMessage[],
  designerIds: Set<string>,
  opts: CalcOptions,
): Calculation[] {
  const code = task.idTaskProject ?? task.idTaskCommon ?? task.id;
  const files = countFiles(messages, designerIds, opts);

  // Есептелетін дизайнерлер: файл жүктегендер + файлсыз тағайындалғандар (0 файл → тексеру)
  const ids = new Set<string>(files.byDesigner.keys());
  for (const a of task.assigned ?? []) if (designerIds.has(a)) ids.add(a);

  const multi = ids.size > 1;
  // Бірінші файл жіберген дизайнер — «негізгі» (пост соған жазылады)
  const firstFile = (id: string) => files.byDesigner.get(id)?.counted.at(0)?.messageId ?? Infinity;
  const primary = [...ids].sort((a, b) => firstFile(a) - firstFile(b)).at(0);
  const out: Calculation[] = [];

  for (const designerId of ids) {
    const df = files.byDesigner.get(designerId) ?? { counted: [], ask: [] };
    const n = df.counted.length;
    const reasons: string[] = [];
    const warnings: string[] = [];
    let status: CalcStatus = "ok";
    let items: Record<string, number> = {};
    let ruleCode: string | undefined;
    let candidates: string[] = [];

    if (!loc) {
      status = "needs_review";
      reasons.push("Тапсырманың орны (бөлім) анықталмады — дизайнерден сұралады");
    }
    if (n === 0 && df.ask.length === 0) {
      status = "needs_review";
      reasons.push("Тапсырма жабылған, бірақ дизайнер файлы жоқ");
    }

    if (status === "ok") {
      const r = applyRules(opts.rules, loc, task.title, n, multi && designerId !== primary);
      candidates = r.candidates;
      if (r.status === "ok") {
        items = r.items;
        ruleCode = r.rule.code;
      } else {
        status = "needs_review";
        reasons.push(r.reason);
        ruleCode = r.rule?.code;
      }
    }

    if (df.ask.length && status === "ok") {
      status = "ask_designer";
      reasons.push(`Түзету сұралғаннан кейін ${df.ask.length} файл жүктелген: түзету ме, қосымша ма?`);
    }
    if (n > opts.manyFilesLimit) warnings.push(`${n} файл — тым көп, тексеріп шығыңыз`);
    if (multi) warnings.push(designerId === primary ? "Бірнеше дизайнер: пост осыған (бірінші жіберген)" : "Бірнеше дизайнер: тек карусель");

    out.push({
      taskId: task.id,
      taskCode: code,
      title: task.title,
      location: loc,
      designerId,
      completedAt: task.completedTimestamp,
      fileCount: n,
      status,
      reasons,
      warnings,
      ruleCode,
      items,
      trace: {
        counted: df.counted,
        ask: df.ask,
        excluded: files.excluded.filter((f) => f.uploadedBy === designerId || f.reason === "not-designer"),
        candidates,
        correctionMessage: files.correctionMessage?.text,
      },
    });
  }
  return out;
}
