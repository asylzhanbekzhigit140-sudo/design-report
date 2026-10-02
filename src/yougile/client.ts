/**
 * YouGile API v2 клиенті — ТЕК ОҚУ (GET).
 * Компанияның шегі 50 сұраныс/мин (адамдарды қоса), сондықтан жүйе өзін минутына ~20-ға шектейді.
 */

export type YgUser = { id: string; realName?: string; email?: string; isAdmin?: boolean };
export type YgProject = { id: string; title: string; deleted?: boolean; users?: Record<string, string> };
export type YgBoard = { id: string; title: string; projectId: string; deleted?: boolean };
export type YgColumn = { id: string; title: string; boardId: string; deleted?: boolean };
export type YgTask = {
  id: string;
  title: string;
  columnId?: string;
  completed?: boolean;
  completedTimestamp?: number;
  archived?: boolean;
  deleted?: boolean;
  assigned?: string[];
  createdBy?: string;
  timestamp?: number;
  deadline?: { deadline?: number };
  idTaskProject?: string;
  idTaskCommon?: string;
};
export type YgMessage = { id: number; fromUserId: string; text?: string; deleted?: boolean };

type Paged<T> = { paging?: { count?: number; limit?: number; offset?: number; next?: boolean }; content?: T[] };

export class YouGileClient {
  private last = 0;
  public requests = 0;

  constructor(
    private readonly key: string,
    private readonly base = "https://ru.yougile.com/api-v2",
    private readonly minIntervalMs = 3000,
  ) {}

  private async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(this.base.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    for (let attempt = 1; attempt <= 4; attempt++) {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      this.requests++;

      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" } });
      } catch (e) {
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 4) throw new Error(`YouGile ${res.status} ${path}`);
        await new Promise((r) => setTimeout(r, res.status === 429 ? 60_000 : 5000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`YouGile ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as T;
    }
    throw new Error(`YouGile: ${path} сәтсіз`);
  }

  /** limit/offset беттерін түгел жинау */
  private async all<T>(path: string, params: Record<string, string | number> = {}, pageSize = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; offset < 100_000; ) {
      const body = await this.get<Paged<T> | T[]>(path, { ...params, limit: pageSize, offset });
      const items = Array.isArray(body) ? body : body.content ?? [];
      out.push(...items);
      const next = !Array.isArray(body) && body.paging?.next;
      if (!next || items.length === 0) break;
      offset += items.length;
    }
    return out;
  }

  users = () => this.all<YgUser>("/users");
  projects = () => this.all<YgProject>("/projects");
  boards = () => this.all<YgBoard>("/boards");
  columns = () => this.all<YgColumn>("/columns");
  tasksAssignedTo = (userId: string) => this.all<YgTask>("/task-list", { assignedTo: userId });
  task = (idOrCode: string) => this.get<YgTask>(`/tasks/${encodeURIComponent(idOrCode)}`);
  messages = (taskId: string) => this.all<YgMessage>(`/chats/${taskId}/messages`, {}, 500);
}

/** Тапсырманың орны: жоба » тақта » колонка */
export type Location = { project: string; board: string; column: string };

export class Structure {
  private col = new Map<string, YgColumn>();
  private board = new Map<string, YgBoard>();
  private project = new Map<string, YgProject>();

  constructor(projects: YgProject[], boards: YgBoard[], columns: YgColumn[]) {
    projects.forEach((p) => this.project.set(p.id, p));
    boards.forEach((b) => this.board.set(b.id, b));
    columns.forEach((c) => this.col.set(c.id, c));
  }

  locate(columnId?: string): Location | null {
    const c = columnId ? this.col.get(columnId) : undefined;
    const b = c ? this.board.get(c.boardId) : undefined;
    const p = b ? this.project.get(b.projectId) : undefined;
    if (!c || !b || !p) return null;
    return { project: p.title.trim(), board: b.title.trim(), column: c.title.trim() };
  }
}
