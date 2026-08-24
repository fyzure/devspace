import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";

const PROTOCOL_VERSION = "2025-06-18";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app/v2.html";

test("stateless MCP keeps resources readable after more than 32 fresh client initializations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-stateless-http-test-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  await mkdir(project);
  await ensureUiBuildFixture(t);

  const publicBaseUrl = "http://127.0.0.1:1";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: project,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
    DEVSPACE_LOG_LEVEL: "silent",
    DEVSPACE_WIDGETS: "changes",
    PORT: "1",
  });

  const token = "stateless-mcp-test-access-token";
  const oauthStore = new SqliteOAuthStore(stateDir);
  const oauthClient = oauthStore.registerClient(
    {
      client_name: "Stateless MCP Test",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    ["127.0.0.1"],
  );
  oauthStore.saveAccessToken(hashToken(token), {
    clientId: oauthClient.client_id,
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    resource: resourceUrlFromServerUrl(new URL("/mcp", publicBaseUrl)).href,
  });
  oauthStore.close();

  const running = createServer(config);
  const httpServer = await listen(running.app);
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  t.after(async () => {
    await close(httpServer);
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 40; index += 1) {
    const initialized = await postMcp(endpoint, token, {
      jsonrpc: "2.0",
      id: index * 2 + 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stateless-test", version: "1.0.0" },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get("mcp-session-id"), null);

    const acknowledged = await postMcp(
      endpoint,
      token,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      { "mcp-protocol-version": PROTOCOL_VERSION },
    );
    assert.equal(acknowledged.status, 202);

    const resource = await postMcp(
      endpoint,
      token,
      {
        jsonrpc: "2.0",
        id: index * 2 + 2,
        method: "resources/read",
        params: { uri: WORKSPACE_APP_URI },
      },
      {
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(index === 39 ? { "mcp-session-id": "legacy-stateful-session" } : {}),
      },
    );
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get("mcp-session-id"), null);
    const body = await resource.text();
    assert.match(body, /ui:\/\/devspace\/workspace-app\/v1\.html/);
    assert.match(body, /text\/html/);
  }
});

function postMcp(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function ensureUiBuildFixture(t: TestContext): Promise<void> {
  const uiRoot = join(process.cwd(), "dist", "ui");
  const manifestPath = join(uiRoot, ".vite", "manifest.json");
  if (existsSync(manifestPath)) return;

  const scriptPath = join(uiRoot, "assets", "workspace-app-stateless-test.js");
  const stylesheetPath = join(uiRoot, "assets", "workspace-app-stateless-test.css");
  await mkdir(join(uiRoot, ".vite"), { recursive: true });
  await mkdir(join(uiRoot, "assets"), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      "workspace-app.html": {
        file: "assets/workspace-app-stateless-test.js",
        css: ["assets/workspace-app-stateless-test.css"],
      },
    }),
  );
  await writeFile(scriptPath, "export {};\n");
  await writeFile(stylesheetPath, "/* stateless MCP test fixture */\n");

  t.after(async () => {
    await rm(manifestPath, { force: true });
    await rm(scriptPath, { force: true });
    await rm(stylesheetPath, { force: true });
  });
}

function listen(app: ReturnType<typeof createServer>["app"]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
