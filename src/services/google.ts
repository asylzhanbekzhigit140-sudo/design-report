/**
 * Google Sheets: сервис-аккаунт арқылы тірі есеп кестесін толтыру.
 * Тәуелділіксіз: JWT (RS256) node:crypto арқылы қол қойылады, Sheets API v4 REST.
 */
import { createSign } from "node:crypto";

export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export function parseServiceAccount(raw: string): ServiceAccount | null {
  if (!raw.trim()) return null;
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const sa = JSON.parse(text);
  if (!sa.client_email || !sa.private_key) throw new Error("Сервис-аккаунт JSON-ында client_email/private_key жоқ");
  return { ...sa, private_key: String(sa.private_key).replace(/\\n/g, "\n") };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function signJwt(sa: ServiceAccount, scope: string, aud: string, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: sa.client_email, scope, aud, iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(sa.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

export class SheetsClient {
  private token: { value: string; exp: number } | null = null;
  private sheetIds = new Map<string, number>();

  constructor(
    private sa: ServiceAccount,
    public spreadsheetId: string,
    private base = "https://sheets.googleapis.com/v4",
    private tokenUrl = "https://oauth2.googleapis.com/token",
  ) {}

  private async auth() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const assertion = signJwt(this.sa, "https://www.googleapis.com/auth/spreadsheets", this.tokenUrl);
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google auth ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}/spreadsheets/${this.spreadsheetId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 403 ? " (кесте сервис-аккаунтпен бөлісілмеген болуы мүмкін)" : res.status === 404 ? " (GOOGLE_SHEET_ID қате)" : "";
      throw new Error(`Google Sheets ${res.status}${hint}: ${JSON.stringify(j).slice(0, 200)}`);
    }
    return j;
  }

  async loadSheets() {
    const j = await this.call("GET", "?fields=sheets.properties(sheetId,title,index)");
    this.sheetIds.clear();
    for (const s of j.sheets ?? []) this.sheetIds.set(s.properties.title, s.properties.sheetId);
    return this.sheetIds;
  }

  /** Парақ жоқ болса жасайды; sheetId қайтарады */
  async ensureSheet(title: string, index = 0) {
    if (!this.sheetIds.size) await this.loadSheets();
    const have = this.sheetIds.get(title);
    if (have !== undefined) return have;
    const j = await this.call("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title, index } } }] });
    const id = j.replies?.[0]?.addSheet?.properties?.sheetId;
    this.sheetIds.set(title, id);
    return id as number;
  }

  /** Парақты толық қайта жазу: тазалау → мәндер (формулалар қоса) → қалың жолдар */
  async writeSheet(title: string, values: (string | number)[][], boldRows: number[], index = 0) {
    const sheetId = await this.ensureSheet(title, index);
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
    await this.call("POST", `/values/${range}:clear`, {});
    await this.call("PUT", `/values/${range}!A1?valueInputOption=USER_ENTERED`, { values });
    const requests: any[] = [
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: Math.max(values.length + 50, 200) },
        cell: { userEnteredFormat: { textFormat: { bold: false } } }, fields: "userEnteredFormat.textFormat.bold" } },
      ...boldRows.map((r) => ({
        repeatCell: { range: { sheetId, startRowIndex: r, endRowIndex: r + 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" },
      })),
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenColumnCount: 1 } }, fields: "gridProperties.frozenColumnCount" } },
    ];
    await this.call("POST", ":batchUpdate", { requests });
  }
}
