const CACHE = "stowplan-shell-v14";
const CACHE_PREFIX = "stowplan-shell-";
const SHELL = [
  "/",
  "/demo",
  "/workspaces",
  "/docs",
  "/labels",
  "/recovery",
  "/offline",
  "/privacy",
  "/terms",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
];
const STATIC_SHELL = new Set([
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
]);

function canonicalPathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const withoutTrailingSlash = pathname.slice(0, -1);
    if (SHELL.includes(withoutTrailingSlash)) return withoutTrailingSlash;
  }
  return pathname;
}

async function installShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  const referencedAssets = new Set();
  for (const path of SHELL.filter((candidate) => !STATIC_SHELL.has(candidate))) {
    const response = await cache.match(path);
    if (!response || !response.headers.get("content-type")?.includes("text/html")) continue;
    const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
      const asset = new URL(match[1], location.origin);
      if (
        asset.origin === location.origin &&
        (
          asset.pathname.startsWith("/assets/") ||
          asset.pathname.startsWith("/_next/static/")
        )
      ) {
        referencedAssets.add(asset.href);
      }
    }
  }
  if (referencedAssets.size) await cache.addAll([...referencedAssets]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  ) return;

  const navigation = request.mode === "navigate";
  const pathname = canonicalPathname(url.pathname);
  const appNavigation =
    pathname === "/demo" ||
    pathname === "/workspaces" ||
    pathname.startsWith("/workspaces/");
  const staticAsset =
    STATIC_SHELL.has(pathname) ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/_next/static/");
  if (!navigation && !staticAsset) return;

  const cacheKey = navigation ? pathname : request;
  const cacheable = navigation ? SHELL.includes(pathname) : true;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && cacheable) {
          const cacheWrite = caches.open(CACHE)
            .then((cache) => cache.put(cacheKey, response.clone()))
            .catch(() => undefined);
          event.waitUntil(cacheWrite);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(cacheKey);
        if (cached) return cached;
        if (navigation && appNavigation) {
          const shell = await caches.match("/workspaces");
          if (shell) return shell;
        }
        if (navigation) return caches.match("/offline");
        return Response.error();
      }),
  );
});
