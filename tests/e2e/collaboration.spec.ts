import { expect, test, type Route } from "@playwright/test";

const DATABASE_NAME = "stowplan-v1";
const OWNER_ID = "usr_collaboration_owner";
const OWNER_EMAIL = "collaboration-owner@example.test";
const OWNER_NAME = "Collaboration Owner";
const OWNER_HEADERS = {
  "x-stowplan-account-id": OWNER_ID,
};

test.beforeEach(async ({ page }) => {
  await page.goto("/workspaces");
  await page.evaluate((databaseName) => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }), DATABASE_NAME);
  await page.reload();
  await page.route("**/api/auth/sessions*", (route) => route.fulfill({
    body: JSON.stringify({
      currentSession: {
        createdAt: "2026-07-25T00:00:00.000Z",
        current: true,
        expiresAt: "2026-08-25T00:00:00.000Z",
        id: "ses_current",
        ipPrefix: "192.0.2.0/24",
        lastSeenAt: "2026-07-25T00:05:00.000Z",
        revokedAt: null,
        status: "active",
        userAgent: "Test browser",
      },
      otherSessions: [],
      page: {
        hasMore: false,
        limit: 25,
        nextCursor: null,
      },
    }),
    contentType: "application/json",
    headers: OWNER_HEADERS,
    status: 200,
  }));
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

test("puts account navigation and sign-in before online-data details", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      accessMigrationAvailable: false,
      configured: true,
      hasLinkedGoogleIdentity: false,
      providers: ["development"],
      turnstileSiteKey: null,
      user: null,
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto("/account?returnTo=%2Fworkspaces");

  const back = page.getByRole("link", { name: "Back to Stowplan" });
  const signIn = page.getByRole("button", { name: "Sign in locally" });
  const disclosure = page.getByText("Online data and privacy", {
    exact: true,
  });
  await expect(back).toBeVisible();
  await expect(signIn).toBeVisible();
  await expect(disclosure).toBeVisible();
  const [backBox, signInBox, disclosureBox] = await Promise.all([
    back.boundingBox(),
    signIn.boundingBox(),
    disclosure.boundingBox(),
  ]);
  expect(backBox).not.toBeNull();
  expect(signInBox).not.toBeNull();
  expect(disclosureBox).not.toBeNull();
  expect(backBox!.y).toBeLessThan(signInBox!.y);
  expect(signInBox!.y).toBeLessThan(disclosureBox!.y);
});

test("puts workspace continuation before sessions and account deletion", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      accessMigrationAvailable: false,
      configured: true,
      hasLinkedGoogleIdentity: false,
      providers: ["development"],
      turnstileSiteKey: null,
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: "2099-07-26T00:00:00.000Z",
        globalRole: "user",
        userId: OWNER_ID,
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto(
    "/account?workspace=ws_shared&returnTo=%2Fworkspaces%2Fshared-home%40ws_shared%2Fsettings",
  );

  const manageAccess = page.getByRole("link", {
    name: "Manage workspace access",
  });
  const sessions = page.getByRole("heading", { name: "Your sessions" });
  const deletion = page.getByRole("heading", {
    name: "Delete server account",
  });
  await expect(manageAccess).toBeVisible();
  await expect(sessions).toBeVisible();
  await expect(deletion).toBeVisible();
  const [manageBox, sessionsBox, deletionBox] = await Promise.all([
    manageAccess.boundingBox(),
    sessions.boundingBox(),
    deletion.boundingBox(),
  ]);
  expect(manageBox).not.toBeNull();
  expect(sessionsBox).not.toBeNull();
  expect(deletionBox).not.toBeNull();
  expect(manageBox!.y).toBeLessThan(sessionsBox!.y);
  expect(sessionsBox!.y).toBeLessThan(deletionBox!.y);
});

test("does not exchange an Access identity for an ordinary account session", async ({
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
      user: null,
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto("/account");

  await expect(page.getByRole("heading", {
    name: "Connect Stowplan",
  })).toBeVisible();
  expect(accessExchanges).toBe(0);
});

test("offers the temporary Access migration handoff only when enabled", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      accessMigrationAvailable: true,
      configured: true,
      providers: [],
      turnstileSiteKey: null,
      user: null,
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/auth/access", (route) => route.fulfill({
    body: JSON.stringify({
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: new Date(
          Date.now() + 3_600_000,
        ).toISOString(),
        globalRole: "user",
        userId: OWNER_ID,
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.goto("/account");

  const migrationRequest = page.waitForRequest(
    request => new URL(request.url()).pathname ===
      "/api/auth/access",
  );
  await page.getByRole("button", {
    name: "Recover existing account",
  }).click();

  await expect((await migrationRequest).method()).toBe("POST");
});

test("keeps Terms acceptance separate from persistent Google sign-in", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.turnstile = {
      remove: () => undefined,
      render: (_container, options) => {
        queueMicrotask(() => options.callback(
          "synthetic-turnstile-token",
        ));
        return "synthetic-widget";
      },
      reset: () => undefined,
    };
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      accessMigrationAvailable: false,
      configured: true,
      hasLinkedGoogleIdentity: false,
      providers: ["google"],
      turnstileSiteKey: "1x00000000000000000000AA",
      user: null,
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route(
    "**/api/auth/google/start*",
    (route) => route.fulfill({
      body: JSON.stringify({
        code: "AUTHENTICATION_UNAVAILABLE",
        error: "Synthetic stop after request capture",
      }),
      contentType: "application/json",
      status: 503,
    }),
  );
  await page.goto("/account");

  const continueButton = page.getByRole("button", {
    exact: true,
    name: "Continue with Google",
  });
  const termsAgreement = page.getByRole("checkbox", {
    name: /I agree to the Terms of Service/u,
  });
  const persistentSignIn = page.getByRole("checkbox", {
    name: "Keep me signed in after I close the browser",
  });
  await expect(termsAgreement).not.toBeChecked();
  await expect(persistentSignIn).not.toBeChecked();
  await expect(continueButton).toBeDisabled();
  const agreementRow = termsAgreement.locator("..");
  await expect(agreementRow.getByRole("link", {
    name: "Terms of Service",
  })).toHaveAttribute(
    "href",
    "https://stowplan.jklein.dev/terms",
  );
  await expect(agreementRow.getByRole("link", {
    name: "Privacy Policy",
  })).toHaveAttribute(
    "href",
    "https://stowplan.jklein.dev/privacy",
  );

  await termsAgreement.check();
  await expect(continueButton).toBeEnabled();
  await persistentSignIn.check();
  const startRequest = page.waitForRequest(
    request => new URL(request.url()).pathname ===
      "/api/auth/google/start",
  );
  await continueButton.click();
  const form = new URLSearchParams(
    (await startRequest).postData() ?? "",
  );
  expect(form.get("termsAccepted")).toBe("true");
  expect(form.get("sessionPersistence")).toBe("persistent");
});

for (const {
  afterLabel,
  error,
  hasLinkedGoogleIdentity,
  label,
  message,
  state,
} of [
  {
    afterLabel: "Link Google identity",
    error:
      "Sign out and sign in again with this account's existing method, then link Google when you return",
    hasLinkedGoogleIdentity: false,
    label: "Link Google identity",
    message:
      "Sign out and sign in again with this account's existing method, then link Google when you return",
    state: "first",
  },
  {
    afterLabel: "Confirm with Google",
    error:
      "Sign in again with an existing Google identity before linking another",
    hasLinkedGoogleIdentity: true,
    label: "Link another Google identity",
    message:
      "Confirm with an existing Google identity, then choose link again when you return.",
    state: "additional",
  },
]) {
  test(`labels the ${state} Google identity action from server state`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.turnstile = {
        remove: () => undefined,
        render: (_container, options) => {
          queueMicrotask(() => options.callback(
            "synthetic-turnstile-token",
          ));
          return "synthetic-widget";
        },
        reset: () => undefined,
      };
    });
    await page.route("**/api/auth/me", (route) => route.fulfill({
      body: JSON.stringify({
        accessMigrationAvailable: false,
        configured: true,
        hasLinkedGoogleIdentity,
        providers: ["google"],
        turnstileSiteKey: "1x00000000000000000000AA",
        user: {
          displayName: OWNER_NAME,
          email: OWNER_EMAIL,
          expiresAt: "2099-07-26T00:00:00.000Z",
          globalRole: "user",
          userId: OWNER_ID,
        },
      }),
      contentType: "application/json",
      status: 200,
    }));
    await page.route(
      "**/api/auth/google/start*",
      (route) => route.fulfill({
        body: JSON.stringify({
          code: "REAUTHENTICATION_REQUIRED",
          error,
          hasLinkedGoogleIdentity,
        }),
        contentType: "application/json",
        status: 401,
      }),
    );

    await page.goto("/account");

    const action = page.getByRole("button", {
      exact: true,
      name: label,
    });
    await expect(action).toBeEnabled();
    await action.click();
    await expect(page.getByRole("button", {
      exact: true,
      name: afterLabel,
    })).toBeVisible();
    await expect(page.locator("output")).toContainText(message);
  });
}

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
        userId: OWNER_ID,
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
  await page.getByRole("button", {
    exact: true,
    name: "Sign out this session",
  }).click();
  await page.getByRole("button", {
    exact: true,
    name: "Sign out",
  }).click();
  await reloaded;
  await expect(page.getByRole("heading", {
    name: `Signed in as ${OWNER_NAME}`,
  })).toBeVisible();
  expect(accountNavigations).toBe(2);
  expect(accessLogoutRequests).toBe(0);
});

test("keeps a failed current-session sign-out in its dialog context", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: ["development"],
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        globalRole: "admin",
        userId: OWNER_ID,
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/auth/logout", (route) => route.fulfill({
    body: JSON.stringify({
      error: "Sign-out service is unavailable",
    }),
    contentType: "application/json",
    status: 503,
  }));

  await page.goto("/account");
  await page.getByRole("button", {
    exact: true,
    name: "Sign out this session",
  }).click();
  const dialog = page.getByRole("dialog", {
    name: "Sign out this session?",
  });
  await dialog.getByRole("button", {
    exact: true,
    name: "Sign out",
  }).click();

  await expect(dialog).toBeVisible();
  await expect(page.getByRole("region", {
    name: "Your sessions",
  }).getByRole("alert")).toContainText(
    "Sign-out service is unavailable",
  );
});

test("does not visit Access logout after an ordinary app sign-out", async ({
  page,
}) => {
  let accessLogoutRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/cdn-cgi/access/logout") {
      accessLogoutRequests += 1;
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
        userId: OWNER_ID,
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
  await page.getByRole("button", {
    exact: true,
    name: "Sign out this session",
  }).click();
  await page.getByRole("button", {
    exact: true,
    name: "Sign out",
  }).click();
  await reloaded;
  expect(accessLogoutRequests).toBe(0);
});

test("lists and revokes another account session with keyboard-safe confirmation", async ({
  page,
}) => {
  await page.unroute("**/api/auth/sessions*");
  let revokedSessionId: string | null = null;
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      providers: ["development"],
      user: {
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        expiresAt: "2026-08-25T00:00:00.000Z",
        globalRole: "admin",
        userId: OWNER_ID,
      },
    }),
    contentType: "application/json",
    status: 200,
  }));
  const sessionRoute = (route: Route) => {
    if (route.request().method() === "DELETE") {
      revokedSessionId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
      );
      return route.fulfill({
        body: JSON.stringify({
          current: false,
          revoked: true,
          revokedAt: "2026-07-25T02:00:00.000Z",
          sessionId: revokedSessionId,
        }),
        contentType: "application/json",
        headers: OWNER_HEADERS,
        status: 200,
      });
    }
    return route.fulfill({
      body: JSON.stringify({
        currentSession: {
          createdAt: "2026-07-25T00:00:00.000Z",
          current: true,
          expiresAt: "2026-08-25T00:00:00.000Z",
          id: "ses_current",
          ipPrefix: "192.0.2.0/24",
          lastSeenAt: "2026-07-25T01:55:00.000Z",
          revokedAt: null,
          status: "active",
          userAgent: "Current browser",
        },
        otherSessions: [
          {
            createdAt: "2026-07-24T00:00:00.000Z",
            current: false,
            expiresAt: "2026-08-24T00:00:00.000Z",
            id: "ses_other",
            ipPrefix: "2001:db8:abcd::/48",
            lastSeenAt: "2026-07-24T03:00:00.000Z",
            revokedAt: null,
            status: "active",
            userAgent: "Other tablet",
          },
          {
            createdAt: "2026-07-23T00:00:00.000Z",
            current: false,
            expiresAt: "2026-08-23T00:00:00.000Z",
            id: "ses_other_two",
            ipPrefix: null,
            lastSeenAt: "2026-07-23T03:00:00.000Z",
            revokedAt: null,
            status: "active",
            userAgent: "Other laptop",
          },
        ],
        page: {
          hasMore: false,
          limit: 25,
          nextCursor: null,
        },
      }),
      contentType: "application/json",
      headers: OWNER_HEADERS,
      status: 200,
    });
  };
  await page.route("**/api/auth/sessions*", sessionRoute);
  await page.route("**/api/auth/sessions/**", sessionRoute);

  await page.goto("/account");
  const otherSession = page.getByRole("article").filter({
    has: page.getByText("ses_other", { exact: true }),
  });
  const secondOtherSession = page.getByRole("article").filter({
    has: page.getByText("ses_other_two", { exact: true }),
  });
  await expect(otherSession).toContainText("Other tablet");
  await expect(otherSession).toContainText("2001:db8:abcd::/48");
  await expect(secondOtherSession.getByRole("button", {
    exact: true,
    name: "Revoke session Other laptop (ses_other_two)",
  })).toBeVisible();
  await otherSession.getByRole("button", {
    exact: true,
    name: "Revoke session Other tablet (ses_other)",
  }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", {
    name: "Revoke this session?",
  })).toBeVisible();
  await expect(page.getByRole("dialog", {
    name: "Revoke this session?",
  })).toContainText("Other tablet (ses_other)");
  await expect(page.getByRole("button", {
    exact: true,
    name: "Cancel",
  })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => revokedSessionId).toBe("ses_other");
  await expect(otherSession).toContainText("revoked");
  await expect(page.getByText(
    "Session revoked. Local work on that device was not deleted.",
  )).toBeVisible();
  await expect(otherSession.getByRole("button", {
    name: "Revoke session Other tablet",
  })).toHaveCount(0);
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
