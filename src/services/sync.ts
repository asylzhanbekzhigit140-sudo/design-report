/**
 * Синхронизация: YouGile → database → есептеу.
 * Тек оқиды. Адамның шешімдері (түзету, жауап, қолмен енгізу) қайта синхронизацияда өшпейді.
 */
import { createHash } from "node:crypto";
import { q, one, audit, getSetting } from "../db/db.js";
import { YouGileClient, Structure, type YgTask } from "../yougile/client.js";
import { calculateTask, type Calculation } from "../core/calculate.js";
import { parseFiles, type ChatMessage } from "../core/files.js";
import { weekOf, weekLabel, type Week } from "../time/week.js";
import { DESIGNERS, RULES, ALLOWED_EXTS, CORRECTION_WORDS, MANY_FILES_LIMIT } from "../seed/catalog.js";
import { applyRules } from "../core/rules.js";
import { config } from "../config.js";

const HOUR = 3600_000;
let structureCache: { at: number; st: Structure } | null = null;

export async function calcOptions() {
  return {
    rules: RULES,
    allowedExts: await getSetting("allowed_exts", ALLOWED_EXTS),
    correctionWords: await getSetting("correction_words", CORRECTION_WORDS),
    manyFilesLimit: await getSetting("many_files_limit", MANY_FILES_LIMIT),
  };
}

export async function ensureWeek(w: Week) {
  await q("INSERT INTO weeks (monday, label) VALUES ($1,$2) ON CONFLICT (monday) DO NOTHING", [
    w.monday,
    weekLabel(w, config.month1),
  ]);
  return (await one<{ status: string }>("SELECT status FROM weeks WHERE monday=$1", [w.monday]))!.status;
}

/** Дизайнерлерді YouGile аттары бойынша database-ке жазу. YouGile id → people жолы */
async function syncDesigners(yg: YouGileClient) {
  const users = await yg.users();
  for (const d of DESIGNERS) {
    const u = users.find((x) => (x.realName ?? "").trim().toLowerCase() === d.yougileName.toLowerCase());
    if (!u) continue;
    await q(
      `INSERT INTO people (role, name, yougile_id, yougile_name, excel_name) VALUES ('designer',$1,$2,$3,$4)
       ON CONFLICT (yougile_id) DO UPDATE SET yougile_name=EXCLUDED.yougile_name`,
      [d.shortName, u.id, d.yougileName, d.excelName],
    );
  }
  return q<{ yougile_id: string; name: string }>("SELECT yougile_id, name FROM people WHERE role='designer' AND active");
}

async function structure(yg: YouGileClient) {
  if (!structureCache || Date.now() - structureCache.at > 6 * HOUR)
    structureCache = { at: Date.now(), st: new Structure(await yg.projects(), await yg.boards(), await yg.columns()) };
  return structureCache.st;
}

const hashTask = (t: YgTask) =>
  createHash("sha1")
    .update(JSON.stringify([t.title, t.columnId, t.completed, t.completedTimestamp, [...(t.assigned ?? [])].sort()]))
    .digest("hex");

/** Есептеу нәтижесін адам шешімімен біріктіру */
export function applyAnswer(c: Calculation, answer: string | null, opts: Awaited<ReturnType<typeof calcOptions>>, secondary: boolean): Calculation {
  if (!answer || answer === "uploaded") return c;
  let n: number;
  if (answer === "correction") n = c.fileCount;
  else if (answer === "extra") n = c.fileCount + c.trace.ask.length;
  else if (answer.startsWith("manual:")) n = Number(answer.slice(7));
  else return c;
  const r = applyRules(opts.rules, c.location, c.title, n, secondary);
  if (r.status !== "ok") return { ...c, fileCount: n, status: "needs_review", reasons: [r.reason], items: {} };
  return { ...c, fileCount: n, status: "ok", reasons: [], items: r.items, ruleCode: r.rule.code };
}

function statusOf(c: Calculation): string {
  if (c.status === "needs_review" && c.location && c.fileCount === 0 && c.trace.ask.length === 0) return "no_files";
  return c.status;
}

async function saveFiles(taskId: string, msgs: ChatMessage[], calcs: Calculation[]) {
  await q("DELETE FROM task_files WHERE task_id=$1", [taskId]);
  const status = new Map<string, [string, string | null]>();
  for (const c of calcs) {
    c.trace.counted.forEach((f) => status.set(f.uuid, ["counted", null]));
    c.trace.ask.forEach((f) => status.set(f.uuid, ["ask", null]));
    c.trace.excluded.forEach((f) => status.set(f.uuid, ["excluded", f.reason]));
  }
  for (const m of msgs)
    for (const f of parseFiles(m)) {
      const [s, reason] = status.get(f.uuid) ?? ["excluded", "not-designer"];
      await q(
        `INSERT INTO task_files (task_id, uuid, name, ext, message_id, uploaded_by, status, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [taskId, f.uuid, f.name, f.ext, f.messageId, f.uploadedBy, s, reason],
      );
    }
}

async function upsertCalc(c: Calculation, week: string, supplement: boolean) {
  const secondary = c.warnings.some((w) => w.includes("тек карусель"));
  await q(
    `INSERT INTO calculations (task_id, designer_yid, week, is_supplement, file_count, ask_count, rule_code, status, reasons, warnings, items, trace)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (task_id, designer_yid, week, is_supplement) DO UPDATE SET
       file_count=EXCLUDED.file_count, ask_count=EXCLUDED.ask_count, rule_code=EXCLUDED.rule_code,
       status=EXCLUDED.status, reasons=EXCLUDED.reasons, warnings=EXCLUDED.warnings,
       items=EXCLUDED.items, trace=EXCLUDED.trace, updated_at=now()
     WHERE calculations.status NOT IN ('corrected','skipped')`,
    [
      c.taskId, c.designerId, week, supplement, c.fileCount, c.trace.ask.length, c.ruleCode ?? null, statusOf(c),
      c.reasons, c.warnings, JSON.stringify(c.items),
      JSON.stringify({ ...c.trace, location: c.location, title: c.title, code: c.taskCode, secondary }),
    ],
  );
}

export type SyncResult = { requests: number; tasksNew: number; tasksChanged: number };

/**
 * full=true — ашық апталардағы барлық тапсырманың чатын қайта оқу (дүйсенбі таңертеңгі соңғы өту).
 */
export async function syncAll(yg: YouGileClient, opts: { full?: boolean } = {}): Promise<SyncResult> {
  const run = await one<{ id: number }>("INSERT INTO sync_runs (kind) VALUES ($1) RETURNING id", [opts.full ? "full" : "incremental"]);
  const startReq = yg.requests;
  const res: SyncResult = { requests: 0, tasksNew: 0, tasksChanged: 0 };
  try {
    const designers = await syncDesigners(yg);
    const designerIds = new Set(designers.map((d) => d.yougile_id));
    const st = await structure(yg);
    const co = await calcOptions();

    // Өңделетін кезең: ең ескі ашық апта (әдетте өткен апта)
    const now = Date.now();
    const thisWeek = weekOf(now);
    const lastWeek = weekOf(thisWeek.startMs - 1);
    const lastStatus = await ensureWeek(lastWeek);
    await ensureWeek(thisWeek);
    const horizon = lastStatus === "open" ? lastWeek.startMs : thisWeek.startMs;

    const seen = new Map<string, YgTask>();
    for (const id of designerIds) for (const t of await yg.tasksAssignedTo(id)) if (!t.deleted) seen.set(t.id, t);

    // Ашық тапсырмалар (✓ болмаған) — AI үшін «қазір кімде не бар»
    const open = [...seen.values()].filter((t) => !t.completed && !t.archived && !t.deleted);
    await q("DELETE FROM open_tasks");
    for (const t of open) {
      const loc = st.locate(t.columnId);
      await q(
        `INSERT INTO open_tasks (yougile_id, code, title, project, board, column_name, assigned, deadline_at, created_at_yg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($9/1000.0)) ON CONFLICT DO NOTHING`,
        [t.id, t.idTaskProject ?? t.idTaskCommon ?? t.id, t.title, loc?.project ?? null, loc?.board ?? null, loc?.column ?? null,
         t.assigned ?? [], t.deadline?.deadline ?? null, t.timestamp ?? null],
      );
    }
    const doneInWindow = [...seen.values()].filter((t) => t.completed && (t.completedTimestamp ?? 0) >= horizon).length;
    console.log(`[sync] ${opts.full ? "full" : "incremental"}: барлығы ${seen.size} тапсырма, ашық ${open.length}, кезеңде жабылған ${doneInWindow}`);
    let processed = 0;
    for (const t of seen.values()) {
      const existing = await one<any>("SELECT * FROM tasks WHERE yougile_id=$1", [t.id]);

      // Қайта ашылды: бұрын жабық еді, енді ашық
      if (existing?.completed && !t.completed) {
        await q("UPDATE tasks SET completed=false, reopened_count=reopened_count+1, synced_at=now() WHERE yougile_id=$1", [t.id]);
        await audit("system", "task_reopened", t.id, { code: existing.code });
        continue;
      }
      if (!t.completed || !t.completedTimestamp || t.completedTimestamp < horizon) continue;

      const hash = hashTask(t);
      const completedAt = t.completedTimestamp;
      // Файлсыз тапсырманың чаты тек соңғы 2 күнде қайта тексеріледі (ескілері әр 15 минут сайын оқылмасын)
      const pendingNoFiles =
        completedAt > now - 48 * HOUR &&
        (await one("SELECT 1 FROM calculations WHERE task_id=$1 AND status='no_files' AND asked_at IS NULL", [t.id]));
      const secondPass =
        existing?.messages_read_at && now > completedAt + 2 * HOUR && new Date(existing.messages_read_at).getTime() < completedAt + 2 * HOUR;
      if (existing && existing.content_hash === hash && !opts.full && !pendingNoFiles && !secondPass) continue;

      const msgs = await yg.messages(t.id);
      if (++processed % 20 === 0) console.log(`[sync] чат оқылды: ${processed}`);
      const loc = st.locate(t.columnId);
      const code = t.idTaskProject ?? t.idTaskCommon ?? t.id;
      await q(
        `INSERT INTO tasks (yougile_id, code, title, project, board, column_name, assigned, completed, completed_at, raw, content_hash, messages_read_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10,$11,now())
         ON CONFLICT (yougile_id) DO UPDATE SET code=$2, title=$3, project=$4, board=$5, column_name=$6, assigned=$7,
           completed=$8, completed_at=to_timestamp($9/1000.0), raw=$10, content_hash=$11, messages_read_at=now(), synced_at=now()`,
        [t.id, code, t.title, loc?.project ?? null, loc?.board ?? null, loc?.column ?? null, t.assigned ?? [], true, completedAt, JSON.stringify(t), hash],
      );
      existing ? res.tasksChanged++ : res.tasksNew++;

      const week = weekOf(completedAt);
      const weekStatus = await ensureWeek(week);
      if (weekStatus !== "open") continue; // жабылған апта өзгермейді

      // Қайта ашылып, басқа аптада жабылды → қосымша: ескі жабылудан кейінгі файлдар ғана, дизайнерден сұралады
      const prevDone = existing?.completed_at ? new Date(existing.completed_at).getTime() : null;
      const prevWeek = prevDone ? weekOf(prevDone) : null;
      const prevStatus = prevWeek ? (await one<{ status: string }>("SELECT status FROM weeks WHERE monday=$1", [prevWeek.monday]))?.status : null;
      const supplement = !!prevWeek && prevWeek.monday !== week.monday && prevStatus === "sent";

      let calcs = calculateTask(t, loc, msgs, designerIds, co);
      if (supplement) {
        calcs = calcs
          .map((c) => {
            const fresh = [...c.trace.counted, ...c.trace.ask].filter((f) => f.messageId > prevDone!);
            return { ...c, fileCount: 0, items: {}, status: "ask_designer" as const,
              reasons: [`Тапсырма қайта ашылып жабылды: ${fresh.length} жаңа файл — қосымша ма, түзету ме?`],
              trace: { ...c.trace, counted: [], ask: fresh } };
          })
          .filter((c) => c.trace.ask.length > 0);
      }

      for (const c of calcs) {
        const prev = await one<{ answer: string | null }>(
          "SELECT answer FROM calculations WHERE task_id=$1 AND designer_yid=$2 AND week=$3 AND is_supplement=$4",
          [c.taskId, c.designerId, week.monday, supplement],
        );
        const secondary = c.warnings.some((w) => w.includes("тек карусель"));
        await upsertCalc(applyAnswer(c, prev?.answer ?? null, co, secondary || supplement), week.monday, supplement);
      }
      await saveFiles(t.id, msgs, calcs);
    }

    res.requests = yg.requests - startReq;
    console.log(`[sync] дайын: жаңа ${res.tasksNew}, өзгерген ${res.tasksChanged}, сұраныс ${res.requests}`);
    await q("UPDATE sync_runs SET finished_at=now(), requests=$2, tasks_new=$3, tasks_changed=$4 WHERE id=$1", [
      run!.id, res.requests, res.tasksNew, res.tasksChanged,
    ]);
    return res;
  } catch (e: any) {
    await q("UPDATE sync_runs SET finished_at=now(), error=$2 WHERE id=$1", [run!.id, String(e?.message ?? e)]);
    throw e;
  }
}
