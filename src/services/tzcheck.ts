/**
 * Толық емес ТЗ: жаңа ашық тапсырмада дедлайн жоқ болса немесе ешбір ереже сәйкес келмесе
 * (яғни есепте «Тексеру қажет» болатын болса) — админге бір рет ескерту.
 */
import { q } from "../db/db.js";
import { applyRules } from "../core/rules.js";
import { RULES, subjectFor } from "../seed/catalog.js";
import { esc } from "./reports.js";

export type TzIssue = { taskId: string; title: string; who: string; place: string; reasons: string[] };

export function tzReasons(o: { title: string; project: string | null; board: string | null; column_name: string | null; deadline_at: string | null }) {
  const reasons: string[] = [];
  if (!o.deadline_at) reasons.push("дедлайн жоқ");
  const loc = o.project ? { project: o.project, board: o.board ?? "", column: o.column_name ?? "" } : null;
  if (!loc) reasons.push("орны белгісіз");
  else if (applyRules(RULES, loc, o.title, 2).status !== "ok") reasons.push("ереже табылмайды — есепте «Тексеру қажет» болады");
  return reasons;
}

/** Соңғы 24 сағатта берілген, бұрын ескертілмеген тапсырмаларды тексеру */
export async function findNewTzIssues(): Promise<TzIssue[]> {
  const rows = await q<any>(
    `SELECT o.* FROM open_tasks o LEFT JOIN tz_warnings w ON w.task_id=o.yougile_id
      WHERE w.task_id IS NULL AND o.created_at_yg > now() - interval '24 hours'`,
  );
  const names = new Map((await q<any>("SELECT yougile_id, name FROM people WHERE role='designer'")).map((x) => [x.yougile_id, x.name]));
  const out: TzIssue[] = [];
  for (const o of rows) {
    const reasons = tzReasons(o);
    await q("INSERT INTO tz_warnings (task_id, reasons) VALUES ($1,$2) ON CONFLICT DO NOTHING", [o.yougile_id, reasons]);
    if (!reasons.length) continue;
    const loc = o.project ? { project: o.project, board: o.board, column: o.column_name } : null;
    out.push({
      taskId: o.yougile_id, title: o.title,
      who: (o.assigned as string[]).map((id) => names.get(id)).filter(Boolean).join(", ") || "—",
      place: loc ? `${subjectFor(loc).name} (${o.project} » ${o.board} » ${o.column_name})` : "?",
      reasons,
    });
  }
  return out;
}

export function tzIssuesText(issues: TzIssue[]) {
  const lines = [`⚠️ <b>Толық емес ТЗ: ${issues.length}</b>`];
  for (const i of issues.slice(0, 30)) lines.push(`• «${esc(i.title)}» · ${esc(i.who)}\n   ${esc(i.place)}\n   <i>${esc(i.reasons.join("; "))}</i>`);
  if (issues.length > 30) lines.push(`…тағы ${issues.length - 30}`);
  lines.push("\nТапсырма берушіге дедлайн қоюды немесе тапсырманы дұрыс колонкаға жылжытуды сұраңыз.");
  return lines.join("\n");
}
