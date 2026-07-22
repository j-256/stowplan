import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(origin, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Node server exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for the Node server\n${logs()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)).then(() => child.kill("SIGKILL")),
  ]);
}

async function assertStatus(response, expected) {
  if (response.status !== expected) {
    assert.fail(`Expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

const directory = await mkdtemp(join(tmpdir(), "stowplan-node-smoke-"));
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(process.execPath, ["scripts/node-server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AUTH_ADMIN_EMAILS: "owner@example.test",
    AUTH_BASE_URL: origin,
    AUTH_DEV_ENABLED: "true",
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: String(port),
    STOWPLAN_SQLITE_PATH: join(directory, "stowplan.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => { output = `${output}${chunk}`.slice(-12_000); });
}

try {
  const health = await waitForServer(origin, child, () => output);
  assert.deepEqual(await health.json().then(({ ok, storage }) => ({ ok, storage })), { ok: true, storage: "configured" });

  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(home.headers.get("x-content-type-options"), "nosniff");

  const login = await fetch(`${origin}/api/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "owner@example.test", name: "Smoke Owner" }),
  });
  await assertStatus(login, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^stowplan_session=/);
  const authenticatedHeaders = { cookie };

  const me = await fetch(`${origin}/api/auth/me`, { headers: authenticatedHeaders });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert.equal(identity.user.email, "owner@example.test");
  assert.equal(identity.user.globalRole, "admin");

  const timestamp = new Date().toISOString();
  const snapshot = {
    activities: [],
    audit: [],
    items: [],
    locations: [],
    plans: [],
    schemaVersion: 1,
    workspace: {
      createdAt: timestamp,
      id: "ws_smoke",
      name: "Smoke workspace",
      revision: 0,
      updatedAt: timestamp,
    },
  };
  const syncHeaders = { ...authenticatedHeaders, "content-type": "application/json", origin };
  const initialize = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: "ws_smoke", commands: [], snapshot }),
  });
  await assertStatus(initialize, 200);

  const command = {
    actorId: "smoke-user",
    baseRevision: 0,
    command: { type: "workspace.rename", name: "Renamed smoke workspace" },
    deviceId: "smoke-device",
    expectations: [{ id: "ws_smoke", path: "name", target: "workspace", value: "Smoke workspace" }],
    id: "cmd_smoke_rename",
    timestamp: new Date().toISOString(),
    workspaceId: "ws_smoke",
  };
  const apply = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: "ws_smoke", commands: [command] }),
  });
  await assertStatus(apply, 200);
  const applied = await apply.json();
  assert.equal(applied.receipts[0].status, "applied");
  assert.equal(applied.state.workspace.revision, 1);

  const replay = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: "ws_smoke", commands: [command] }),
  });
  await assertStatus(replay, 200);
  assert.equal((await replay.json()).receipts[0].status, "duplicate");

  const stored = await fetch(`${origin}/api/snapshot?workspaceId=ws_smoke`, { headers: authenticatedHeaders });
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(storedBody.state.workspace.name, "Renamed smoke workspace");
  assert.equal(storedBody.state.workspace.revision, 1);

  const restoreSnapshot = structuredClone(storedBody.state);
  restoreSnapshot.workspace.name = "Restored smoke workspace";
  const restore = await fetch(`${origin}/api/snapshot`, {
    method: "PUT",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: "ws_smoke", expectedRevision: 1, snapshot: restoreSnapshot }),
  });
  await assertStatus(restore, 200);
  const restored = await restore.json();
  assert.equal(restored.state.workspace.name, "Restored smoke workspace");
  assert.equal(restored.state.workspace.revision, 2);

  const admin = await fetch(`${origin}/api/admin/overview`, { headers: authenticatedHeaders });
  await assertStatus(admin, 200);
  const overview = await admin.json();
  assert.equal(overview.users.length, 1);
  assert.equal(overview.identities.length, 1);
  assert.equal(overview.memberships.length, 1);
  assert.equal(overview.sessions.length, 1);

  const createGuest = await fetch(`${origin}/api/admin/guest-links`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: "ws_smoke", role: "viewer", hours: 1 }),
  });
  await assertStatus(createGuest, 201);
  const guest = await createGuest.json();
  assert.equal(new URL(guest.url).origin, origin);
  const token = new URL(guest.url).pathname.split("/").at(-1);
  assert(token);

  const confirmation = await fetch(guest.url);
  await assertStatus(confirmation, 200);
  assert.match(await confirmation.text(), /Open the shared workspace/);
  const legacyGet = await fetch(`${origin}/api/auth/guest/${token}`, { redirect: "manual" });
  assert.equal(legacyGet.status, 302);
  assert.match(legacyGet.headers.get("location") ?? "", new RegExp(`/guest/${token}$`));

  const redeem = await fetch(`${origin}/api/auth/guest/${token}`, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  assert.equal(redeem.status, 302);
  const guestCookie = (redeem.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(guestCookie, /^stowplan_session=/);
  const guestSnapshot = await fetch(`${origin}/api/snapshot?workspaceId=ws_smoke`, { headers: { cookie: guestCookie } });
  await assertStatus(guestSnapshot, 200);
  const viewerRefresh = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: { cookie: guestCookie, "content-type": "application/json", origin },
    body: JSON.stringify({ workspaceId: "ws_smoke", commands: [] }),
  });
  await assertStatus(viewerRefresh, 200);
  const viewerWrite = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: { cookie: guestCookie, "content-type": "application/json", origin },
    body: JSON.stringify({ workspaceId: "ws_smoke", commands: [{ ...command, id: "cmd_viewer_denied", baseRevision: 1 }] }),
  });
  assert.equal(viewerWrite.status, 403);
  const replayGuest = await fetch(`${origin}/api/auth/guest/${token}`, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  assert.equal(replayGuest.status, 401);

  console.log("Node + SQLite smoke passed: health, headers, auth, sync, idempotency, restore, admin, viewer refresh, and scanner-safe guest links.");
} finally {
  await stop(child);
  await rm(directory, { recursive: true, force: true });
}
