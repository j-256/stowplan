import { expect, test } from "@playwright/test";

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
