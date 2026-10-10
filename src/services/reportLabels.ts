/**
 * Есепке арналған «таза» жолдар: YouGile-дегі колонка атауы емес, пән/аккаунт + сандар бір жолда.
 *   «Химия — 3 пост, 10 карусель», «YouTube — 7 обложка», «HR — 2 баннер, 1 обложка»
 * Орны белгісіз тапсырмада пәнді ТЗ атауынан шамамен табады.
 */
import { subjectFor, WORK_TYPES } from "../seed/catalog.js";

const PRETTY: Record<string, string> = {
  "ТАРИХ МС": "Тарих МС", ДЖТ: "Дүниежүзі тарихы", АҒЫЛШЫН: "Ағылшын", МАТ: "Математика", ӘДЕБТІЛ: "Әдебиет/тіл",
  БИОЛОГИЯ: "Биология", ГЕОГРАФИЯ: "География", ФИЗИКА: "Физика", ХИМИЯ: "Химия", РУСЛИТ: "Руслит", ҚҰҚЫҚ: "Құқық",
  ИНФО: "Информатика", "JUZ40 ONL": "JUZ40 Online", IELTS: "IELTS", JUNIOR: "Junior", COMM: "Community", CAREER: "Career",
  YOUTUBE: "YouTube",
};

/** ТЗ атауындағы кілт сөз → пән (тек орны белгісіз тапсырмаға) */
const FROM_TITLE: [RegExp, string][] = [
  [/хими/i, "Химия"], [/биолог/i, "Биология"], [/физик/i, "Физика"], [/географ/i, "География"],
  [/дүниежүзі|джт/i, "Дүниежүзі тарихы"], [/тарих/i, "Тарих МС"], [/ielts/i, "IELTS"], [/ағылшын|англ|english/i, "Ағылшын"],
  [/математ|\bмат\b/i, "Математика"], [/әдеб|қазақ тілі/i, "Әдебиет/тіл"], [/информат/i, "Информатика"], [/құқық/i, "Құқық"],
  [/руслит|русск/i, "Руслит"], [/youtube|ютуб|ютьюб/i, "YouTube"], [/juzeng|жузенг/i, "JUZENG"], [/community|комьюнити/i, "Community"],
];

const PROJECT: Record<string, string> = { hr: "HR", juzeng: "JUZENG", design: "Дизайн", product: "Product", marketing: "Marketing" };

/** Бір тапсырманың есептегі «пәні» */
export function reportSubject(r: { trace: any }): string {
  const loc = r.trace?.location ?? null;
  const s = subjectFor(loc).name;
  if (PRETTY[s]) return PRETTY[s];
  const title = String(r.trace?.title ?? "");
  const hit = FROM_TITLE.find(([re]) => re.test(title) || (loc && re.test(loc.column)));
  if (hit) return hit[1];
  if (loc?.project) return PROJECT[loc.project.toLowerCase()] ?? loc.project;
  return "Басқа";
}

/** «YouTube» пәнінде «YouTube обложка» → «обложка» деп қысқарады */
function typeName(subject: string, wt: string, n: number) {
  if (subject === "YouTube" && wt === "YouTube обложка") return `${n} обложка`;
  return `${n} ${wt === "YouTube обложка" ? "YouTube обложка" : wt.toLowerCase()}`;
}

/** Тапсырмалар → «Пән — 3 пост, 10 карусель» жолдары (көбі жоғарыда) */
export function subjectLines(rows: { trace: any; items: Record<string, number> }[]): string[] {
  const by = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!Object.keys(r.items ?? {}).length) continue;
    const s = reportSubject(r);
    const e = by.get(s) ?? {};
    for (const [k, v] of Object.entries(r.items)) e[k] = (e[k] ?? 0) + v;
    by.set(s, e);
  }
  const sum = (it: Record<string, number>) => Object.values(it).reduce((a, b) => a + b, 0);
  return [...by]
    .sort(([, a], [, b]) => sum(b) - sum(a))
    .map(([s, it]) => `${s} — ${WORK_TYPES.filter((w) => it[w]).map((w) => typeName(s, w, it[w])).join(", ")}`);
}
