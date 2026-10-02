/**
 * Тапсырма чатынан файлдарды бөліп алу және санау.
 *
 * YouGile файлды хабарлама мәтінінің ішінде береді:
 *   /root/#file:/user-data/<UUID>/<екі рет URL-кодталған атау>%3Fpreviews...
 *
 * Келісілген ереже:
 *  - орындаушы дизайнер жүктеген, рұқсат етілген түрдегі БАРЛЫҚ бірегей файл саналады;
 *  - бір UUID немесе бір дизайнердің бірдей атаулы файлы — бір рет;
 *  - басқа адам ТҮЗЕТУ сұраса (кілт сөздер), одан кейінгі файлдар «сұрақ» тобына түседі:
 *    бот дизайнерден [Түзету] / [Қосымша жұмыс] деп сұрайды.
 */

export type ChatMessage = { id: number; fromUserId: string; text?: string; deleted?: boolean };

export type ParsedFile = { uuid: string; name: string; ext: string; messageId: number; uploadedBy: string };

export type ExcludedFile = ParsedFile & {
  reason: "not-designer" | "extension" | "duplicate-uuid" | "duplicate-name";
};

export type DesignerFiles = {
  designerId: string;
  counted: ParsedFile[];
  /** Түзету сұралғаннан кейінгі файлдар — дизайнерден сұралады */
  ask: ParsedFile[];
};

export type FileCountResult = {
  byDesigner: Map<string, DesignerFiles>;
  excluded: ExcludedFile[];
  /** Түзету сұрауы бар хабарлама (болса) */
  correctionMessage?: { id: number; fromUserId: string; text: string };
};

const FILE_RE = /\/user-data\/([0-9a-fA-F-]{36})\/([^\s]+)/g;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Бір хабарламадағы барлық файл */
export function parseFiles(msg: ChatMessage): ParsedFile[] {
  const out: ParsedFile[] = [];
  const text = msg.text ?? "";
  for (const m of text.matchAll(FILE_RE)) {
    const once = safeDecode(m[2]); // %3F → ?, %25D1 → %D1
    const raw = once.split("?")[0];
    const name = safeDecode(raw).trim();
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    out.push({ uuid: m[1].toLowerCase(), name, ext, messageId: msg.id, uploadedBy: msg.fromUserId });
  }
  return out;
}

export function isCorrectionRequest(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w.toLowerCase()));
}

/** Файл атауынан ұқсас мәтінді алып тастап, тек хабарлама сөздерін қалдыру */
const stripFiles = (text: string) => text.replace(/\/root\/#file:\S+/g, " ").trim();

export function countFiles(
  messages: ChatMessage[],
  designerIds: Set<string>,
  opts: { allowedExts: string[]; correctionWords: string[] },
): FileCountResult {
  const allowed = new Set(opts.allowedExts.map((e) => e.toLowerCase()));
  const byDesigner = new Map<string, DesignerFiles>();
  const excluded: ExcludedFile[] = [];
  const seenUuid = new Set<string>();
  const seenName = new Set<string>(); // designerId + name
  let correctionMessage: FileCountResult["correctionMessage"];
  /** Түзету сұрауы тек дизайнер алғашқы файлын жібергеннен КЕЙІН ізделеді (ТЗ ішіндегі сөздер есептелмейді) */
  let designerUploaded = false;

  const sorted = [...messages].filter((m) => !m.deleted).sort((a, b) => a.id - b.id);

  for (const msg of sorted) {
    const fromDesigner = designerIds.has(msg.fromUserId);

    if (!fromDesigner) {
      const words = stripFiles(msg.text ?? "");
      if (designerUploaded && !correctionMessage && words && isCorrectionRequest(words, opts.correctionWords)) {
        correctionMessage = { id: msg.id, fromUserId: msg.fromUserId, text: words.slice(0, 300) };
      }
      for (const f of parseFiles(msg)) excluded.push({ ...f, reason: "not-designer" });
      continue;
    }

    for (const f of parseFiles(msg)) {
      if (!allowed.has(f.ext)) {
        excluded.push({ ...f, reason: "extension" });
        continue;
      }
      if (seenUuid.has(f.uuid)) {
        excluded.push({ ...f, reason: "duplicate-uuid" });
        continue;
      }
      seenUuid.add(f.uuid);
      const nameKey = `${f.uploadedBy}|${f.name.toLowerCase()}`;
      if (seenName.has(nameKey)) {
        excluded.push({ ...f, reason: "duplicate-name" });
        continue;
      }
      seenName.add(nameKey);
      designerUploaded = true;

      let entry = byDesigner.get(msg.fromUserId);
      if (!entry) {
        entry = { designerId: msg.fromUserId, counted: [], ask: [] };
        byDesigner.set(msg.fromUserId, entry);
      }
      (correctionMessage ? entry.ask : entry.counted).push(f);
    }
  }

  return { byDesigner, excluded, correctionMessage };
}
