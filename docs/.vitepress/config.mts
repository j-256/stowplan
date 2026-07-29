import { defineConfig } from "vitepress";

const DEMO_LINK_MARKER = "stowplan:demo";
const PRIVACY_LINK_MARKER = "stowplan:privacy";
const TERMS_LINK_MARKER = "stowplan:terms";
const rawBase = process.env.DOCS_BASE ?? "/";
const base = rawBase.startsWith("/") && rawBase.endsWith("/") ? rawBase : `/${rawBase.replace(/^\/+|\/+$/g, "")}/`;
const applicationUrl = (
  process.env.DOCS_APPLICATION_URL ||
  "https://stowplan.jklein.dev"
).replace(/\/+$/u, "");
const demoUrl = `${applicationUrl}/demo`;
const privacyUrl = (
  process.env.DOCS_PRIVACY_POLICY_URL ||
  `${applicationUrl}/privacy`
).replace(/\/+$/u, "");
const termsUrl = (
  process.env.DOCS_TERMS_OF_SERVICE_URL ||
  `${applicationUrl}/terms`
).replace(/\/+$/u, "");
const repositoryUrl = process.env.DOCS_REPOSITORY_URL ?? "https://github.com/j-256/stowplan";

export default defineConfig({
  title: "Stowplan",
  description: "Find what you packed without opening every box.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  head: [
    // Both forms, base-prefixed so they resolve under a deployment subpath:
    // .ico for crawlers/legacy that still prefer it, .svg for modern browsers.
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }],
    ["link", { rel: "icon", type: "image/x-icon", href: `${base}favicon.ico` }],
    ["meta", { name: "theme-color", content: "#536954" }],
  ],
  markdown: {
    config(markdown) {
      const renderLinkOpen = markdown.renderer.rules.link_open;
      markdown.renderer.rules.link_open = (
        tokens,
        index,
        options,
        environment,
        renderer,
      ) => {
        if (tokens[index].attrGet("href") === DEMO_LINK_MARKER) {
          tokens[index].attrSet("href", demoUrl);
        } else if (
          tokens[index].attrGet("href") === PRIVACY_LINK_MARKER
        ) {
          tokens[index].attrSet("href", privacyUrl);
        } else if (
          tokens[index].attrGet("href") === TERMS_LINK_MARKER
        ) {
          tokens[index].attrSet("href", termsUrl);
        }
        return renderLinkOpen
          ? renderLinkOpen(
              tokens,
              index,
              options,
              environment,
              renderer,
            )
          : renderer.renderToken(tokens, index, options);
      };
    },
  },
  transformPageData(pageData) {
    const hero = pageData.frontmatter.hero;
    if (
      pageData.relativePath !== "index.md" ||
      !hero ||
      !Array.isArray(hero.actions)
    ) return;
    return {
      frontmatter: {
        ...pageData.frontmatter,
        hero: {
          ...hero,
          actions: hero.actions.map((
            action: Record<string, unknown>,
          ) => action.link === DEMO_LINK_MARKER
            ? { ...action, link: demoUrl }
            : action),
        },
      },
    };
  },
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Try Stowplan", link: demoUrl },
      { text: "User guide", link: "/guide/getting-started" },
      { text: "Host and operate", link: "/deploy/" },
      { text: "Maintain", link: "/maintainers/architecture" },
      { text: "Privacy", link: privacyUrl },
      { text: "Terms", link: termsUrl },
      { text: "Source", link: repositoryUrl },
    ],
    sidebar: [
      { text: "Use Stowplan", items: [
        { text: "Getting started", link: "/guide/getting-started" },
        { text: "Fast capture", link: "/guide/capture" },
        { text: "Spaces and inventory", link: "/guide/organize" },
        { text: "Move plans", link: "/guide/plans" },
        { text: "Workspaces and sharing", link: "/guide/collaboration" },
        { text: "Offline and backup", link: "/guide/offline" },
        { text: "Activity and undo", link: "/guide/activity" },
        { text: "Backup and recovery", link: "/guide/recovery" },
        { text: "Account, privacy, and data", link: "/guide/account-data" },
        { text: "Privacy policy", link: privacyUrl },
        { text: "Terms of Service", link: termsUrl },
      ] },
      { text: "Host and operate", items: [
        { text: "Deployment targets", link: "/deploy/" },
        { text: "Cloudflare Workers and D1", link: "/deploy/cloudflare" },
        { text: "Node and SQLite", link: "/deploy/node-sqlite" },
        { text: "Docker and Podman", link: "/deploy/containers" },
        { text: "Fly.io", link: "/deploy/fly-io" },
        { text: "Railway", link: "/deploy/railway" },
        { text: "Render", link: "/deploy/render" },
        { text: "GitHub Pages docs", link: "/deploy/github-pages" },
        { text: "Cloudflare Pages docs", link: "/deploy/cloudflare-pages" },
        { text: "Authentication overview", link: "/auth/" },
        { text: "Google sign-in", link: "/auth/google" },
        { text: "Cloudflare Access", link: "/auth/cloudflare-access" },
        { text: "Global administration", link: "/guide/admin" },
        { text: "Configuration", link: "/maintainers/configuration" },
      ] },
      { text: "Maintain", items: [
        { text: "Architecture", link: "/maintainers/architecture" },
        { text: "API and sync protocol", link: "/maintainers/api" },
        { text: "Testing and release", link: "/maintainers/testing" },
        { text: "Agent handoff", link: "/maintainers/agents" },
      ] },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repositoryUrl }],
    footer: { message: "A Strange Lasers project. Released under AGPL-3.0-only", copyright: "Copyright © 2026 James Klein (j-256)" },
  },
});
