import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { GUEST_LINK_EXPIRY_HOURS } from "../src/shared/quotas.js";

const origin = "http://127.0.0.1:3000";
const workspaceId = `ws_next_d1_smoke_${process.pid}`;
const workspaceName = `Next D1 smoke ${process.pid}`;
const workspaceReturnTo = `/workspaces/${workspaceId}/inventory`;
const accountContextHeader = "x-stowplan-account-id";
let output = "";

function safeOutput(value) {
  return value
    .replace(
      /(\/(?:api\/auth\/)?guest\/)[A-Za-z0-9_-]+/gu,
      "$1[redacted]",
    )
    .replace(
      /(stowplan_session=)[^;\s]+/gu,
      "$1[redacted]",
    );
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
    response.headers.get(accountContextHeader),
    accountId,
  );
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Next dev exited early (${child.exitCode})\n${safeOutput(output)}`,
      );
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response;
    } catch {
      // Compilation or the listener may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for Next dev\n${safeOutput(output)}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)).then(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }),
  ]);
}

console.log("Applying local D1 migrations…");
const migration = spawnSync("bash", [
  "scripts/sites-env.sh",
  "--",
  "./node_modules/.bin/wrangler",
  "d1",
  "migrations",
  "apply",
  "stowplan",
  "--local",
  "--config",
  "wrangler.jsonc",
], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
});
if (migration.status !== 0) {
  throw new Error(`Local D1 migration failed (${migration.status ?? "no status"})\n${migration.stdout}${migration.stderr}`);
}

console.log("Starting Next development server with OpenNext bindings…");
const child = spawn("bash", ["scripts/sites-env.sh", "--", "./node_modules/.bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3000"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AUTH_ADMIN_EMAILS: "owner@example.test",
    AUTH_BASE_URL: origin,
    AUTH_DEV_ENABLED: "true",
  },
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => { output = `${output}${chunk}`.slice(-16_000); });
}

try {
  const health = await waitForServer(child);
  console.log("OpenNext development bindings are healthy; exercising member access…");
  assert.deepEqual(await health.json().then(({ ok, storage }) => ({ ok, storage })), { ok: true, storage: "configured" });

  const login = await fetch(`${origin}/api/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "owner@example.test", name: "Next Dev Owner" }),
  });
  await assertStatus(login, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^stowplan_session=/);

  const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert.equal(identity.user.globalRole, "admin");
  assert.deepEqual(identity.providers, ["development"]);
  const ownerAccountId = identity.user.userId;
  assert(ownerAccountId);
  const authenticatedHeaders = {
    [accountContextHeader]: ownerAccountId,
    cookie,
  };

  const admin = await fetch(`${origin}/api/admin/overview`, {
    headers: authenticatedHeaders,
  });
  assert.equal(admin.status, 200, await admin.clone().text());
  const overview = await admin.json();
  assert(overview.users.some(user => user.email === "owner@example.test"));

  const timestamp = new Date().toISOString();
  const syncHeaders = {
    ...authenticatedHeaders,
    "content-type": "application/json",
    origin,
  };
  const initialize = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({
      commands: [],
      snapshot: {
        activities: [],
        audit: [],
        items: [],
        locations: [],
        plans: [],
        schemaVersion: 1,
        workspace: {
          createdAt: timestamp,
          id: workspaceId,
          name: workspaceName,
          revision: 0,
          updatedAt: timestamp,
        },
      },
      workspaceId,
    }),
  });
  await assertStatus(initialize, 200);
  assertAccountContext(initialize, ownerAccountId);
  const initialized = await initialize.json();
  assert.equal(initialized.authorization.role, "owner");
  assert.equal(initialized.authorization.capabilities.manageAccess, true);

  const catalogResponse = await fetch(
    `${origin}/api/workspaces?limit=50&q=${encodeURIComponent(workspaceName)}`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(catalogResponse, 200);
  assertAccountContext(catalogResponse, ownerAccountId);
  assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
  const catalog = await catalogResponse.json();
  assert.equal(catalog.page.hasMore, false);
  const discoveredWorkspace = catalog.workspaces.find(
    workspace => workspace.name === workspaceName,
  );
  assert.equal(discoveredWorkspace.id, workspaceId);
  assert.equal(discoveredWorkspace.role, "owner");
  assert.equal(discoveredWorkspace.capabilities.leave, false);

  const ownerAccessResponse = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}/access`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(ownerAccessResponse, 200);
  assertAccountContext(ownerAccessResponse, ownerAccountId);
  const ownerAccess = await ownerAccessResponse.json();
  assert.equal(ownerAccess.access.role, "owner");
  assert.equal(ownerAccess.access.capabilities.delete, true);
  assert.equal(
    ownerAccess.guestLinkPolicy.maximumExpiryHours,
    GUEST_LINK_EXPIRY_HOURS.maximum,
  );

  const inviteLink = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}/guest-links`,
    {
      method: "POST",
      headers: syncHeaders,
      body: JSON.stringify({
        expectedAccessRevision: ownerAccess.access.accessRevision,
        expiresInHours: 3,
        returnTo: workspaceReturnTo,
        role: "viewer",
      }),
    },
  );
  await assertStatus(inviteLink, 201);
  assertAccountContext(inviteLink, ownerAccountId);
  const invite = await inviteLink.json();
  assert.equal(invite.guestLink.role, "viewer");
  assert.equal(invite.guestLink.status, "active");
  const guestUrl = new URL(invite.oneTimeUrl);
  assert.equal(guestUrl.origin, origin);
  assert.equal(guestUrl.searchParams.get("returnTo"), workspaceReturnTo);
  const guestToken = guestUrl.pathname.slice("/guest/".length);
  assert(guestToken);
  const confirmation = await fetch(guestUrl);
  await assertStatus(confirmation, 200);
  assert.match(await confirmation.text(), /Open the shared workspace/);

  const viewerLogin = await fetch(`${origin}/api/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: "viewer@example.test",
      name: "Next Dev Viewer",
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
    [accountContextHeader]: viewerAccountId,
    cookie: viewerCookie,
  };
  const viewerSyncHeaders = {
    ...viewerHeaders,
    "content-type": "application/json",
    origin,
  };
  const redeem = await fetch(
    `${origin}/api/auth/guest/${encodeURIComponent(guestToken)}?returnTo=${encodeURIComponent(workspaceReturnTo)}`,
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
  assert.equal(redeem.headers.get("location"), `${origin}${workspaceReturnTo}`);
  assert.equal(redeem.headers.get("set-cookie"), null);
  const guestSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${workspaceId}`,
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
    workspace => workspace.id === discoveredWorkspace.id,
  );
  assert.equal(viewerWorkspace.role, "viewer");
  assert.equal(viewerWorkspace.capabilities.write, false);
  assert.equal(viewerWorkspace.capabilities.manageAccess, false);

  const forgedCommand = {
    actorId: "forged-viewer",
    baseRevision: discoveredWorkspace.revision,
    command: {
      name: "Viewer mutation must fail",
      type: "workspace.rename",
    },
    deviceId: "next-d1-smoke-viewer",
    expectations: [{
      id: discoveredWorkspace.id,
      path: "name",
      target: "workspace",
      value: workspaceName,
    }],
    id: `cmd_viewer_denied_${process.pid}`,
    timestamp: new Date().toISOString(),
    workspaceId: discoveredWorkspace.id,
  };
  const viewerWrite = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: viewerSyncHeaders,
    body: JSON.stringify({
      commands: [forgedCommand],
      workspaceId: discoveredWorkspace.id,
    }),
  });
  assert.equal(viewerWrite.status, 403);
  assertAccountContext(viewerWrite, viewerAccountId);
  const viewerWriteProblem = await viewerWrite.json();
  assert.equal(viewerWriteProblem.code, "WRITE_ACCESS_REQUIRED");
  assert.equal(viewerWriteProblem.receipts[0].status, "rejected");

  const viewerDelete = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}`,
    {
      method: "DELETE",
      headers: viewerSyncHeaders,
      body: JSON.stringify({
        confirmationName: workspaceName,
        expectedAccessRevision: viewerWorkspace.accessRevision,
        expectedMembershipRevision: viewerWorkspace.membershipRevision,
        expectedRevision: viewerWorkspace.revision,
      }),
    },
  );
  assert.equal(viewerDelete.status, 403);
  assert.equal((await viewerDelete.json()).code, "OWNER_REQUIRED");

  const replay = await fetch(
    `${origin}/api/auth/guest/${encodeURIComponent(guestToken)}`,
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
  assert.equal(replay.status, 409);

  const latestAccessResponse = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}/access`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(latestAccessResponse, 200);
  assertAccountContext(latestAccessResponse, ownerAccountId);
  const latestAccess = await latestAccessResponse.json();
  assert.equal(latestAccess.access.capabilities.leave, false);

  const finalOwnerLeave = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}/membership`,
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

  const removeOnlineSave = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}`,
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

  const repeatedDelete = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(discoveredWorkspace.id)}`,
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
    `${origin}/api/workspaces?limit=50&q=${encodeURIComponent(workspaceName)}`,
    { headers: authenticatedHeaders },
  );
  await assertStatus(afterDeletionCatalog, 200);
  assertAccountContext(afterDeletionCatalog, ownerAccountId);
  assert.deepEqual((await afterDeletionCatalog.json()).workspaces, []);

  const deletedSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${encodeURIComponent(discoveredWorkspace.id)}`,
    { headers: authenticatedHeaders },
  );
  assert.equal(deletedSnapshot.status, 404);
  assert.equal(
    (await deletedSnapshot.json()).code,
    "NOT_FOUND_OR_INACCESSIBLE",
  );

  const revokedGuestSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${encodeURIComponent(discoveredWorkspace.id)}`,
    { headers: viewerHeaders },
  );
  assert.equal(revokedGuestSnapshot.status, 404);

  const page = await fetch(`${origin}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stowplan administration/);
  console.log("Next dev + local D1 smoke passed: bindings, development login, member discovery, owner access, viewer forgery rejection, scanner-safe invite enrollment, final-owner leave refusal, guarded online deletion, and the control-panel route.");
} finally {
  await stop(child);
}
