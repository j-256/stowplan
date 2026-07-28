# Cloudflare Pages documentation

Cloudflare Pages is an optional static-docs host; the build output is ordinary HTML/CSS/JS.

Dashboard settings:

```text
Build command: npm ci && npm run docs:build
Build output directory: docs/.vitepress/dist
Environment variable: DOCS_BASE=/
Optional application link: DOCS_APPLICATION_URL=https://YOUR_STOWPLAN_ORIGIN
Node version: 24.18.0
```

CLI deployment after a local build:

```bash
DOCS_BASE=/ npm run docs:build
npx wrangler pages project create stowplan-docs
npx wrangler pages deploy docs/.vitepress/dist --project-name stowplan-docs
```

`pages project create` is a one-time remote mutation. On retry, list projects rather than creating another:

```bash
npx wrangler pages project list
```

This docs deployment is independent of the application Worker and D1.
