/**
 * YouGile кілтін ауыстыру: жаңа кілт жасап, .env-ке жазады және ескісін өшіреді.
 * Іске қосу: npm run rotate-key
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const BASE = (process.env.YOUGILE_BASE_URL ?? "https://ru.yougile.com/api-v2").replace(/\/$/, "");

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) (rl as any)._writeToOutput = (s: string) => s.startsWith(question) && process.stdout.write(question);
  return new Promise((r) => rl.question(question, (a) => (rl.close(), hidden && process.stdout.write("\n"), r(a.trim()))));
}

async function call(method: string, path: string, body?: object) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const env = await readFile(".env", "utf8");
  const old = env.match(/^YOUGILE_API_KEY=(.*)$/m)?.[1]?.trim();
  const login = await ask("YouGile логин (email): ");
  const password = await ask("Құпиясөз: ", true);
  const companies = await call("POST", "/auth/companies", { login, password });
  const company = (companies.content ?? companies).find((c: any) => /juz40/i.test(c.name)) ?? (companies.content ?? companies)[0];
  const { key } = await call("POST", "/auth/keys", { login, password, companyId: company.id });
  await writeFile(".env", env.replace(/^YOUGILE_API_KEY=.*$/m, `YOUGILE_API_KEY=${key}`));
  console.log("✅ Жаңа кілт .env файлына жазылды (экранға шығарылмайды).");
  if (old) {
    try {
      await call("DELETE", `/auth/keys/${old}`);
      console.log("✅ Ескі кілт өшірілді.");
    } catch (e: any) {
      console.log(`⚠️ Ескі кілтті өшіру сәтсіз: ${e.message}. YouGile баптауларынан қолмен өшіріңіз.`);
    }
  }
  console.log("Railway-дегі YOUGILE_API_KEY мәнін де жаңартыңыз: open -e .env");
}

main().catch((e) => (console.error("Қате:", e.message), process.exit(1)));
