import { defineConfig } from "vitepress";

const rawBase = process.env.DOCS_BASE ?? "/";
const base = rawBase.startsWith("/") && rawBase.endsWith("/") ? rawBase : `/${rawBase.replace(/^\/+|\/+$/g, "")}/`;
const repositoryUrl = process.env.DOCS_REPOSITORY_URL ?? "https://github.com/j-256/stowplan";

export default defineConfig({
  title: "Stowplan",
  description: "Local-first storage organization, from first label to finished move plan.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  head: [["meta", { name: "theme-color", content: "#536954" }]],
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "User guide", link: "/guide/getting-started" },
      { text: "Deploy", link: "/deploy/" },
      { text: "Maintain", link: "/maintainers/architecture" },
      { text: "Source", link: repositoryUrl },
    ],
    sidebar: [
      { text: "Use Stowplan", items: [
        { text: "Getting started", link: "/guide/getting-started" }, { text: "Fast capture", link: "/guide/capture" },
        { text: "Spaces & inventory", link: "/guide/organize" }, { text: "Move plans", link: "/guide/plans" },
        { text: "Offline & sync", link: "/guide/offline" }, { text: "Activity & rollback", link: "/guide/activity" },
        { text: "Backup & recovery", link: "/guide/recovery" }, { text: "Admin", link: "/guide/admin" },
      ]},
      { text: "Authentication", items: [
        { text: "Overview", link: "/auth/" }, { text: "Google OAuth", link: "/auth/google" },
        { text: "GitHub OAuth", link: "/auth/github" }, { text: "Cloudflare Access", link: "/auth/cloudflare-access" },
      ]},
      { text: "Deploy", items: [
        { text: "Target matrix", link: "/deploy/" }, { text: "Cloudflare Workers + D1", link: "/deploy/cloudflare" },
        { text: "Node + SQLite", link: "/deploy/node-sqlite" }, { text: "Docker / Podman", link: "/deploy/containers" },
        { text: "Fly.io", link: "/deploy/fly-io" }, { text: "Railway", link: "/deploy/railway" },
        { text: "Render", link: "/deploy/render" },
        { text: "GitHub Pages docs", link: "/deploy/github-pages" }, { text: "Cloudflare Pages docs", link: "/deploy/cloudflare-pages" },
      ]},
      { text: "Maintain", items: [
        { text: "Architecture", link: "/maintainers/architecture" }, { text: "Configuration", link: "/maintainers/configuration" },
        { text: "API & sync protocol", link: "/maintainers/api" }, { text: "Testing & release", link: "/maintainers/testing" },
        { text: "Agent handoff", link: "/maintainers/agents" },
      ]},
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repositoryUrl }],
    footer: { message: "Released under AGPL-3.0-only", copyright: "Copyright © 2026 James Klein (j-256)" },
  },
});
