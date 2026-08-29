import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HttpRemoteCardStore,
  HybridCardStore,
  SqliteCardStore,
  type RemoteCardStore,
  type StoredCardSnapshot,
} from "./card-store.js";

test("card snapshots persist independently of widget lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-card-store-test-"));
  try {
    const first = new SqliteCardStore(root);
    const saved = first.save({
      conversationScopeId: "chat-1",
      workspaceId: "ws-1",
      tool: "show_changes",
      card: {
        tool: "show_changes",
        workspaceId: "ws-1",
        payload: { patch: "diff --git a/a b/a" },
      },
    });
    first.close();

    assert.equal(saved.card.cardId, saved.id);

    const reopened = new SqliteCardStore(root);
    try {
      assert.deepEqual(reopened.get(saved.id), saved);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("card snapshots are recoverable by conversation-scoped tool invocation id", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-card-invocation-test-"));
  try {
    const store = new SqliteCardStore(root);
    try {
      const numeric = store.save({
        conversationScopeId: "chat-1",
        requestId: 42,
        workspaceId: "ws-1",
        tool: "read",
        card: { tool: "read", path: "README.md" },
      });
      const string = store.save({
        conversationScopeId: "chat-1",
        requestId: "42",
        workspaceId: "ws-1",
        tool: "ls",
        card: { tool: "ls", path: "." },
      });
      store.save({
        conversationScopeId: "chat-2",
        requestId: 42,
        workspaceId: "ws-2",
        tool: "grep",
        card: { tool: "grep" },
      });

      assert.deepEqual(
        store.getByInvocation({ conversationScopeId: "chat-1", requestId: 42 }),
        numeric,
      );
      assert.deepEqual(
        store.getByInvocation({ conversationScopeId: "chat-1", requestId: "42" }),
        string,
      );
      assert.notEqual(
        store.getByInvocation({ conversationScopeId: "chat-2", requestId: 42 })?.id,
        numeric.id,
      );
      assert.equal(
        store.getByInvocation({ conversationScopeId: "chat-1", requestId: 7 }),
        undefined,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reused stateless request ids create distinct cards and restore the newest invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-card-reused-request-id-test-"));
  try {
    const store = new SqliteCardStore(root);
    try {
      const first = store.save({
        conversationScopeId: "chat-idempotent",
        requestId: "call-1",
        workspaceId: "ws-1",
        tool: "read",
        card: { tool: "read", path: "first.md" },
      });
      const second = store.save({
        conversationScopeId: "chat-idempotent",
        requestId: "call-1",
        workspaceId: "ws-1",
        tool: "read",
        card: { tool: "read", path: "second.md" },
      });

      assert.notEqual(second.id, first.id);
      assert.equal(first.card.cardId, first.id);
      assert.equal(second.card.cardId, second.id);
      assert.equal(second.card.path, "second.md");
      assert.deepEqual(
        store.getByInvocation({
          conversationScopeId: "chat-idempotent",
          requestId: "call-1",
        }),
        second,
      );
      assert.equal(store.get(first.id)?.card.path, "first.md");
      assert.equal(store.get(second.id)?.card.path, "second.md");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid card store mirrors saves and restores remote misses into sqlite", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-hybrid-card-store-test-"));
  const remoteRows = new Map<string, StoredCardSnapshot>();
  const remote: RemoteCardStore = {
    async save(snapshot) {
      remoteRows.set(snapshot.id, structuredClone(snapshot));
    },
    async get(id) {
      const snapshot = remoteRows.get(id);
      return snapshot ? structuredClone(snapshot) : undefined;
    },
  };

  try {
    const firstLocal = new SqliteCardStore(root);
    const first = new HybridCardStore(firstLocal, remote);
    const saved = await first.save({
      conversationScopeId: "chat-remote",
      workspaceId: "ws-remote",
      tool: "show_changes",
      card: { tool: "show_changes", payload: { patch: "remote diff" } },
    });
    assert.deepEqual(remoteRows.get(saved.id), saved);
    first.close();

    const emptyRoot = await mkdtemp(join(tmpdir(), "devspace-hybrid-card-store-empty-"));
    try {
      const secondLocal = new SqliteCardStore(emptyRoot);
      const second = new HybridCardStore(secondLocal, remote);
      assert.deepEqual(await second.get(saved.id), saved);
      assert.deepEqual(secondLocal.get(saved.id), saved);
      second.close();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid card store keeps local saves available when the remote store fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-hybrid-card-store-failure-"));
  const errors: string[] = [];
  const remote: RemoteCardStore = {
    async save() {
      throw new Error("remote unavailable");
    },
    async get() {
      throw new Error("remote unavailable");
    },
  };

  try {
    const local = new SqliteCardStore(root);
    const hybrid = new HybridCardStore(local, remote, {
      onRemoteError: ({ operation }) => errors.push(operation),
    });
    const saved = await hybrid.save({
      tool: "open_workspace",
      card: { tool: "open_workspace" },
    });
    assert.deepEqual(local.get(saved.id), saved);
    assert.deepEqual(errors, ["save"]);
    assert.equal(await hybrid.get("missing-card"), undefined);
    assert.deepEqual(errors, ["save", "get"]);
    hybrid.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("http remote card store authenticates requests and validates returned ids", async () => {
  const snapshot: StoredCardSnapshot = {
    id: "card-1",
    tool: "show_changes",
    card: { tool: "show_changes", cardId: "card-1" },
    createdAt: "2026-08-20T00:00:00.000Z",
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    return Response.json(snapshot);
  };
  const remote = new HttpRemoteCardStore({
    baseUrl: "https://cards.example.com/",
    token: "test-token-that-is-long-enough",
    fetch: request as typeof fetch,
  });

  await remote.save(snapshot);
  assert.deepEqual(await remote.get(snapshot.id), snapshot);
  assert.equal(requests[0]?.url, "https://cards.example.com/cards/card-1");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer test-token-that-is-long-enough");
});
