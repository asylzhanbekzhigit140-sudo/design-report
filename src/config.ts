/** Барлық баптау environment variables-тан. Құпиялар кодта сақталмайды. */
const req = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} environment variable жоқ`);
  return v;
};

export const config = {
  databaseUrl: () => req("DATABASE_URL"),
  yougileKey: () => req("YOUGILE_API_KEY"),
  yougileBase: process.env.YOUGILE_BASE_URL || "https://ru.yougile.com/api-v2",
  botToken: () => req("TELEGRAM_BOT_TOKEN"),
  /** Бірінші /start <код> жіберген адам админ болады */
  adminSetupCode: () => req("ADMIN_SETUP_CODE"),
  month1: process.env.REPORT_MONTH1 || undefined,
  /** Сұраныстар арасындағы минимал аралық (мс) — компанияның 50/мин шегінен төмен */
  ygIntervalMs: Number(process.env.YG_INTERVAL_MS ?? 3000),
  tz: "Asia/Almaty",
  /** AI-сұрақтар (міндетті емес). Кілт болмаса, функция өшік */
  ai: (() => {
    const gemini = process.env.GEMINI_API_KEY || "";
    const openai = process.env.OPENAI_API_KEY || "";
    const provider = (process.env.AI_PROVIDER || (gemini ? "gemini" : openai ? "openai" : "")).toLowerCase();
    if (provider === "gemini")
      return {
        provider, key: gemini,
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        model: process.env.AI_MODEL || "gemini-3.5-flash-lite",
      };
    if (provider === "openai")
      return { provider, key: openai, url: "https://api.openai.com/v1/chat/completions", model: process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini" };
    return { provider: "", key: "", url: "", model: "" };
  })(),
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT ?? 30),
};
