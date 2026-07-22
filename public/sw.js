const CACHE="stowplan-shell-v1",SHELL=["/","/offline","/manifest.webmanifest","/favicon.svg"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener("fetch",event=>{const url=new URL(event.request.url);if(event.request.method!=="GET"||url.pathname.startsWith("/api/"))return;event.respondWith(fetch(event.request).then(response=>{if(response.ok&&url.origin===location.origin)caches.open(CACHE).then(c=>c.put(event.request,response.clone()));return response}).catch(()=>caches.match(event.request).then(r=>r||caches.match("/offline"))))});
