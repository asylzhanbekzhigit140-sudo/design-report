/**
 * AI-сұрақтар: тек database-тегі деректер бойынша түсіндіреді, сан ойлап таппайды.
 * Дизайнерге тек өз деректері, админге — барлығы беріледі. Басқа адамның деректері AI-ға жіберілмейді.
 */
import { q, one, audit } from "../db/db.js";
import { weekRows, type ReportRow } from "./reports.js";
import { RULES, subjectFor } from "../seed/catalog.js";
import { weekOf } from "../time/week.js";
import { config } from "../config.js";

export type AskPerson = { id: number; name: string; yougile_id: string | null; isAdmin: boolean; telegram_id: number };

const DAY = 86400_000;
const STATUS: Record<string, string> = {
  ok: "автоматты есептелді", corrected: "дизайнер/админ түзеткен", ask_designer: "дизайнерден сұрақ күтуде",
  no_files: "чатта файл жоқ", needs_review: "тексеру қажет", skipped: "есептен шығарылған",
};

function line(r: ReportRow, label: string, withName: boolean) {
  const loc = r.trace.location ? `${r.trace.location.project} » ${r.trace.location.board} » ${r.trace.location.column}` : "орны белгісіз";
  const items = Object.entries(r.items).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
  const done = new Date(r.completed_at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return [
    `«${r.trace.title}»`, `пән/акк: ${subjectFor(r.trace.location ?? null).name}`, withName ? `дизайнер: ${r.designer}` : null,
    `жабылды: ${done}`, label, loc, `код: ${r.trace.code}`,
    `саналған файл: ${r.file_count}${r.ask_count ? ` (+${r.ask_count} түзетуден кейінгі)` : ""}`,
    `ереже: ${r.rule_code ?? "—"}`, `нәтиже: ${items}`, `статус: ${STATUS[r.status] ?? r.status}`,
    r.manual ? "саны қолмен енгізілген" : null, r.is_supplement ? "қайта ашылған тапсырманың қосымшасы" : null,
    r.reasons.length ? `себеп: ${r.reasons.join("; ")}` : null, r.warnings.length ? `ескерту: ${r.warnings.join("; ")}` : null,
  ].filter(Boolean).join(" | ");
}

export async function buildContext(p: AskPerson) {
  const weeks = await q<{ monday: string; label: string; status: string }>(
    "SELECT monday, label, status FROM weeks WHERE monday >= $1 ORDER BY monday DESC",
    [weekOf(Date.now() - (p.isAdmin ? 14 : 28) * DAY).monday],
  );
  const out: string[] = [];
  for (const w of weeks) {
    const rows = await weekRows(w.monday, p.isAdmin ? undefined : p.yougile_id ?? "__none__");
    out.push(`## Апта ${w.monday} (${w.label})${w.status === "sent" ? " — жабылған, басшыға жіберілген" : " — ашық"}: ${rows.length} жазба`);
    rows.forEach((r) => out.push(line(r, w.label, p.isAdmin)));
  }
  // Қазір ашық тапсырмалар
  const people = new Map((await q<{ yougile_id: string; name: string }>("SELECT yougile_id, name FROM people WHERE role='designer'")).map((x) => [x.yougile_id, x.name]));
  const openRows = await q<any>(
    `SELECT * FROM open_tasks WHERE ($1::text IS NULL OR $1 = ANY(assigned)) ORDER BY deadline_at NULLS LAST`,
    [p.isAdmin ? null : p.yougile_id ?? "__none__"],
  );
  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "жоқ";
  out.push(`## Қазір ашық тапсырмалар (YouGile-де әлі ✓ болмаған): ${openRows.length}`);
  for (const o of openRows) {
    const who = (o.assigned as string[]).map((id) => people.get(id)).filter(Boolean).join(", ") || "—";
    const overdue = o.deadline_at && new Date(o.deadline_at).getTime() < Date.now() ? " (мерзімі өткен)" : "";
    out.push(
      `«${o.title}» | пән/акк: ${subjectFor(o.project ? { project: o.project, board: o.board, column: o.column_name } : null).name} | ${p.isAdmin ? `дизайнер: ${who} | ` : ""}дедлайн: ${fmt(o.deadline_at)}${overdue} | берілген: ${fmt(o.created_at_yg)} | орны: ${o.project ?? "?"} » ${o.board ?? "?"} » ${o.column_name ?? "?"} | код: ${o.code}`,
    );
  }

  const corr = await q<any>(
    `SELECT c.made_at, c.old_items, c.new_items, c.reason, c.reverted_at, k.trace->>'code' AS code
       FROM corrections c JOIN calculations k ON k.id=c.calc_id
      WHERE c.made_at > now() - interval '35 days' AND ($1::text IS NULL OR k.designer_yid=$1) ORDER BY c.made_at DESC LIMIT 50`,
    [p.isAdmin ? null : p.yougile_id ?? "__none__"],
  );
  if (corr.length) {
    out.push("## Түзетулер");
    corr.forEach((c) => out.push(`${c.code}: ${JSON.stringify(c.old_items)} → ${JSON.stringify(c.new_items)}, себеп: ${c.reason}${c.reverted_at ? " (қайтарылған)" : ""}`));
  }
  return out.join("\n");
}

const today = () =>
  new Date().toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

const SYSTEM = (p: AskPerson) => `Сен JUZ40 дизайн бөлімінің апталық есеп ботысың. Қазақ тілінде қысқа, нақты жауап бер.
Бүгін: ${today()} (Алматы уақыты). «01.10» сияқты күндер — күн.ай, жылы ағымдағы жыл.
Әр жолдағы «жабылды:» — тапсырманың YouGile-де ✓ болған уақыты. Күн бойынша сұраса, сол өріс бойынша сана.
«Қазір ашық тапсырмалар» — әлі орындалмаған тапсырмалар («кімде қандай тапсырма бар», «не істеуім керек» деген сұрақтарға соны қолдан).
Тапсырманы ӘРҚАШАН ТЗ атауымен және пәнімен ата, мысалы: «Мотив пост» (Биология). Код (DES-3229) тек қажет болса жақшада.
Тізім берсең, қысқа маркерлі тізім қолдан, пән немесе дизайнер бойынша топтастыр.
Сұрақ қойып тұрған адам: ${p.name}${p.isAdmin ? " (админ — барлық дизайнердің деректерін көреді)" : " (дизайнер — тек өз деректері)"}.

ҚАТАҢ ЕРЕЖЕЛЕР:
- Тек төмендегі ДЕРЕКТЕР бойынша жауап бер. Онда жоқ санды, тапсырманы, себепті ойлап таппа. Білмесең: «Бұл ақпарат жүйеде жоқ» де.
- Сандарды өзің есептесең, тек деректердегі жолдарды қос; нені қосқаныңды қысқаша көрсет.
- Сен ештеңені өзгерте алмайсың. Сан қате болса: дизайнерге «апталық есептегі ✏️ Қате бар батырмасы арқылы түзетіңіз», файл чатта жоқ болса «файлды тапсырма чатына салыңыз» деп айт.
- Адамдарды бағалама («жалқау», «нашар» деме), тек деректерді көрсет.
- Басқа тақырыптағы сұрақтарға (есептен тыс) сыпайы түрде тек есеп туралы көмектесе алатыныңды айт.

ЕСЕПТЕУ ЕРЕЖЕЛЕРІ (N = дизайнер чатқа жүктеген бірегей файл саны):
${RULES.map((r) => `${r.code}: ${r.description}`).join("\n")}
Түзету сұралғаннан кейінгі файлдар туралы дизайнерден «түзету ме, қосымша ма» деп сұралады.
Бірнеше дизайнер болса, пост бірінші файл жіберген дизайнерге жазылады.
Апта: дүйсенбі 00:00 – жексенбі 23:59 (Алматы). Тапсырма жабылған күні бойынша есептеледі.

ДЕРЕКТЕР:
`;

export async function usedToday(p: AskPerson) {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int n FROM audit_log WHERE actor=$1 AND action='ai_question'
       AND at > date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty'`,
    [`tg:${p.telegram_id}`],
  );
  return r?.n ?? 0;
}

export async function askAI(p: AskPerson, question: string): Promise<string> {
  const ai = config.ai;
  if (!ai.key) return "AI-сұрақтар әлі қосылмаған.";
  if ((await usedToday(p)) >= config.aiDailyLimit) return `Бүгінгі сұрақ шегі (${config.aiDailyLimit}) бітті. Ертең қайта жазыңыз.`;

  const context = await buildContext(p);
  const reasoning = ai.provider === "openai" && /^(gpt-5|o\d)/.test(ai.model);
  const res = await fetch(ai.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: "system", content: SYSTEM(p) + context },
        { role: "user", content: question.slice(0, 1000) },
      ],
      ...(reasoning
        ? { max_completion_tokens: 3000, reasoning_effort: "low" }
        : { max_tokens: 1500, temperature: 0.2 }),
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  await audit(`tg:${p.telegram_id}`, "ai_question", "ai", { question: question.slice(0, 300), status: res.status, usage: body?.usage });
  if (!res.ok) {
    console.error(`AI error (${ai.provider}/${ai.model})`, res.status, JSON.stringify(body).slice(0, 400));
    return res.status === 429 ? "AI қазір бос емес (минуттық/күндік шек немесе баланс). Бір-екі минуттан кейін қайталаңыз." : "AI жауап бере алмады. Кейінірек қайталаңыз.";
  }
  return (body.choices?.[0]?.message?.content ?? "").trim() || "Жауап бос келді, сұрақты басқаша жазып көріңіз.";
}
