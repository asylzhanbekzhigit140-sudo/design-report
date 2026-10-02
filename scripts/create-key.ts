/**
 * YouGile API кілтін жасау (бір рет).
 * Логин мен құпиясөз тек YouGile-ге жіберіледі, ешқайда сақталмайды.
 * Іске қосу: npm run create-key
 */
import { createInterface } from "node:readline";

const BASE = (process.env.YOUGILE_BASE_URL ?? "https://ru.yougile.com/api-v2").replace(/\/$/, "");

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    (rl as any)._writeToOutput = (s: string) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a.trim());
    }),
  );
}

async function post(path: string, body: object) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function main() {
  const login = await ask("YouGile логин (email): ");
  const password = await ask("Құпиясөз: ", true);

  const companies = await post("/auth/companies", { login, password });
  const list: any[] = companies?.content ?? companies ?? [];
  if (!list.length) throw new Error("Компания табылмады.");
  list.forEach((c, i) => console.log(`${i + 1}. ${c.name} (${c.id})`));

  let company = list.find((c) => /juz40/i.test(c.name)) ?? list[0];
  if (list.length > 1) {
    const n = await ask(`Компания нөмірі [${list.indexOf(company) + 1}]: `);
    if (n) company = list[Number(n) - 1] ?? company;
  }

  const res = await post("/auth/keys", { login, password, companyId: company.id });
  console.log("\nКілт жасалды. Оны .env файлына YOUGILE_API_KEY= жолына қойыңыз.");
  console.log("Кілтті чатқа немесе басқа адамға жібермеңіз.\n");
  console.log(res.key ?? JSON.stringify(res));
}

main().catch((e) => {
  console.error("Қате:", e.message);
  console.error("Балама: кілтті YouGile интерфейсінде (Баптаулар → API) жасауға болады.");
  process.exit(1);
});
