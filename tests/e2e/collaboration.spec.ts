import { expect, test } from "@playwright/test";
import { projectContextOptions } from "./project-context";

const DATABASE_NAME = "stowplan-v1";
const OWNER_EMAIL = "collaboration-owner@example.test";
const OWNER_NAME = "Collaboration Owner";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate((databaseName) => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }), DATABASE_NAME);
  await page.reload();
});

test("signs in, backs up, and opens an exact workspace view through a one-time guest link", async ({
  browser,
  page,
}, testInfo) => {
  await page.getByRole("button", {
    name: "Explore the kitchen demo instead",
  }).click();
  await expect(page).toHaveURL(/\/workspaces\/[^/]+\//);
  const workspaceId = new URL(page.url()).pathname.split("/")[2];
  expect(workspaceId).toBeTruthy();

  const settingsPath = `/workspaces/${encodeURIComponent(workspaceId)}/settings`;
  await page.goto(settingsPath);
  await page.getByRole("link", {
    name: "Sign in, sync, or create a guest link to this view",
  }).click();

  await expect(page).toHaveURL(new RegExp(
    `/account\\?workspace=${encodeURIComponent(workspaceId)}`,
  ));
  await page.getByLabel("Name").fill(OWNER_NAME);
  await page.getByLabel("Admin email").fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Sign in locally" }).click();

  await expect(page).toHaveURL(new RegExp(`${settingsPath}$`));
  await expect(page.locator(".sync")).toContainText("Backed up", {
    timeout: 15_000,
  });
  await page.getByRole("link", {
    name: "Sign in, sync, or create a guest link to this view",
  }).click();
  await expect(page.getByRole("heading", {
    name: `Signed in as ${OWNER_NAME}`,
  })).toBeVisible();

  await page.getByRole("button", { name: "Create guest link" }).click();
  await expect(page.getByText(
    "Guest link created. It can be used once during the next 24 hours.",
  )).toBeVisible();
  const guestUrl = await page.getByLabel("One-time guest link").inputValue();
  expect(new URL(guestUrl).searchParams.get("returnTo")).toBe(settingsPath);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  await page.goto(settingsPath);
  await expect(page.getByRole("heading", {
    name: "Settings",
    exact: true,
  })).toBeVisible();

  const collaboratorContext = await browser.newContext(
    projectContextOptions(page, testInfo),
  );
  try {
    const collaborator = await collaboratorContext.newPage();
    await collaborator.goto(guestUrl);
    await expect(collaborator.getByRole("heading", {
      name: "Open the shared workspace?",
    })).toBeVisible();
    await collaborator.getByRole("button", {
      name: "Open shared workspace",
    }).click();

    await expect(collaborator).toHaveURL(new RegExp(`${settingsPath}$`));
    await expect(collaborator.getByRole("heading", {
      name: "Settings",
      exact: true,
    })).toBeVisible();
    await expect(collaborator.getByText("Kitchen reset", {
      exact: true,
    })).toBeVisible();
    await expect(collaborator.getByText(
      "Shared workspace opened. Your previous local workspace is still available from the main menu.",
    )).toBeVisible();
    expect(collaborator.viewportSize()).toEqual(page.viewportSize());
    expect(await collaborator.evaluate(() => ({
      devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    }))).toEqual(await page.evaluate(() => ({
      devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    })));

    await expect(collaborator.locator(".sync")).toContainText("Backed up", {
      timeout: 15_000,
    });
    const sharedName = `Shared ${testInfo.project.name} kitchen`;
    const collaboratorSync = collaborator.waitForResponse((response) =>
      response.ok() &&
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sync"
    );
    await collaborator.getByLabel("Workspace name").fill(sharedName);
    await collaborator.getByRole("button", {
      name: "Rename workspace",
    }).click();
    await collaboratorSync;

    const ownerReconciliation = page.waitForResponse((response) =>
      response.ok() &&
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sync"
    );
    await page.bringToFront();
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await ownerReconciliation;
    await expect(page.locator(".app-shell > main > header .eyebrow"))
      .toHaveText(sharedName);
  } finally {
    await collaboratorContext.close();
  }
});

test("shows an action-specific error for an empty account status response", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: "",
    status: 502,
  }));
  await page.goto("/account");

  await expect(page.locator("output")).toContainText(
    "Could not check account status: the server returned an empty or unreadable response",
  );
});

test("shows an action-specific error when Access refuses an empty exchange", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: ["cloudflare-access"],
      user: null,
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/auth/access", (route) => route.fulfill({
    body: "",
    status: 401,
  }));
  await page.goto("/account");

  await expect(page.locator("output")).toContainText(
    "Cloudflare Access could not create an app session: the server returned an empty or unreadable response",
  );
});

test("acknowledges a canceled guest-link share", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("Canceled", "AbortError");
      },
    });
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: [],
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        globalRole: "admin",
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/admin/guest-links", (route) => route.fulfill({
    body: JSON.stringify({
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      url: "http://127.0.0.1:3100/guest/example",
    }),
    contentType: "application/json",
    status: 201,
  }));
  await page.goto(
    "/account?workspace=ws_feedback&returnTo=%2Fworkspaces%2Fws_feedback%2Fsettings",
  );

  await page.getByRole("button", { name: "Create guest link" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.locator("output")).toHaveText("Sharing was canceled.");
});

test("reloads after development sign-out without visiting the Access logout endpoint", async ({
  page,
}) => {
  let accessLogoutRequests = 0;
  let accountNavigations = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/cdn-cgi/access/logout") accessLogoutRequests += 1;
    if (
      pathname === "/account" &&
      request.isNavigationRequest()
    ) {
      accountNavigations += 1;
    }
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: ["development"],
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        globalRole: "admin",
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/auth/logout", (route) => route.fulfill({
    body: JSON.stringify({ ok: true }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto("/account");
  await expect(page.getByRole("heading", {
    name: `Signed in as ${OWNER_NAME}`,
  })).toBeVisible();

  const reloaded = page.waitForEvent("framenavigated", (frame) => (
    frame === page.mainFrame()
  ));
  await page.getByRole("button", { name: "Sign out" }).click();
  await reloaded;
  await expect(page.getByRole("heading", {
    name: `Signed in as ${OWNER_NAME}`,
  })).toBeVisible();
  expect(accountNavigations).toBe(2);
  expect(accessLogoutRequests).toBe(0);
});

test("clears the Access cookie after an Access-configured app sign-out", async ({
  page,
}) => {
  let accessExchanges = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/access") {
      accessExchanges += 1;
    }
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: ["cloudflare-access"],
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        globalRole: "admin",
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/auth/logout", (route) => route.fulfill({
    body: JSON.stringify({ ok: true }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto("/account");
  await expect(page.getByRole("heading", {
    name: `Signed in as ${OWNER_NAME}`,
  })).toBeVisible();

  const accessLogout = page.waitForRequest((request) => (
    request.isNavigationRequest() &&
    new URL(request.url()).pathname === "/cdn-cgi/access/logout"
  ));
  await page.getByRole("button", { name: "Sign out" }).click();
  await accessLogout;
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
  await page.waitForLoadState("domcontentloaded");
  expect(accessExchanges).toBe(0);
});

test("keeps return destinations on the local origin after repeated decoding", async ({
  page,
}) => {
  const safePath = "/workspaces/ws_safe/settings?panel=backup#links";
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: ["development"],
      user: null,
    }),
    contentType: "application/json",
    status: 200,
  }));

  await page.goto(`/account?returnTo=${encodeURIComponent(safePath)}`);
  await expect(page.getByRole("link", { name: "Back to Stowplan" }))
    .toHaveAttribute("href", safePath);

  const encodedBackslashEscape = "/%5C%5Cevil.example";
  await page.goto(
    `/account?returnTo=${encodeURIComponent(encodedBackslashEscape)}`,
  );
  await expect(page.getByRole("link", { name: "Back to Stowplan" }))
    .toHaveAttribute("href", "/");
});
