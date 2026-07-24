import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MigrationStream = Object.freeze({
  NUMBERED: "numbered",
  SITES: "sites",
});

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

function captureOutput(child) {
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      output = `${output}${chunk}`.slice(-12_000);
    });
  }
  return () => output;
}

async function waitForExit(child, logs) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for the Node process to exit\n${logs()}`));
    }, 5_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function assertStatus(response, expected) {
  if (response.status !== expected) {
    assert.fail(`Expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

async function assertSitesMigrationStreamRefused(directory) {
  const databasePath = join(directory, "sites.sqlite");
  const sqlite = new DatabaseSync(databasePath);
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter(name => name.endsWith(".sql"))
    .sort();
  for (const migrationName of migrationNames) {
    sqlite.exec((await readFile(
      new URL(migrationName, migrationDirectory),
      "utf8",
    )).replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.close();

  const child = spawn(process.execPath, ["scripts/node-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      STOWPLAN_SQLITE_PATH: databasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = captureOutput(child);
  try {
    const result = await waitForExit(child, logs);
    assert.notEqual(result.code, 0);
    assert.match(
      logs(),
      /Refusing to use a Sites migration stream with the Node runtime/,
    );
  } finally {
    await stop(child);
  }

  const refusedDatabase = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(
      refusedDatabase.prepare(
        "SELECT id, stream FROM stowplan_migration_stream ORDER BY id",
      ).all().map(({ id, stream }) => ({ id, stream })),
      [{ id: 1, stream: MigrationStream.SITES }],
    );
    assert.equal(
      refusedDatabase.prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'stowplan_node_migrations'`,
      ).get(),
      undefined,
    );
  } finally {
    refusedDatabase.close();
  }
}

const directory = await mkdtemp(join(tmpdir(), "stowplan-node-smoke-"));
try {
  await assertSitesMigrationStreamRefused(directory);
} catch (error) {
  await rm(directory, { recursive: true, force: true });
  throw error;
}
const databasePath = join(directory, "stowplan.sqlite");
const legacyDatabase = new DatabaseSync(databasePath);
legacyDatabase.exec(await readFile(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8",
));
legacyDatabase.close();
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
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
    STOWPLAN_SQLITE_PATH: databasePath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = captureOutput(child);

try {
  const health = await waitForServer(origin, child, logs);
  assert.deepEqual(await health.json().then(({ ok, storage }) => ({ ok, storage })), { ok: true, storage: "configured" });
  const migratedDatabase = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(
      migratedDatabase.prepare(
        "SELECT id, stream FROM stowplan_migration_stream ORDER BY id",
      ).all().map(({ id, stream }) => ({ id, stream })),
      [{ id: 1, stream: MigrationStream.NUMBERED }],
    );
    const expectedMigrations = (await readdir(
      new URL("../migrations/", import.meta.url),
    )).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    assert.deepEqual(
      migratedDatabase.prepare(
        "SELECT name FROM stowplan_node_migrations ORDER BY name",
      ).all().map(({ name }) => name),
      expectedMigrations,
    );
  } finally {
    migratedDatabase.close();
  }

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
  assert.deepEqual(identity.providers, ["development"]);

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
    body: JSON.stringify({
      workspaceId: "ws_smoke",
      role: "viewer",
      hours: 1,
      returnTo: "/workspaces/ws_smoke/inventory",
    }),
  });
  await assertStatus(createGuest, 201);
  const guest = await createGuest.json();
  const guestUrl = new URL(guest.url);
  assert.equal(guestUrl.origin, origin);
  assert.equal(
    guestUrl.searchParams.get("returnTo"),
    "/workspaces/ws_smoke/inventory",
  );
  const token = guestUrl.pathname.split("/").at(-1);
  assert(token);

  const confirmation = await fetch(guest.url);
  await assertStatus(confirmation, 200);
  assert.match(await confirmation.text(), /Open the shared workspace/);
  const legacyGet = await fetch(`${origin}/api/auth/guest/${token}`, { redirect: "manual" });
  assert.equal(legacyGet.status, 302);
  assert.match(legacyGet.headers.get("location") ?? "", new RegExp(`/guest/${token}$`));

  const redeem = await fetch(
    `${origin}/api/auth/guest/${token}?returnTo=${encodeURIComponent("/workspaces/ws_smoke/inventory")}`,
    {
      method: "POST",
      headers: { origin },
      redirect: "manual",
    },
  );
  assert.equal(redeem.status, 302);
  assert.equal(
    redeem.headers.get("location"),
    `${origin}/workspaces/ws_smoke/inventory`,
  );
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

  console.log("Node + SQLite smoke passed: stream isolation, legacy migration, health, headers, auth, sync, idempotency, restore, admin, viewer refresh, and scanner-safe guest links.");
} finally {
  await stop(child);
  await rm(directory, { recursive: true, force: true });
}
