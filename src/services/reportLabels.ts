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
  if (r.trace?.added && r.trace.subject) return r.trace.subject;
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

// ---------- «➕ Тапсырма қосу»: «Құқық 2 пост 5 карусель» ----------
type Loc = { project: string; board: string; column: string };
const pk = (column: string): Loc => ({ project: "Marketing", board: "Пән акк", column });
/** Таңдауға шығатын пәндер/аккаунттар (батырма) және мәтіннен табу үлгісі */
export const PICK: { label: string; re: RegExp; loc: Loc }[] = [
  { label: "Ағылшын", re: /ағылшын|англ|english/i, loc: pk("Англ") },
  { label: "Химия", re: /хими/i, loc: pk("Химия") },
  { label: "Биология", re: /биолог/i, loc: pk("Биология") },
  { label: "Физика", re: /физик/i, loc: pk("Физика") },
  { label: "География", re: /географ/i, loc: pk("География") },
  { label: "Математика", re: /математ|(?:^|\s)мат(?:\s|$)/i, loc: pk("Математика") },
  { label: "Тарих МС", re: /тарих\s*мс|қазақстан тарих/i, loc: pk("ТарихМс") },
  { label: "Дүниежүзі тарихы", re: /дүниежүзі|джт/i, loc: pk("Дүниежүзі тарихы") },
  { label: "Әдебиет/тіл", re: /әдеб|қазақ тіл/i, loc: pk("ӘдебТіл") },
  { label: "Информатика", re: /информат|инфо(?![а-яәіңғүұқөһ])/i, loc: pk("Информатика") },
  { label: "Құқық", re: /құқық|кукык/i, loc: pk("Құқық") },
  { label: "Руслит", re: /руслит|русск/i, loc: pk("РусЛит") },
  { label: "JUZ40 Online", re: /online|онлайн|juz40\s*onl/i, loc: pk("Online") },
  { label: "IELTS", re: /ielts/i, loc: { project: "Marketing", board: "Проект", column: "IELTS" } },
  { label: "Community", re: /community|комьюнити|\bcomm\b/i, loc: { project: "Marketing", board: "Проект", column: "Community" } },
  { label: "Junior", re: /junior/i, loc: { project: "Marketing", board: "Проект", column: "Junior" } },
  { label: "Career", re: /career/i, loc: { project: "Marketing", board: "Проект", column: "Career" } },
  { label: "YouTube", re: /youtube|ютуб/i, loc: { project: "Product", board: "YouTube", column: "Қолмен" } },
  { label: "HR", re: /\bhr\b|эйчар|hr\s*бөлім/i, loc: { project: "HR", board: "Қолмен", column: "HR" } },
  { label: "JUZENG", re: /juzeng|жузенг/i, loc: { project: "JUZENG", board: "Қолмен", column: "JUZENG" } },
];
export const pickBySubject = (label: string) => PICK.find((p) => p.label === label);
export const findSubject = (text: string) => PICK.find((p) => p.re.test(text)) ?? null;
/** Тізімде жоқ пән: дизайнер жазған атау «Басқа» парағына түседі */
export const otherSubject = (name: string) => ({ label: name, loc: { project: name, board: "Қолмен", column: name } as Loc });

const TYPE_WORDS: [string, string][] = [
  ["YouTube обложка", "(?:youtube|ютуб)\\s*обложк\\S*"],
  ["Рилс обложка", "(?:рилс|рилз|reels?)(?:\\s*обложк\\S*)?"],
  ["Таргет баннер", "таргет\\S*(?:\\s*баннер\\S*)?"],
  ["Пост", "пост\\S*|post\\S*"],
  ["Карусель", "карусел\\S*|carousel\\S*"],
  ["Баннер", "баннер\\S*|banner\\S*"],
  ["Раздатка", "раздатк\\S*|handout\\S*"],
  ["Презентация", "презентац\\S*"],
  ["Обложка", "обложк\\S*|cover\\S*"],
];
/** «2 пост, 5 карусель» / «пост - 2» → {Пост: 2, Карусель: 5} */
export function parseWorkItems(text: string, subject?: string): Record<string, number> {
  let t = " " + text.toLowerCase() + " ";
  const out: Record<string, number> = {};
  for (const [type, word] of TYPE_WORDS) {
    const re = new RegExp(`(\\d+)\\s*(?:${word})|(?:${word})\\s*[-—:–]?\\s*(\\d+)`, "giu");
    t = t.replace(re, (_m, a, b) => {
      const n = Number(a ?? b);
      if (n > 0 && n <= 500) {
        const key = type === "Обложка" && subject === "YouTube" ? "YouTube обложка" : type;
        out[key] = (out[key] ?? 0) + n;
      }
      return " ";
    });
  }
  return out;
}
export const itemsText = (subject: string, items: Record<string, number>) =>
  `${subject} — ${WORK_TYPES.filter((w) => items[w]).map((w) => typeName(subject, w, items[w])).join(", ")}`;
