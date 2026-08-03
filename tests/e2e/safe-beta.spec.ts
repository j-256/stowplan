import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
  Route,
  TestInfo,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspacePath } from "../../src/domain/app-url";
import {
  expect,
  readActiveReplica,
  readLocalReplicas,
  tabTo,
  test,
} from "./safe-beta-fixtures";
import { ACCOUNT_CONTEXT_HEADER } from "../../src/shared/account-context";

const CHROMIUM_RESPONSIVE_PROJECTS = Object.freeze([
  "mobile-chromium",
  "mobile-landscape",
  "tablet-portrait",
  "tablet-landscape",
  "desktop-compact",
  "desktop-chromium",
]);
const PHONE_PROJECT = "mobile-chromium";
const DESKTOP_PROJECT = "desktop-chromium";
const WEBKIT_PHONE_PROJECT = "webkit-phone";
const WEBKIT_TABLET_PROJECT = "webkit-tablet-landscape";
const DATABASE_NAME = "stowplan-v1";
const DATABASE_STORE = "records";
const ACTIVE_CATALOG_ACCOUNT_KEY = "catalog-account:active";
const CATALOG_KEY_PREFIX = "catalog:";

function skipUnlessProject(
  testInfo: TestInfo,
  projects: readonly string[],
): void {
  test.skip(
    !projects.includes(testInfo.project.name),
    `Covered in ${projects.join(", ")}`,
  );
}

function cardFor(page: Page, workspaceName: string): Locator {
  return page.getByRole("article").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: workspaceName,
    }),
  });
}

async function openMobileMore(page: Page): Promise<Locator> {
  await page.getByRole("button", {
    exact: true,
    name: "More",
  }).click();
  const dialog = page.getByRole("dialog", { name: "More" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function navigateToWorkspaceView(
  page: Page,
  view: "Activity" | "Settings",
): Promise<void> {
  const desktopLink = page.locator(".app-shell > aside").getByRole("link", {
    exact: true,
    name: view,
  });
  if (await desktopLink.isVisible()) {
    await desktopLink.click();
    return;
  }
  const dialog = await openMobileMore(page);
  await dialog.getByRole("link", { exact: true, name: view }).click();
}

async function openWorkspaceHub(page: Page): Promise<void> {
  const desktopLink = page.locator(".header-actions").getByRole("link", {
    name: "Workspaces and backup status",
  });
  if (await desktopLink.isVisible()) {
    await desktopLink.click();
    return;
  }
  const dialog = await openMobileMore(page);
  await dialog.getByRole("link", {
    name: "Workspaces and backup status",
  }).click();
}

async function expectWorkspaceRolePermissions(
  page: Page,
  role: "Editor" | "Owner" | "Viewer",
): Promise<void> {
  await expect(page.getByText(`${role} role permissions`, {
    exact: true,
  })).toBeVisible();
}

function syncRequestHasCommands(request: Request): boolean {
  if (
    request.method() !== "POST" ||
    new URL(request.url()).pathname !== "/api/sync"
  ) {
    return false;
  }
  try {
    const body = request.postDataJSON() as { commands?: unknown[] };
    return Array.isArray(body.commands) && body.commands.length > 0;
  } catch {
    return false;
  }
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }))).toEqual({ body: 0, root: 0 });
}

async function expectNoSeriousAccessibilityViolations(
  page: Page,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    results.violations.filter((violation) =>
      violation.impact === "critical" || violation.impact === "serious"
    ),
  ).toEqual([]);
}

async function seedRecoveryOutbox(
  page: Page,
  workspaceId: string,
): Promise<void> {
  await page.evaluate(
    ({
      databaseName,
      storeName,
      workspaceId: expectedWorkspaceId,
      workspaceKey,
    }) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const activeRequest = store.get("active");
        let updateError: Error | null = null;
        transaction.onerror = () => undefined;
        transaction.onabort = () => {
          open.result.close();
          reject(
            updateError ??
              transaction.error ??
              new Error("Could not seed recovery work"),
          );
        };
        transaction.oncomplete = () => {
          open.result.close();
          resolve();
        };
        activeRequest.onerror = () => reject(activeRequest.error);
        activeRequest.onsuccess = () => {
          try {
            const replica = activeRequest.result as {
              authorization?: {
                accessRevision?: number;
                accountId?: string | null;
                membershipRevision?: number;
              };
              outbox?: unknown[];
              state?: {
                workspace?: {
                  id?: string;
                  name?: string;
                  revision?: number;
                };
              };
            } | undefined;
            if (
              replica?.state?.workspace?.id !== expectedWorkspaceId ||
              typeof replica.state.workspace.name !== "string" ||
              typeof replica.state.workspace.revision !== "number"
            ) {
              updateError = new Error(
                "The active workspace was not ready for recovery work",
              );
              transaction.abort();
              return;
            }
            const timestamp = "2026-07-25T18:00:00.000Z";
            const authorization = {
              membershipRevision:
                replica.authorization?.membershipRevision ?? 0,
              workspaceAccessRevision:
                replica.authorization?.accessRevision ?? 0,
            };
            const envelope = (id: string, name: string) => ({
              actorId: replica.authorization?.accountId ?? "local-user",
              authorization,
              baseRevision: replica.state!.workspace!.revision,
              command: { name, type: "workspace.rename" },
              deviceId: "e2e-recovery-device",
              expectations: [{
                id: expectedWorkspaceId,
                path: "name",
                target: "workspace",
                value: replica.state!.workspace!.name,
              }],
              id,
              timestamp,
              workspaceId: expectedWorkspaceId,
            });
            const withRecoveryWork = {
              ...replica,
              outbox: [
                {
                  accountId: replica.authorization?.accountId ?? null,
                  envelope: envelope(
                    "cmd_e2e_pending_recovery",
                    "Pending recovery rename",
                  ),
                  status: "pending",
                },
                {
                  accountId: replica.authorization?.accountId ?? null,
                  envelope: envelope(
                    "cmd_e2e_blocked_recovery",
                    "Blocked recovery rename",
                  ),
                  error:
                    "Workspace rename: the server rejected this edit after access changed",
                  status: "blocked",
                },
              ],
            };
            store.put(withRecoveryWork, "active");
            store.put(withRecoveryWork, workspaceKey);
          } catch (error) {
            updateError = error instanceof Error
              ? error
              : new Error("Could not seed recovery work");
            transaction.abort();
          }
        };
      };
    }),
    {
      databaseName: DATABASE_NAME,
      storeName: DATABASE_STORE,
      workspaceId,
      workspaceKey: `workspace:${workspaceId}`,
    },
  );
}

async function readCatalogState(
  page: Page,
  accountId: string,
): Promise<{
  activeAccountId: string | null;
  workspaceIds: string[];
}> {
  return page.evaluate(
    ({
      activeAccountKey,
      catalogKey,
      databaseName,
      storeName,
    }) => new Promise<{
      activeAccountId: string | null;
      workspaceIds: string[];
    }>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction(storeName);
        const store = transaction.objectStore(storeName);
        const activeRequest = store.get(activeAccountKey);
        const catalogRequest = store.get(catalogKey);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          const catalog = catalogRequest.result as {
            entries?: Array<{ id?: unknown }>;
          } | undefined;
          open.result.close();
          resolve({
            activeAccountId: typeof activeRequest.result === "string"
              ? activeRequest.result
              : null,
            workspaceIds: Array.isArray(catalog?.entries)
              ? catalog.entries.flatMap((entry) =>
                  typeof entry.id === "string" ? [entry.id] : []
                )
              : [],
          });
        };
      };
    }),
    {
      activeAccountKey: ACTIVE_CATALOG_ACCOUNT_KEY,
      catalogKey: `${CATALOG_KEY_PREFIX}${accountId}`,
      databaseName: DATABASE_NAME,
      storeName: DATABASE_STORE,
    },
  );
}

async function newContext(
  browser: Browser,
  origin: string,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL: origin });
}

test(
  "discovers a server workspace and opens it durably without replacing local work @responsive",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    test.slow();
    const localName = `Device pantry ${safeBeta.namespace}`;
    const serverName = `Server pantry ${safeBeta.namespace}`;

    await page.goto("/workspaces");
    await page.getByLabel("Your workspace name").fill(localName);
    await page.getByRole("button", { exact: true, name: "Create" }).click();
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Capture",
    })).toBeVisible();
    const localReplica = await readActiveReplica(page);
    expect(localReplica).not.toBeNull();
    const localWorkspaceId = localReplica!.state.workspace.id;

    const discoveryOwner = await safeBeta.signIn(
      context,
      "discovery owner",
    );
    const serverWorkspace = await safeBeta.createWorkspace(
      context,
      "discovery server",
      serverName,
    );

    const freshContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(freshContext, "discovery owner");
      const freshPage = await freshContext.newPage();
      await freshPage.goto("/workspaces");
      await expect(cardFor(freshPage, serverName)).toHaveCount(1);
      await expect(
        cardFor(freshPage, serverName).getByRole("button", {
          name: "Download and open",
        }),
      ).toBeVisible();
      expect(Object.keys(await readLocalReplicas(freshPage))).toEqual([]);
    } finally {
      await freshContext.close();
    }

    await page.goto("/workspaces");
    const localCard = cardFor(page, localName);
    const serverCard = cardFor(page, serverName);
    await expect(localCard).toHaveCount(1);
    await expect(serverCard).toHaveCount(1);
    await expect(serverCard).toContainText("Owner");
    await expect(serverCard).toContainText("Available from the server");
    await expectNoSeriousAccessibilityViolations(page);

    if (!testInfo.project.name.startsWith("webkit-")) {
      const snapshotUrl =
        `**/api/snapshot?workspaceId=${encodeURIComponent(serverWorkspace.summary.id)}`;
      await page.route(snapshotUrl, async (route) => {
        await route.fulfill({
          body: JSON.stringify({
            authorization: serverWorkspace.authorization,
            state: {
              workspace: {
                id: serverWorkspace.summary.id,
                name: serverName,
              },
            },
            workspace: serverWorkspace.summary,
          }),
          headers: {
            [ACCOUNT_CONTEXT_HEADER]: discoveryOwner.userId,
            "content-type": "application/json",
          },
          status: 200,
        });
      });
      await serverCard.getByRole("button", {
        name: "Download and open",
      }).click();
      await expect(page.getByRole("alert").filter({
        hasText: "failed validation and was not saved",
      })).toBeVisible();
      expect((await readActiveReplica(page))?.state.workspace.id).toBe(
        localWorkspaceId,
      );
      expect(Object.keys(await readLocalReplicas(page))).toEqual([
        localWorkspaceId,
      ]);

      await page.unroute(snapshotUrl);
    }
    await serverCard.getByRole("button", {
      name: "Download and open",
    }).click();
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Capture",
    })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(
        `/workspaces/[^/]*${serverWorkspace.summary.id.replaceAll(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}/capture`,
      ),
    );

    const openedReplicas = await readLocalReplicas(page);
    expect(Object.keys(openedReplicas).sort()).toEqual(
      [localWorkspaceId, serverWorkspace.summary.id].sort(),
    );
    expect((await readActiveReplica(page))?.state.workspace.id).toBe(
      serverWorkspace.summary.id,
    );
    expect(openedReplicas[localWorkspaceId]?.state.workspace.name).toBe(
      localName,
    );

    await page.reload();
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Capture",
    })).toBeVisible();
    expect((await readActiveReplica(page))?.state.workspace.id).toBe(
      serverWorkspace.summary.id,
    );
    await page.goto("/workspaces");
    await expect(cardFor(page, localName)).toHaveCount(1);
    await expect(cardFor(page, serverName)).toHaveCount(1);
    await expectNoHorizontalPageOverflow(page);

    expect([
      ...CHROMIUM_RESPONSIVE_PROJECTS,
      WEBKIT_PHONE_PROJECT,
      WEBKIT_TABLET_PROJECT,
    ]).toContain(testInfo.project.name);
  },
);

test(
  "keeps a known viewer read-only while preserving search and inspection",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [
      ...CHROMIUM_RESPONSIVE_PROJECTS,
      WEBKIT_TABLET_PROJECT,
    ]);
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(ownerContext, "viewer owner");
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "viewer workspace",
        `Viewer pantry ${safeBeta.namespace}`,
      );
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "viewer",
      );
      await safeBeta.redeemInvite(
        context,
        invite.oneTimeUrl,
        "viewer member",
      );

      const mutationRequests: string[] = [];
      page.on("request", (request) => {
        if (syncRequestHasCommands(request)) {
          mutationRequests.push(request.postData() ?? "");
        }
      });
      await page.goto(workspacePath({
        view: "capture",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expect(page.getByText("Viewer access", { exact: true }))
        .toBeVisible();
      const before = await readActiveReplica(page);
      expect(before).not.toBeNull();
      expect(before!.outbox).toEqual([]);

      const markerName = `${workspace.summary.name} marker`;
      await page.getByLabel("Search spaces and items").fill(markerName);
      await expect(page.getByText(markerName, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Save & add next",
      })).toHaveCount(0);

      await page.getByRole("link", {
        exact: true,
        name: "Spaces",
      }).first().click();
      await page.getByLabel("Search spaces").fill("shelf");
      await expect(page.getByRole("heading", {
        name: `${workspace.summary.name} shelf`,
      })).toBeVisible();

      await page.getByRole("link", {
        exact: true,
        name: "Inventory",
      }).first().click();
      await page.getByLabel("Search inventory").fill(markerName);
      await page.getByRole("button", { name: "View details" }).click();
      const itemDialog = page.getByRole("dialog", { name: "Item details" });
      await expect(itemDialog).toBeVisible();
      await itemDialog.getByRole("button", { name: "Close" }).click();

      await page.getByRole("link", {
        exact: true,
        name: "Plan",
      }).first().click();
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Plan",
      })).toBeVisible();
      await navigateToWorkspaceView(page, "Activity");
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Activity",
      })).toBeVisible();
      await navigateToWorkspaceView(page, "Settings");
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Settings",
      })).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Export JSON backup",
      })).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: () => {
            throw new Error("Synthetic object URL failure");
          },
        });
      });
      await page.getByRole("button", {
        name: "Export JSON backup",
      }).click();
      await expect(page.getByRole("alert").filter({
        hasText: "Could not export this workspace backup",
      })).toBeVisible();
      await expect(page.getByLabel("Workspace name")).toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Rename workspace",
      })).toHaveCount(0);
      await expectNoHorizontalPageOverflow(page);

      const after = await readActiveReplica(page);
      expect(after?.state.workspace.revision).toBe(
        before!.state.workspace.revision,
      );
      expect(after?.outbox).toEqual([]);
      expect(mutationRequests).toEqual([]);
    } finally {
      await ownerContext.close();
    }
  },
);

test(
  "allows editor content changes without exposing owner-only access actions",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(ownerContext, "editor owner");
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "editor workspace",
        `Editor pantry ${safeBeta.namespace}`,
      );
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "editor",
      );
      await safeBeta.redeemInvite(
        context,
        invite.oneTimeUrl,
        "editor member",
      );

      await page.goto(workspacePath({
        view: "settings",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expect(page.getByLabel("Workspace name")).toBeVisible();
      const renamed = `Editor changed ${safeBeta.namespace}`;
      const synced = page.waitForResponse((response) =>
        syncRequestHasCommands(response.request())
      );
      await page.getByLabel("Workspace name").fill(renamed);
      await page.getByRole("button", {
        name: "Rename workspace",
      }).click();
      expect((await synced).ok()).toBe(true);
      await expect.poll(async () =>
        (await readActiveReplica(page))?.outbox.length
      ).toBe(0);

      await page.getByRole("link", { name: "Workspace access" }).click();
      await expectWorkspaceRolePermissions(page, "Editor");
      await expect(page.getByRole("heading", {
        name: "Access management is owner-only",
      })).toBeVisible();
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Members",
      })).toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Create invite link",
      })).toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Delete server workspace",
      })).toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Leave shared workspace",
      })).toBeVisible();

      const snapshot = await context.request.get(
        `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
          workspace.summary.id,
        )}`,
      );
      expect(snapshot.ok()).toBe(true);
      expect(
        ((await snapshot.json()) as {
          state: { workspace: { name: string } };
        }).state.workspace.name,
      ).toBe(renamed);
    } finally {
      await ownerContext.close();
    }
  },
);

test(
  "reconciles collaborator changes when the window regains focus",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    await safeBeta.signIn(context, "focus reconciliation owner");
    const workspace = await safeBeta.createWorkspace(
      context,
      "focus reconciliation workspace",
      `Focus pantry ${safeBeta.namespace}`,
    );
    await page.goto(workspacePath({
      view: "settings",
      workspaceId: workspace.summary.id,
      workspaceLabel: workspace.summary.name,
    }));
    await expect(page.getByText(workspace.summary.name, {
      exact: true,
    })).toBeVisible();

    const collaboratorContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(
        collaboratorContext,
        "focus reconciliation owner",
      );
      const collaboratorPage = await collaboratorContext.newPage();
      await collaboratorPage.goto(workspacePath({
        view: "settings",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      const collaboratorName = `Focused update ${safeBeta.namespace}`;
      const collaboratorSync = collaboratorPage.waitForResponse((response) =>
        syncRequestHasCommands(response.request())
      );
      await collaboratorPage.getByLabel("Workspace name").fill(
        collaboratorName,
      );
      await collaboratorPage.getByRole("button", {
        name: "Rename workspace",
      }).click();
      expect((await collaboratorSync).ok()).toBe(true);
      await expect.poll(async () =>
        (await readActiveReplica(collaboratorPage))?.outbox.length
      ).toBe(0);
      await expect(page.getByText(collaboratorName, {
        exact: true,
      })).toHaveCount(0);

      const focusReconciliation = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/sync"
      );
      await page.evaluate(() => dispatchEvent(new Event("focus")));
      expect((await focusReconciliation).ok()).toBe(true);
      await expect(page.getByText(collaboratorName, {
        exact: true,
      })).toBeVisible();
      expect(
        (await readActiveReplica(page))?.state.workspace.name,
      ).toBe(collaboratorName);
    } finally {
      await collaboratorContext.close();
    }
  },
);

test(
  "opens blocked workspace recovery directly from the workspace hub",
  async ({ context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    await safeBeta.signIn(context, "hub recovery owner");
    const workspace = await safeBeta.createWorkspace(
      context,
      "hub recovery workspace",
      `Recovery pantry ${safeBeta.namespace}`,
    );
    await page.goto(workspacePath({
      view: "capture",
      workspaceId: workspace.summary.id,
      workspaceLabel: workspace.summary.name,
    }));
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Capture",
    })).toBeVisible();
    await seedRecoveryOutbox(page, workspace.summary.id);

    await page.goto("/workspaces");
    const card = cardFor(page, workspace.summary.name);
    await expect(card).toContainText(
      "Backup refused one or more local changes",
    );
    await card.getByRole("button", {
      name: "Review sync issues",
    }).click();
    await expect(page).toHaveURL(/\/recovery$/u);
    await expect(page.getByRole("heading", {
      name: "Sync & recovery",
    })).toBeVisible();
    expect((await readActiveReplica(page))?.state.workspace.id).toBe(
      workspace.summary.id,
    );
  },
);

test(
  "manages members and invite links with keyboard-confirmed owner actions",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [
      ...CHROMIUM_RESPONSIVE_PROJECTS,
      WEBKIT_TABLET_PROJECT,
    ]);
    test.slow();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async () => {
          throw new DOMException("Share canceled", "AbortError");
        },
      });
    });
    const owner = await safeBeta.signIn(context, "access owner");
    const workspace = await safeBeta.createWorkspace(
      context,
      "access workspace",
      `Access pantry ${safeBeta.namespace}`,
    );
    const enrollment = await safeBeta.createInvite(
      context,
      workspace.summary.id,
      "viewer",
    );
    const targetContext = await newContext(browser, safeBeta.origin);
    try {
      const target = await safeBeta.redeemInvite(
        targetContext,
        enrollment.oneTimeUrl,
        "access member",
      );
      const ownerSession = await context.request.get(
        `${safeBeta.origin}/api/auth/me`,
      );
      expect(ownerSession.ok()).toBe(true);
      expect(
        ((await ownerSession.json()) as {
          user: { userId: string } | null;
        }).user?.userId,
      ).toBe(owner.userId);
      expect(await page.evaluate(async (origin) => {
        const response = await fetch(`${origin}/api/auth/me`);
        const body = await response.json() as {
          user: { userId?: string } | null;
        };
        return body.user?.userId ?? null;
      }, safeBeta.origin)).toBe(owner.userId);
      const createdInviteBodies: Array<{
        expiresInHours: number;
        role: string;
      }> = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/guest-links")
        ) {
          createdInviteBodies.push(
            request.postDataJSON() as {
              expiresInHours: number;
              role: string;
            },
          );
        }
      });

      await page.goto(workspacePath({
        view: "access",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Members",
      })).toBeVisible();
      await expectNoSeriousAccessibilityViolations(page);
      await expectNoHorizontalPageOverflow(page);

      const targetRole = page.getByLabel(
        `Role for ${target.displayName}`,
      );
      await tabTo(page, targetRole);
      await page.keyboard.press("ArrowDown");
      const roleDialog = page.getByRole("dialog", {
        name: "Confirm role change",
      });
      if (!await roleDialog.isVisible()) {
        await expect(targetRole).toBeFocused();
        await page.keyboard.press("e");
      }
      await expect(roleDialog).toBeVisible();
      await expect(roleDialog.getByRole("button", {
        name: "Cancel",
      })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(roleDialog.getByRole("button", {
        name: "Confirm role",
      })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({
        hasText: `${target.displayName}'s role is now editor`,
      })).toBeVisible();
      await expect(targetRole).toHaveValue("editor");
      await expect(targetRole).toBeFocused();

      const expiry = page.getByLabel("Invitation expires after hours");
      const createInvite = page.getByRole("button", {
        name: "Create invite link",
      });
      await tabTo(page, expiry);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("12");
      await tabTo(page, createInvite);
      await page.keyboard.press("Enter");
      const viewerDialog = page.getByRole("dialog", {
        name: "Invite link created",
      });
      await expect(viewerDialog).toBeVisible();
      await expect(viewerDialog.getByLabel("Single-use enrollment URL"))
        .toBeFocused();
      await expect.poll(() => createdInviteBodies.length).toBe(1);
      expect(createdInviteBodies[0]).toMatchObject({
        expiresInHours: 12,
        role: "viewer",
      });
      const shareButton = viewerDialog.getByRole("button", { name: "Share" });
      await tabTo(page, shareButton);
      await page.keyboard.press("Enter");
      await expect(viewerDialog.getByText(
        "Could not share automatically",
      )).toHaveCount(0);
      const viewerUrl = await viewerDialog
        .getByLabel("Single-use enrollment URL").inputValue();
      const viewerInvitationUrl = new URL(viewerUrl);
      expect(viewerInvitationUrl.pathname).toBe("/guest");
      expect(viewerInvitationUrl.search).toBe("");
      expect(new URLSearchParams(
        viewerInvitationUrl.hash.slice(1),
      ).get("token")).toBeTruthy();
      const doneButton = viewerDialog.getByRole("button", { name: "Done" });
      await tabTo(page, doneButton);
      await page.keyboard.press("Enter");
      await expect(viewerDialog).toBeHidden();
      await expect(createInvite).toBeFocused();

      const editorRadio = page.getByRole("radio", {
        exact: true,
        name: "Editor",
      });
      const viewerRadio = page.getByRole("radio", {
        exact: true,
        name: "Viewer",
      });
      await tabTo(page, viewerRadio);
      await page.keyboard.press("ArrowRight");
      await expect(editorRadio).toBeFocused();
      await expect(editorRadio).toBeChecked();
      await tabTo(page, expiry);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("48");
      await tabTo(page, createInvite);
      await page.keyboard.press("Enter");
      const editorDialog = page.getByRole("dialog", {
        name: "Invite link created",
      });
      await expect(editorDialog).toBeVisible();
      await expect.poll(() => createdInviteBodies.length).toBe(2);
      expect(createdInviteBodies[1]).toMatchObject({
        expiresInHours: 48,
        role: "editor",
      });
      await tabTo(
        page,
        editorDialog.getByRole("button", { name: "Done" }),
      );
      await page.keyboard.press("Enter");
      await expect(editorDialog).toBeHidden();
      await expect(createInvite).toBeFocused();

      const viewerInvitation = page.getByRole("listitem").filter({
        has: page.getByText("Viewer invitation", { exact: true }),
      }).filter({
        has: page.getByText("Active", { exact: true }),
      });
      const revoke = viewerInvitation.getByRole("button", {
        name: "Revoke invite",
      });
      await tabTo(page, revoke);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({
        hasText: "Invite link revoked",
      })).toBeVisible();
      await expect(page.getByRole("listitem").filter({
        has: page.getByText("Viewer invitation", { exact: true }),
      }).filter({
        has: page.getByText("Revoked", { exact: true }),
      })).toBeVisible();

      const targetMember = page.getByRole("listitem").filter({
        hasText: target.displayName,
      });
      const transfer = targetMember.getByRole("button", {
        name: "Transfer ownership",
      });
      await tabTo(page, transfer);
      await page.keyboard.press("Enter");
      const transferDialog = page.getByRole("dialog", {
        name: "Transfer workspace ownership?",
      });
      await expect(transferDialog.getByRole("button", {
        name: "Cancel",
      })).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expectWorkspaceRolePermissions(page, "Editor");
      await expect(page.getByRole("heading", {
        name: "Access management is owner-only",
      })).toBeVisible();
      await expect(page.locator("section[aria-labelledby]").filter({
        has: page.getByRole("heading", {
          exact: true,
          level: 1,
          name: workspace.summary.name,
        }),
      })).toBeFocused();

      const targetPage = await targetContext.newPage();
      await targetPage.goto(workspacePath({
        view: "access",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expectWorkspaceRolePermissions(targetPage, "Owner");
      const formerOwner = targetPage.getByRole("listitem").filter({
        hasText: owner.email,
      });
      const remove = formerOwner.getByRole("button", { name: "Remove" });
      await tabTo(targetPage, remove);
      await targetPage.keyboard.press("Enter");
      const removeDialog = targetPage.getByRole("dialog", {
        name: "Remove workspace member?",
      });
      await expect(removeDialog.getByRole("button", {
        name: "Cancel",
      })).toBeFocused();
      await targetPage.keyboard.press("Tab");
      await targetPage.keyboard.press("Enter");
      await expect(targetPage.getByRole("status").filter({
        hasText: `${owner.displayName} was removed from the workspace`,
      })).toBeVisible();
      await expect(formerOwner).toHaveCount(0);
      await expect(
        targetPage.locator('section[aria-labelledby="members-title"]'),
      ).toBeFocused();
    } finally {
      await targetContext.close();
    }
  },
);

test(
  "keeps invitation previews inert until a signed-in account confirms",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [
      DESKTOP_PROJECT,
      WEBKIT_PHONE_PROJECT,
    ]);
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(ownerContext, "browser invite owner");
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "browser invite workspace",
        `Browser invitation ${safeBeta.namespace}`,
      );
      const returnTo = workspacePath({
        view: "settings",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      });
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "viewer",
        24,
        returnTo,
      );
      const invitationUrl = new URL(invite.oneTimeUrl);
      const rawToken = new URLSearchParams(
        invitationUrl.hash.slice(1),
      ).get("token") ?? "";
      expect(rawToken).toBeTruthy();
      const observedRequests: Array<{
        referer: string;
        url: string;
      }> = [];
      page.on("request", request => {
        observedRequests.push({
          referer: request.headers().referer ?? "",
          url: request.url(),
        });
      });

      await page.goto(invite.oneTimeUrl);
      await expect(page.getByRole("heading", {
        name: "Open the shared workspace?",
      })).toBeVisible();
      await expect(page.locator("p", {
        hasText: "Viewer access offered.",
      })).toContainText(
        "Viewer access offered. You can browse this workspace, but you cannot change its contents.",
      );
      const signInToAccept = page.getByRole("button", {
        name: "Sign in to accept invitation",
      });
      await tabTo(page, signInToAccept);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(
        /\/account\?resume=invitation$/u,
      );

      const linksResponse = await ownerContext.request.get(
        `${safeBeta.origin}/api/workspaces/${encodeURIComponent(
          workspace.summary.id,
        )}/guest-links`,
      );
      expect(linksResponse.ok()).toBe(true);
      const links = (await linksResponse.json()) as {
        guestLinks: {
          guestLinkId: string;
          status: string;
        }[];
      };
      expect(links.guestLinks.find(
        link => link.guestLinkId === invite.guestLink.guestLinkId,
      )?.status).toBe("active");

      const recipient = safeBeta.identity("browser invite member");
      if (testInfo.project.name === WEBKIT_PHONE_PROJECT) {
        await safeBeta.signIn(context, "browser invite member");
        await page.reload();
      } else {
        await page.getByLabel("Name").fill(recipient.name);
        await page.getByLabel("Email").fill(recipient.email);
        await page.getByRole("button", {
          name: "Sign in locally",
        }).click();
      }
      await expect(page.getByRole("heading", {
        name: "Open the shared workspace?",
      })).toBeVisible();
      const acceptInvitation = page.getByRole("button", {
        exact: true,
        name: "Accept invitation",
      });
      await tabTo(page, acceptInvitation);
      const confirmationResponse = page.waitForResponse(response =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/guest"
      );
      await page.keyboard.press("Enter");
      expect((await confirmationResponse).status()).toBe(200);

      await expect(page).toHaveURL(new RegExp(
        `${returnTo.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ));
      expect(observedRequests.some(request =>
        new URL(request.url).pathname === "/api/auth/guest"
      )).toBe(true);
      expect(observedRequests.every(request =>
        !request.url.includes(rawToken) &&
        !request.referer.includes(rawToken)
      )).toBe(true);
      await expect(page.getByText("Viewer access", { exact: true }))
        .toBeVisible();
      await expect(page.getByText(
        "Shared workspace opened. Your previous local workspace is still available from the main menu.",
      )).toHaveCount(0);
      expect((await readActiveReplica(page))?.state.workspace.id).toBe(
        workspace.summary.id,
      );
      const members = await safeBeta.listMembers(
        ownerContext,
        workspace.summary.id,
      );
      expect(members.members.find(
        member => member.email === recipient.email,
      )?.role).toBe("viewer");
      await page.goBack({ waitUntil: "domcontentloaded" });
      expect(page.url()).not.toContain(rawToken);
      expect(page.url()).not.toContain("#token=");
      expect(observedRequests.every(request =>
        !request.url.includes(rawToken) &&
        !request.referer.includes(rawToken)
      )).toBe(true);
    } finally {
      await ownerContext.close();
    }
  },
);

test(
  "rejects a stale tab sync after the shared browser session switches accounts",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    test.slow();
    const secondTab = await context.newPage();
    await page.bringToFront();

    const accountA = await safeBeta.signIn(
      context,
      "account switch A",
    );
    const originalName = `Account A pantry ${safeBeta.namespace}`;
    const workspaceA = await safeBeta.createWorkspace(
      context,
      "account switch workspace A",
      originalName,
    );
    const initialSync = page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/sync";
    });
    await page.goto(workspacePath({
      view: "settings",
      workspaceId: workspaceA.summary.id,
      workspaceLabel: workspaceA.summary.name,
    }));
    await expect(page.getByLabel("Workspace name")).toBeVisible();
    expect((await initialSync).ok()).toBe(true);

    const accountB = await safeBeta.signIn(
      context,
      "account switch B",
    );
    const workspaceB = await safeBeta.createWorkspace(
      context,
      "account switch workspace B",
      `Account B pantry ${safeBeta.namespace}`,
    );
    await context.setExtraHTTPHeaders({});
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...arguments_) => {
        const response = await originalFetch(...arguments_);
        const input = arguments_[0];
        const requestUrl = typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
        if (new URL(requestUrl, location.origin).pathname === "/api/sync") {
          void response.clone().json().then((body: unknown) => {
            if (
              body &&
              typeof body === "object" &&
              "code" in body
            ) {
              document.documentElement.dataset.e2eAccountContextCode =
                String((body as { code: unknown }).code);
            }
          });
        }
        return response;
      };
    });
    const rejectedName = `Retained account A edit ${safeBeta.namespace}`;
    const rejectedSync = page.waitForResponse((response) =>
      syncRequestHasCommands(response.request())
    );
    await page.getByLabel("Workspace name").fill(rejectedName);
    await page.getByRole("button", {
      name: "Rename workspace",
    }).click();
    const response = await rejectedSync;
    expect(response.status()).toBe(409);
    expect(
      await response.request().headerValue(ACCOUNT_CONTEXT_HEADER),
    ).toBe(accountA.userId);
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.dataset.e2eAccountContextCode
    )).toBe("ACCOUNT_CONTEXT_CHANGED");

    await expect(page.getByRole("alert").filter({
      hasText: "The signed-in account changed",
    })).toBeVisible();
    await expect(page.getByRole("alert").filter({
      hasText: "Editing is unavailable until workspace access can be confirmed",
    })).toBeVisible();
    await expect.poll(async () => {
      const replica = await readActiveReplica(page);
      return {
        accountId: replica?.outbox[0]?.accountId,
        name: replica?.state.workspace.name,
        pending: replica?.outbox.filter(
          entry => entry.status === "pending",
        ).length,
      };
    }).toEqual({
      accountId: accountA.userId,
      name: rejectedName,
      pending: 1,
    });

    await secondTab.goto("/workspaces");
    await expect(cardFor(secondTab, workspaceB.summary.name)).toBeVisible();
    await expect.poll(
      () => readCatalogState(secondTab, accountB.userId),
    ).toEqual({
      activeAccountId: accountB.userId,
      workspaceIds: [workspaceB.summary.id],
    });

    const accountBSnapshot = await context.request.get(
      `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
        workspaceA.summary.id,
      )}`,
      {
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: accountB.userId,
        },
      },
    );
    expect(accountBSnapshot.ok()).toBe(false);
    expect(await accountBSnapshot.text()).not.toContain(originalName);
    expect(await readCatalogState(secondTab, accountB.userId)).toEqual({
      activeAccountId: accountB.userId,
      workspaceIds: [workspaceB.summary.id],
    });

    const verifierContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(verifierContext, "account switch A");
      const serverSnapshot = await verifierContext.request.get(
        `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
          workspaceA.summary.id,
        )}`,
      );
      expect(serverSnapshot.ok()).toBe(true);
      expect(
        ((await serverSnapshot.json()) as {
          state: { workspace: { name: string } };
        }).state.workspace.name,
      ).toBe(originalName);
    } finally {
      await verifierContext.close();
    }
  },
);

test(
  "reconciles an offline role downgrade and retains the rejected local command",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [
      DESKTOP_PROJECT,
      WEBKIT_PHONE_PROJECT,
    ]);
    test.slow();
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(ownerContext, "downgrade owner");
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "downgrade workspace",
        `Downgrade pantry ${safeBeta.namespace}`,
      );
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "editor",
      );
      const editor = await safeBeta.redeemInvite(
        context,
        invite.oneTimeUrl,
        "downgrade editor",
      );
      await page.goto(workspacePath({
        view: "settings",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expect(page.getByLabel("Workspace name")).toBeVisible();

      await context.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine))
        .toBe(false);
      const rejectedName = `Offline edit ${safeBeta.namespace}`;
      await page.getByLabel("Workspace name").fill(rejectedName);
      await page.getByRole("button", {
        name: "Rename workspace",
      }).click();
      await expect.poll(async () =>
        (await readActiveReplica(page))?.outbox.filter(
          (entry) => entry.status === "pending",
        ).length
      ).toBe(1);

      await safeBeta.changeMemberRole(
        ownerContext,
        workspace.summary.id,
        editor.userId,
        "viewer",
      );
      const rejectedSync = page.waitForResponse((response) =>
        syncRequestHasCommands(response.request())
      );
      await context.setOffline(false);
      await rejectedSync;

      await expect.poll(async () =>
        (await readActiveReplica(page))?.outbox.filter(
          (entry) => entry.status === "blocked",
        ).length
      ).toBe(1);
      const retained = await readActiveReplica(page);
      expect(retained?.state.workspace.name).toBe(rejectedName);
      expect(retained?.authorization?.role).toBe("viewer");
      expect(retained?.outbox[0]?.error).toMatch(
        /access|authorized|permission|viewer|write/i,
      );
      await expect(page.getByText("Viewer access", { exact: true }))
        .toBeVisible();
      await expect(page.locator(".sync")).toHaveAttribute(
        "aria-label",
        /1 change needs review/u,
      );
      const backupAlert = page.getByRole("alert").filter({
        hasText: "Backup needs attention",
      });
      await expect(backupAlert).toBeVisible();
      const accessMessage = page.locator(".workspace-read-only-banner");
      await expect(accessMessage).toContainText("Viewer access");
      await accessMessage.getByRole("button", {
        name: "Dismiss workspace access message",
      }).click();
      await expect(accessMessage).toBeHidden();
      await expect(backupAlert).toBeVisible();
      await backupAlert.getByRole("link", {
        name: "Review backup",
      }).click();
      await expect(page).toHaveURL(/\/recovery$/u);
      await expect(page.getByRole("heading", {
        name: "Sync & recovery",
      })).toBeVisible();

      const serverSnapshot = await context.request.get(
        `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
          workspace.summary.id,
        )}`,
      );
      expect(serverSnapshot.ok()).toBe(true);
      expect(
        ((await serverSnapshot.json()) as {
          state: { workspace: { name: string } };
        }).state.workspace.name,
      ).toBe(workspace.summary.name);
    } finally {
      if (!page.isClosed()) await context.setOffline(false);
      await ownerContext.close();
    }
  },
);

test(
  "hides owner access controls when reconciliation downgrades the active account",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(ownerContext, "access downgrade owner");
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "access downgrade workspace",
        `Access downgrade ${safeBeta.namespace}`,
      );
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "editor",
      );
      const target = await safeBeta.redeemInvite(
        context,
        invite.oneTimeUrl,
        "access downgrade target",
      );
      await safeBeta.changeMemberRole(
        ownerContext,
        workspace.summary.id,
        target.userId,
        "owner",
      );
      await page.goto(workspacePath({
        view: "access",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Members",
      })).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Create invite link",
      })).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Delete server workspace",
      })).toBeVisible();

      await context.setOffline(true);
      await safeBeta.changeMemberRole(
        ownerContext,
        workspace.summary.id,
        target.userId,
        "viewer",
      );
      const reconciliation = page.waitForResponse((response) => {
        const request = response.request();
        return request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/sync";
      });
      await context.setOffline(false);
      expect((await reconciliation).ok()).toBe(true);

      await expect(page.getByText("Viewer access", { exact: true }))
        .toBeVisible();
      await expectWorkspaceRolePermissions(page, "Viewer");
      await expect(page.getByRole("heading", {
        name: "Access management is owner-only",
      })).toBeVisible();
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Members",
      })).toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Create invite link",
      })).toHaveCount(0);
      await expect(page.getByRole("button", {
        name: "Delete server workspace",
      })).toHaveCount(0);
    } finally {
      if (!page.isClosed()) await context.setOffline(false);
      await ownerContext.close();
    }
  },
);

test(
  "replaces an open access page with retained-copy guidance after remote removal",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    test.slow();
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      const owner = await safeBeta.signIn(
        ownerContext,
        "remote removal owner",
      );
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "remote removal workspace",
        `Remote removal ${safeBeta.namespace}`,
      );
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "editor",
      );
      const target = await safeBeta.redeemInvite(
        context,
        invite.oneTimeUrl,
        "remote removal target",
      );
      await page.goto(workspacePath({
        view: "access",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expectWorkspaceRolePermissions(page, "Editor");
      await expect(page.getByRole("button", {
        name: "Refresh access",
      })).toBeVisible();

      await context.setOffline(true);
      const members = await safeBeta.listMembers(
        ownerContext,
        workspace.summary.id,
      );
      const targetMember = members.members.find(
        member => member.userId === target.userId,
      );
      expect(targetMember).toBeDefined();
      const removal = await ownerContext.request.delete(
        `${safeBeta.origin}/api/workspaces/${encodeURIComponent(
          workspace.summary.id,
        )}/members/${encodeURIComponent(target.userId)}`,
        {
          data: {
            expectedAccessRevision: members.accessRevision,
            expectedMembershipRevision:
              targetMember!.membershipRevision,
          },
          headers: {
            [ACCOUNT_CONTEXT_HEADER]: owner.userId,
            origin: safeBeta.origin,
          },
        },
      );
      expect(removal.status()).toBe(200);

      const reconciliation = page.waitForResponse((response) => {
        const request = response.request();
        return request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/sync";
      });
      await context.setOffline(false);
      expect((await reconciliation).status()).toBe(404);

      await expect(page.getByRole("heading", {
        exact: true,
        name: "Workspace access removed",
      })).toBeVisible();
      await expect(page.getByText(
        "Your server membership was removed. This retained device copy is read-only and is no longer backed up.",
        { exact: true },
      )).toBeVisible();
      await expect(page.getByRole("heading", {
        exact: true,
        name: "Read-only copy retained",
      })).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Workspaces and backup status",
      })).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Refresh access",
      })).toHaveCount(0);
      await expect(page.getByText(
        /^(Owner|Editor|Viewer) role permissions$/,
        { exact: true },
      )).toHaveCount(0);

      const retained = await readActiveReplica(page);
      expect(retained?.authorization?.status).toBe("revoked");
      expect(retained?.authorization?.role).toBeNull();
      await expect(page.locator(".sync")).toContainText("Access removed");
      await expect(page.locator(".sync")).not.toContainText(
        "Backed up online",
      );

      await page.goto(workspacePath({
        view: "settings",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));
      await expect(page.getByText(
        "Your workspace access was removed. This retained device copy is read-only.",
        { exact: true },
      )).toBeVisible();
      await expect(page.getByRole("link", {
        exact: true,
        name: "Workspace access",
      })).toHaveCount(0);
    } finally {
      if (!page.isClosed()) await context.setOffline(false);
      await ownerContext.close();
    }
  },
);

test(
  "keeps each tab on its selected workspace during catalog reconciliation",
  async ({ context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    await safeBeta.signIn(context, "cross-tab owner");
    const workspaceA = await safeBeta.createWorkspace(
      context,
      "cross-tab workspace A",
      `Cross-tab pantry A ${safeBeta.namespace}`,
    );
    const workspaceB = await safeBeta.createWorkspace(
      context,
      "cross-tab workspace B",
      `Cross-tab pantry B ${safeBeta.namespace}`,
    );

    await page.goto("/workspaces");
    await cardFor(page, workspaceA.summary.name).getByRole("button", {
      name: "Download and open",
    }).click();
    await expect(page).toHaveURL(new RegExp(
      `${workspaceA.summary.id}/capture(?:/|$)`,
    ));

    const secondTab = await context.newPage();
    try {
      await secondTab.goto("/workspaces");
      await cardFor(secondTab, workspaceB.summary.name).getByRole("button", {
        name: "Download and open",
      }).click();
      await expect(secondTab).toHaveURL(new RegExp(
        `${workspaceB.summary.id}/capture(?:/|$)`,
      ));

      await page.bringToFront();
      await page.getByRole("link", {
        name: "Workspaces and backup status",
      }).first().click();
      await page.getByRole("button", {
        name: "Refresh server list",
      }).click();
      await expect(cardFor(page, workspaceA.summary.name).getByRole("button", {
        name: "Continue",
      })).toBeVisible();
      await expect(cardFor(page, workspaceB.summary.name).getByRole("button", {
        name: "Open",
      })).toBeVisible();
    } finally {
      await secondTab.close();
    }
  },
);

test(
  "removes only the device copy and rediscovers the server copy on a fresh device",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    await safeBeta.signIn(context, "device removal owner");
    const workspace = await safeBeta.createWorkspace(
      context,
      "device removal workspace",
      `Removal pantry ${safeBeta.namespace}`,
    );
    await page.goto("/workspaces");
    await cardFor(page, workspace.summary.name).getByRole("button", {
      name: "Download and open",
    }).click();
    await page.getByRole("link", {
      name: "Workspaces and backup status",
    }).first().click();
    const secondTab = await context.newPage();
    await secondTab.goto("/workspaces");
    await expect(cardFor(secondTab, workspace.summary.name)).toContainText(
      "Device and server are synchronized",
    );

    const card = cardFor(page, workspace.summary.name);
    await card.getByRole("button", {
      name: "Remove from this device",
    }).click();
    const removalDialog = page.getByRole("dialog", {
      name: `Remove ${workspace.summary.name} from this device?`,
    });
    await expect(removalDialog).toContainText(
      "does not delete the server copy or change membership",
    );
    await removalDialog.getByRole("button", {
      name: "Remove device copy",
    }).click();
    await expect.poll(async () =>
      Object.hasOwn(
        await readLocalReplicas(page),
        workspace.summary.id,
      )
    ).toBe(false);
    await expect(cardFor(page, workspace.summary.name)).toContainText(
      "Available from the server",
    );
    await expect(
      cardFor(page, workspace.summary.name).getByRole("button", {
        name: "Download and open",
      }),
    ).toBeVisible();
    await expect(cardFor(secondTab, workspace.summary.name)).toContainText(
      "Available from the server",
    );
    await expect(
      cardFor(secondTab, workspace.summary.name).getByRole("button", {
        name: "Download and open",
      }),
    ).toBeVisible();

    const freshContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(freshContext, "device removal owner");
      const freshPage = await freshContext.newPage();
      await freshPage.goto("/workspaces");
      await cardFor(freshPage, workspace.summary.name).getByRole("button", {
        name: "Download and open",
      }).click();
      await expect(freshPage.getByRole("heading", {
        exact: true,
        name: "Capture",
      })).toBeVisible();
      expect(
        Object.hasOwn(
          await readLocalReplicas(freshPage),
          workspace.summary.id,
        ),
      ).toBe(true);
    } finally {
      await freshContext.close();
    }
  },
);

test(
  "leaves membership while retaining an explicitly read-only device copy",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    const ownerContext = await newContext(browser, safeBeta.origin);
    try {
      await safeBeta.signIn(ownerContext, "leave owner");
      const workspace = await safeBeta.createWorkspace(
        ownerContext,
        "leave workspace",
        `Leave pantry ${safeBeta.namespace}`,
      );
      const invite = await safeBeta.createInvite(
        ownerContext,
        workspace.summary.id,
        "editor",
      );
      await safeBeta.redeemInvite(
        context,
        invite.oneTimeUrl,
        "leaving editor",
      );
      await page.goto(workspacePath({
        view: "access",
        workspaceId: workspace.summary.id,
        workspaceLabel: workspace.summary.name,
      }));

      await page.getByRole("button", {
        name: "Leave shared workspace",
      }).click();
      const leaveDialog = page.getByRole("dialog", {
        name: `Leave ${workspace.summary.name}?`,
      });
      await expect(leaveDialog).toContainText(
        "removes only your server membership",
      );
      await leaveDialog.getByRole("button", {
        name: "Leave workspace",
      }).click();
      const disposition = page.getByRole("dialog", {
        name: "Choose what happens to the device copy",
      });
      await expect(disposition).toBeVisible();
      await disposition.getByRole("button", {
        name: "Keep read-only copy",
      }).click();
      await expect(page.getByRole("heading", {
        name: "Server membership ended",
      })).toBeVisible();
      await expect(page.locator(".sync")).toContainText("Membership left");
      await expect(page.locator(".sync")).not.toContainText(
        "Backed up online",
      );

      const local = await readActiveReplica(page);
      expect(local?.authorization?.status).toBe("left");
      expect(local?.authorization?.capabilities.write).toBe(false);
      expect(local?.state.workspace.id).toBe(workspace.summary.id);
      const ownerSnapshot = await ownerContext.request.get(
        `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
          workspace.summary.id,
        )}`,
      );
      expect(ownerSnapshot.ok()).toBe(true);
      const formerMemberSnapshot = await context.request.get(
        `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
          workspace.summary.id,
        )}`,
      );
      expect(formerMemberSnapshot.ok()).toBe(false);
    } finally {
      await ownerContext.close();
    }
  },
);

test(
  "retires a backed-up demo before opening a fresh private instance",
  async ({ context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [PHONE_PROJECT, DESKTOP_PROJECT]);
    const owner = await safeBeta.signIn(
      context,
      "isolated demo reset owner",
    );
    await page.reload();
    await page.getByRole("button", {
      name: "Open kitchen demo",
    }).click();
    await page.getByRole("button", {
      name: "Reopen capture",
    }).click();
    await page.getByLabel("Qty").fill("1");
    await page.getByLabel("What is it?").fill(
      `Temporary demo item ${safeBeta.namespace}`,
    );
    const initialBackup = page.waitForResponse((response) =>
      syncRequestHasCommands(response.request())
    );
    await page.getByRole("button", {
      name: "Save & add next",
    }).click();
    expect((await initialBackup).ok()).toBe(true);
    await expect.poll(async () =>
      (await readActiveReplica(page))?.outbox.length
    ).toBe(0);
    const backedUp = await readActiveReplica(page);
    const oldWorkspaceId = backedUp?.state.workspace.id ?? "";
    expect(oldWorkspaceId).toMatch(/^ws_demo/u);
    expect(backedUp?.authorization?.status).toBe("active");
    expect(backedUp?.authorization?.role).toBe("owner");
    const invite = await safeBeta.createInvite(
      context,
      oldWorkspaceId,
      "viewer",
    );

    await openWorkspaceHub(page);
    await cardFor(page, backedUp!.state.workspace.name).getByRole("button", {
      name: "Reset kitchen demo",
    }).click();
    const reset = page.getByRole("dialog", {
      name: "Reset the kitchen demo?",
    });
    await expect(reset).toContainText(
      "permanently deletes this demo's server instance",
    );
    await expect(reset).toContainText(
      "removes its memberships and invite links",
    );
    const serverDeletion = page.waitForResponse((response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname ===
        `/api/workspaces/${encodeURIComponent(oldWorkspaceId)}`
    );
    await reset.getByRole("button", {
      name: "Delete old demo and reset",
    }).click();
    expect((await serverDeletion).ok()).toBe(true);
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Capture",
    })).toBeVisible();
    await expect(page.getByText(
      "Old demo deleted and fresh private demo created",
      { exact: true },
    )).toBeVisible();

    const fresh = await readActiveReplica(page);
    const freshWorkspaceId = fresh?.state.workspace.id ?? "";
    expect(freshWorkspaceId).toMatch(/^ws_demo/u);
    expect(freshWorkspaceId).not.toBe(oldWorkspaceId);
    expect(
      Object.hasOwn(await readLocalReplicas(page), oldWorkspaceId),
    ).toBe(false);
    expect((await context.request.get(
      `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
        oldWorkspaceId,
      )}`,
    )).status()).toBe(404);

    const invitation = new URL(invite.oneTimeUrl);
    const fragment = new URLSearchParams(invitation.hash.slice(1));
    const retiredInvite = await context.request.post(
      `${safeBeta.origin}/api/auth/guest`,
      {
        data: {
          expectedAccountId: owner.userId,
          returnTo: fragment.get("returnTo") ?? "/workspaces",
          token: fragment.get("token") ?? "",
        },
        headers: {
          [ACCOUNT_CONTEXT_HEADER]: owner.userId,
          origin: safeBeta.origin,
        },
      },
    );
    expect(retiredInvite.status()).toBe(409);

    await openWorkspaceHub(page);
    await expect(cardFor(page, fresh!.state.workspace.name)).toHaveCount(1);
  },
);

test(
  "deletes the server workspace without silently deleting the local replica",
  async ({ browser, context, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [
      ...CHROMIUM_RESPONSIVE_PROJECTS,
      WEBKIT_PHONE_PROJECT,
      WEBKIT_TABLET_PROJECT,
    ]);
    await safeBeta.signIn(context, "deletion owner");
    const workspace = await safeBeta.createWorkspace(
      context,
      "deletion workspace",
      `Deletion pantry ${safeBeta.namespace}`,
    );
    const outstandingInvite = await safeBeta.createInvite(
      context,
      workspace.summary.id,
      "viewer",
    );
    await page.goto(workspacePath({
      view: "access",
      workspaceId: workspace.summary.id,
      workspaceLabel: workspace.summary.name,
    }));

    const openDelete = page.getByRole("button", {
      name: "Delete server workspace",
    });
    await expect(openDelete).toBeVisible();
    await seedRecoveryOutbox(page, workspace.summary.id);
    await tabTo(page, openDelete);
    await page.keyboard.press("Enter");
    const deleteDialog = page.getByRole("dialog", {
      name: `Delete ${workspace.summary.name} from the server?`,
    });
    await expect(deleteDialog).toContainText(
      "immediate and not recoverable",
    );
    const confirmation = deleteDialog.getByRole("textbox");
    await expect(confirmation).toBeFocused();
    await confirmation.fill(workspace.summary.name);
    const confirmDelete = deleteDialog.getByRole("button", {
      name: "Delete server workspace",
    });
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(confirmDelete).toBeFocused();
    await page.keyboard.press("Enter");
    const disposition = page.getByRole("dialog", {
      name: "Choose what happens to the device copy",
    });
    await expect(disposition).toBeVisible();
    const keepCopy = disposition.getByRole("button", {
      name: "Keep read-only copy",
    });
    const exportCopy = disposition.getByRole("button", {
      name: "Export recovery copy",
    });
    await expect(keepCopy).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(exportCopy).toBeFocused();
    const downloadPromise = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    expect(stream).not.toBeNull();
    let recoveryText = "";
    for await (const chunk of stream!) {
      recoveryText += chunk.toString();
    }
    const recovery = JSON.parse(recoveryText) as {
      format?: string;
      replica?: {
        outbox?: Array<{
          error?: string;
          status?: string;
        }>;
      };
    };
    expect(recovery.format).toBe("stowplan-recovery-v1");
    expect(recovery.replica?.outbox).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({
        error: expect.stringContaining(
          "server rejected this edit after access changed",
        ),
        status: "blocked",
      }),
    ]);
    await page.keyboard.press("Shift+Tab");
    await expect(keepCopy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", {
      name: "Server workspace deleted",
    })).toBeVisible();
    await expect(page.locator(".sync")).not.toContainText(
      "Backed up online",
    );
    await page.goto("/workspaces");
    const retainedCard = cardFor(page, workspace.summary.name);
    await expect(retainedCard).toContainText("Server deleted");
    await retainedCard.getByRole("button", {
      name: "Remove from this device",
    }).click();
    const retainedRemovalDialog = page.getByRole("dialog", {
      name: `Remove ${workspace.summary.name} from this device?`,
    });
    await expect(retainedRemovalDialog).toContainText(
      "The server copy was deleted. Export this retained device copy first if you need to keep it.",
    );
    await expect(retainedRemovalDialog).toContainText(
      /(?:0 pending and 2 blocked|1 pending and 1 blocked)/u,
    );
    await retainedRemovalDialog.getByRole("button", {
      name: "Cancel",
    }).click();

    const local = await readActiveReplica(page);
    expect(local?.authorization?.status).toBe("deleted");
    expect(local?.state.workspace.id).toBe(workspace.summary.id);
    expect(local?.outbox).toHaveLength(2);
    expect(local?.outbox.filter(entry => entry.status === "blocked").length)
      .toBeGreaterThanOrEqual(1);
    expect(local?.outbox.filter(entry =>
      entry.status === "blocked" &&
      typeof entry.error === "string" &&
      entry.error.length > 0
    )).toHaveLength(
      local?.outbox.filter(entry => entry.status === "blocked").length ?? 0,
    );
    expect(local?.outbox.map(entry => entry.error).join(" ")).toMatch(
      /(?:not found or is inaccessible|server rejected this edit)/u,
    );
    await page.reload();
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Your workspaces",
    })).toBeVisible();
    const reloaded = await readActiveReplica(page);
    expect(reloaded?.authorization?.status).toBe("deleted");
    expect(reloaded?.outbox).toHaveLength(2);
    expect(
      reloaded?.outbox.filter(entry => entry.status === "blocked").length,
    ).toBeGreaterThanOrEqual(1);
    const deletedSnapshot = await context.request.get(
      `${safeBeta.origin}/api/snapshot?workspaceId=${encodeURIComponent(
        workspace.summary.id,
      )}`,
    );
    expect(deletedSnapshot.ok()).toBe(false);

    const inviteUrl = new URL(outstandingInvite.oneTimeUrl);
    const invitationFragment = new URLSearchParams(
      inviteUrl.hash.slice(1),
    );
    const token = invitationFragment.get("token") ?? "";
    const returnTo =
      invitationFragment.get("returnTo") ?? "/workspaces";
    const inviteContext = await newContext(browser, safeBeta.origin);
    try {
      const inviteRecipient = await safeBeta.signIn(
        inviteContext,
        "deleted invite recipient",
      );
      const redemption = await inviteContext.request.post(
        `${safeBeta.origin}/api/auth/guest`,
        {
          data: {
            expectedAccountId: inviteRecipient.userId,
            returnTo,
            token,
          },
          headers: {
            [ACCOUNT_CONTEXT_HEADER]: inviteRecipient.userId,
            origin: safeBeta.origin,
          },
          maxRedirects: 0,
        },
      );
      expect(redemption.status()).not.toBe(302);
    } finally {
      await inviteContext.close();
    }
  },
);

test(
  "returns through sign-in to an ordinary shared workspace URL",
  async ({ browser, page, safeBeta }, testInfo) => {
    skipUnlessProject(testInfo, [
      DESKTOP_PROJECT,
      WEBKIT_PHONE_PROJECT,
    ]);
    const setupContext = await newContext(browser, safeBeta.origin);
    let identity;
    let workspace;
    try {
      identity = await safeBeta.signIn(setupContext, "return owner");
      workspace = await safeBeta.createWorkspace(
        setupContext,
        "return workspace",
        `Return pantry ${safeBeta.namespace}`,
      );
    } finally {
      await setupContext.close();
    }
    const returnPath = workspacePath({
      view: "settings",
      workspaceId: workspace.summary.id,
      workspaceLabel: workspace.summary.name,
    });

    await page.goto(returnPath);
    await expect(page).toHaveURL(/\/account\?returnTo=/);
    if (testInfo.project.name === WEBKIT_PHONE_PROJECT) {
      await safeBeta.signIn(page.context(), "return owner");
      await page.getByRole("link", { name: "Back to Stowplan" }).click();
    } else {
      await page.getByLabel("Email").fill(identity.email);
      await page.getByRole("button", {
        name: "Sign in locally",
      }).click();
    }
    await expect(page.getByRole("heading", {
      exact: true,
      name: "Settings",
    })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`${returnPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
    expect((await readActiveReplica(page))?.state.workspace.id).toBe(
      workspace.summary.id,
    );
  },
);

test(
  "keeps session and global-admin controls usable in WebKit",
  async ({ page }, testInfo) => {
    skipUnlessProject(testInfo, [
      WEBKIT_PHONE_PROJECT,
      WEBKIT_TABLET_PROJECT,
    ]);
    const accountId = "usr_webkit_control";
    const responseHeaders = {
      [ACCOUNT_CONTEXT_HEADER]: accountId,
    };
    let sessionRevoked = false;
    let guestDeleted = false;
    await page.route("**/api/auth/me", route => route.fulfill({
      body: JSON.stringify({
        configured: true,
        providers: ["development"],
        user: {
          displayName: "WebKit administrator",
          email: "webkit-admin@example.test",
          expiresAt: "2026-08-25T00:00:00.000Z",
          globalRole: "admin",
          userId: accountId,
        },
      }),
      contentType: "application/json",
      status: 200,
    }));
    const sessionRoute = (route: Route) => {
      if (route.request().method() === "DELETE") {
        sessionRevoked = true;
        return route.fulfill({
          body: JSON.stringify({
            current: false,
            revoked: true,
            revokedAt: "2026-07-25T02:00:00.000Z",
            sessionId: "ses_webkit_other",
          }),
          contentType: "application/json",
          headers: responseHeaders,
          status: 200,
        });
      }
      return route.fulfill({
        body: JSON.stringify({
          currentSession: {
            createdAt: "2026-07-25T00:00:00.000Z",
            current: true,
            expiresAt: "2026-08-25T00:00:00.000Z",
            id: "ses_webkit_current",
            ipPrefix: "192.0.2.0/24",
            lastSeenAt: "2026-07-25T01:55:00.000Z",
            revokedAt: null,
            status: "active",
            userAgent: "WebKit current device",
          },
          otherSessions: [{
            createdAt: "2026-07-24T00:00:00.000Z",
            current: false,
            expiresAt: "2026-08-24T00:00:00.000Z",
            id: "ses_webkit_other",
            ipPrefix: "2001:db8:abcd::/48",
            lastSeenAt: "2026-07-24T03:00:00.000Z",
            revokedAt: null,
            status: "active",
            userAgent: "WebKit other device",
          }],
          page: {
            hasMore: false,
            limit: 25,
            nextCursor: null,
          },
        }),
        contentType: "application/json",
        headers: responseHeaders,
        status: 200,
      });
    };
    await page.route("**/api/auth/sessions*", sessionRoute);
    await page.route("**/api/auth/sessions/**", sessionRoute);

    await page.goto("/account");
    const otherSession = page.getByRole("article").filter({
      hasText: "ses_webkit_other",
    });
    await otherSession.getByRole("button", {
      name: "Revoke session",
    }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", {
      exact: true,
      name: "Cancel",
    })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => sessionRevoked).toBe(true);
    await expect(otherSession).toContainText("revoked");
    await expectNoHorizontalPageOverflow(page);

    await page.route("**/api/admin/overview*", route => route.fulfill({
      body: JSON.stringify({
        audit: [],
        databaseInventory: {
          entries: [{
            key: "guest-links",
            label: "One-time invite links",
            metrics: [{ kind: "count", label: "active", value: 1 }],
            rowCount: 1,
            table: "guest_links",
          }],
          generatedAt: "2026-07-25T02:00:00.000Z",
        },
        deletions: [],
        guestLinks: [{
          consumed_at: null,
          created_at: "2026-07-25T00:00:00.000Z",
          created_by_display_name: "WebKit administrator",
          created_by_email: "webkit-admin@example.test",
          created_by_user_id: accountId,
          expires_at: "2099-07-26T00:00:00.000Z",
          guest_link_id: "guest_webkit",
          redemption_id: null,
          revoked_at: null,
          role: "viewer",
          workspace_id: "ws_webkit",
          workspace_name: "WebKit workspace",
        }],
        identities: [],
        memberships: [],
        migrations: [],
        oauthStates: [],
        sessions: [],
        users: [],
        workspaces: [],
      }),
      contentType: "application/json",
      headers: responseHeaders,
      status: 200,
    }));
    await page.route("**/api/admin/mutate", async route => {
      const body = route.request().postDataJSON() as {
        action?: string;
      };
      guestDeleted = body.action === "guest.delete";
      await route.fulfill({
        body: JSON.stringify({
          message: "Guest link deleted",
          ok: true,
        }),
        contentType: "application/json",
        headers: responseHeaders,
        status: 200,
      });
    });

    await page.goto("/admin");
    const inventoryLink = page.getByRole("region", {
      name: "Database inventory",
    }).getByRole("link");
    await inventoryLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#admin-guest-links$/u);
    const activeGuestLink = page.getByRole("listitem", {
      name: "Enrollment link guest_webkit for WebKit workspace",
    });
    await expect(activeGuestLink.getByText("active", {
      exact: true,
    })).toBeVisible();
    await activeGuestLink.getByRole("button", {
      exact: true,
      name: "Delete record for enrollment link guest_webkit in WebKit workspace",
    }).click();
    const deletionDialog = page.getByRole("dialog", {
      name: "Delete this guest-link record?",
    });
    await expect(deletionDialog).toBeVisible();
    await deletionDialog.getByRole("button", {
      name: "Delete and invalidate",
    }).click();
    await expect.poll(() => guestDeleted).toBe(true);
    await expect(page.getByText("Guest link deleted")).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
    await expectNoSeriousAccessibilityViolations(page);
  },
);

test(
  "inspects and controls a server workspace through the audited admin surface",
  async ({ page }, testInfo) => {
    skipUnlessProject(testInfo, [
      PHONE_PROJECT,
      DESKTOP_PROJECT,
      WEBKIT_PHONE_PROJECT,
      WEBKIT_TABLET_PROJECT,
    ]);
    const accountId = "usr_admin_inspector";
    const workspaceId = "ws_admin_inspector";
    const workspaceName = "Admin inspection workspace";
    const timestamp = "2026-07-25T04:00:00.000Z";
    const responseHeaders = {
      [ACCOUNT_CONTEXT_HEADER]: accountId,
    };
    const state = {
      activities: [{
        actorId: "usr_workspace_owner",
        commandId: "cmd_private_item",
        id: "activity_private_item",
        label: "Created Private tax records",
        patches: [],
        status: "applied",
        subjectIds: ["item_private_records"],
        timestamp,
        undoneAt: null,
      }],
      audit: [{
        actorId: "usr_workspace_owner",
        id: "audit_private_item",
        label: "Reapplied private records activity",
        targetActivityIds: ["activity_private_item"],
        timestamp,
        type: "reapply",
      }],
      commandReceipts: ["cmd_compacted_private_records"],
      items: [{
        archivedAt: null,
        category: "Records",
        constraints: {
          avoidHumidity: true,
          avoidWarmth: false,
          foodOnly: false,
          keepTogether: null,
          requiredTags: [],
        },
        createdAt: timestamp,
        dimensions: null,
        frequency: "rarely",
        id: "item_private_records",
        locationId: "loc_private_archive",
        name: "Private tax records",
        description: "Inspector-only improvement clue",
        order: 0,
        quantity: 2,
        tags: ["private"],
        unit: "boxes",
        updatedAt: timestamp,
        version: 1,
      }],
      locations: [{
        archivedAt: null,
        captureStatus: "counted",
        code: "ATTIC",
        conditions: {
          dark: false,
          dry: true,
          foodSafe: false,
          humidity: "normal",
          temperature: "normal",
        },
        createdAt: timestamp,
        description: "Restricted household archive",
        dimensions: null,
        id: "loc_private_archive",
        kind: "room",
        name: "Private attic archive",
        order: 0,
        parentId: null,
        tags: ["sensitive"],
        updatedAt: timestamp,
      }],
      plans: [],
      schemaVersion: 2,
      workspace: {
        createdAt: timestamp,
        id: workspaceId,
        name: workspaceName,
        revision: 12,
        updatedAt: timestamp,
      },
    };
    const workspaceRequests: Array<{
      accountId: string | undefined;
      body: Record<string, unknown>;
      method: string;
    }> = [];

    await page.route("**/api/auth/me", route => route.fulfill({
      body: JSON.stringify({
        configured: true,
        providers: ["development"],
        user: {
          displayName: "Workspace inspector",
          email: "inspector@example.test",
          expiresAt: "2026-08-25T00:00:00.000Z",
          globalRole: "admin",
          userId: accountId,
        },
      }),
      contentType: "application/json",
      status: 200,
    }));
    await page.route("**/api/admin/overview*", route => route.fulfill({
      body: JSON.stringify({
        audit: [],
        databaseInventory: {
          entries: [],
          generatedAt: timestamp,
        },
        deletions: [],
        guestLinks: [],
        identities: [],
        memberships: [],
        migrations: [],
        oauthStates: [],
        sessions: [],
        users: [],
        workspaces: [{
          access_revision: 7,
          active_guest_link_count: 2,
          activity_count: state.activities.length,
          activity_patch_count: 0,
          audit_event_count: state.audit.length,
          command_receipt_count: state.commandReceipts.length,
          created_at: timestamp,
          item_count: state.items.length,
          location_count: state.locations.length,
          member_count: 2,
          owner_count: 1,
          plan_count: 0,
          plan_step_count: 0,
          retained_guest_link_count: 2,
          revision: state.workspace.revision,
          snapshot_bytes: JSON.stringify(state).length,
          updated_at: timestamp,
          viewer_is_member: 0,
          workspace_id: workspaceId,
          workspace_name: workspaceName,
        }],
      }),
      contentType: "application/json",
      headers: responseHeaders,
      status: 200,
    }));
    await page.route(
      `**/api/admin/workspaces/${workspaceId}`,
      async route => {
        const request = route.request();
        const body = request.postDataJSON() as Record<string, unknown>;
        workspaceRequests.push({
          accountId: request.headers()[ACCOUNT_CONTEXT_HEADER],
          body,
          method: request.method(),
        });
        if (request.method() === "POST" && body.action === "inspect") {
          await route.fulfill({
            body: JSON.stringify({
              accessRevision: 7,
              createdAt: timestamp,
              inspectedAt: "2026-07-25T04:05:00.000Z",
              operatorRole: null,
              snapshotBytes: JSON.stringify(state).length,
              state,
              updatedAt: timestamp,
              workspaceId,
            }),
            contentType: "application/json",
            headers: responseHeaders,
            status: 200,
          });
          return;
        }
        if (
          request.method() === "POST" &&
          body.action === "takeOwnership"
        ) {
          await route.fulfill({
            body: JSON.stringify({
              accessRevision: 8,
              operatorRole: "owner",
              workspaceId,
            }),
            contentType: "application/json",
            headers: responseHeaders,
            status: 200,
          });
          return;
        }
        if (request.method() === "DELETE") {
          await route.fulfill({
            body: JSON.stringify({
              deleted: true,
              deletedAt: "2026-07-25T04:10:00.000Z",
              deletionId: "deletion_admin_inspector",
              finalAccessRevision: 9,
              finalSnapshotRevision: state.workspace.revision,
              recovery: "not_available",
              workspaceId,
            }),
            contentType: "application/json",
            headers: responseHeaders,
            status: 200,
          });
          return;
        }
        await route.fulfill({
          body: JSON.stringify({ error: "Unexpected inspector request" }),
          contentType: "application/json",
          headers: responseHeaders,
          status: 400,
        });
      },
    );

    await page.goto("/admin");
    const inspectorLink = page.getByRole("link", {
      name: "Inspect content (audited)",
    });
    await expect(page.getByText("No ordinary membership")).toBeVisible();
    await expect(page.getByRole("link", {
      name: "Open member settings",
    })).toHaveCount(0);
    await inspectorLink.focus();
    await expect(inspectorLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/admin/workspaces/${workspaceId}$`, "u"),
    );
    await expect(page.getByRole("heading", {
      exact: true,
      name: workspaceName,
    })).toBeVisible();
    await expect(page.getByText(
      "did not add a workspace membership or local replica",
    )).toBeVisible();
    await expect.poll(() => workspaceRequests.filter(request =>
      request.body.action === "inspect"
    )).toEqual([{
      accountId,
      body: { action: "inspect" },
      method: "POST",
    }]);

    const snapshot = page.getByRole("region", {
      name: "Complete snapshot content",
    }).getByLabel("Complete validated workspace snapshot");
    await expect(snapshot).toContainText("Private attic archive");
    await expect(snapshot).toContainText("Private tax records");
    await expect(snapshot).toContainText("Inspector-only improvement clue");
    await expect(snapshot).toContainText("Reapplied private records activity");
    await expect(snapshot).toContainText("cmd_compacted_private_records");
    await snapshot.focus();
    await expect(snapshot).toBeFocused();
    await expectNoHorizontalPageOverflow(page);
    await expectNoSeriousAccessibilityViolations(page);

    if (testInfo.project.name === DESKTOP_PROJECT) {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", {
        name: "Export inspected snapshot",
      }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(
        "admin-inspection-workspace-admin-inspection.json",
      );
      const stream = await download.createReadStream();
      expect(stream).not.toBeNull();
      let exportedText = "";
      for await (const chunk of stream!) {
        exportedText += chunk.toString();
      }
      const exported = JSON.parse(exportedText) as typeof state;
      expect(exported.items[0]).toEqual(expect.objectContaining({
        name: "Private tax records",
        description: "Inspector-only improvement clue",
      }));
      expect(exported.commandReceipts).toContain(
        "cmd_compacted_private_records",
      );
    }

    const custodyButton = page.getByRole("button", {
      name: "Take owner custody",
    });
    await custodyButton.focus();
    await page.keyboard.press("Enter");
    const custodyDialog = page.getByRole("dialog", {
      name: "Take owner custody?",
    });
    await expect(custodyDialog).toBeVisible();
    await expect(custodyDialog.getByRole("button", {
      exact: true,
      name: "Cancel",
    })).toBeFocused();
    await page.keyboard.press("Tab");
    const confirmCustody = custodyDialog.getByRole("button", {
      name: "Add owner membership",
    });
    await expect(confirmCustody).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText(
      "Owner custody added and audited",
    )).toBeVisible();
    await expect(page.getByText("Owner custody is active")).toBeVisible();
    await expect(page.getByRole("link", {
      name: "Open member settings",
    })).toHaveAttribute(
      "href",
      "/workspaces/admin-inspection-workspace@ws_admin_inspector/settings",
    );
    await expect(page.getByRole("region", {
      name: "Operator controls",
    })).toBeFocused();
    await expect.poll(() => workspaceRequests.filter(request =>
      request.body.action === "takeOwnership"
    )).toEqual([{
      accountId,
      body: {
        action: "takeOwnership",
        expectedAccessRevision: 7,
      },
      method: "POST",
    }]);

    const deleteButton = page.getByRole("button", {
      name: "Delete server workspace",
    });
    await deleteButton.focus();
    await page.keyboard.press("Enter");
    const deletionDialog = page.getByRole("dialog", {
      name: "Delete this server workspace?",
    });
    await expect(deletionDialog).toContainText(
      "no server-side recovery window",
    );
    const confirmation = deletionDialog.getByRole("textbox");
    await expect(confirmation).toBeFocused();
    const confirmDelete = deletionDialog.getByRole("button", {
      name: "Delete server workspace",
    });
    await expect(confirmDelete).toBeDisabled();
    await confirmation.fill("Admin inspection workspac");
    await expect(confirmDelete).toBeDisabled();
    await confirmation.fill(workspaceName);
    await expect(confirmDelete).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(deletionDialog.getByRole("button", {
      exact: true,
      name: "Cancel",
    })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirmDelete).toBeFocused();
    await expectNoHorizontalPageOverflow(page);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", {
      name: "Server workspace deleted",
    })).toBeVisible();
    await expect(page.getByText(
      "There is no server-side recovery window",
    )).toBeVisible();
    await expect(page.getByText(
      "prevents stale devices, sync, membership changes, and guest redemption",
    )).toBeVisible();
    await expect.poll(() => workspaceRequests.filter(request =>
      request.method === "DELETE"
    )).toEqual([{
      accountId,
      body: {
        confirmationName: workspaceName,
        expectedAccessRevision: 8,
        expectedRevision: state.workspace.revision,
      },
      method: "DELETE",
    }]);
    await expectNoHorizontalPageOverflow(page);
    await expectNoSeriousAccessibilityViolations(page);
  },
);

test(
  "ignores an older inspection response after newer custody reconciliation",
  async ({ page }, testInfo) => {
    skipUnlessProject(testInfo, [DESKTOP_PROJECT]);
    const accountId = "usr_admin_inspection_race";
    const workspaceId = "ws_admin_inspection_race";
    const workspaceName = "Inspection race workspace";
    const initialTimestamp = "2026-07-25T05:00:00.000Z";
    const newerTimestamp = "2026-07-25T05:05:00.000Z";
    const responseHeaders = {
      [ACCOUNT_CONTEXT_HEADER]: accountId,
    };
    const initialState = {
      activities: [],
      audit: [],
      commandReceipts: [],
      items: [],
      locations: [],
      plans: [],
      schemaVersion: 2,
      workspace: {
        createdAt: initialTimestamp,
        id: workspaceId,
        name: workspaceName,
        revision: 4,
        updatedAt: initialTimestamp,
      },
    };
    const newerState = {
      ...initialState,
      workspace: {
        ...initialState.workspace,
        revision: 5,
        updatedAt: newerTimestamp,
      },
    };
    let inspectionCalls = 0;
    let staleRequestCompleted = false;
    let releaseStaleRequest: () => void = () => undefined;
    let releaseLatestRequest: () => void = () => undefined;
    const staleRequestGate = new Promise<void>((resolve) => {
      releaseStaleRequest = resolve;
    });
    const latestRequestGate = new Promise<void>((resolve) => {
      releaseLatestRequest = resolve;
    });

    await page.route("**/api/auth/me", route => route.fulfill({
      body: JSON.stringify({
        configured: true,
        providers: ["development"],
        user: {
          displayName: "Inspection race administrator",
          email: "inspection-race@example.test",
          expiresAt: "2026-08-25T00:00:00.000Z",
          globalRole: "admin",
          userId: accountId,
        },
      }),
      contentType: "application/json",
      status: 200,
    }));
    await page.route(
      `**/api/admin/workspaces/${workspaceId}`,
      async route => {
        const body = route.request().postDataJSON() as {
          action?: string;
        };
        if (
          route.request().method() !== "POST" ||
          body.action !== "inspect"
        ) {
          await route.fulfill({
            body: JSON.stringify({ error: "Unexpected inspector request" }),
            contentType: "application/json",
            headers: responseHeaders,
            status: 400,
          });
          return;
        }
        inspectionCalls += 1;
        const requestNumber = inspectionCalls;
        if (requestNumber === 2) await staleRequestGate;
        if (requestNumber === 3) await latestRequestGate;
        const latest = requestNumber === 3;
        await route.fulfill({
          body: JSON.stringify({
            accessRevision: latest ? 8 : 7,
            createdAt: initialTimestamp,
            inspectedAt: latest ? newerTimestamp : initialTimestamp,
            operatorRole: latest ? "owner" : null,
            snapshotBytes: JSON.stringify(
              latest ? newerState : initialState,
            ).length,
            state: latest ? newerState : initialState,
            updatedAt: latest ? newerTimestamp : initialTimestamp,
            workspaceId,
          }),
          contentType: "application/json",
          headers: responseHeaders,
          status: 200,
        });
        if (requestNumber === 2) staleRequestCompleted = true;
      },
    );

    try {
      await page.goto(`/admin/workspaces/${workspaceId}`);
      await expect(page.getByRole("heading", {
        exact: true,
        name: workspaceName,
      })).toBeVisible();
      const refresh = page.getByRole("button", {
        name: /Refresh/,
      });
      await refresh.evaluate((element) => {
        const button = element as HTMLButtonElement;
        button.click();
        button.click();
      });
      await expect.poll(() => inspectionCalls).toBe(3);
      await expect(refresh).toBeDisabled();
      await expect(page.getByRole("button", {
        name: "Take owner custody",
      })).toBeDisabled();
      await expect(page.getByRole("button", {
        name: "Delete server workspace",
      })).toBeDisabled();
      releaseLatestRequest();
      await expect(page.getByText("Owner custody is active")).toBeVisible();
      await expect(page.getByText("Access revision").locator(".."))
        .toContainText("8");
      await expect(page.getByText("Snapshot revision").locator(".."))
        .toContainText("5");

      releaseStaleRequest();
      await expect.poll(() => staleRequestCompleted).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      await expect(page.getByText("Owner custody is active")).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Take owner custody",
      })).toHaveCount(0);
      await expect(page.getByText("Access revision").locator(".."))
        .toContainText("8");
      await expect(page.getByText("Snapshot revision").locator(".."))
        .toContainText("5");
    } finally {
      releaseLatestRequest();
      releaseStaleRequest();
    }
  },
);
