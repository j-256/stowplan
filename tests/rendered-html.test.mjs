import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(await response.text(), developmentPreviewMeta);
});

test("keeps private APIs out of the service-worker cache and ships install icons", () => {
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /SHELL\.includes\(url\.pathname\)\|\|url\.pathname\.startsWith\("\/_next\/static\/"\)/);
  assert.doesNotMatch(worker, /cache\.put\(event\.request/);
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.deepEqual(manifest.icons.slice(0, 2).map((icon) => icon.sizes), ["192x192", "512x512"]);
});

test("initializes OpenNext bindings for next dev and awaits runtime context failures", () => {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /initOpenNextCloudflareForDev\(\)/);
  const runtime = readFileSync(new URL("../src/server/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /await getCloudflareContext\(\{ async: true \}\)/);
});

test("keeps hierarchy and touch drag affordances in the shipped organizer", () => {
  const application = readFileSync(new URL("../src/client/stowplan-app.tsx", import.meta.url), "utf8");
  assert.match(application, /aria-label="Space hierarchy"/);
  assert.match(application, /onPointerDown=/);
  assert.match(application, /"before" \| "inside" \| "after"/);
  assert.match(application, /const canReorder = Boolean\(locationFilter\)/);
});

test("ships task-oriented item, plan, and workspace controls", () => {
  const application = readFileSync(new URL("../src/client/stowplan-app.tsx", import.meta.url), "utf8");
  assert.match(application, /Organize and find it/);
  assert.match(application, /Placement requirements/);
  assert.match(application, /affects a plan/);
  assert.match(application, /What is waiting/);
  assert.match(application, /This does not delete any server copy/);
  const replica = readFileSync(new URL("../src/client/local-replica.ts", import.meta.url), "utf8");
  assert.match(replica, /lastSyncedAt/);
  assert.match(replica, /deleteWorkspaceReplica/);
});
