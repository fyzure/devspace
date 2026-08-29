import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { cardSnapshots, type CardSnapshotRow } from "./db/schema.js";

export interface StoredCardSnapshot {
  id: string;
  conversationScopeId?: string;
  requestId?: string;
  workspaceId?: string;
  tool: string;
  card: Record<string, unknown>;
  createdAt: string;
}

export type CardRequestId = string | number;

export interface CardStore {
  save(input: {
    conversationScopeId?: string;
    requestId?: CardRequestId;
    workspaceId?: string;
    tool: string;
    card: Record<string, unknown>;
  }): StoredCardSnapshot | Promise<StoredCardSnapshot>;
  get(id: string): StoredCardSnapshot | undefined | Promise<StoredCardSnapshot | undefined>;
  getByInvocation(input: {
    conversationScopeId: string;
    requestId: CardRequestId;
  }): StoredCardSnapshot | undefined | Promise<StoredCardSnapshot | undefined>;
  close?(): void;
}

export interface RemoteCardStore {
  save(snapshot: StoredCardSnapshot): Promise<void>;
  get(id: string): Promise<StoredCardSnapshot | undefined>;
}

export interface HttpRemoteCardStoreOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface HybridCardStoreOptions {
  onRemoteError?: (input: {
    operation: "save" | "get";
    cardId: string;
    error: unknown;
  }) => void;
}

export class SqliteCardStore implements CardStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  save(input: {
    conversationScopeId?: string;
    requestId?: CardRequestId;
    workspaceId?: string;
    tool: string;
    card: Record<string, unknown>;
  }): StoredCardSnapshot {
    const save = this.database.sqlite.transaction(() => {
      // JSON-RPC request ids are only required to correlate a request with its
      // response on a connection. Stateless MCP clients may reuse the same id
      // for later tool calls, so it is not a stable widget identity. Always
      // allocate a fresh card id and keep request_id only as a best-effort
      // restore hint when the host has not surfaced the card id yet.
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const card = {
        ...input.card,
        cardId: id,
      };

      const snapshot = {
        id,
        conversationScopeId: input.conversationScopeId,
        requestId: encodeOptionalRequestId(input.requestId),
        workspaceId: input.workspaceId,
        tool: input.tool,
        card,
        createdAt,
      };
      this.put(snapshot);
      return snapshot;
    });

    return save.immediate();
  }

  get(id: string): StoredCardSnapshot | undefined {
    const row = this.database.db
      .select()
      .from(cardSnapshots)
      .where(eq(cardSnapshots.id, id))
      .get();

    return row ? rowToStoredCardSnapshot(row) : undefined;
  }

  getByInvocation(input: {
    conversationScopeId: string;
    requestId: CardRequestId;
  }): StoredCardSnapshot | undefined {
    const row = this.database.db
      .select()
      .from(cardSnapshots)
      .where(and(
        eq(cardSnapshots.conversationScopeId, input.conversationScopeId),
        eq(cardSnapshots.requestId, encodeRequestId(input.requestId)),
      ))
      .orderBy(desc(cardSnapshots.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();

    return row ? rowToStoredCardSnapshot(row) : undefined;
  }

  put(snapshot: StoredCardSnapshot): void {
    this.database.db
      .insert(cardSnapshots)
      .values(snapshotToRow(snapshot))
      .onConflictDoUpdate({
        target: cardSnapshots.id,
        set: {
          conversationScopeId: snapshot.conversationScopeId ?? null,
          requestId: snapshot.requestId ?? null,
          workspaceId: snapshot.workspaceId ?? null,
          tool: snapshot.tool,
          cardJson: JSON.stringify(snapshot.card),
          createdAt: snapshot.createdAt,
        },
      })
      .run();
  }

  close(): void {
    this.database.close();
  }
}

export class HttpRemoteCardStore implements RemoteCardStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(options: HttpRemoteCardStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.request = options.fetch ?? fetch;
  }

  async save(snapshot: StoredCardSnapshot): Promise<void> {
    const response = await this.request(this.cardUrl(snapshot.id), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Remote card store save failed with HTTP ${response.status}.`);
    }
  }

  async get(id: string): Promise<StoredCardSnapshot | undefined> {
    const response = await this.request(this.cardUrl(id), {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Remote card store read failed with HTTP ${response.status}.`);
    }

    const snapshot = parseStoredCardSnapshot(await response.json());
    if (snapshot.id !== id) {
      throw new Error(`Remote card store returned mismatched card id ${snapshot.id}.`);
    }
    return snapshot;
  }

  private cardUrl(id: string): string {
    return `${this.baseUrl}/cards/${encodeURIComponent(id)}`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }
}

export class HybridCardStore implements CardStore {
  constructor(
    private readonly local: SqliteCardStore,
    private readonly remote: RemoteCardStore,
    private readonly options: HybridCardStoreOptions = {},
  ) {}

  save(input: {
    conversationScopeId?: string;
    requestId?: CardRequestId;
    workspaceId?: string;
    tool: string;
    card: Record<string, unknown>;
  }): StoredCardSnapshot {
    const snapshot = this.local.save(input);
    void this.remote.save(snapshot).catch((error) => {
      this.options.onRemoteError?.({ operation: "save", cardId: snapshot.id, error });
    });
    return snapshot;
  }

  async get(id: string): Promise<StoredCardSnapshot | undefined> {
    const local = this.local.get(id);
    if (local) return local;

    try {
      const remote = await this.remote.get(id);
      if (!remote) return undefined;
      this.local.put(remote);
      return remote;
    } catch (error) {
      this.options.onRemoteError?.({ operation: "get", cardId: id, error });
      return undefined;
    }
  }

  getByInvocation(input: {
    conversationScopeId: string;
    requestId: CardRequestId;
  }): StoredCardSnapshot | undefined {
    return this.local.getByInvocation(input);
  }

  close(): void {
    this.local.close();
  }
}

function snapshotToRow(snapshot: StoredCardSnapshot): typeof cardSnapshots.$inferInsert {
  return {
    id: snapshot.id,
    conversationScopeId: snapshot.conversationScopeId ?? null,
    requestId: snapshot.requestId ?? null,
    workspaceId: snapshot.workspaceId ?? null,
    tool: snapshot.tool,
    cardJson: JSON.stringify(snapshot.card),
    createdAt: snapshot.createdAt,
  };
}

function parseStoredCardSnapshot(value: unknown): StoredCardSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Remote card snapshot is malformed.");
  }

  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== "string"
    || typeof input.tool !== "string"
    || typeof input.createdAt !== "string"
    || !input.card
    || typeof input.card !== "object"
    || Array.isArray(input.card)
  ) {
    throw new Error("Remote card snapshot is malformed.");
  }

  if (input.conversationScopeId !== undefined && typeof input.conversationScopeId !== "string") {
    throw new Error("Remote card snapshot has an invalid conversation scope id.");
  }
  if (input.requestId !== undefined && typeof input.requestId !== "string") {
    throw new Error("Remote card snapshot has an invalid request id.");
  }
  if (input.workspaceId !== undefined && typeof input.workspaceId !== "string") {
    throw new Error("Remote card snapshot has an invalid workspace id.");
  }

  return {
    id: input.id,
    ...(typeof input.conversationScopeId === "string"
      ? { conversationScopeId: input.conversationScopeId }
      : {}),
    ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    tool: input.tool,
    card: input.card as Record<string, unknown>,
    createdAt: input.createdAt,
  };
}

function rowToStoredCardSnapshot(row: CardSnapshotRow): StoredCardSnapshot {
  const parsed = JSON.parse(row.cardJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored card snapshot ${row.id} is malformed.`);
  }

  return {
    id: row.id,
    conversationScopeId: row.conversationScopeId ?? undefined,
    requestId: row.requestId ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    tool: row.tool,
    card: parsed as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

function encodeRequestId(requestId: CardRequestId): string {
  return typeof requestId === "number" ? `n:${requestId}` : `s:${requestId}`;
}

function encodeOptionalRequestId(requestId: CardRequestId | undefined): string | undefined {
  return requestId === undefined ? undefined : encodeRequestId(requestId);
}
