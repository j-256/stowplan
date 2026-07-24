import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const origin = "http://127.0.0.1:3000";
let output = "";

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next dev exited early (${child.exitCode})\n${output}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response;
    } catch {
      // Compilation or the listener may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for Next dev\n${output}`);
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
  console.log("OpenNext development bindings are healthy; exercising admin authentication…");
  assert.deepEqual(await health.json().then(({ ok, storage }) => ({ ok, storage })), { ok: true, storage: "configured" });

  const login = await fetch(`${origin}/api/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "owner@example.test", name: "Next Dev Owner" }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^stowplan_session=/);

  const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert.equal(identity.user.globalRole, "admin");
  assert.deepEqual(identity.providers, ["development"]);

  const admin = await fetch(`${origin}/api/admin/overview`, { headers: { cookie } });
  assert.equal(admin.status, 200, await admin.clone().text());
  const overview = await admin.json();
  assert(overview.users.some(user => user.email === "owner@example.test"));

  const timestamp = new Date().toISOString();
  const workspaceId = "ws_next_d1_smoke";
  const syncHeaders = {
    "content-type": "application/json",
    cookie,
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
          name: "Next D1 smoke",
          revision: 0,
          updatedAt: timestamp,
        },
      },
      workspaceId,
    }),
  });
  assert.equal(initialize.status, 200, await initialize.clone().text());

  const guestLink = await fetch(`${origin}/api/admin/guest-links`, {
    method: "POST",
    headers: syncHeaders,
    body: JSON.stringify({
      hours: 1,
      returnTo: `/workspaces/${workspaceId}/inventory`,
      role: "viewer",
      workspaceId,
    }),
  });
  assert.equal(guestLink.status, 201, await guestLink.clone().text());
  const guestUrl = new URL((await guestLink.json()).url);
  const guestToken = guestUrl.pathname.slice("/guest/".length);
  assert(guestToken);
  const redeem = await fetch(
    `${origin}/api/auth/guest/${encodeURIComponent(guestToken)}`,
    {
      method: "POST",
      headers: { origin },
      redirect: "manual",
    },
  );
  assert.equal(redeem.status, 302, await redeem.clone().text());
  const guestCookie = (redeem.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(guestCookie, /^stowplan_session=/);
  const guestSnapshot = await fetch(
    `${origin}/api/snapshot?workspaceId=${workspaceId}`,
    { headers: { cookie: guestCookie } },
  );
  assert.equal(guestSnapshot.status, 200, await guestSnapshot.clone().text());
  const replay = await fetch(
    `${origin}/api/auth/guest/${encodeURIComponent(guestToken)}`,
    {
      method: "POST",
      headers: { origin },
      redirect: "manual",
    },
  );
  assert.equal(replay.status, 401);

  const page = await fetch(`${origin}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stowplan administration/);
  console.log("Next dev + local D1 smoke passed: bindings, development login, guest redemption, admin authorization, and control-panel route.");
} finally {
  await stop(child);
}
