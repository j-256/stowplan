import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

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

test("keeps private APIs out of the service-worker cache and ships install icons", () => {
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/assets\/"\)/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /event\.waitUntil\(installShell\(\)/);
  assert.match(worker, /cache\.put\(cacheKey, response\.clone\(\)\)/);
  assert.match(worker, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(worker, /"\/docs\/"/);
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
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /initOpenNextCloudflareForDev\(\)/);
  const runtime = readFileSync(new URL("../src/server/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /await getCloudflareContext\(\{ async: true \}\)/);
});

test("keeps hierarchy and touch drag affordances in the shipped organizer", () => {
  const application = readFileSync(new URL("../src/client/stowplan-app.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(application, /aria-label="Space hierarchy"/);
  assert.match(application, /reorder within/);
  assert.match(application, /onPointerDown=/);
  assert.match(application, /"before" \| "inside" \| "after"/);
  assert.match(application, /const canReorder = Boolean\(locationFilter\) && !query\.trim\(\)/);
  assert.match(application, /scrollContainer\.current = event\.currentTarget\.closest<HTMLElement>\("\.capture-tree"\)/);
  assert.match(application, /activeSubmitControl\.focus\(\)/);
  assert.match(application, /Select \$\{actionIdentity\} in/);
  assert.match(application, /"Undo" : "Reapply"\} \$\{entry\.label\}/);
  assert.match(application, /key=\{current\.id\} className="quick"/);
  assert.match(styles, /\.tree-select \.tree-name\{[^}]*overflow:visible[^}]*white-space:normal/);
  assert.match(styles, /\.drag-handle,[^{]*\{[^}]*min-height:44px/);
  assert.match(styles, /\.app-shell\{display:grid;grid-template-columns:minmax\(0,1fr\);grid-template-rows:minmax\(0,1fr\) auto;height:100dvh/);
  assert.match(styles, /\.bottom\{position:static;grid-row:2;grid-column:1\}/);
  assert.match(styles, /\.capture\{grid-template-columns:minmax\(0,1fr\)\}\.finish\{bottom:12px\}\.info-tip>button\{scroll-margin-bottom:8px\}/);
  assert.match(styles, /@media\(max-width:1100px\) and \(min-width:761px\)\{\.capture\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(styles, /\.capture-location-row \.queue-name b\{[^}]*white-space:nowrap/);
  assert.match(styles, /\.capture-location-row \.queue-name span\{[^}]*overflow:visible[^}]*white-space:normal/);
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
  assert.match(application, /Queued changes/);
  assert.match(application, /This does not delete any server copy/);
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
  assert.match(labels, /workspace=.*container=/s);
});
