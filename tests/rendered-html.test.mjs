import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(prefix, entry.name);
    return entry.isDirectory()
      ? filesBelow(join(directory, entry.name), relativePath)
      : [relativePath];
  }).sort();
}

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(await response.text(), developmentPreviewMeta);
});

test("renders canonical workspace view routes", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("workspace-route-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request(
      "http://localhost/workspaces/ws_example/inventory/items/item_example",
      { headers: { accept: "text/html" } },
    ),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("renders the direct kitchen demo route", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("demo-route-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/demo", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("passes the Sites D1 binding from the Worker environment to server routes", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("sites-binding-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const runtimeGlobal = globalThis;
  let schemaProbed = false;

  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/health"),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
        DB: {
          prepare(query) {
            assert.match(query, /workspace_snapshots/);
            schemaProbed = true;
            return {
              first: async () => ({ has_snapshots: 0 }),
            };
          },
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.schema, "ready");
    assert.equal(body.storage, "configured");
    assert.match(body.time, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(schemaProbed, true);
  } finally {
    delete runtimeGlobal.__STOWPLAN_ENV;
  }
});

test("keeps private APIs out of the service-worker cache and ships install icons", () => {
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/assets\/"\)/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /url\.pathname === "\/demo"/);
  assert.match(worker, /url\.pathname\.startsWith\("\/workspaces\/"\)/);
  assert.match(worker, /caches\.match\("\/"\)/);
  assert.match(worker, /event\.waitUntil\(installShell\(\)/);
  assert.match(worker, /cache\.put\(cacheKey, response\.clone\(\)\)/);
  assert.match(worker, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(worker, /"\/docs\/"/);
  assert.match(worker, /"\/demo"/);
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.deepEqual(manifest.icons.slice(0, 2).map((icon) => icon.sizes), ["192x192", "512x512"]);
});

test("does not mix App Router payloads with cached HTML or block responses on cache writes", async () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = {};
  let finishCacheWrite;
  const pendingCacheWrite = new Promise((resolve) => { finishCacheWrite = resolve; });
  const writes = [];
  const cache = {
    addAll: async () => undefined,
    match: async () => null,
    put: async (key) => {
      writes.push(key);
      await pendingCacheWrite;
    },
  };
  const caches = {
    delete: async () => true,
    keys: async () => [],
    match: async () => null,
    open: async () => cache,
  };
  const self = {
    addEventListener(type, listener) { listeners[type] = listener; },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
  };
  runInNewContext(source, {
    URL,
    Request,
    Response,
    Set,
    caches,
    fetch: async () => new Response("<html>shell</html>", {
      headers: { "content-type": "text/html" },
    }),
    location: { origin: "https://stowplan.test" },
    self,
  });

  let rscIntercepted = false;
  listeners.fetch({
    request: {
      method: "GET",
      mode: "cors",
      url: "https://stowplan.test/docs?_rsc=payload",
    },
    respondWith() { rscIntercepted = true; },
    waitUntil() {},
  });
  assert.equal(rscIntercepted, false);

  let responsePromise;
  const background = [];
  listeners.fetch({
    request: {
      method: "GET",
      mode: "navigate",
      url: "https://stowplan.test/docs",
    },
    respondWith(value) { responsePromise = value; },
    waitUntil(value) { background.push(value); },
  });
  const response = await responsePromise;
  assert.equal(await response.text(), "<html>shell</html>");
  assert.deepEqual(writes, ["/docs"]);
  assert.equal(background.length, 1);
  finishCacheWrite();
  await Promise.all(background);
});

test("marks API responses as private across missing-configuration paths", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("api-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/auth/me"),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("initializes OpenNext bindings for next dev and awaits runtime context failures", () => {
  const hosting = JSON.parse(
    readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  );
  assert.equal(hosting.d1, "DB");
  const packagedHosting = JSON.parse(
    readFileSync(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"),
  );
  assert.equal(packagedHosting.d1, "DB");
  const sourceMigrationDirectory = fileURLToPath(
    new URL("../drizzle/", import.meta.url),
  );
  const packagedMigrationDirectory = fileURLToPath(
    new URL("../dist/.openai/drizzle/", import.meta.url),
  );
  const sourceMigrations = filesBelow(sourceMigrationDirectory)
    .filter((name) => !name.endsWith(".DS_Store"));
  const packagedMigrations = filesBelow(packagedMigrationDirectory);
  assert.ok(sourceMigrations.some((name) => name.endsWith(".sql")));
  assert.equal(packagedMigrations.includes(".DS_Store"), false);
  assert.deepEqual(packagedMigrations, sourceMigrations);
  for (const migration of sourceMigrations) {
    assert.deepEqual(
      readFileSync(join(packagedMigrationDirectory, migration)),
      readFileSync(join(sourceMigrationDirectory, migration)),
    );
  }
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /initOpenNextCloudflareForDev\(/);
  assert.match(config, /STOWPLAN_WRANGLER_PERSIST_PATH/);
  assert.match(config, /persist: \{ path: localPersistencePath \}/);
  const runtime = readFileSync(new URL("../src/server/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /await getCloudflareContext\(\{ async: true \}\)/);
});

test("keeps hierarchy and touch drag affordances in the shipped organizer", () => {
  const application = readFileSync(new URL("../src/client/stowplan-app.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(application, /aria-label="Space hierarchy"/);
  assert.match(application, /to move or nest it/);
  assert.match(application, /const handlePointerDown/);
  assert.match(application, /onPointerDown: handlePointerDown/);
  assert.match(application, /activePointerId\.current = event\.pointerId/);
  assert.match(application, /"before" \| "inside" \| "after"/);
  assert.match(application, /function locationPlacementForDrop/);
  assert.match(application, /function useHierarchyChanges/);
  assert.match(application, /data-collapsible="true"/);
  assert.match(application, /<span \{\.\.\.sharedProps\} aria-hidden="true">/);
  assert.match(application, /className="capture-root-drop"/);
  assert.match(
    application,
    /const canReorder = Boolean\(locationFilter\) &&\s+!query\.trim\(\) &&\s+!filteredCaptureComplete/,
  );
  assert.match(
    application,
    /event\.currentTarget\.closest<HTMLElement>\("\.capture-tree"\)/,
  );
  assert.match(
    application,
    /event\.currentTarget\.closest<HTMLElement>\("\.app-shell > main"\)/,
  );
  assert.match(
    application,
    /candidate\.scrollHeight <= candidate\.clientHeight/,
  );
  assert.match(application, /activeSubmitControl\.focus\(\)/);
  assert.match(application, /Select \$\{actionIdentity\} in/);
  assert.match(application, /"Undo" : "Reapply"\} \$\{entry\.label\}/);
  assert.match(application, /key=\{current\.id\} className="quick"/);
  assert.match(application, /href=\{href\}/);
  assert.match(application, /Share this view/);
  assert.match(styles, /\.tree-select \.tree-name\{[^}]*overflow:visible[^}]*white-space:normal/);
  assert.match(styles, /\.drag-handle,[^{]*\{[^}]*min-height:44px/);
  assert.match(styles, /\.app-shell\{display:grid;grid-template-columns:minmax\(0,1fr\);grid-template-rows:minmax\(0,1fr\) auto;height:100dvh/);
  assert.match(styles, /\.bottom\{position:static;grid-row:2;grid-column:1\}/);
  assert.match(styles, /\.capture\{grid-template-columns:minmax\(0,1fr\)\}\.finish\{bottom:12px\}\.info-tip>button\{scroll-margin-bottom:8px\}/);
  assert.match(styles, /@media\(max-width:1100px\) and \(min-width:761px\)\{\.capture\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(styles, /\.capture-location-row \.queue-name b\{[^}]*white-space:nowrap/);
  assert.match(styles, /\.capture-location-row \.queue-name span\{[^}]*overflow:hidden[^}]*white-space:nowrap/);
  assert.match(styles, /\.capture-location-row>\.row-actions\{position:absolute/);
  assert.match(styles, /\.capture-location-row>\.drag-handle\[data-collapsible="true"\]/);
});

test("ships task-oriented item, plan, and workspace controls", () => {
  const application = readFileSync(new URL("../src/client/stowplan-app.tsx", import.meta.url), "utf8");
  assert.match(application, /Organize and find it/);
  assert.match(application, /Placement requirements/);
  assert.match(application, /affects a plan/);
  assert.match(application, /Workspace name/);
  assert.match(application, /Short ID/);
  assert.match(application, /Mark moved/);
  assert.match(application, /inventory-order-actions/);
  const workspaceHub = readFileSync(new URL("../src/client/workspace-hub.tsx", import.meta.url), "utf8");
  assert.match(workspaceHub, /Pending changes/);
  assert.match(workspaceHub, /It does not delete the server copy/);
  const replica = readFileSync(new URL("../src/client/local-replica.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../src/client/store.tsx", import.meta.url), "utf8");
  assert.match(replica, /lastSyncedAt/);
  assert.match(replica, /deleteWorkspaceReplica/);
  assert.match(replica, /export async function mutateReplica/);
  assert.match(replica, /The server did not acknowledge this change/);
  assert.match(store, /BACKUP_UNAVAILABLE_SESSION_KEY/);
  assert.match(store, /BACKUP_RETRY_INTERVAL_MS/);
});

test("guards restore commit boundaries and label deep links", () => {
  const recovery = readFileSync(new URL("../app/recovery/page.tsx", import.meta.url), "utf8");
  const snapshotRoute = readFileSync(new URL("../app/api/snapshot/route.ts", import.meta.url), "utf8");
  const syncRoute = readFileSync(new URL("../app/api/sync/route.ts", import.meta.url), "utf8");
  const labels = readFileSync(new URL("../app/labels/page.tsx", import.meta.url), "utf8");
  assert.match(recovery, /writeWorkspaceReplicaIfUnchanged/);
  assert.match(recovery, /Server restore succeeded at revision/);
  assert.match(recovery, /restore outcome could not be confirmed/);
  assert.match(recovery, /Export current server backup/);
  assert.match(recovery, /Export matching-device recovery bundle/);
  assert.match(recovery, /I saved this recovery file somewhere I can reopen it/);
  assert.match(recovery, /serverExportAcknowledged/);
  assert.match(recovery, /targetExportAcknowledged/);
  assert.match(snapshotRoute, /auditRecorded/);
  assert.match(syncRoute, /Every command must belong to the requested workspace/);
  assert.match(labels, /workspacePath\(\{/);
  assert.match(labels, /view: "capture"/);
});
