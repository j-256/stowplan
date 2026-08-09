#!/usr/bin/env node
// Generate the README screenshots of the app.
//
// Programmatic rather than hand-captured: the page is the app (no chrome to
// crop), the input is fixed (the built-in "Kitchen reset" demo the /demo route
// seeds), and deviceScaleFactor 2 keeps the dense capture/plan UI crisp.
//
// The app is a client-rendered SPA backed by a Node server over HTTPS with a
// __Host- session cookie, so it needs the SAME server the e2e suite uses -- a
// file:// load has no API and no session. This script reuses that exact boot:
// `next build` then scripts/playwright-node-server.mjs on :3100, with the same
// AUTH_*/HOST/PORT/sqlite env the Playwright config sets. The demo seeds itself
// with no sign-in, so no auth flow is needed.
//
// Each run uses a throwaway sqlite file and a fresh browser context, so the demo
// workspace is seeded clean every time and the shots cannot drift from a stale
// database.
//
// Usage:  node scripts/screenshots.mjs [outDir]
// Default outDir is screenshots/ (docs/ is the VitePress site).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Not docs/: that directory is the VitePress documentation site. README images
// live in a dedicated screenshots/ directory at the repo root.
const OUT = process.argv[2] || join(ROOT, 'screenshots');

// playwright-node-server.mjs guards that STOWPLAN_SQLITE_PATH resolves under
// ./test-results, so the throwaway db has to live there (not a tmpdir).
const DB_PATH = join(ROOT, 'test-results', 'screenshots.sqlite');

const PORT = 3100;
const BASE = `https://localhost:${PORT}`;
const HEALTH = `${BASE}/api/health`;

// Two capture passes. The docs carousel serves the mobile image below 640px via
// <picture>, so the app is shown in whichever layout that device actually uses.
//   - desktop: wide enough for the multi-pane capture layout.
//   - mobile: a phone width, but taller than a real handset so each view's key
//     content fits in one uniform-ratio crop without clipping mid-element.
const PROFILES = [
  { key: 'desktop', suffix: '', viewport: { width: 1440, height: 960 } },
  { key: 'mobile', suffix: '-mobile', viewport: { width: 390, height: 900 } },
];

// The demo lands on Capture; Plan and Inventory are the other primary surfaces,
// reachable from the seeded workspace URL prefix. An optional prepare(page,
// profile) runs after the view loads, for view-specific setup before the shot.
// Each shot should show the app doing useful work, not demo-only coaching or an
// empty pre-generation state, so the prepare steps below branch by profile.
const VIEWS = [
  {
    name: 'capture',
    suffix: null, // where /demo already is
    // The demo lands on the current-container form, which carries a demo-only
    // "Try one change" coaching banner. That banner plus the empty input crowd
    // out the actual content, and the space tree -- the counted-progress
    // showcase -- lives on the other compact panel
    //   - mobile: dismiss the demo banner, then switch to Capture queue so the
    //     tree with "Counted" badges becomes the shot
    //   - desktop: both panels already show side by side, so there is no panel
    //     toggle; dismiss the banner directly instead
    prepare: async (page, profile) => {
      if (profile.key === 'mobile') {
        const navigation = page.getByRole('group', { name: 'Capture panels navigation' });
        await navigation.waitFor();
        await dismissDemoBanner(page);
        await navigation.getByRole('button', { name: 'capture queue' }).click();
        await page.locator('.capture > .queue').waitFor();
      } else {
        await dismissDemoBanner(page);
      }
    },
  },
  {
    name: 'plan',
    suffix: '/plan',
    // A fresh demo generates a small plan, so click Generate and wait for the
    // next-move card: the shot then shows a real explainable recommendation
    // (route + "Mark moved") rather than an empty intro. On desktop there is
    // room to also expand "Plan priorities" below the card as a showcase; on
    // mobile there is room to show the supporting Plan options too
    prepare: async (page, profile) => {
      await page.getByRole('button', { name: 'Generate move plan' }).click();
      await page.getByRole('region', { name: 'Next move' }).waitFor();
      if (profile.key === 'desktop') {
        const summary = page.locator('.plan-settings > summary');
        if (await summary.count()) await summary.click();
      } else {
        await page.getByRole('button', { name: /Plan options/ }).click();
      }
    },
  },
  { name: 'inventory', suffix: '/inventory' },
];

// Dismiss the demo-only "Try one change" coaching banner if present. It only
// renders on the /demo workspace, so the control is absent otherwise; the count
// guard keeps this a no-op rather than a wait in that case.
async function dismissDemoBanner(page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss demo task' });
  if (await dismiss.count()) await dismiss.click();
}

// Mirror the env the Playwright config passes to the same server command.
function serverEnv(dbPath) {
  return {
    ...process.env,
    AUTH_BASE_URL: BASE,
    AUTH_DEV_ENABLED: 'true',
    AUTH_IDENTITY_DIGEST_KEY: 'screenshots-identity-digest-key-at-least-32-bytes',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    STOWPLAN_SQLITE_PATH: dbPath,
  };
}

// The server presents a self-signed cert. Node's fetch() has no per-request way
// to skip verification (it ignores an init `tls` option), so probe with the
// https module and rejectUnauthorized: false instead.
function probeOnce(url) {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once('error', () => resolve(false));
    req.setTimeout(1_000, () => req.destroy());
    req.end();
  });
}

async function waitForHealth(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeOnce(url)) return;
    if (Date.now() > deadline) throw new Error(`server did not become healthy at ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });
  // Start from a clean db so the demo seeds fresh and shots cannot drift.
  rmSync(DB_PATH, { force: true });

  // Build once, then serve. Both go through sites-env.sh via the npm script for
  // the build; the server is launched directly the way the Playwright config does.
  const server = spawn(
    'bash',
    ['-lc', 'npm run build:next && node scripts/playwright-node-server.mjs'],
    { cwd: ROOT, stdio: 'inherit', env: serverEnv(DB_PATH) },
  );

  try {
    await waitForHealth(HEALTH);

    const browserInstance = await chromium.launch({
      // The ephemeral TLS cert is not trusted; accept it (mirrors the e2e config).
      args: ['--ignore-certificate-errors'],
    });

    console.log('capturing into', OUT);
    for (const profile of PROFILES) {
      // A fresh context per profile gives a clean IndexedDB, so /demo re-seeds
      // the same kitchen at this profile's viewport.
      const context = await browserInstance.newContext({
        viewport: profile.viewport,
        deviceScaleFactor: 2, // retina: capture rows and item editors stay sharp
        ignoreHTTPSErrors: true,
        // The app's default theme is "system"; dark here makes it resolve to dark.
        colorScheme: 'dark',
      });
      const page = await context.newPage();

      // Seed + open the demo. It redirects into the Kitchen reset workspace and
      // lands on Capture; the heading is the ready signal.
      await page.goto(`${BASE}/demo`);
      await page.getByRole('heading', { name: 'Capture', exact: true }).waitFor();

      // The seeded workspace id is in the URL: /workspaces/<slug@id>/capture/...
      // Everything up to and including the id is the prefix other views hang off.
      const match = page.url().match(/\/workspaces\/[^/]+/);
      if (!match) throw new Error(`unexpected demo URL: ${page.url()}`);
      const prefix = `${BASE}${match[0]}`;

      for (const view of VIEWS) {
        if (view.suffix) {
          await page.goto(`${prefix}${view.suffix}`);
          // Each primary surface has an exact-match heading equal to its label.
          const heading = view.suffix.replace('/', '').replace(/^\w/, (c) => c.toUpperCase());
          await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        }
        if (view.prepare) await view.prepare(page, profile);
        // Let the pane settle (list virtualization / layout) before the shot.
        await page.waitForTimeout(400);
        // The demo programmatically focuses a row in the container detail pane,
        // which draws that panel's :focus-visible outline -- an odd "why is this
        // highlighted" artifact in a static shot. Blur AFTER the settle, since a
        // post-layout effect re-focuses the row; blurring before it would be undone.
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        // Reset any scrolled container to its top. On mobile the app scrolls an
        // inner <main> (not the window); a programmatic focus can leave it partway
        // down, which clips the sticky header. Start every shot at the true top.
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          for (const el of document.querySelectorAll('*')) {
            if (el.scrollTop > 0) el.scrollTop = 0;
          }
        });
        await page.waitForTimeout(150);
        const file = `${view.name}${profile.suffix}.png`;
        await page.screenshot({ path: join(OUT, file), fullPage: false });
        console.log('  wrote', file);
      }

      await context.close();
    }

    await browserInstance.close();
  } finally {
    server.kill('SIGTERM');
    rmSync(DB_PATH, { force: true });
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
