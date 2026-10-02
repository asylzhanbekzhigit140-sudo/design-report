/**
 * Апта шекаралары Asia/Almaty бойынша.
 * Қазақстан 2024-03-01 бастап бірыңғай UTC+5, жазғы уақыт жоқ.
 */
export const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export type Week = {
  /** Дүйсенбі 00:00 Алматы, UTC мс */
  startMs: number;
  /** Келесі дүйсенбі 00:00 Алматы, UTC мс (қоса есептелмейді) */
  endMs: number;
  /** Дүйсенбінің Алматы күні, YYYY-MM-DD */
  monday: string;
};

/** Уақыт белгісі түсетін аптаны қайтарады */
export function weekOf(ms: number): Week {
  const local = ms + ALMATY_OFFSET_MS;
  const dayStart = Math.floor(local / DAY) * DAY;
  const weekday = (new Date(dayStart).getUTCDay() + 6) % 7; // 0 = дүйсенбі
  const mondayLocal = dayStart - weekday * DAY;
  return {
    startMs: mondayLocal - ALMATY_OFFSET_MS,
    endMs: mondayLocal + 7 * DAY - ALMATY_OFFSET_MS,
    monday: new Date(mondayLocal).toISOString().slice(0, 10),
  };
}

/** "2026-09-22" → сол аптаның шекаралары */
export function weekFromMonday(monday: string): Week {
  return weekOf(Date.parse(`${monday}T00:00:00Z`) - ALMATY_OFFSET_MS);
}

export const inWeek = (ms: number, w: Week) => ms >= w.startMs && ms < w.endMs;

/**
 * «3-АЙ 1-АПТА» белгісі.
 * Апта дүйсенбісі түскен айға жатады. Ай нөмірі month1 (бірінші айдың кез келген күні,
 * YYYY-MM-DD) берілсе, содан бастап саналады; берілмесе — ай атауы қолданылады.
 */
export function weekLabel(w: Week, month1?: string): string {
  const [y, m, d] = w.monday.split("-").map(Number);
  const weekNo = Math.ceil(d / 7);
  if (month1) {
    const [y1, m1] = month1.split("-").map(Number);
    const monthNo = (y - y1) * 12 + (m - m1) + 1;
    return `${monthNo}-АЙ ${weekNo}-АПТА`;
  }
  const names = ["ҚАҢТАР", "АҚПАН", "НАУРЫЗ", "СӘУІР", "МАМЫР", "МАУСЫМ", "ШІЛДЕ", "ТАМЫЗ", "ҚЫРКҮЙЕК", "ҚАЗАН", "ҚАРАША", "ЖЕЛТОҚСАН"];
  return `${names.at(m - 1)} ${weekNo}-АПТА`;
}

/** Адамға оқылатын аралық: «22–28 қыркүйек» */
export function weekRangeText(w: Week): string {
  const months = ["қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде", "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан"];
  const a = new Date(w.startMs + ALMATY_OFFSET_MS);
  const b = new Date(w.endMs - 1 + ALMATY_OFFSET_MS);
  const ma = months.at(a.getUTCMonth())!;
  const mb = months.at(b.getUTCMonth())!;
  return ma === mb
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${mb}`
    : `${a.getUTCDate()} ${ma} – ${b.getUTCDate()} ${mb}`;
}
