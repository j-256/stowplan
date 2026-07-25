import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { GUEST_LINK_EXPIRY_HOURS } from "../src/shared/quotas.js";

const MigrationStream = Object.freeze({
  NUMBERED: "numbered",
  SITES: "sites",
});
const WORKSPACE_ID = "ws_smoke";
const WORKSPACE_NAME = "Smoke workspace";
const RESTORED_WORKSPACE_NAME = "Restored smoke workspace";
const WORKSPACE_RETURN_TO = `/workspaces/${WORKSPACE_ID}/inventory`;
const ACCOUNT_CONTEXT_HEADER = "x-stowplan-account-id";

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
    const body = await response.clone().json().catch(() => null);
    const code = body && typeof body === "object" && typeof body.code === "string"
      ? ` ${body.code}`
      : "";
    const error = body && typeof body === "object" && typeof body.error === "string"
      ? `: ${body.error}`
      : "";
    assert.fail(`Expected HTTP ${expected}, received ${response.status}${code}${error}`);
  }
}

function assertAccountContext(response, accountId) {
  assert.equal(
    response.headers.get(ACCOUNT_CONTEXT_HEADER),
    accountId,
  );
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
  const sessionHeaders = { cookie };

  const me = await fetch(`${origin}/api/auth/me`, { headers: sessionHeaders });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert.equal(identity.user.email, "owner@example.test");
  assert.equal(identity.user.globalRole, "admin");
  assert.deepEqual(identity.providers, ["development"]);
  const ownerAccountId = identity.user.userId;
  assert(ownerAccountId);
  const authenticatedHeaders = {
    ...sessionHeaders,
    [ACCOUNT_CONTEXT_HEADER]: ownerAccountId,
  };

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
      id: WORKSPACE_ID,
      name: WORKSPACE_NAME,
      revision: 0,
      updatedAt: timestamp,
    },
  };
  const syncHeaders = { ...authenticatedHeaders, "content-type": "application/json", origin };
  const initialize = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, commands: [], snapshot }),
  });
  await assertStatus(initialize, 200);
  assertAccountContext(initialize, ownerAccountId);
  const initialized = await initialize.json();
  assert.equal(initialized.authorization.role, "owner");
  assert.equal(initialized.authorization.capabilities.manageAccess, true);

  const command = {
    actorId: "smoke-user",
    baseRevision: 0,
    command: { type: "workspace.rename", name: "Renamed smoke workspace" },
    deviceId: "smoke-device",
    expectations: [{ id: WORKSPACE_ID, path: "name", target: "workspace", value: WORKSPACE_NAME }],
    id: "cmd_smoke_rename",
    timestamp: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
  };
  const apply = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, commands: [command] }),
  });
  await assertStatus(apply, 200);
  assertAccountContext(apply, ownerAccountId);
  const applied = await apply.json();
  assert.equal(applied.receipts[0].status, "applied");
  assert.equal(applied.state.workspace.revision, 1);

  const replay = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, commands: [command] }),
  });
  await assertStatus(replay, 200);
  assertAccountContext(replay, ownerAccountId);
  assert.equal((await replay.json()).receipts[0].status, "duplicate");

  const stored = await fetch(
    `${origin}/api/snapshot?workspaceId=${encodeURIComponent(WORKSPACE_ID)}`,
    { headers: authenticatedHeaders },
  );
  assert.equal(stored.status, 200);
  assertAccountContext(stored, ownerAccountId);
  const storedBody = await stored.json();
  assert.equal(storedBody.state.workspace.name, "Renamed smoke workspace");
  assert.equal(storedBody.state.workspace.revision, 1);

  const restoreSnapshot = structuredClone(storedBody.state);
  restoreSnapshot.workspace.name = RESTORED_WORKSPACE_NAME;
  const restore = await fetch(`${origin}/api/snapshot`, {
    method: "PUT",
    headers: syncHeaders,
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, expectedRevision: 1, snapshot: restoreSnapshot }),
  });
  await assertStatus(restore, 200);
  assertAccountContext(restore, ownerAccountId);
  const restored = await restore.json();
  assert.equal(restored.state.workspace.name, RESTORED_WORKSPACE_NAME);
  assert.equal(restored.state.workspace.revision, 2);

  const catalogResponse = await fetch(
    `${origin}/api/workspaces?limit=1&q=smoke&role=owner`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(catalogResponse, 200);
  assertAccountContext(catalogResponse, ownerAccountId);
  assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
  const catalog = await catalogResponse.json();
  assert.deepEqual(
    {
      hasMore: catalog.page.hasMore,
      nextCursor: catalog.page.nextCursor,
      role: catalog.workspaces[0]?.role,
      workspaceId: catalog.workspaces[0]?.id,
    },
    {
      hasMore: false,
      nextCursor: null,
      role: "owner",
      workspaceId: WORKSPACE_ID,
    },
  );
  const discoveredWorkspaceId = catalog.workspaces[0].id;
  assert.equal(catalog.workspaces[0].name, RESTORED_WORKSPACE_NAME);
  assert.equal(catalog.workspaces[0].capabilities.leave, false);

  const ownerAccessResponse = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}/access`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(ownerAccessResponse, 200);
  assertAccountContext(ownerAccessResponse, ownerAccountId);
  assert.equal(ownerAccessResponse.headers.get("cache-control"), "no-store");
  const ownerAccess = await ownerAccessResponse.json();
  assert.equal(ownerAccess.access.role, "owner");
  assert.equal(ownerAccess.access.capabilities.delete, true);
  assert.equal(ownerAccess.access.capabilities.manageAccess, true);
  assert.equal(
    ownerAccess.guestLinkPolicy.minimumExpiryHours,
    GUEST_LINK_EXPIRY_HOURS.minimum,
  );

  const admin = await fetch(`${origin}/api/admin/overview`, { headers: authenticatedHeaders });
  await assertStatus(admin, 200);
  const overview = await admin.json();
  assert.equal(overview.users.length, 1);
  assert.equal(overview.identities.length, 1);
  assert.equal(overview.memberships.length, 1);
  assert.equal(overview.sessions.length, 1);

  const createInvite = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}/guest-links`,
    {
      method: "POST",
      headers: syncHeaders,
      body: JSON.stringify({
        expectedAccessRevision: ownerAccess.access.accessRevision,
        expiresInHours: 2,
        role: "viewer",
        returnTo: WORKSPACE_RETURN_TO,
      }),
    },
  );
  await assertStatus(createInvite, 201);
  assertAccountContext(createInvite, ownerAccountId);
  const invite = await createInvite.json();
  assert.equal(invite.guestLink.role, "viewer");
  assert.equal(invite.guestLink.status, "active");
  const guestUrl = new URL(invite.oneTimeUrl);
  assert.equal(guestUrl.origin, origin);
  assert.equal(
    guestUrl.searchParams.get("returnTo"),
    WORKSPACE_RETURN_TO,
  );
  const token = guestUrl.pathname.split("/").at(-1);
  assert(token);

  const confirmation = await fetch(guestUrl);
  await assertStatus(confirmation, 200);
  assert.match(await confirmation.text(), /Open the shared workspace/);
  const legacyGet = await fetch(`${origin}/api/auth/guest/${token}`, { redirect: "manual" });
  assert.equal(legacyGet.status, 302);
  const legacyLocation = new URL(
    legacyGet.headers.get("location") ?? "/",
    origin,
  );
  assert.equal(legacyLocation.pathname.split("/").at(-1) === token, true);

  const viewerLogin = await fetch(`${origin}/api/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: "viewer@example.test",
      name: "Smoke Viewer",
    }),
  });
  await assertStatus(viewerLogin, 200);
  const viewerCookie = (
    viewerLogin.headers.get("set-cookie") ?? ""
  ).split(";")[0];
  assert.match(viewerCookie, /^stowplan_session=/);
  const viewerMe = await fetch(`${origin}/api/auth/me`, {
    headers: { cookie: viewerCookie },
  });
  await assertStatus(viewerMe, 200);
  const viewerIdentity = await viewerMe.json();
  const viewerAccountId = viewerIdentity.user.userId;
  assert(viewerAccountId);
  const viewerHeaders = {
    [ACCOUNT_CONTEXT_HEADER]: viewerAccountId,
    cookie: viewerCookie,
  };
  const viewerSyncHeaders = {
    ...viewerHeaders,
    "content-type": "application/json",
    origin,
  };
  const redeem = await fetch(
    `${origin}/api/auth/guest/${token}?returnTo=${encodeURIComponent(WORKSPACE_RETURN_TO)}`,
    {
      body: new URLSearchParams({
        expectedAccountId: viewerAccountId,
      }),
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: viewerCookie,
        origin,
      },
      redirect: "manual",
    },
  );
  assert.equal(redeem.status, 303);
  assert.equal(
    redeem.headers.get("location"),
    `${origin}${WORKSPACE_RETURN_TO}`,
  );
  assert.equal(redeem.headers.get("set-cookie"), null);
  const guestSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${encodeURIComponent(discoveredWorkspaceId)}`,
    { headers: viewerHeaders },
  );
  await assertStatus(guestSnapshot, 200);
  assertAccountContext(guestSnapshot, viewerAccountId);
  const viewerCatalogResponse = await fetch(
    `${origin}/api/workspaces?limit=50`,
    { headers: viewerHeaders },
  );
  await assertStatus(viewerCatalogResponse, 200);
  assertAccountContext(viewerCatalogResponse, viewerAccountId);
  const viewerCatalog = await viewerCatalogResponse.json();
  const viewerWorkspace = viewerCatalog.workspaces.find(
    workspace => workspace.id === discoveredWorkspaceId,
  );
  assert.equal(viewerWorkspace.role, "viewer");
  assert.equal(viewerWorkspace.capabilities.write, false);
  assert.equal(viewerWorkspace.capabilities.manageAccess, false);
  const viewerRefresh = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: viewerSyncHeaders,
    body: JSON.stringify({ workspaceId: discoveredWorkspaceId, commands: [] }),
  });
  await assertStatus(viewerRefresh, 200);
  assertAccountContext(viewerRefresh, viewerAccountId);
  const viewerWrite = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: viewerSyncHeaders,
    body: JSON.stringify({
      workspaceId: discoveredWorkspaceId,
      commands: [{
        ...command,
        baseRevision: restored.state.workspace.revision,
        id: "cmd_viewer_denied",
      }],
    }),
  });
  assert.equal(viewerWrite.status, 403);
  assertAccountContext(viewerWrite, viewerAccountId);
  const viewerWriteProblem = await viewerWrite.json();
  assert.equal(viewerWriteProblem.code, "WRITE_ACCESS_REQUIRED");
  assert.equal(viewerWriteProblem.receipts[0].status, "rejected");

  const viewerDelete = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}`,
    {
      method: "DELETE",
      headers: viewerSyncHeaders,
      body: JSON.stringify({
        confirmationName: RESTORED_WORKSPACE_NAME,
        expectedAccessRevision: viewerWorkspace.accessRevision,
        expectedMembershipRevision: viewerWorkspace.membershipRevision,
        expectedRevision: viewerWorkspace.revision,
      }),
    },
  );
  assert.equal(viewerDelete.status, 403);
  assert.equal((await viewerDelete.json()).code, "OWNER_REQUIRED");

  const replayGuest = await fetch(`${origin}/api/auth/guest/${token}`, {
    body: new URLSearchParams({
      expectedAccountId: viewerAccountId,
    }),
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: viewerCookie,
      origin,
    },
    redirect: "manual",
  });
  assert.equal(replayGuest.status, 409);

  const latestAccessResponse = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}/access`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(latestAccessResponse, 200);
  assertAccountContext(latestAccessResponse, ownerAccountId);
  const latestAccess = await latestAccessResponse.json();
  assert.equal(latestAccess.access.capabilities.leave, false);

  const finalOwnerLeave = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}/membership`,
    {
      method: "DELETE",
      headers: syncHeaders,
      body: JSON.stringify({
        expectedAccessRevision: latestAccess.access.accessRevision,
        expectedMembershipRevision:
          latestAccess.access.membershipRevision,
      }),
    },
  );
  assert.equal(finalOwnerLeave.status, 409);
  assert.equal((await finalOwnerLeave.json()).code, "FINAL_OWNER_REQUIRED");

  const incompleteDelete = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}`,
    {
      method: "DELETE",
      headers: syncHeaders,
      body: JSON.stringify({
        confirmationName: "Not the workspace name",
        expectedAccessRevision: latestAccess.access.accessRevision,
        expectedMembershipRevision:
          latestAccess.access.membershipRevision,
        expectedRevision: latestAccess.workspace.revision,
      }),
    },
  );
  assert.equal(incompleteDelete.status, 409);
  assert.equal((await incompleteDelete.json()).code, "CONFIRMATION_REQUIRED");

  const removeOnlineSave = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}`,
    {
      method: "DELETE",
      headers: syncHeaders,
      body: JSON.stringify({
        confirmationName: latestAccess.workspace.name,
        expectedAccessRevision: latestAccess.access.accessRevision,
        expectedMembershipRevision:
          latestAccess.access.membershipRevision,
        expectedRevision: latestAccess.workspace.revision,
      }),
    },
  );
  await assertStatus(removeOnlineSave, 200);
  assertAccountContext(removeOnlineSave, ownerAccountId);
  const deletion = await removeOnlineSave.json();
  assert.equal(deletion.deleted, true);
  assert.equal(deletion.localReplicaDispositionRequired, true);
  assert.equal(deletion.recovery, "not_available");
  assert.equal(deletion.workspaceId, discoveredWorkspaceId);

  const repeatedDelete = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspaceId)}`,
    {
      method: "DELETE",
      headers: syncHeaders,
      body: JSON.stringify({
        confirmationName: latestAccess.workspace.name,
        expectedAccessRevision: latestAccess.access.accessRevision,
        expectedMembershipRevision:
          latestAccess.access.membershipRevision,
        expectedRevision: latestAccess.workspace.revision,
      }),
    },
  );
  assert.equal(repeatedDelete.status, 410);
  assert.equal((await repeatedDelete.json()).code, "WORKSPACE_DELETED");

  const afterDeletionCatalog = await fetch(
    `${origin}/api/workspaces?limit=1&q=smoke`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(afterDeletionCatalog, 200);
  assertAccountContext(afterDeletionCatalog, ownerAccountId);
  assert.deepEqual((await afterDeletionCatalog.json()).workspaces, []);

  const deletedSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${encodeURIComponent(discoveredWorkspaceId)}`,
    { headers: authenticatedHeaders },
  );
  assert.equal(deletedSnapshot.status, 404);
  assert.equal(
    (await deletedSnapshot.json()).code,
    "NOT_FOUND_OR_INACCESSIBLE",
  );

  const revokedGuestSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${encodeURIComponent(discoveredWorkspaceId)}`,
    { headers: viewerHeaders },
  );
  assert.equal(revokedGuestSnapshot.status, 404);

  console.log("Node + SQLite smoke passed: stream isolation, legacy migration, member discovery, owner access, sync, restore, admin visibility, viewer forgery rejection, scanner-safe invite enrollment, final-owner leave refusal, and guarded online deletion.");
} finally {
  await stop(child);
  await rm(directory, { recursive: true, force: true });
}
