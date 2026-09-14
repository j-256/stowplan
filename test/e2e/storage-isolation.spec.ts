import { expect, test } from "@playwright/test";
import { BROWSER_PROJECTS, forProjects } from "./browser-projects";

const PROBE_PATH = "/__storage_isolation__";
const STORAGE_MARKER = "stowplan-isolation-probe";
const PROBE_VALUE = "persisted within this test";

// Both tests leave data behind so a reused page or context fails the next one
for (const attempt of [1, 2]) {
  test(`isolates browser storage between tests (attempt ${attempt})`,
    forProjects([BROWSER_PROJECTS.desktop]), async ({ context, page }) => {
      await page.route(`**${PROBE_PATH}`, route => route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Storage isolation</title>",
      }));
      await page.goto(PROBE_PATH);
      const readStorage = () => page.evaluate(async marker => ({
        local: localStorage.getItem(marker),
        session: sessionStorage.getItem(marker),
        databases: (await indexedDB.databases()).map(database => database.name),
        caches: await caches.keys(),
        cookie: document.cookie,
      }), STORAGE_MARKER);
      expect(await readStorage()).toEqual({
        local: null, session: null, databases: [], caches: [], cookie: "",
      });
      expect(await context.cookies()).toEqual([]);

      await page.evaluate(async ({ marker, value }) => {
        localStorage.setItem(marker, value);
        sessionStorage.setItem(marker, value);
        document.cookie = `${marker}=present; Secure; SameSite=Strict; Path=/`;
        const cache = await caches.open(marker);
        await cache.put("/probe", new Response(value));
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(marker, 1);
          request.onupgradeneeded = () => request.result.createObjectStore("data");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction("data", "readwrite");
            transaction.objectStore("data").put(value, marker);
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => { database.close(); reject(transaction.error); };
          };
        });
      }, { marker: STORAGE_MARKER, value: PROBE_VALUE });
      await page.reload();
      expect(await readStorage()).toEqual({
        local: PROBE_VALUE,
        session: PROBE_VALUE,
        databases: [STORAGE_MARKER],
        caches: [STORAGE_MARKER],
        cookie: `${STORAGE_MARKER}=present`,
      });
    });
}
