/**
 * Бастапқы анықтамалықтар. Кейін database-ке көшіріліп, Admin-де өзгертіледі.
 * Барлығы сұхбатта бекітілген деректерден алынған.
 */
import type { Rule } from "../core/rules.js";

/** YouGile realName → Excel-дегі аты */
export const DESIGNERS: { yougileName: string; excelName: string; shortName: string }[] = [
  { yougileName: "AIYMBOL BEKBOLAT", excelName: "Бекболат", shortName: "Айымбол" },
  { yougileName: "Жания Абубакирова", excelName: "Абубакирова", shortName: "Жания" },
  { yougileName: "Nurmukhammad", excelName: "Асханов", shortName: "Нұрмұхаммад" },
  { yougileName: "Asylzhan", excelName: "Бекжігіт", shortName: "Асылжан" },
  { yougileName: "Altynay", excelName: "Махмутхан", shortName: "Алтынай" },
  { yougileName: "Илан Рамазан", excelName: "Рамазан", shortName: "Илан" },
  { yougileName: "Балауса", excelName: "Нұрсұлтан", shortName: "Балауса" },
  { yougileName: "Алинка", excelName: "Маликова", shortName: "Алина" },
  { yougileName: "Нұрбол Қален", excelName: "Қален", shortName: "Нұрбол" },
  { yougileName: "Айнур Шакизат", excelName: "Шакизат", shortName: "Айнур" },
];

export type SheetName = "ПӘН АКК" | "ИНСТА АКК" | "ӨЗГЕ";

/** «Жоба/Тақта/Колонка» → Excel-дегі пән/аккаунт атауы және парағы */
export const SUBJECTS: Record<string, { name: string; sheet: SheetName }> = {
  "Marketing/Пән акк/ТарихМс": { name: "ТАРИХ МС", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Дүниежүзі тарихы": { name: "ДЖТ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Англ": { name: "АҒЫЛШЫН", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Математика": { name: "МАТ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/ӘдебТіл": { name: "ӘДЕБТІЛ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Биология": { name: "БИОЛОГИЯ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/География": { name: "ГЕОГРАФИЯ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Физика": { name: "ФИЗИКА", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Химия": { name: "ХИМИЯ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/РусЛит": { name: "РУСЛИТ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Құқық": { name: "ҚҰҚЫҚ", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Информатика": { name: "ИНФО", sheet: "ПӘН АКК" },
  "Marketing/Пән акк/Online": { name: "JUZ40 ONL", sheet: "ИНСТА АКК" },
  "Marketing/Проект/IELTS": { name: "IELTS", sheet: "ИНСТА АКК" },
  "Marketing/Проект/Junior": { name: "JUNIOR", sheet: "ИНСТА АКК" },
  "Marketing/Проект/Community": { name: "COMM", sheet: "ИНСТА АКК" },
  "Marketing/Проект/Career": { name: "CAREER", sheet: "ИНСТА АКК" },
};

/** Сәйкестендірілмеген орын үшін: жоба » колонка атауы, парағы — ӨЗГЕ (Проект тақтасы — ИНСТА АКК) */
export function subjectFor(loc: { project: string; board: string; column: string } | null) {
  if (!loc) return { name: "БЕЛГІСІЗ", sheet: "ӨЗГЕ" as SheetName };
  const hit = SUBJECTS[`${loc.project}/${loc.board}/${loc.column}`];
  if (hit) return hit;
  if (loc.project === "Product" && loc.board === "YouTube") return { name: "YOUTUBE", sheet: "ӨЗГЕ" as SheetName };
  if (loc.project === "Marketing" && loc.board === "Проект")
    return { name: loc.column.toUpperCase(), sheet: "ИНСТА АКК" as SheetName };
  return { name: `${loc.project} » ${loc.column}`, sheet: "ӨЗГЕ" as SheetName };
}

export const WORK_TYPES = [
  "Пост",
  "Карусель",
  "YouTube обложка",
  "Рилс обложка",
  "Таргет баннер",
  "Баннер",
  "Раздатка",
  "Презентация",
  "Обложка",
  "ҰБТ обложка", // резерв
] as const;

export const ALLOWED_EXTS = ["png", "jpg", "jpeg", "webp", "pdf", "mp4", "mov"];

export const CORRECTION_WORDS = [
  "түзет", "өзгерт", "қате", "ауыстыр", "дұрыста",
  "исправ", "поменя", "правк", "переделай", "замени", "ошибк",
];

const POST_CAROUSEL = [
  { workType: "Пост", expr: "1" },
  { workType: "Карусель", expr: "N-1" },
];

export const RULES: Rule[] = [
  {
    code: "R4b", level: 1, description: "Marketing » Проект » Таргет колонкасы → N таргет",
    when: { project: "Marketing", board: "Проект", columns: ["Таргет"] },
    outputs: [{ workType: "Таргет баннер", expr: "N" }],
  },
  {
    code: "R3b", level: 1, description: "Marketing » Проект » Youtube колонкасы → N YouTube обложка",
    when: { project: "Marketing", board: "Проект", columns: ["Youtube"] },
    outputs: [{ workType: "YouTube обложка", expr: "N" }],
  },
  {
    code: "R4", level: 2, description: "Атауында «таргет» → N таргет",
    when: { titleAny: ["таргет", "target"] },
    outputs: [{ workType: "Таргет баннер", expr: "N" }],
  },
  {
    code: "R6", level: 2, description: "SERVICE + «баннер» → N баннер",
    when: { project: "SERVICE", titleAny: ["баннер", "banner"] },
    outputs: [{ workType: "Баннер", expr: "N" }],
  },
  {
    // Атауында анық «рилс/reels» болса — рилс обложка. Ал жай «обложка» екіұшты (карусель мұқабасы да болуы мүмкін):
    // ол R1/R2 бойынша саналады, бірақ бот дизайнерден бір батырмамен растауды сұрайды (cover_checks).
    code: "R12", level: 2, description: "Marketing + атауында «рилс / reels» → N рилс обложка",
    when: { project: "Marketing", titleAny: ["рилс", "рилз", "reels", "reel"] },
    outputs: [{ workType: "Рилс обложка", expr: "N" }],
  },
  {
    code: "R7", level: 2, description: "Раздатка / handout / peer work → N раздатка",
    when: { titleAny: ["раздатка", "раздаточ", "handout", "peer work"] },
    outputs: [{ workType: "Раздатка", expr: "N" }],
  },
  {
    code: "R8", level: 2, description: "Презентация → N презентация",
    when: { titleAny: ["презентац", "преза", "presentation"] },
    outputs: [{ workType: "Презентация", expr: "N" }],
  },
  {
    code: "R1", level: 3, description: "Marketing » Пән акк → 1 пост + (N−1) карусель",
    when: { project: "Marketing", board: "Пән акк" },
    outputs: POST_CAROUSEL,
  },
  {
    code: "R2", level: 3, description: "Marketing » Проект (инста аккаунттар) → 1 пост + (N−1) карусель",
    when: { project: "Marketing", board: "Проект" },
    outputs: POST_CAROUSEL,
  },
  {
    code: "R3", level: 3, description: "Product » YouTube → N YouTube обложка",
    when: { project: "Product", board: "YouTube" },
    outputs: [{ workType: "YouTube обложка", expr: "N" }],
  },
  // 4-деңгей: орын ережесі жоқ жерлерге (JUZENG, HR, PR, UBT, Design » ӨЗ ТЗ…) атау бойынша жалпы ережелер.
  // Marketing-тегі жай «обложка» R1/R2 бойынша саналады, бот дизайнерден растауды сұрайды.
  {
    code: "R9", level: 4, description: "Атауында «обложка / шапка / превью» → N обложка",
    when: { titleAny: ["обложк", "шапка", "превью", "preview", "cover"] },
    outputs: [{ workType: "Обложка", expr: "N" }],
  },
  {
    code: "R10", level: 4, description: "Атауында «баннер» → N баннер (кез келген бөлім)",
    when: { titleAny: ["баннер", "banner"] },
    outputs: [{ workType: "Баннер", expr: "N" }],
  },
  {
    code: "R11", level: 4, description: "Атауында «пост / карусель» → 1 пост + (N−1) карусель (кез келген бөлім)",
    when: { titleAny: ["пост", "post", "карусель", "carousel"] },
    outputs: POST_CAROUSEL,
  },
];

export const MANY_FILES_LIMIT = 60;
