import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { workspacePath } from "../../src/domain/app-url";

const MAX_FACING_CONTENT_GAP = 54;
const MAX_PANEL_GUTTER = 16;
const MAX_PANEL_PADDING = 18;
const MAX_PANEL_SHELL_PADDING = 22;
const MIN_RESIZE_TARGET = 32;
const MOCK_ACCOUNT_ID = "user_test";
const MOCK_ACCOUNT_HEADERS = Object.freeze({
  "x-stowplan-account-id": MOCK_ACCOUNT_ID,
});
const MOCK_OWNER_CAPABILITIES = Object.freeze({
  delete: true,
  leave: false,
  manageAccess: true,
  read: true,
  write: true,
});

function mockOwnerSyncResponse(
  state: {
    workspace: {
      id: string;
      name: string;
      revision: number;
      updatedAt: string;
    };
  },
  commands: readonly { id: string }[],
) {
  return {
    authorization: {
      accessRevision: 1,
      accountId: MOCK_ACCOUNT_ID,
      capabilities: MOCK_OWNER_CAPABILITIES,
      checkedAt: state.workspace.updatedAt,
      kind: "server",
      membershipRevision: 1,
      role: "owner",
      status: "active",
    },
    receipts: commands.map((command) => ({
      commandId: command.id,
      revision: state.workspace.revision,
      status: "applied",
    })),
    state,
    workspace: {
      accessRevision: 1,
      accountId: MOCK_ACCOUNT_ID,
      capabilities: MOCK_OWNER_CAPABILITIES,
      id: state.workspace.id,
      membershipRevision: 1,
      name: state.workspace.name,
      revision: state.workspace.revision,
      role: "owner",
      updatedAt: state.workspace.updatedAt,
    },
  };
}

async function localReplica(page: Page) {
  const handle = await page.waitForFunction(() =>
    new Promise<false | Record<string, unknown>>((resolve, reject) => {
      const open = indexedDB.open("stowplan-v1", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction("records")
          .objectStore("records")
          .get("active");
        request.onerror = () => {
          database.close();
          reject(request.error);
        };
        request.onsuccess = () => {
          const replica = request.result as Record<string, unknown> | undefined;
          database.close();
          resolve(replica ?? false);
        };
      };
    })
  );
  try {
    return await handle.jsonValue() as Record<string, unknown>;
  } finally {
    await handle.dispose();
  }
}

async function expectCompactPanelSpacing(panel: Locator): Promise<void> {
  const spacing = await panel.evaluate((element) => {
    const sections = [
      ...element.querySelectorAll<HTMLElement>(":scope > section"),
    ];
    const primary = sections[0];
    const secondary = sections[1];
    const measure = (section: HTMLElement) => {
      const bounds = section.getBoundingClientRect();
      const styles = getComputedStyle(section);
      const borderBottom = Number.parseFloat(styles.borderBottomWidth);
      const borderLeft = Number.parseFloat(styles.borderLeftWidth);
      const borderRight = Number.parseFloat(styles.borderRightWidth);
      const borderTop = Number.parseFloat(styles.borderTopWidth);
      const paddingBottom = Number.parseFloat(styles.paddingBottom);
      const paddingLeft = Number.parseFloat(styles.paddingLeft);
      const paddingRight = Number.parseFloat(styles.paddingRight);
      const paddingTop = Number.parseFloat(styles.paddingTop);
      return {
        bounds,
        contentBottom: bounds.bottom - borderBottom - paddingBottom,
        contentLeft: bounds.left + borderLeft + paddingLeft,
        contentRight: bounds.right - borderRight - paddingRight,
        contentTop: bounds.top + borderTop + paddingTop,
        paddings: [paddingTop, paddingRight, paddingBottom, paddingLeft],
      };
    };
    const primaryBox = primary ? measure(primary) : undefined;
    const secondaryBox = secondary ? measure(secondary) : undefined;
    const layout = element.dataset.panelLayout;
    const resizerBounds = element.querySelector<HTMLElement>(".pane-resizer")
      ?.getBoundingClientRect();
    const styles = getComputedStyle(element);
    const sideBySide = layout === "side-by-side";
    return {
      facingContentGap: primaryBox && secondaryBox
        ? sideBySide
          ? secondaryBox.contentLeft - primaryBox.contentRight
          : secondaryBox.contentTop - primaryBox.contentBottom
        : Number.POSITIVE_INFINITY,
      innerPaddings: sections.flatMap((section) => measure(section).paddings),
      layout,
      resizeContentClearance: sideBySide
        && primaryBox
        && secondaryBox
        && resizerBounds
        ? Math.min(
          resizerBounds.left - primaryBox.contentRight,
          secondaryBox.contentLeft - resizerBounds.right,
        )
        : null,
      resizeTarget: resizerBounds?.width ?? 0,
      separation: primaryBox && secondaryBox
        ? sideBySide
          ? secondaryBox.bounds.left - primaryBox.bounds.right
          : secondaryBox.bounds.top - primaryBox.bounds.bottom
        : Number.POSITIVE_INFINITY,
      shellPadding: Math.max(
        Number.parseFloat(styles.paddingLeft),
        Number.parseFloat(styles.paddingRight),
      ),
    };
  });

  expect(spacing.shellPadding).toBeLessThanOrEqual(MAX_PANEL_SHELL_PADDING);
  expect(Math.max(...spacing.innerPaddings)).toBeLessThanOrEqual(
    MAX_PANEL_PADDING,
  );
  expect(spacing.facingContentGap).toBeLessThanOrEqual(
    MAX_FACING_CONTENT_GAP,
  );
  expect(spacing.separation).toBeGreaterThanOrEqual(0);
  expect(spacing.separation).toBeLessThanOrEqual(MAX_PANEL_GUTTER);
  if (spacing.layout === "side-by-side") {
    expect(spacing.resizeContentClearance).toBeGreaterThanOrEqual(0);
    expect(spacing.resizeTarget).toBeGreaterThanOrEqual(MIN_RESIZE_TARGET);
  }
}

async function holdNativeDrag(
  page: Page,
  source: Locator,
  target: Locator,
  targetPosition = 0.5,
): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Drag endpoints are not visible");
  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height * targetPosition,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 16 });
  await page.mouse.move(end.x + 1, end.y, { steps: 2 });
}

async function dispatchNativeDrop(
  page: Page,
  source: Locator,
  target: Locator,
  targetPosition = 0.5,
): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("Drop target is not visible");
  const clientX = targetBox.x + targetBox.width / 2;
  const clientY = targetBox.y + targetBox.height * targetPosition;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent("dragstart", { dataTransfer });
    await target.dispatchEvent("dragover", {
      clientX,
      clientY,
      dataTransfer,
    });
    await target.dispatchEvent("drop", {
      clientX,
      clientY,
      dataTransfer,
    });
    await source.dispatchEvent("dragend", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function dispatchNativeCancel(
  page: Page,
  source: Locator,
): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent("dragstart", { dataTransfer });
    await source.dispatchEvent("dragend", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function reopenCurrentCapture(page: Page): Promise<void> {
  const reopen = page.getByRole("button", { name: "Reopen capture" });
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(reopen).toBeHidden();
  await expect(page.getByRole("button", { name: "Counted & next" })).toBeVisible();
}

async function reopenCaptureLocation(
  page: Page,
  locationId: string,
): Promise<void> {
  await page.locator(".nav:visible", { hasText: "Capture" }).click();
  await page.locator(
    `.capture-location-row[data-location-id="${locationId}"] .queue-row`,
  ).click();
  await reopenCurrentCapture(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("stowplan-v1");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }));
  await page.reload();
});

test("names a new workspace during first run", async ({ page }) => {
  await expect(page.getByRole("link", { name: "Open Account" })).toHaveAttribute(
    "href",
    "/account?returnTo=%2Fworkspaces",
  );
  await page.getByRole("textbox", {
    name: "New device workspace",
  }).fill("Jamie's apartment");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
  await expect(page.getByText("Jamie's apartment", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "No containers yet. Add your first space below.",
  )).toBeVisible();
  await expect(page.locator(".capture-order-help")).toHaveCount(0);
  const replica = await localReplica(page) as { state: { workspace: { name: string } } };
  expect(replica.state.workspace.name).toBe("Jamie's apartment");
});

test("uses one application name in invitation titles", async ({ page }) => {
  await page.goto("/guest");
  await expect(page).toHaveTitle(
    "Accept workspace invitation · Stowplan",
  );
});

test("names and links account-deletion workspace blockers", async ({
  page,
}) => {
  const workspaceId = "ws_private_identifier";
  const workspaceName = "Bob's Box Room";
  const accountHeaders = {
    "content-type": "application/json",
    "x-stowplan-account-id": MOCK_ACCOUNT_ID,
  };
  await page.route("**/api/auth/me", route => route.fulfill({
    body: JSON.stringify({
      accessMigrationAvailable: false,
      configured: true,
      providers: ["development"],
      turnstileSiteKey: null,
      user: {
        displayName: "Bob",
        email: "bob@example.test",
        expiresAt: "2099-07-26T12:00:00.000Z",
        globalRole: "user",
        userId: MOCK_ACCOUNT_ID,
      },
    }),
    headers: accountHeaders,
    status: 200,
  }));
  await page.route("**/api/auth/sessions*", route => route.fulfill({
    body: JSON.stringify({
      currentSession: {
        createdAt: "2026-07-26T11:00:00.000Z",
        current: true,
        expiresAt: "2099-07-26T12:00:00.000Z",
        id: "ses_bob",
        ipPrefix: null,
        lastSeenAt: "2026-07-26T12:00:00.000Z",
        revokedAt: null,
        status: "active",
        userAgent: "Chrome for Testing",
      },
      otherSessions: [],
      page: {
        hasMore: false,
        limit: 50,
        nextCursor: null,
      },
    }),
    headers: accountHeaders,
    status: 200,
  }));
  await page.route("**/api/account/deletion", route => route.fulfill({
    body: JSON.stringify({
      deletion: {
        accountRevision: 3,
        blockers: [{
          code: "FINAL_WORKSPACE_OWNER",
          workspaceId,
          workspaceName,
        }],
        custodyTransfers: [],
        globalRole: "user",
        membershipCount: 1,
        membershipRevision: 4,
        status: "active",
        userId: MOCK_ACCOUNT_ID,
      },
    }),
    headers: accountHeaders,
    status: 200,
  }));

  await page.goto("/account");
  await page.getByRole("button", {
    name: "Review account deletion",
  }).click();
  const blockers = page.getByRole("alert").filter({
    hasText: "Deletion is blocked",
  });
  await expect(blockers).toContainText(
    `Transfer or delete ${workspaceName} before deleting the account.`,
  );
  await expect(blockers).not.toContainText(workspaceId);
  await expect(blockers.getByRole("link", {
    name: workspaceName,
  })).toHaveAttribute("href", workspacePath({
    view: "access",
    workspaceId,
    workspaceLabel: workspaceName,
  }));
});

test("names label choices and toggles the complete selection", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await expect(page.getByRole("heading", {
    exact: true,
    name: "Capture",
  })).toBeVisible();
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state?: { locations?: unknown[] };
    };
    return replica.state?.locations?.length ?? 0;
  }).toBeGreaterThan(0);
  await page.goto("/labels");

  const kitchen = page.getByRole("checkbox", {
    name: "Include KIT, Kitchen",
  });
  await expect(kitchen).toBeChecked();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect.poll(() => page.getByRole("checkbox").evaluateAll(
    (checkboxes) => checkboxes.every(
      (checkbox) => !(checkbox as HTMLInputElement).checked,
    ),
  )).toBe(true);
  await expect(page.getByRole("button", { name: "Select all" })).toBeVisible();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(kitchen).toBeChecked();
  await expect(page.getByRole("button", { name: "Clear all" })).toBeVisible();
});

test("starts workspaces and primary views at the top", async ({ page }) => {
  const demo = page.getByRole("button", {
    name: "Open kitchen demo",
  });
  await demo.scrollIntoViewIfNeeded();
  await demo.click();
  const appMain = page.locator(".app-shell > main");
  await expect(appMain).toBeVisible();
  await expect.poll(() => appMain.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  const usesAppScroller = await appMain.evaluate(
    (element) => getComputedStyle(element).overflowY === "auto",
  );
  if (usesAppScroller) {
    await appMain.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect.poll(
      () => appMain.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
  } else {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  }
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  await expect.poll(() => appMain.evaluate((element) => element.scrollTop)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("gives tabs, spaces, filters, and item editors restorable URLs", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  const replica = await localReplica(page) as {
    state: { workspace: { id: string } };
  };
  const workspacePrefix =
    `/workspaces/kitchen-reset@${encodeURIComponent(replica.state.workspace.id)}`;

  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/capture/locations/kit-kitchen@loc_kitchen$`),
  );
  const plan = page.locator(".nav:visible", { hasText: "Plan" });
  await expect(plan).toHaveAttribute("href", `${workspacePrefix}/plan`);
  await plan.click();
  await expect(page).toHaveURL(new RegExp(`${workspacePrefix}/plan$`));
  await expect(page).toHaveTitle(/Plan · Kitchen reset · Stowplan/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Capture", exact: true })).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/capture/locations/kit-kitchen@loc_kitchen$`),
  );
  await page.locator(
    '.capture-location-row[data-location-id="loc_bin"] .queue-row',
  ).click();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/capture/locations/b-17-baking-bin@loc_bin$`),
  );

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/inventory/locations/b-17-baking-bin@loc_bin$`),
  );
  await page.locator('[data-item-id="item_flour"] .item-name').click();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/inventory/items/all-purpose-flour@item_flour$`),
  );
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Review item" })).toBeVisible();
  await page.getByRole("button", { name: "Close item editor" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `${workspacePrefix}/inventory/locations/b-17-baking-bin@loc_bin$`,
    ),
  );
  await expect(page.locator(".inventory-marker")).toHaveCount(0);
  await expect(page.locator(".inventory-row .reorder-drop-copy:visible"))
    .toHaveCount(0);
  const locationLink = page.locator(
    '.inventory-row[data-item-id="item_flour"] .location-path',
  );
  await expect(locationLink).toHaveAttribute(
    "href",
    `${workspacePrefix}/spaces/locations/b-17-baking-bin@loc_bin`,
  );
  await locationLink.click();
  await expect(page.getByRole("heading", {
    name: "Spaces",
    exact: true,
  })).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/spaces/locations/b-17-baking-bin@loc_bin$`),
  );
});

test("closes item routes without duplicating Inventory history", async ({
  page,
}) => {
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();
  await expect(page).toHaveURL(/\/capture\/locations\//);
  const captureUrl = page.url();
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  const inventoryUrl = page.url();
  const itemLink = page.locator(
    '[data-item-id="item_flour"] .item-name',
  );
  await itemLink.click();
  const itemUrl = page.url();
  expect(await page.evaluate(() => history.state?.itemModal)).toBe(true);

  await page.getByRole("button", { name: "Close item editor" }).click();
  await expect(page).toHaveURL(inventoryUrl);
  await page.goBack();
  await expect(page.getByRole("heading", {
    name: "Capture",
    exact: true,
  })).toBeVisible();
  await expect(page).toHaveURL(captureUrl);

  await page.goForward();
  await expect(page.getByRole("heading", {
    name: "Inventory",
    exact: true,
  })).toBeVisible();
  await expect(page).toHaveURL(inventoryUrl);
  await page.goBack();
  await expect(page.getByRole("heading", {
    name: "Capture",
    exact: true,
  })).toBeVisible();
  await expect(page).toHaveURL(captureUrl);

  await page.goto(itemUrl);
  await expect(page.getByRole("dialog", { name: "Review item" })).toBeVisible();
  await page.getByRole("button", { name: "Close item editor" }).click();
  await expect(page).toHaveURL(inventoryUrl);
  await page.goBack();
  await expect(page.getByRole("heading", {
    name: "Capture",
    exact: true,
  })).toBeVisible();
  await expect(page).toHaveURL(captureUrl);
});

test("refuses stale item and space targets without rewriting their URLs", async ({
  page,
}) => {
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();
  const replica = await localReplica(page) as {
    state: { workspace: { id: string } };
  };
  const workspacePrefix =
    `/workspaces/kitchen-reset@${encodeURIComponent(replica.state.workspace.id)}`;

  await page.locator(
    '.capture-location-row[data-location-id="loc_bin"] .queue-row',
  ).click();
  await page.getByRole("button", { name: "Reopen capture" }).click();
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.locator('[data-item-id="item_flour"] .item-name').click();
  const moreActions = page.getByText("More actions", { exact: true });
  await moreActions.focus();
  await page.keyboard.press("Enter");
  const deleteItem = page.getByRole("button", {
    name: "Delete item record",
  });
  await deleteItem.focus();
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /item/i })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${workspacePrefix}/inventory$`));

  const archivedItemUrl =
    `${workspacePrefix}/inventory/items/all-purpose-flour@item_flour`;
  await page.goto(archivedItemUrl);
  await expect(page.locator(".workspace-notice")).toContainText(
    "This item link is stale. The item is missing or archived",
  );
  await expect(page.locator(".workspace-notice")).toBeVisible();
  await expect(page.locator(".feedback-toast")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /item/i })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${archivedItemUrl}$`));

  const missingSpaceUrl =
    `${workspacePrefix}/spaces/locations/missing-space@loc_missing`;
  await page.goto(missingSpaceUrl);
  await expect(page.locator(".workspace-notice")).toContainText(
    "This space link is stale. The space is missing or archived",
  );
  await expect(page.locator(".workspace-notice")).toBeVisible();
  await expect(page.locator(".feedback-toast")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${missingSpaceUrl}$`));
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await expect(page).toHaveURL(new RegExp(`${workspacePrefix}/inventory$`));
  await expect(page.locator(".workspace-notice")).toHaveCount(0);
});

test("announces share outcomes without reporting an ordinary cancel", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          sessionStorage.setItem("shared-view", value);
        },
      },
    });
  });

  await page.getByLabel("Share this view").click();
  await expect(page.locator(".feedback-toast[role='status']")).toContainText(
    "Link copied",
  );
  expect(await page.evaluate(() => sessionStorage.getItem("shared-view")))
    .toBe(page.url());

  await page.getByRole("button", { name: "Dismiss message" }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  await page.getByLabel("Share this view").click();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Could not share automatically",
  );

  await page.getByRole("button", { name: "Dismiss message" }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("Canceled", "AbortError");
      },
    });
  });
  await page.getByLabel("Share this view").click();
  await expect(page.locator(".feedback-toast")).toHaveCount(0);
});

test("collapses the desktop sidebar and persists the icon-only preference", async ({ page }, testInfo) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) <= 799 ||
      testInfo.project.name === "mobile-landscape",
    "Phone, narrow-tablet, and short touch layouts use compact navigation",
  );
  await page.getByRole("button", { name: "Open kitchen demo" }).click();

  const shell = page.locator(".app-shell");
  const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
  const expandedWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect.poll(
    () => sidebar.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeLessThan(expandedWidth);

  await page.reload();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
  await expect(page.locator("aside .nav").first()).toHaveAttribute("title", "Capture");
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");
});

test("keeps short touch landscape navigation fully visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-landscape", "The landscape phone project covers short touch navigation");
  await page.getByRole("button", { name: "Open kitchen demo" }).click();

  const sidebar = page.getByRole("complementary", {
    name: "Workspace navigation",
  });
  await expect.poll(
    () => sidebar.evaluate((element) =>
      Math.round(element.getBoundingClientRect().width)
    ),
  ).toBe(80);
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
  await expect(sidebar.locator(".sync")).toBeVisible();
  const layout = await sidebar.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const syncBounds = element.querySelector(".sync")?.getBoundingClientRect();
    const links = [...element.querySelectorAll<HTMLElement>(".nav")];
    return {
      allLinksVisible: links.every((link) => {
        const linkBounds = link.getBoundingClientRect();
        return linkBounds.top >= bounds.top && linkBounds.bottom <= bounds.bottom;
      }),
      syncVisible: Boolean(
        syncBounds &&
        syncBounds.top >= bounds.top &&
        syncBounds.bottom <= bounds.bottom,
      ),
    };
  });
  expect(layout).toEqual({ allLinksVisible: true, syncVisible: true });
  await sidebar.locator(".nav", { hasText: "Spaces" }).click();
  await expect(page.getByRole("heading", { name: "Spaces", exact: true }))
    .toBeVisible();
  const spaces = page.locator(".split.resizable-panels");
  await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");
  await expect(page.getByRole("group", {
    name: "Space panels navigation",
  })).toBeVisible();
  await expect(spaces.locator(":scope > .panel-layout-toolbar")).toBeHidden();
});

test("uses a compact icon rail at both narrow-tablet boundaries and orientations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "tablet-portrait", "The portrait tablet project covers the 761 to 799 pixel band");
  await page.getByRole("button", { name: "Open kitchen demo" }).click();

  for (const viewport of [
    { width: 761, height: 1024 },
    { width: 799, height: 761 },
  ]) {
    await page.setViewportSize(viewport);
    const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
    await expect.poll(
      () => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    ).toBe(80);
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeHidden();
    await expect(page.locator("aside .nav").first()).toHaveAttribute("title", "Capture");
    expect(await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      sidebarTextWidths: [...document.querySelectorAll<HTMLElement>(
        ".app-shell > aside .nav > span",
      )].map((label) => Math.round(label.getBoundingClientRect().width)),
    }))).toEqual({
      documentOverflow: false,
      sidebarTextWidths: [1, 1, 1, 1, 1, 1],
    });
  }
});

test("switches, resizes, and persists responsive panel layouts", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();

  const capture = page.locator(".capture.resizable-panels");
  const captureLayout = page.getByRole("group", { name: "Capture panels layout" });
  const sideBySide = captureLayout.getByRole("button", { name: "Side by side" });
  const stacked = captureLayout.getByRole("button", { name: "Stacked" });
  const captureNavigation = page.getByRole("group", {
    name: "Capture panels navigation",
  });
  await expect(capture).toBeVisible();

  if (await captureNavigation.isVisible()) {
    await expect(capture.locator(":scope > .panel-layout-toolbar")).toBeHidden();
    await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
    await expect(page.getByRole("separator", { name: "Resize capture queue" }))
      .toBeHidden();
    await expectCompactPanelSpacing(capture);
  } else if (await sideBySide.isDisabled()) {
    await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
    await expect(page.getByRole("separator", { name: "Resize capture queue" }))
      .toBeHidden();
    await expectCompactPanelSpacing(capture);
  } else {
    await stacked.click();
    await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
    await expectCompactPanelSpacing(capture);
    await sideBySide.click();
    await expect(capture).toHaveAttribute("data-panel-layout", "side-by-side");
    await expectCompactPanelSpacing(capture);
    const separator = page.getByRole("separator", { name: "Resize capture queue" });
    await expect(separator).toBeVisible();
    await separator.focus();
    await page.keyboard.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "62");
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "58");
    const separatorBounds = await separator.boundingBox();
    const captureBounds = await capture.boundingBox();
    if (!separatorBounds || !captureBounds) {
      throw new Error("Capture panel resize controls are not visible");
    }
    await page.mouse.move(
      separatorBounds.x + separatorBounds.width / 2,
      separatorBounds.y + Math.min(80, separatorBounds.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      captureBounds.x + captureBounds.width * 0.36,
      separatorBounds.y + Math.min(80, separatorBounds.height / 2),
      { steps: 6 },
    );
    await page.mouse.up();
    await expect.poll(async () =>
      Number(await separator.getAttribute("aria-valuenow"))
    ).toBeLessThan(50);
    await stacked.click();
    await page.reload();
    await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
  }

  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  const spaces = page.locator(".split.resizable-panels");
  const spacesLayout = page.getByRole("group", { name: "Space panels layout" });
  const spacesSideBySide = spacesLayout.getByRole("button", { name: "Side by side" });
  const spacesNavigation = page.getByRole("group", {
    name: "Space panels navigation",
  });
  if (await spacesNavigation.isVisible()) {
    await expect(spaces.locator(":scope > .panel-layout-toolbar")).toBeHidden();
    await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");
    await expectCompactPanelSpacing(spaces);
  } else if (await spacesSideBySide.isDisabled()) {
    await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");
    await expectCompactPanelSpacing(spaces);
  } else {
    await spacesLayout.getByRole("button", { name: "Stacked" }).click();
    await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");
    await expectCompactPanelSpacing(spaces);
    await spacesSideBySide.click();
    await expect(spaces).toHaveAttribute("data-panel-layout", "side-by-side");
    await expectCompactPanelSpacing(spaces);
  }

  expect(await page.evaluate(() => ({
    body: document.body.scrollWidth <= document.body.clientWidth + 1,
    document: document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  }))).toEqual({ body: true, document: true });
});

test("keeps the Spaces tree and editor dense at compact desktop widths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The wide desktop project probes compact and full desktop widths",
  );
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();

  const spaces = page.locator(".split.resizable-panels");
  const layout = page.getByRole("group", { name: "Space panels layout" });
  const sideBySide = layout.getByRole("button", { name: "Side by side" });
  await page.setViewportSize({ width: 1133, height: 744 });
  await expect(sideBySide).toBeDisabled();
  await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sideBySide).toBeEnabled();
  await sideBySide.click();
  await expect(spaces).toHaveAttribute("data-panel-layout", "side-by-side");
  await expect(page.locator(".tree-panel > .root-drop")).toBeHidden();

  const density = await spaces.evaluate((element) => {
    const treePanel = element.querySelector<HTMLElement>(".tree-panel");
    const firstRow = treePanel?.querySelector<HTMLElement>(".tree-row");
    const rows = [...element.querySelectorAll<HTMLElement>(".tree-row")];
    const controls = [...element.querySelectorAll<HTMLElement>(
      ".tree-row button, .tree-row .drag-handle",
    )].filter((control) => {
      const styles = getComputedStyle(control);
      const bounds = control.getBoundingClientRect();
      return styles.display !== "none" &&
        styles.visibility !== "hidden" &&
        bounds.width > 0 &&
        bounds.height > 0;
    });
    const labels = [...element.querySelectorAll<HTMLElement>(
      ".inspector .editor-form label",
    )];
    return {
      controlsMeetTarget: controls.every((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.width >= 44 && bounds.height >= 44;
      }),
      firstRowOffset: treePanel && firstRow
        ? firstRow.getBoundingClientRect().top -
          treePanel.getBoundingClientRect().top
        : Number.POSITIVE_INFINITY,
      labelMarginsReset: labels.every((label) => {
        const styles = getComputedStyle(label);
        return styles.marginTop === "0px" && styles.marginBottom === "0px";
      }),
      maxRowHeight: Math.max(
        0,
        ...rows.map((row) => row.getBoundingClientRect().height),
      ),
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  expect(density.controlsMeetTarget).toBe(true);
  expect(density.firstRowOffset).toBeLessThanOrEqual(140);
  expect(density.labelMarginsReset).toBe(true);
  expect(density.maxRowHeight).toBeLessThanOrEqual(80);
  expect(density.noHorizontalOverflow).toBe(true);
});

test("keeps preferences usable when browser storage is unavailable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Preference failure behavior is viewport-independent");
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Storage.prototype.getItem = function () {
      throw new DOMException("Preference reads are unavailable", "SecurityError");
    };
    Storage.prototype.setItem = function () {
      throw new DOMException("Preference writes are unavailable", "SecurityError");
    };
  });
  await page.reload();

  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  const shell = page.locator(".app-shell");
  const capture = page.locator(".capture.resizable-panels");
  await expect(capture).toBeVisible();
  await expect(page.getByText("Preferences are session-only")).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
  await page.getByRole("button", { name: /theme active\. Switch to/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("group", { name: "Capture panels layout" })
    .getByRole("button", { name: "Stacked" })
    .click();
  await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
  expect(pageErrors).toEqual([]);
});

test("aligns header controls and immediately toggles the applied system theme", async ({
  page,
}, testInfo) => {
  test.skip(
    !["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name),
    "Portrait phone and wide desktop cover both header control layouts",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => localStorage.removeItem("stowplan-theme"));
  await page.reload();
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();

  const root = page.locator("html");
  const darkToggle = page.getByRole("button", {
    name: "Dark theme active. Switch to light theme",
  });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(darkToggle.locator("svg.lucide-moon")).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => localStorage.getItem("stowplan-theme"))
  ).toBe("system");

  const search = page.getByRole("button", {
    name: "Search and jump, Command or Control K",
  });
  const home = page.getByRole("link", { name: "Workspaces and backup status" });
  const settings = page.getByRole("link", { name: "Open settings" });
  const share = page.getByRole("button", { name: "Share this view" });
  const controlBounds = await Promise.all(
    [search, home, share, darkToggle].map((control) => control.boundingBox()),
  );
  if (controlBounds.some((bounds) => bounds === null)) {
    throw new Error("Header controls are not visible");
  }
  const [searchBounds, homeBounds, shareBounds, themeBounds] = controlBounds as
    Exclude<(typeof controlBounds)[number], null>[];
  expect(homeBounds.width).toBe(44);
  expect(shareBounds.width).toBe(homeBounds.width);
  expect(themeBounds.width).toBe(homeBounds.width);
  for (const bounds of controlBounds) expect(bounds?.height).toBe(44);
  if ((page.viewportSize()?.width ?? 0) <= 980) {
    expect(searchBounds.width).toBe(homeBounds.width);
  } else {
    expect(searchBounds.width).toBeGreaterThan(homeBounds.width);
  }
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    await expect(settings).toBeVisible();
  } else {
    await expect(settings).toBeHidden();
  }

  expect(await darkToggle.evaluate((button: HTMLButtonElement) => {
    button.click();
    return document.documentElement.dataset.theme;
  })).toBe("light");
  const lightToggle = page.getByRole("button", {
    name: "Light theme active. Switch to dark theme",
  });
  await expect(lightToggle.locator("svg.lucide-sun")).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => localStorage.getItem("stowplan-theme"))
  ).toBe("light");

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", {
    name: "Light theme active. Switch to dark theme",
  })).toBeVisible();

  const mobileSettings = page.getByRole("link", { name: "Open settings" });
  if (await mobileSettings.isVisible()) {
    await mobileSettings.click();
  } else {
    await page.locator(".nav:visible", { hasText: "Settings" }).click();
  }
  const themeChoices = page.locator(".settings .segments");
  await themeChoices.getByRole("button", { name: "system" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", {
    name: "Dark theme active. Switch to light theme",
  })).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await themeChoices.getByRole("button", { name: "dark" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await themeChoices.getByRole("button", { name: "light" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  const workspaceStatusLink = page.locator(".settings-workspaces-link");
  await expect(workspaceStatusLink).toHaveAttribute("href", "/workspaces");
  await workspaceStatusLink.click();
  await expect(page.getByRole("heading", {
    name: "Your workspaces",
  })).toBeFocused();
});

test("navigates every active surface with arrow keys while preserving native controls", async ({
  page,
}) => {
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();

  const jump = page.getByRole("button", {
    name: "Search and jump, Command or Control K",
  });
  await jump.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("link", { name: "Workspaces and backup status" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(jump).toBeFocused();
  await page.keyboard.press("Control+ArrowDown");
  await expect(jump).toBeFocused();

  await page.locator(
    '.capture-location-row[data-location-id="loc_corner"] .queue-row',
  ).click();
  const quantity = page.getByLabel("Qty");
  await quantity.focus();
  await expect(quantity).toHaveValue("1");
  await page.keyboard.press("ArrowUp");
  await expect(quantity).toBeFocused();
  await expect(quantity).toHaveValue("2");

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  const inventorySearch = page.getByLabel("Search inventory");
  await inventorySearch.focus();
  await page.keyboard.press("ArrowDown");
  await expect(inventorySearch).toBeFocused();
  const inventorySort = page.getByLabel("Sort inventory");
  await inventorySort.focus();
  await page.keyboard.press("ArrowDown");
  await expect(inventorySort).toBeFocused();
  const firstInventoryRow = page.locator(".inventory-row").first();
  const rowCheckbox = firstInventoryRow.getByRole("checkbox");
  const rowName = firstInventoryRow.locator(".item-name");
  await rowCheckbox.focus();
  await page.keyboard.press("ArrowDown");
  await expect(rowCheckbox).toBeFocused();
  await rowName.focus();
  await page.keyboard.press("ArrowDown");
  await expect(firstInventoryRow.getByRole("link", {
    name: /in Spaces$/,
  })).toBeFocused();
  await page.locator('[data-item-id="item_flour"] .item-name').click();
  const dialog = page.getByRole("dialog", { name: "Review item" });
  const close = page.getByRole("button", { name: "Close item editor" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) =>
    element.contains(document.activeElement)
  )).toBe(true);
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press("ArrowUp");
  expect(await dialog.evaluate((element) =>
    element.contains(document.activeElement)
  )).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).toBeHidden();

  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  await page.getByText("Plan priorities", { exact: true }).click();
  const range = page.getByLabel("Accessibility weight");
  await range.focus();
  const rangeValue = Number(await range.inputValue());
  await page.keyboard.press("ArrowDown");
  await expect(range).toBeFocused();
  expect(Number(await range.inputValue())).toBeLessThan(rangeValue);
  const radios = page.locator("[data-keyboard-radio-test] input");
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.dataset.keyboardRadioTest = "";
    fixture.innerHTML = [
      '<input aria-label="First test choice" name="keyboard-test" type="radio" checked>',
      '<input aria-label="Second test choice" name="keyboard-test" type="radio">',
    ].join("");
    document.querySelector("main")?.appendChild(fixture);
  });
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toBeChecked();

  await page.goto("/docs/");
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    window.scrollTo(0, 0);
  });
  await page.keyboard.press("ArrowDown");
  const back = page.getByRole("link", { name: "Back to organizer" });
  await expect(back).toBeFocused();
  expect(await back.evaluate((element) => {
    const styles = getComputedStyle(element);
    return Number.parseFloat(styles.outlineWidth) > 0 &&
      styles.outlineStyle !== "none";
  })).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press("ArrowDown");
  const adminGuide = page.getByRole("link", {
    name: "Open the admin testing guide",
  });
  await expect(adminGuide).toBeFocused();
  expect(await adminGuide.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  })).toBe(true);
});

test("searches and jumps with Control or Command K", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();

  const primaryShortcut = testInfo.project.name.startsWith("mobile")
    ? "Control+KeyK"
    : "Meta+KeyK";
  await page.keyboard.press(primaryShortcut);
  const palette = page.getByRole("dialog", { name: "Search and jump" });
  await expect(palette).toBeVisible();
  const firstView = palette.locator('[role="option"][data-kind="view"]').first();
  await expect(firstView).toContainText("Workspace page");
  await expect(firstView.locator("b")).toHaveCount(0);
  const search = page.getByRole("combobox", { name: "Search views, spaces, and items" });
  await search.press("Shift+Tab");
  await expect(palette.getByRole("option").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await search.press("Tab");
  await expect(palette.getByRole("option").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByRole("heading", { name: "Capture", exact: true })).toBeVisible();

  await page.keyboard.press(primaryShortcut);
  await expect(palette).toBeVisible();
  await search.press("Tab");
  await expect(palette.getByRole("option").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(palette.getByRole("option").nth(1)).toBeFocused();
  await expect(palette.getByRole("option").nth(1)).toHaveAttribute(
    "data-active",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible();

  await page.keyboard.press(primaryShortcut);
  await expect(palette).toBeVisible();
  for (let index = 0; index < 12; index += 1) {
    await search.press("ArrowDown");
  }
  await expect.poll(() =>
    palette.locator('[role="option"][data-active="true"]').evaluate((option) => {
      const results = option.closest(".jump-results");
      if (!results) return false;
      const optionBounds = option.getBoundingClientRect();
      const resultsBounds = results.getBoundingClientRect();
      return optionBounds.top >= resultsBounds.top &&
        optionBounds.bottom <= resultsBounds.bottom;
    })
  ).toBe(true);
  await search.fill("Brown sugar");
  await page.locator('[role="option"][data-kind="item"]', { hasText: "Brown sugar" }).click();
  await expect(page.getByRole("dialog", { name: "Review item" })).toBeVisible();
  await expect(page).toHaveURL(
    /\/inventory\/items\/brown-sugar@item_sugar$/,
  );
  expect(await page.evaluate(() => {
    const close = document.querySelector<HTMLElement>(
      '[aria-label="Close item editor"]',
    )?.getBoundingClientRect();
    return {
      closeVisible: Boolean(close && close.right <=
        document.documentElement.clientWidth),
      noOverflow: document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    };
  })).toEqual({ closeVisible: true, noOverflow: true });
  await page.getByRole("button", { name: "Close item editor" }).click();
  await expect(
    page.getByRole("dialog", { name: "Review item" }),
  ).toBeHidden();
  await expect(page).toHaveURL(/\/spaces(?:\/locations\/[^/]+)?$/);
  await expect(page.locator(".loading")).toHaveCount(0);

  await page.keyboard.press("Meta+KeyK");
  await search.fill("Baking bin");
  await page.locator('[role="option"][data-kind="space"]', { hasText: "Baking bin" }).click();
  await expect(page.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible();
  await expect(page).toHaveURL(
    /\/spaces\/locations\/b-17-baking-bin@loc_bin$/,
  );

  await page.keyboard.press("Control+KeyK");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("keeps known empty separate from an undoable empty-container action", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(
    '.capture-location-row[data-location-id="loc_bin"] .queue-row',
  ).click();

  await expect(page.locator(".capture-locked")).toContainText(
    "Reopen this space before adding, editing, or reordering its contents",
  );
  await expect(page.getByLabel("Qty")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit All-purpose flour" }))
    .toHaveCount(0);
  await expect(page.locator('.captured-row[data-item-id="item_flour"] .drag-handle'))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add inside Baking bin" }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add top-level space" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Reopen capture" }).click();
  await expect(page.locator(".feedback-toast")).toBeHidden();
  await expect(page.getByRole("button", { name: "Counted & next" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Empty container" })).toBeVisible();

  await page.getByRole("button", { name: "Known empty & next" }).click();
  await expect(page.locator(".feedback-toast")).toBeHidden();
  const knownEmptyReview = page.getByRole("dialog", {
    name: "Known empty is unavailable",
  });
  await expect(knownEmptyReview).toContainText(
    "Known empty records an observation. It never removes item records.",
  );
  await expect(knownEmptyReview).toContainText("All-purpose flour");
  await expect(knownEmptyReview).toContainText("Brown sugar");
  await expect(knownEmptyReview.getByRole("button", {
    name: "Empty container",
    exact: true,
  })).toHaveCount(0);
  const keepCounting = knownEmptyReview.getByRole("button", {
    name: "Keep counting",
  });
  await expect(keepCounting).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(knownEmptyReview.getByRole("button", {
    name: "Close known-empty review",
  })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(keepCounting).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(knownEmptyReview.getByRole("button", {
    name: "Close known-empty review",
  })).toBeFocused();
  await page.keyboard.press("Control+KeyK");
  await expect(page.getByRole("dialog", { name: "Search and jump" }))
    .toHaveCount(0);
  await expect(knownEmptyReview.getByRole("status")).toContainText(
    "Close this review before searching",
  );
  await knownEmptyReview.locator(".container-review-list b").first().evaluate(
    (amount) => {
      amount.textContent = `1 ${"verylongunit".repeat(16)}`;
    },
  );
  expect(await knownEmptyReview.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const list = dialog.querySelector(".container-review-list");
    return {
      fitsViewport: bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight,
      noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth,
      noListHorizontalOverflow: list
        ? list.scrollWidth <= list.clientWidth
        : false,
    };
  })).toEqual({
    fitsViewport: true,
    noHorizontalOverflow: true,
    noListHorizontalOverflow: true,
  });
  const reviewedState = async () => {
    const replica = await localReplica(page) as {
      state: {
        items: { id: string; locationId: string }[];
        locations: { captureStatus: string; id: string }[];
      };
    };
    return {
      itemIds: replica.state.items
        .filter((item) => item.locationId === "loc_bin")
        .map((item) => item.id)
        .sort(),
      status: replica.state.locations
        .find((location) => location.id === "loc_bin")?.captureStatus,
    };
  };
  await expect.poll(reviewedState).toEqual({
    itemIds: ["item_flour", "item_sugar"],
    status: "in_progress",
  });
  await keepCounting.click();
  await expect(knownEmptyReview).toBeHidden();
  await expect(page.locator(".feedback-toast")).toHaveCount(0);

  await page.getByRole("button", { name: "Empty container" }).click();
  const emptyContainerReview = page.getByRole("dialog", {
    name: "Empty container?",
  });
  await expect(emptyContainerReview).toContainText(
    "marks the space known empty as one undoable change",
  );
  await expect(emptyContainerReview).toContainText("All-purpose flour");
  await expect(emptyContainerReview).toContainText("Brown sugar");
  await emptyContainerReview.getByRole("button", {
    name: "Empty container",
    exact: true,
  }).click();
  await expect(page.getByRole("status")).toContainText(
    "was emptied and is now known empty",
  );
  await expect.poll(reviewedState).toEqual({
    itemIds: [],
    status: "known_empty",
  });

  await page.locator(".nav:visible", { hasText: "Activity" }).click();
  await page.getByRole("button", {
    name: "Undo Emptied Baking bin and marked it known empty",
  }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: {
        items: { id: string; locationId: string }[];
        locations: { captureStatus: string; id: string }[];
      };
    };
    return {
      itemIds: replica.state.items
        .filter((item) => item.locationId === "loc_bin")
        .map((item) => item.id)
        .sort(),
      status: replica.state.locations
        .find((location) => location.id === "loc_bin")?.captureStatus,
    };
  }).toEqual({
    itemIds: ["item_flour", "item_sugar"],
    status: "in_progress",
  });
});

test("requires Reopen before completed contents change from Spaces or Inventory", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  await page.locator('[data-location-id="loc_bin"] .tree-select').click();

  const spaceEditor = page.getByRole("region", { name: "Edit Baking bin" });
  await expect(spaceEditor.getByRole("button", { name: "Earlier" })).toBeDisabled();
  await expect(spaceEditor.getByRole("button", { name: "Later" })).toBeDisabled();
  await expect(spaceEditor.getByText("Contents are read-only")).toBeVisible();
  await expect(spaceEditor.getByRole("button", { name: "Add nested space" }))
    .toHaveCount(0);
  await expect(spaceEditor.getByRole("button", { name: "Edit All-purpose flour" }))
    .toHaveCount(0);
  await spaceEditor.getByRole("button", { name: "Reopen capture" }).click();
  await expect(spaceEditor.getByRole("button", { name: "Add nested space" }))
    .toBeVisible();
  await expect(spaceEditor.getByRole("button", { name: "Edit All-purpose flour" }))
    .toBeVisible();

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Filter by location").selectOption("loc_warm");
  await expect(page.getByText("Cabinet above oven is read-only")).toBeVisible();
  await expect(page.locator('.inventory-row[data-item-id="item_pasta"] .drag-handle'))
    .toHaveCount(0);
  await page.locator('[data-item-id="item_pasta"] .item-name').click();
  const itemEditor = page.getByRole("dialog", { name: "Review item" });
  await expect(itemEditor.getByText("Cabinet above oven is read-only"))
    .toBeVisible();
  await expect(itemEditor.getByRole("button", { name: "Save item" }))
    .toHaveCount(0);
  await itemEditor.getByRole("button", { name: "Reopen capture" }).click();
  await expect(page.getByRole("dialog", { name: "Edit item" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save item" })).toBeVisible();
});

test("visibly refuses unchanged item and space saves", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCaptureLocation(page, "loc_warm");
  const before = await localReplica(page) as {
    state: {
      activities: unknown[];
      items: { id: string; version: number }[];
      plans: unknown[];
      workspace: { revision: number };
    };
  };

  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  await page.locator('[data-location-id="loc_bin"] .tree-select').click();
  await page.getByRole("button", { name: "Save space" }).click();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "No changes to save for Baking bin",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.locator('[data-item-id="item_pasta"] .item-name').click();
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("No changes to save for Pasta")).toBeVisible();
  await page.getByRole("button", { name: "Close item editor" }).click();
  await page.locator('a[href$="/settings"]:visible').first().click();
  await page.getByRole("button", { name: "Rename workspace" }).click();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Workspace is already named Kitchen reset",
  );

  const after = await localReplica(page) as typeof before;
  expect(after.state.workspace.revision).toBe(before.state.workspace.revision);
  expect(after.state.activities).toEqual(before.state.activities);
  expect(after.state.plans).toEqual(before.state.plans);
  expect(after.state.items.find((item) => item.id === "item_pasta")?.version)
    .toBe(before.state.items.find((item) => item.id === "item_pasta")?.version);
});

test("does not offer known-empty capture while nested spaces remain", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(
    '.capture-location-row[data-location-id="loc_corner"] .queue-row',
  ).click();
  await expect(page.getByRole("heading", {
    name: "No direct items recorded",
  })).toBeVisible();
  await expect(page.getByText(
    "1 nested space is already recorded here. Add a direct item, or mark this space counted.",
  )).toBeVisible();
  await expect(page.getByRole("button", {
    name: "Known empty & next",
  })).toHaveCount(0);
  const replica = await localReplica(page) as {
    state: { locations: { captureStatus: string; id: string }[] };
  };
  expect(replica.state.locations
    .find((location) => location.id === "loc_corner")?.captureStatus)
    .toBe("in_progress");
});

test("onboards, captures, edits, searches, plans, rolls back, and persists locally", async ({ page }) => {
  const consoleErrors: string[] = [];
  const syncRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sync") syncRequests.push(request.url());
  });

  await expect(page.getByRole("heading", {
    name: "Your workspaces",
  })).toBeVisible();
  await expect(page.getByRole("region", {
    name: "Workspace tools",
  })).toBeVisible();
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
  await expect(page.locator(".queue-row", { hasText: "B-17" })).toHaveAttribute("data-depth", "3");
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("2");
  await page.getByLabel("What is it?").fill("Test tea towels");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();
  await expect(page.getByLabel("What is it?")).toBeFocused();
  await expect(page.getByLabel("What is it?")).toHaveValue("");

  await page.getByLabel("Workspaces and backup status").click();
  await expect(page.getByRole("heading", {
    name: "Your workspaces",
  })).toBeVisible();
  await page.getByRole("button", { name: "Continue current workspace" }).click();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Edit Test tea towels" }).click();
  const itemEditor = page.getByRole("dialog", { name: "Edit item" });
  await expect(itemEditor).toBeVisible();
  await expect(itemEditor.getByText("What is it?", { exact: true })).toBeVisible();
  await expect(itemEditor.getByText("Organize and find it", { exact: true })).toBeVisible();
  await page.getByLabel("Category").fill("Linens");
  await page.getByLabel("Search tags").fill("washable, prep");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Saved on this device.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save item" })).toBeFocused();
  await page.getByRole("button", { name: "Close item editor" }).click();

  await page.reload();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await expect(page.getByRole("heading", { name: "All item records" })).toBeVisible();
  await expect(page.getByText("Showing the containerless inventory.")).toBeVisible();
  await expect(page.locator('.inventory-row .drag-handle[title="Drag Test tea towels to reorder"]')).toHaveCount(0);
  await page.getByPlaceholder("Search names, categories, tags, constraints, and notes").fill("washable");
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();
  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  await page.getByText("Plan priorities", { exact: true }).click();
  await page.getByRole("button", { name: "How accessibility affects a plan" }).focus();
  await expect(page.getByRole("tooltip", { name: /Score bonus = max/ })).toBeVisible();
  await page.getByRole("button", { name: "Generate move plan" }).click();
  await page.locator(".nav:visible", { hasText: "Activity" }).click();
  await expect(page.getByText(/recorded changes/)).toBeVisible();
  await page.getByRole("button", { name: /theme active\. Switch to/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(consoleErrors).toEqual([]);
  expect(syncRequests).toEqual([]);
});

test("prevents repeated form submission from creating duplicate records", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("2");
  await page.getByLabel("What is it?").fill("One deliberate record");
  await page.locator("form.quick").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: { items: { name: string }[] };
    };
    return replica.state.items.filter(
      (item) => item.name === "One deliberate record",
    ).length;
  }).toBe(1);
});

test("resets the active demo from the main menu", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  const before = await localReplica(page) as { state: { workspace: { id: string } } };
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("1");
  await page.getByLabel("What is it?").fill("Temporary demo item");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await page.getByLabel("Workspaces and backup status").click();
  await page.getByRole("button", { name: "Reset kitchen demo" }).click();
  const reset = page.getByRole("dialog", {
    name: "Reset the kitchen demo?",
  });
  await expect(reset).toContainText(
    "A fresh private demo instance will open on this device.",
  );
  await expect(reset.getByRole("button", {
    name: "Cancel",
  })).toBeFocused();
  await reset.getByRole("button", {
    name: "Reset demo",
  }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
  await expect(page.getByText("Temporary demo item", { exact: true })).toHaveCount(0);
  const after = await localReplica(page) as { state: { workspace: { id: string } } };
  expect(after.state.workspace.id).not.toBe(before.state.workspace.id);
});

test("collapses Capture branches while search temporarily reveals matches", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();

  const left = page.locator(
    '.capture-location-row[data-location-id="loc_left"]',
  );
  const food = page.locator(
    '.capture-location-row[data-location-id="loc_food"]',
  );
  const warm = page.locator(
    '.capture-location-row[data-location-id="loc_warm"]',
  );
  const drawer = page.locator(
    '.capture-location-row[data-location-id="loc_drawer"]',
  );
  const collapseLeft = page.getByRole("button", {
    name: "Collapse Left side",
  });
  await expect(collapseLeft).toHaveAttribute("aria-expanded", "true");
  await collapseLeft.click();
  await expect(food).toHaveCount(0);
  await expect(warm).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(
    '.capture-location-row[data-location-id="loc_right"]',
  )).toBeVisible();

  const search = page.getByLabel("Find container");
  await search.fill("Food cabinet");
  await expect(left).toBeVisible();
  await expect(food).toBeVisible();
  await expect(left.locator(".drag-handle")).not.toHaveAttribute(
    "aria-expanded",
  );
  await expect(page.locator(
    ".capture-location-row[data-location-id]",
  )).toHaveCount(3);

  await search.clear();
  await expect(food).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Left side" }).click();
  await expect(food).toBeVisible();
  await expect(warm).toBeVisible();
  await expect(drawer).toBeVisible();
});

test("keeps combined Capture branch handles stable across Pixel taps and drags", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The Pixel 7 Pro project covers combined touch controls",
  );
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();

  const lower = page.locator(
    '.capture-location-row[data-location-id="loc_lower"]',
  );
  const bin = page.locator(
    '.capture-location-row[data-location-id="loc_bin"]',
  );
  const counter = page.locator(
    '.capture-location-row[data-location-id="loc_counter"]',
  );
  const handle = lower.locator(".drag-handle");
  await lower.evaluate((element) =>
    element.scrollIntoView({ block: "center" })
  );
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(bin).toBeVisible();

  const before = await localReplica(page) as {
    state: {
      activities: unknown[];
      locations: { id: string; order: number }[];
      workspace: { revision: number };
    };
  };
  await handle.tap();
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect(bin).toHaveCount(0);
  const afterCollapse = await localReplica(page) as typeof before;
  expect(afterCollapse.state.activities).toHaveLength(
    before.state.activities.length,
  );
  expect(afterCollapse.state.workspace.revision).toBe(
    before.state.workspace.revision,
  );
  await expect(page.locator(".feedback-toast")).toBeHidden();

  await handle.tap();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(bin).toBeVisible();
  const afterExpand = await localReplica(page) as typeof before;
  expect(afterExpand.state.activities).toHaveLength(
    before.state.activities.length,
  );
  expect(afterExpand.state.workspace.revision).toBe(
    before.state.workspace.revision,
  );
  await expect(page.locator(".feedback-toast")).toBeHidden();

  await page.locator(".capture-tree").evaluate((tree) => {
    const sourceRow = tree.querySelector<HTMLElement>(
      '.capture-location-row[data-location-id="loc_lower"]',
    );
    const targetRow = tree.querySelector<HTMLElement>(
      '.capture-location-row[data-location-id="loc_counter"]',
    );
    if (!sourceRow || !targetRow) {
      throw new Error("Combined touch-control rows are unavailable");
    }
    const treeBounds = tree.getBoundingClientRect();
    const sourceBounds = sourceRow.getBoundingClientRect();
    const targetBounds = targetRow.getBoundingClientRect();
    const pairCenter = (
      sourceBounds.top +
      sourceBounds.bottom +
      targetBounds.top +
      targetBounds.bottom
    ) / 4;
    tree.scrollBy({
      behavior: "auto",
      top: pairCenter - (treeBounds.top + treeBounds.bottom) / 2,
    });
  });
  const sourceBox = await handle.boundingBox();
  const targetBox = await counter.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Combined touch-control drag endpoints are not visible");
  }
  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height * 0.8,
  };
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{
      id: 21,
      radiusX: 3,
      radiusY: 3,
      x: start.x,
      y: start.y,
    }],
  });
  for (let step = 1; step <= 12; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        id: 21,
        radiusX: 3,
        radiusY: 3,
        x: start.x + (end.x - start.x) * step / 12,
        y: start.y + (end.y - start.y) * step / 12,
      }],
    });
  }
  await expect(counter).toHaveAttribute("data-touch-drop-intent", "after");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    const locations = replica.state.locations;
    return {
      activityCount: replica.state.activities.length,
      reordered:
        (locations.find((location) => location.id === "loc_lower")?.order ?? 0) >
        (locations.find((location) => location.id === "loc_counter")?.order ?? 0),
      revision: replica.state.workspace.revision,
    };
  }).toEqual({
    activityCount: before.state.activities.length + 1,
    reordered: true,
    revision: before.state.workspace.revision + 1,
  });
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(bin).toBeVisible();
  await expect(page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  })).toHaveCount(0);
});

test("previews desktop hierarchy destinations and confirms completed-parent changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Native mouse feedback is a desktop contract");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Open kitchen demo" }).click();

  const before = await localReplica(page) as {
    state: {
      activities: unknown[];
      locations: {
        captureStatus: string;
        id: string;
        parentId: string | null;
      }[];
      workspace: { revision: number };
    };
  };
  const source = page.locator(
    '.capture-location-row[data-location-id="loc_food"]',
  );
  const right = page.locator('.capture-location-row[data-location-id="loc_right"]');
  const idleDropStyles = await right.evaluate((row) => ({
    background: getComputedStyle(row).backgroundColor,
    outline: getComputedStyle(row).outline,
  }));
  await holdNativeDrag(page, source.locator(".drag-handle"), right);
  await expect(source).toHaveAttribute("data-dragging", "true");
  await expect(right).toHaveAttribute("data-drop-valid", "true");
  await expect(right).toHaveAttribute("data-drop-intent", "inside");
  await expect(right.locator(".reorder-drop-copy")).toHaveText("Move inside");
  const dropStyles = await right.evaluate((row) => ({
    background: getComputedStyle(row).backgroundColor,
    outline: getComputedStyle(row).outline,
  }));
  expect(dropStyles.background).not.toBe(idleDropStyles.background);
  expect(dropStyles.outline).not.toBe(idleDropStyles.outline);
  await page.mouse.up();
  const confirmation = page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("C-01 · Food cabinet");
  await expect(confirmation).toContainText("KIT-L · Left side");
  await expect(confirmation).toContainText("KIT-R · Right side");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(source.locator(".queue-row")).toBeFocused();
  const afterCancel = await localReplica(page) as typeof before;
  expect(afterCancel.state.workspace.revision).toBe(
    before.state.workspace.revision,
  );
  expect(afterCancel.state.activities).toHaveLength(
    before.state.activities.length,
  );
  expect(
    afterCancel.state.locations.find((location) => location.id === "loc_food")
      ?.parentId,
  ).toBe("loc_left");

  const rootTarget = page.locator(".capture-root-drop");
  const rootDataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.locator(".drag-handle").dispatchEvent("dragstart", {
      dataTransfer: rootDataTransfer,
    });
    await expect(rootTarget).toBeVisible();
    const kitchen = page.locator(
      '.capture-location-row[data-location-id="loc_kitchen"]',
    );
    const kitchenBounds = await kitchen.boundingBox();
    if (!kitchenBounds) throw new Error("The first Capture row is not visible");
    const firstRowTarget = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-drop-target]");
      return {
        id: target?.dataset.dropId,
        kind: target?.dataset.dropTarget,
      };
    }, {
      x: kitchenBounds.x + kitchenBounds.width * 0.25,
      y: kitchenBounds.y + kitchenBounds.height / 2,
    });
    expect(firstRowTarget).toEqual({
      id: "loc_kitchen",
      kind: "location",
    });
    const rootBounds = await rootTarget.boundingBox();
    if (!rootBounds) throw new Error("The Capture top-level target is not visible");
    const clientX = rootBounds.x + rootBounds.width / 2;
    const clientY = rootBounds.y + rootBounds.height / 2;
    await rootTarget.dispatchEvent("dragover", {
      clientX,
      clientY,
      dataTransfer: rootDataTransfer,
    });
    await expect(rootTarget).toHaveAttribute("data-drop-intent", "inside");
    await expect(rootTarget).toContainText("Make top level");
    await rootTarget.dispatchEvent("drop", {
      clientX,
      clientY,
      dataTransfer: rootDataTransfer,
    });
    await source.locator(".drag-handle").dispatchEvent("dragend", {
      dataTransfer: rootDataTransfer,
    });
  } finally {
    await rootDataTransfer.dispose();
  }
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator(".hierarchy-review-list li")).toHaveCount(1);
  await expect(confirmation).toContainText("KIT-L · Left side");
  await expect(confirmation).not.toContainText("KIT-R · Right side");
  await confirmation.getByRole("button", {
    name: "Move and reopen",
  }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    return {
      activityCount: replica.state.activities.length,
      leftStatus: replica.state.locations.find(
        (location) => location.id === "loc_left",
      )?.captureStatus,
      parentId: replica.state.locations.find(
        (location) => location.id === "loc_food",
      )?.parentId,
      revision: replica.state.workspace.revision,
    };
  }).toEqual({
    activityCount: before.state.activities.length + 1,
    leftStatus: "in_progress",
    parentId: null,
    revision: before.state.workspace.revision + 1,
  });

  await page.locator('.capture-location-row[data-location-id="loc_bin"] .queue-row').click();
  await reopenCurrentCapture(page);
  const flour = page.locator('.captured-row[data-item-id="item_flour"]');
  const sugar = page.locator('.captured-row[data-item-id="item_sugar"]');
  await holdNativeDrag(page, sugar.locator(".drag-handle"), flour, 0.2);
  await expect(sugar).toHaveAttribute("data-dragging", "true");
  await expect(flour).toHaveAttribute("data-drop-intent", "before");
  await expect(flour.locator(".reorder-drop-copy")).toHaveText("Place before");
  await page.mouse.up();
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: { items: { id: string; order: number }[] };
    };
    const items = replica.state.items;
    return (items.find((item) => item.id === "item_sugar")?.order ?? 0) <
      (items.find((item) => item.id === "item_flour")?.order ?? 0);
  }).toBe(true);

  await expect(sugar).not.toHaveAttribute("data-dragging", "true");
  await dispatchNativeDrop(page, sugar.locator(".drag-handle"), flour, 0.2);
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Brown sugar is already in that position",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  const spacesBin = page.locator('.tree-row[data-location-id="loc_bin"]');
  await dispatchNativeCancel(page, spacesBin.locator(".drag-handle"));
  await expect(page.locator(".feedback-toast")).toBeHidden();
  await dispatchNativeDrop(
    page,
    spacesBin.locator(".drag-handle"),
    spacesBin,
  );
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    /Reopen Lower cabinet before changing its contents|Choose a different destination for Baking bin/,
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  const inventoryFlour = page.locator('.inventory-row[data-item-id="item_flour"]');
  const inventorySugar = page.locator('.inventory-row[data-item-id="item_sugar"]');
  await holdNativeDrag(page, inventoryFlour.locator(".drag-handle"), inventorySugar, 0.2);
  await expect(inventoryFlour).toHaveAttribute("data-dragging", "true");
  await expect(inventorySugar).toHaveAttribute("data-drop-intent", "before");
  await expect(inventorySugar.locator(".reorder-drop-copy")).toHaveText("Place before");
  await page.mouse.up();
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: { items: { id: string; order: number }[] };
    };
    const items = replica.state.items;
    return (items.find((item) => item.id === "item_flour")?.order ?? 0) <
      (items.find((item) => item.id === "item_sugar")?.order ?? 0);
  }).toBe(true);

  await dispatchNativeCancel(page, inventoryFlour.locator(".drag-handle"));
  await expect(page.locator(".feedback-toast")).toBeHidden();
  await dispatchNativeDrop(
    page,
    inventoryFlour.locator(".drag-handle"),
    inventoryFlour,
  );
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Choose another item in this filtered container",
  );
});

test("keeps touch reordering available on draggable handles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Touch input is a mobile contract");
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  const capturePanelNavigation = page.getByRole("group", {
    name: "Capture panels navigation",
  });
  await expect(capturePanelNavigation).toBeVisible();
  await expect(page.getByRole("group", {
    name: "Capture panels layout",
  })).toBeHidden();
  await capturePanelNavigation.getByRole("button", {
    name: "current container",
  }).click();
  await expect(page.locator(".capture-card")).toBeInViewport();
  await capturePanelNavigation.getByRole("button", {
    name: "capture queue",
  }).click();
  await expect(page.locator(".queue")).toBeInViewport();
  const untouched = await localReplica(page) as {
    state: { locations: { captureStatus: string; id: string }[] };
  };
  expect(
    untouched.state.locations.find((location) => location.id === "loc_left")
      ?.captureStatus,
  ).toBe("counted");

  const source = page.locator('.capture-location-row[data-location-id="loc_food"]');
  const target = page.locator('.capture-location-row[data-location-id="loc_warm"]');
  await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const sourceBox = await source.locator(".drag-handle").boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Touch reorder endpoints are not visible");

  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height * 0.8,
  };
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, radiusX: 3, radiusY: 3, x: start.x, y: start.y }],
  });
  for (let step = 1; step <= 12; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        id: 1,
        radiusX: 3,
        radiusY: 3,
        x: start.x + (end.x - start.x) * step / 12,
        y: start.y + (end.y - start.y) * step / 12,
      }],
    });
  }

  await expect.poll(() => page.evaluate(
    () => document.documentElement.dataset.touchDragging,
  )).toBe("true");
  await expect(target).toHaveAttribute("data-touch-drop-active", "true");
  await expect(target).toHaveAttribute("data-touch-drop-intent", "after");
  const touchCopyStyles = await target.locator(".reorder-drop-copy").evaluate((copy) => ({
    content: getComputedStyle(copy, "::after").content,
    display: getComputedStyle(copy).display,
  }));
  expect(touchCopyStyles).toEqual({
    content: '"Place after"',
    display: "block",
  });
  const nativeDragCanceled = await source.locator(".drag-handle").evaluate(
    (handle) => !handle.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
    })),
  );
  expect(nativeDragCanceled).toBe(true);
  await expect(source).not.toHaveAttribute("data-dragging");
  await source.locator(".drag-handle").evaluate((handle) =>
    handle.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      clientX: 1,
      clientY: 1,
      pointerId: 1,
      pointerType: "touch",
    }))
  );
  await expect.poll(() => page.evaluate(
    () => document.documentElement.dataset.touchDragging,
  )).toBe("true");
  await expect(target).toHaveAttribute("data-touch-drop-active", "true");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(target).not.toHaveAttribute("data-touch-drop-active");
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: {
        locations: { captureStatus: string; id: string; order: number }[];
      };
    };
    const locations = replica.state.locations;
    return {
      parentStatus: locations.find((location) => location.id === "loc_left")
        ?.captureStatus,
      reordered:
        (locations.find((location) => location.id === "loc_food")?.order ?? 0) >
        (locations.find((location) => location.id === "loc_warm")?.order ?? 0),
    };
  }).toEqual({ parentStatus: "counted", reordered: true });
  await expect(page.locator(".feedback-toast[role='status']")).toContainText(
    "C-01 · Food cabinet reordered",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  const cancelSourceBox = await source.locator(".drag-handle").boundingBox();
  const cancelTargetBox = await target.boundingBox();
  if (!cancelSourceBox || !cancelTargetBox) {
    throw new Error("Touch cancel endpoints are not visible");
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{
      id: 5,
      radiusX: 3,
      radiusY: 3,
      x: cancelSourceBox.x + cancelSourceBox.width / 2,
      y: cancelSourceBox.y + cancelSourceBox.height / 2,
    }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{
      id: 5,
      radiusX: 3,
      radiusY: 3,
      x: cancelTargetBox.x + cancelTargetBox.width / 2,
      y: cancelTargetBox.y + cancelTargetBox.height * 0.2,
    }],
  });
  await expect(target).toHaveAttribute("data-touch-drop-intent", "before");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  await expect(target).not.toHaveAttribute("data-touch-drop-active");
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: { locations: { id: string; order: number }[] };
    };
    const locations = replica.state.locations;
    return (locations.find((location) => location.id === "loc_food")?.order ?? 0) >
      (locations.find((location) => location.id === "loc_warm")?.order ?? 0);
  }).toBe(true);

  const hierarchyTarget = page.locator(
    '.capture-location-row[data-location-id="loc_right"]',
  );
  await page.locator(".capture-tree").evaluate((tree) => {
    const sourceRow = tree.querySelector<HTMLElement>(
      '.capture-location-row[data-location-id="loc_food"]',
    );
    const targetRow = tree.querySelector<HTMLElement>(
      '.capture-location-row[data-location-id="loc_right"]',
    );
    if (!sourceRow || !targetRow) {
      throw new Error("Touch hierarchy rows are unavailable");
    }
    const treeBounds = tree.getBoundingClientRect();
    const sourceBounds = sourceRow.getBoundingClientRect();
    const targetBounds = targetRow.getBoundingClientRect();
    const pairCenter = (
      sourceBounds.top +
      sourceBounds.bottom +
      targetBounds.top +
      targetBounds.bottom
    ) / 4;
    tree.scrollBy({
      behavior: "auto",
      top: pairCenter - (treeBounds.top + treeBounds.bottom) / 2,
    });
  });
  const hierarchySourceBox = await source.locator(".drag-handle").boundingBox();
  const hierarchyTargetBox = await hierarchyTarget.boundingBox();
  if (!hierarchySourceBox || !hierarchyTargetBox) {
    throw new Error("Touch hierarchy endpoints are not visible");
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{
      id: 6,
      radiusX: 3,
      radiusY: 3,
      x: hierarchySourceBox.x + hierarchySourceBox.width / 2,
      y: hierarchySourceBox.y + hierarchySourceBox.height / 2,
    }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{
      id: 6,
      radiusX: 3,
      radiusY: 3,
      x: hierarchyTargetBox.x + hierarchyTargetBox.width / 2,
      y: hierarchyTargetBox.y + hierarchyTargetBox.height / 2,
    }],
  });
  await expect(hierarchyTarget).toHaveAttribute(
    "data-touch-drop-intent",
    "inside",
  );
  const hierarchyCopyStyles = await hierarchyTarget.locator(
    ".reorder-drop-copy",
  ).evaluate((copy) => ({
    content: getComputedStyle(copy, "::after").content,
    display: getComputedStyle(copy).display,
  }));
  expect(hierarchyCopyStyles).toEqual({
    content: '"Move inside"',
    display: "block",
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const hierarchyConfirmation = page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  });
  await expect(hierarchyConfirmation).toBeVisible();
  await expect(hierarchyConfirmation).toContainText("KIT-L · Left side");
  await expect(hierarchyConfirmation).toContainText("KIT-R · Right side");
  const beforeHierarchyConfirmation = await localReplica(page) as {
    state: {
      locations: {
        captureStatus: string;
        id: string;
        parentId: string | null;
      }[];
    };
  };
  expect(
    beforeHierarchyConfirmation.state.locations.find(
      (location) => location.id === "loc_food",
    )?.parentId,
  ).toBe("loc_left");
  expect(
    beforeHierarchyConfirmation.state.locations.find(
      (location) => location.id === "loc_left",
    )?.captureStatus,
  ).toBe("counted");
  expect(
    beforeHierarchyConfirmation.state.locations.find(
      (location) => location.id === "loc_right",
    )?.captureStatus,
  ).toBe("counted");
  await hierarchyConfirmation.getByRole("button", {
    name: "Cancel",
  }).click();
  await expect(hierarchyConfirmation).toHaveCount(0);
  await expect(source.locator(".queue-row")).toBeFocused();

  const invalidSourceBox = await source.locator(".drag-handle").boundingBox();
  if (!invalidSourceBox) throw new Error("Touch reorder source is not visible");
  const invalidStart = {
    x: invalidSourceBox.x + invalidSourceBox.width / 2,
    y: invalidSourceBox.y + invalidSourceBox.height / 2,
  };
  const invalidEnd = { x: 1, y: invalidStart.y };
  expect(await page.evaluate(({ x, y }) =>
    !document.elementFromPoint(x, y)?.closest("[data-drop-target]"), invalidEnd
  )).toBe(true);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 2, radiusX: 3, radiusY: 3, x: invalidStart.x, y: invalidStart.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 2, radiusX: 3, radiusY: 3, x: invalidEnd.x, y: invalidEnd.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Choose a valid destination for Food cabinet",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  const spacesSource = page.locator(
    '.tree-row[data-location-id="loc_food"] .drag-handle',
  );
  const spacesTarget = page.locator(
    '.tree-row[data-location-id="loc_warm"]',
  );
  await spacesSource.evaluate((element) =>
    element.closest(".tree-row")?.scrollIntoView({ block: "center" })
  );
  const spacesSourceBox = await spacesSource.boundingBox();
  const spacesTargetBox = await spacesTarget.boundingBox();
  if (!spacesSourceBox || !spacesTargetBox) {
    throw new Error("Spaces touch reorder rows are not visible");
  }
  const spacesReorderStart = {
    x: spacesSourceBox.x + spacesSourceBox.width / 2,
    y: spacesSourceBox.y + spacesSourceBox.height / 2,
  };
  const spacesReorderEnd = {
    x: spacesTargetBox.x + spacesTargetBox.width / 2,
    y: spacesTargetBox.y + 2,
  };
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{
      id: 3,
      radiusX: 3,
      radiusY: 3,
      x: spacesReorderStart.x,
      y: spacesReorderStart.y,
    }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{
      id: 3,
      radiusX: 3,
      radiusY: 3,
      x: spacesReorderEnd.x,
      y: spacesReorderEnd.y,
    }],
  });
  await expect(spacesTarget).toHaveAttribute(
    "data-touch-drop-intent",
    "before",
  );
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: {
        locations: { captureStatus: string; id: string; order: number }[];
      };
    };
    const locations = replica.state.locations;
    return {
      parentStatus: locations.find((location) => location.id === "loc_left")
        ?.captureStatus,
      reordered:
        (locations.find((location) => location.id === "loc_food")?.order ?? 0) <
        (locations.find((location) => location.id === "loc_warm")?.order ?? 0),
    };
  }).toEqual({ parentStatus: "counted", reordered: true });
  await expect(page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  })).toHaveCount(0);

  const spacesHandle = page.locator(
    '.tree-row[data-location-id="loc_bin"] .drag-handle',
  );
  await spacesHandle.scrollIntoViewIfNeeded();
  const spacesHandleBox = await spacesHandle.boundingBox();
  if (!spacesHandleBox) throw new Error("Spaces touch handle is not visible");
  const spacesStart = {
    x: spacesHandleBox.x + spacesHandleBox.width / 2,
    y: spacesHandleBox.y + spacesHandleBox.height / 2,
  };
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 3, radiusX: 3, radiusY: 3, x: spacesStart.x, y: spacesStart.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 3, radiusX: 3, radiusY: 3, x: 1, y: spacesStart.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Choose a valid destination for Baking bin",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await reopenCaptureLocation(page, "loc_bin");
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  const inventoryHandle = page.locator(
    '.inventory-row[data-item-id="item_sugar"] .drag-handle',
  );
  await inventoryHandle.scrollIntoViewIfNeeded();
  const inventoryHandleBox = await inventoryHandle.boundingBox();
  if (!inventoryHandleBox) throw new Error("Inventory touch handle is not visible");
  const inventoryStart = {
    x: inventoryHandleBox.x + inventoryHandleBox.width / 2,
    y: inventoryHandleBox.y + inventoryHandleBox.height / 2,
  };
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 4, radiusX: 3, radiusY: 3, x: inventoryStart.x, y: inventoryStart.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 4, radiusX: 3, radiusY: 3, x: 1, y: inventoryStart.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Choose a different destination for Brown sugar",
  );
});

test("confirms a Capture touch reparent and atomically reopens completed parents", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The Pixel 7 Pro project covers touch hierarchy changes",
  );
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();

  const source = page.locator(
    '.capture-location-row[data-location-id="loc_food"]',
  );
  const target = page.locator(
    '.capture-location-row[data-location-id="loc_right"]',
  );
  await page.locator(".capture-tree").evaluate((tree) => {
    const sourceRow = tree.querySelector<HTMLElement>(
      '.capture-location-row[data-location-id="loc_food"]',
    );
    const targetRow = tree.querySelector<HTMLElement>(
      '.capture-location-row[data-location-id="loc_right"]',
    );
    if (!sourceRow || !targetRow) {
      throw new Error("Capture hierarchy rows are unavailable");
    }
    const treeBounds = tree.getBoundingClientRect();
    const sourceBounds = sourceRow.getBoundingClientRect();
    const targetBounds = targetRow.getBoundingClientRect();
    const pairCenter = (
      sourceBounds.top +
      sourceBounds.bottom +
      targetBounds.top +
      targetBounds.bottom
    ) / 4;
    tree.scrollBy({
      behavior: "auto",
      top: pairCenter - (treeBounds.top + treeBounds.bottom) / 2,
    });
  });
  const sourceBox = await source.locator(".drag-handle").boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Capture touch hierarchy endpoints are not visible");
  }
  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };
  const before = await localReplica(page) as {
    state: {
      activities: {
        patches: {
          after?: unknown;
          before?: unknown;
          id: string;
          path: string;
          target: string;
        }[];
      }[];
      locations: {
        captureStatus: string;
        id: string;
        parentId: string | null;
      }[];
      workspace: { revision: number };
    };
  };
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{
      id: 22,
      radiusX: 3,
      radiusY: 3,
      x: start.x,
      y: start.y,
    }],
  });
  for (let step = 1; step <= 12; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        id: 22,
        radiusX: 3,
        radiusY: 3,
        x: start.x + (end.x - start.x) * step / 12,
        y: start.y + (end.y - start.y) * step / 12,
      }],
    });
  }
  await expect(target).toHaveAttribute("data-touch-drop-intent", "inside");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  const confirmation = page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("KIT-L · Left side");
  await expect(confirmation).toContainText("KIT-R · Right side");
  const awaitingConfirmation = await localReplica(page) as typeof before;
  expect(awaitingConfirmation.state.activities).toHaveLength(
    before.state.activities.length,
  );
  expect(
    awaitingConfirmation.state.locations.find(
      (location) => location.id === "loc_food",
    )?.parentId,
  ).toBe("loc_left");
  expect(
    awaitingConfirmation.state.locations.find(
      (location) => location.id === "loc_left",
    )?.captureStatus,
  ).toBe("counted");
  expect(
    awaitingConfirmation.state.locations.find(
      (location) => location.id === "loc_right",
    )?.captureStatus,
  ).toBe("counted");
  expect(awaitingConfirmation.state.workspace.revision).toBe(
    before.state.workspace.revision,
  );

  await confirmation.getByRole("button", {
    name: "Move and reopen",
  }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    return {
      activityCount: replica.state.activities.length,
      leftStatus: replica.state.locations.find(
        (location) => location.id === "loc_left",
      )?.captureStatus,
      parentId: replica.state.locations.find(
        (location) => location.id === "loc_food",
      )?.parentId,
      revision: replica.state.workspace.revision,
      rightStatus: replica.state.locations.find(
        (location) => location.id === "loc_right",
      )?.captureStatus,
    };
  }).toEqual({
    activityCount: before.state.activities.length + 1,
    leftStatus: "in_progress",
    parentId: "loc_right",
    revision: before.state.workspace.revision + 1,
    rightStatus: "in_progress",
  });
  const after = await localReplica(page) as typeof before;
  expect(after.state.activities.at(-1)?.patches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        after: "loc_right",
        before: "loc_left",
        id: "loc_food",
        path: "parentId",
        target: "location",
      }),
      expect.objectContaining({
        after: "in_progress",
        before: "counted",
        id: "loc_left",
        path: "captureStatus",
        target: "location",
      }),
      expect.objectContaining({
        after: "in_progress",
        before: "counted",
        id: "loc_right",
        path: "captureStatus",
        target: "location",
      }),
    ]),
  );
  await expect(confirmation).toHaveCount(0);
  await expect(source.locator(".queue-row")).toBeFocused();
});

test("keeps Capture rows compact and supports a focused mobile Move fallback", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The Pixel 7 Pro project covers the Capture mobile fallback",
  );
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();

  const foodRow = page.locator(
    '.capture-location-row[data-location-id="loc_food"]',
  );
  await foodRow.locator(".queue-row").click();
  await expect(foodRow).toBeInViewport();

  const move = foodRow.getByRole("button", {
    name: "Move Food cabinet",
    exact: true,
  });
  await expect(move).toBeVisible();
  await expect(foodRow.getByRole("button", {
    name: "Move Food cabinet up",
  })).toBeHidden();
  await expect(foodRow.getByRole("button", {
    name: "Move Food cabinet down",
  })).toBeHidden();
  const moveBounds = await move.boundingBox();
  if (!moveBounds) throw new Error("The Capture Move action is not visible");
  expect(moveBounds.height).toBeGreaterThanOrEqual(44);
  expect(moveBounds.width).toBeGreaterThanOrEqual(44);

  const density = await page.locator(".capture-tree").evaluate((tree) => {
    const rows = [
      ...tree.querySelectorAll<HTMLElement>(".capture-location-row"),
    ];
    const names = [
      ...tree.querySelectorAll<HTMLElement>(".queue-name span"),
    ];
    const hitTargets = [
      ...tree.querySelectorAll<HTMLElement>(
        ".capture-location-row > .drag-handle, .capture-location-row > .capture-collapse",
      ),
    ];
    const visibleActionButtons = [
      ...tree.querySelectorAll<HTMLElement>(
        ".capture-location-row > .row-actions button",
      ),
    ].filter((button) => {
      const buttonStyles = getComputedStyle(button);
      const actionsStyles = getComputedStyle(
        button.closest<HTMLElement>(".row-actions") as HTMLElement,
      );
      return buttonStyles.display !== "none" &&
        buttonStyles.visibility !== "hidden" &&
        Number.parseFloat(actionsStyles.opacity) > 0.1;
    });
    return {
      appendedActionGroups: tree.querySelectorAll(
        ".mobile-capture-actions",
      ).length,
      maxNameHeight: Math.max(
        ...names.map((name) => name.getBoundingClientRect().height),
      ),
      maxRowHeight: Math.max(
        ...rows.map((row) => row.getBoundingClientRect().height),
      ),
      minQueueShare: Math.min(...rows.map((row) => {
        const rowWidth = row.getBoundingClientRect().width;
        const queueWidth = row.querySelector<HTMLElement>(".queue-row")
          ?.getBoundingClientRect().width ?? 0;
        return queueWidth / rowWidth;
      })),
      narrowActionTargets: visibleActionButtons
        .filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width < 44 || bounds.height < 44;
        })
        .map((button) => button.getAttribute("aria-label")),
      narrowRowTargets: hitTargets
        .filter((target) => {
          const bounds = target.getBoundingClientRect();
          return bounds.width < 44 || bounds.height < 44;
        })
        .map((target) => target.getAttribute("aria-label")),
      rowOverflow: rows
        .filter((row) => row.scrollWidth > row.clientWidth)
        .map((row) => row.dataset.locationId),
      visibleActionLabels: visibleActionButtons.map(
        (button) => button.getAttribute("aria-label"),
      ),
    };
  });
  expect(density.appendedActionGroups).toBe(0);
  expect(density.maxNameHeight).toBeLessThanOrEqual(21);
  expect(density.maxRowHeight).toBeLessThanOrEqual(52);
  expect(density.minQueueShare).toBeGreaterThanOrEqual(0.7);
  expect(density.narrowActionTargets).toEqual([]);
  expect(density.narrowRowTargets).toEqual([]);
  expect(density.rowOverflow).toEqual([]);
  expect(density.visibleActionLabels).toEqual(["Move Food cabinet"]);

  const beforeReorder = await localReplica(page) as {
    state: {
      activities: unknown[];
      locations: {
        captureStatus: string;
        id: string;
        order: number;
        parentId: string | null;
      }[];
      workspace: { revision: number };
    };
  };
  await move.click();
  const moveDialog = page.getByRole("dialog", {
    name: "Move Food cabinet",
  });
  await expect(moveDialog.getByLabel("Parent space")).toBeFocused();
  await moveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(moveDialog).toHaveCount(0);
  await expect(move).toBeFocused();

  await move.click();
  await moveDialog.getByLabel("Position").selectOption({
    label: "After C-02 · Cabinet above oven",
  });
  await moveDialog.getByRole("button", { name: "Review move" }).click();
  await expect(moveDialog).toHaveCount(0);
  await expect(page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  })).toHaveCount(0);
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof beforeReorder;
    const locations = replica.state.locations;
    return {
      activityCount: replica.state.activities.length,
      drawerOrder: locations.find((location) => location.id === "loc_drawer")
        ?.order,
      foodOrder: locations.find((location) => location.id === "loc_food")
        ?.order,
      leftStatus: locations.find((location) => location.id === "loc_left")
        ?.captureStatus,
      revision: replica.state.workspace.revision,
      warmOrder: locations.find((location) => location.id === "loc_warm")
        ?.order,
    };
  }).toEqual(expect.objectContaining({
    activityCount: beforeReorder.state.activities.length + 1,
    leftStatus: "counted",
    revision: beforeReorder.state.workspace.revision + 1,
  }));
  const afterReorder = await localReplica(page) as typeof beforeReorder;
  const reorderedLocations = afterReorder.state.locations;
  const foodOrder = reorderedLocations.find(
    (location) => location.id === "loc_food",
  )?.order ?? 0;
  expect(foodOrder).toBeGreaterThan(
    reorderedLocations.find((location) => location.id === "loc_warm")
      ?.order ?? 0,
  );
  expect(foodOrder).toBeLessThan(
    reorderedLocations.find((location) => location.id === "loc_drawer")
      ?.order ?? Number.POSITIVE_INFINITY,
  );
  const before = await localReplica(page) as typeof beforeReorder;

  await move.click();
  await moveDialog.getByLabel("Parent space").selectOption("loc_right");
  await moveDialog.getByRole("button", { name: "Review move" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  });
  await expect(confirmation).toContainText("KIT-L · Left side");
  await expect(confirmation).toContainText("KIT-R · Right side");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(move).toBeFocused();

  await move.click();
  await moveDialog.getByLabel("Parent space").selectOption("loc_right");
  await moveDialog.getByRole("button", { name: "Review move" }).click();
  await confirmation.getByRole("button", {
    name: "Move and reopen",
  }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    return {
      activityCount: replica.state.activities.length,
      leftStatus: replica.state.locations.find(
        (location) => location.id === "loc_left",
      )?.captureStatus,
      parentId: replica.state.locations.find(
        (location) => location.id === "loc_food",
      )?.parentId,
      revision: replica.state.workspace.revision,
      rightStatus: replica.state.locations.find(
        (location) => location.id === "loc_right",
      )?.captureStatus,
    };
  }).toEqual({
    activityCount: before.state.activities.length + 1,
    leftStatus: "in_progress",
    parentId: "loc_right",
    revision: before.state.workspace.revision + 1,
    rightStatus: "in_progress",
  });
  await expect(foodRow.locator(".queue-row")).toBeFocused();
});

test("moves a space from visible mobile tree actions and atomically reopens its completed parents", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The Pixel 7 Pro project covers the mobile hierarchy fallback",
  );
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();

  const row = page.locator('.tree-row[data-location-id="loc_food"]');
  await row.locator(".tree-select").click();
  const earlier = page.getByRole("button", {
    name: "Earlier Food cabinet",
  });
  const later = page.getByRole("button", {
    name: "Later Food cabinet",
  });
  const edit = page.getByRole("button", {
    name: "Edit details for Food cabinet",
  });
  const move = page.getByRole("button", {
    name: "Move Food cabinet",
    exact: true,
  });
  for (const action of [earlier, later, edit, move]) {
    await expect(action).toBeVisible();
  }
  await expect(move).toBeInViewport();
  const moveBounds = await move.boundingBox();
  if (!moveBounds) throw new Error("The mobile tree Move action is not visible");
  expect(moveBounds.width).toBeGreaterThanOrEqual(44);
  expect(moveBounds.height).toBeGreaterThanOrEqual(44);

  const panelNavigation = page.getByRole("group", {
    name: "Space panels navigation",
  });
  const inspector = page.locator("#space-inspector");
  const draftName = "Unsaved food cabinet name";
  await edit.click();
  await inspector.getByLabel("Friendly name").fill(draftName);
  await panelNavigation.getByRole("button", {
    name: "space hierarchy",
  }).click();
  await expect(row).toBeInViewport();

  const before = await localReplica(page) as {
    state: {
      activities: {
        patches: {
          after?: unknown;
          before?: unknown;
          id: string;
          path: string;
          target: string;
        }[];
      }[];
      locations: {
        captureStatus: string;
        id: string;
        parentId: string | null;
      }[];
      workspace: { revision: number };
    };
  };
  await move.click();
  const moveDialog = page.getByRole("dialog", {
    name: "Move Food cabinet",
  });
  await expect(moveDialog).toBeVisible();
  await moveDialog.getByLabel("Parent space").selectOption("loc_right");
  const position = moveDialog.getByLabel("Position");
  await expect(position).toBeVisible();
  const lastPosition = position.locator("option:not([disabled])").last();
  const lastPositionValue = await lastPosition.getAttribute("value");
  if (!lastPositionValue) {
    throw new Error("The hierarchy Move dialog has no selectable position");
  }
  await position.selectOption(lastPositionValue);
  await moveDialog.getByRole("button", { name: "Review move" }).click();

  const confirmation = page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("KIT-L");
  await expect(confirmation).toContainText("Left side");
  await expect(confirmation).toContainText("KIT-R");
  await expect(confirmation).toContainText("Right side");
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(confirmation).toHaveCount(0);
  await expect(move).toBeFocused();
  const afterCancel = await localReplica(page) as typeof before;
  expect(afterCancel.state.workspace.revision).toBe(
    before.state.workspace.revision,
  );
  expect(afterCancel.state.activities).toHaveLength(
    before.state.activities.length,
  );
  expect(
    afterCancel.state.locations.find((location) => location.id === "loc_food")
      ?.parentId,
  ).toBe("loc_left");

  await move.click();
  await moveDialog.getByLabel("Parent space").selectOption("loc_right");
  await moveDialog.getByLabel("Position").selectOption(lastPositionValue);
  await moveDialog.getByRole("button", { name: "Review move" }).click();
  const confirmedMove = page.getByRole("dialog", {
    name: "Reopen completed spaces?",
  });
  await confirmedMove.getByRole("button", {
    name: "Move and reopen",
  }).click();

  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    const state = replica.state;
    return {
      activityCount: state.activities.length,
      leftStatus: state.locations.find((location) => location.id === "loc_left")
        ?.captureStatus,
      parentId: state.locations.find((location) => location.id === "loc_food")
        ?.parentId,
      revision: state.workspace.revision,
      rightStatus: state.locations.find((location) => location.id === "loc_right")
        ?.captureStatus,
    };
  }).toEqual({
    activityCount: before.state.activities.length + 1,
    leftStatus: "in_progress",
    parentId: "loc_right",
    revision: before.state.workspace.revision + 1,
    rightStatus: "in_progress",
  });
  const after = await localReplica(page) as typeof before;
  expect(after.state.activities.at(-1)?.patches).toEqual(expect.arrayContaining([
    expect.objectContaining({
      after: "loc_right",
      before: "loc_left",
      id: "loc_food",
      path: "parentId",
      target: "location",
    }),
    expect.objectContaining({
      after: "in_progress",
      before: "counted",
      id: "loc_left",
      path: "captureStatus",
      target: "location",
    }),
    expect.objectContaining({
      after: "in_progress",
      before: "counted",
      id: "loc_right",
      path: "captureStatus",
      target: "location",
    }),
  ]));
  await panelNavigation.getByRole("button", {
    name: "space details",
  }).click();
  await expect(inspector.getByLabel("Friendly name")).toHaveValue(draftName);
  await expect(inspector.getByLabel("Parent space")).toHaveValue("loc_right");
});

test("guides incomplete evidence into a reviewable plan", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(".nav:visible", { hasText: "Plan" }).click();

  const readiness = page.getByRole("region", { name: "Planning readiness" });
  await expect(readiness.getByRole("heading", { name: "Enough to try, with gaps to review" })).toBeVisible();
  await expect(readiness.getByText("7 counted destinations")).toBeVisible();
  await expect(readiness.getByText("2 spaces still need a first-pass decision")).toBeVisible();
  await readiness.getByRole("button", { name: "Continue count" }).click();

  const cornerEditor = page.getByRole("region", { name: "Capture inside Corner cabinet" });
  await expect(cornerEditor).toBeFocused();
  await expect(page.getByRole("heading", { name: "C-04 · Corner cabinet" })).toBeVisible();
  const beforeAdvance = await localReplica(page) as {
    state: { locations: { captureStatus: string; id: string }[] };
  };
  await page.getByRole("button", {
    name: "Open next unfinished location without changing Corner cabinet: BX-09, Appliance parts",
  }).click();
  await expect(page.getByRole("heading", { name: "BX-09 · Appliance parts" })).toBeVisible();
  const afterAdvance = await localReplica(page) as typeof beforeAdvance;
  expect(afterAdvance.state.locations.find((location) => location.id === "loc_corner")?.captureStatus)
    .toBe(beforeAdvance.state.locations.find((location) => location.id === "loc_corner")?.captureStatus);
  expect(afterAdvance.state.locations.find((location) => location.id === "loc_box")?.captureStatus)
    .toBe(beforeAdvance.state.locations.find((location) => location.id === "loc_box")?.captureStatus);

  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  const refreshedReadiness = page.getByRole("region", { name: "Planning readiness" });
  await refreshedReadiness.getByText("2 more ways to improve confidence").click();
  await refreshedReadiness.getByRole("button", { name: "Review a space" }).click();
  await expect(page.getByRole("group", { name: "Suitability" })).toBeFocused();

  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  const capacityReadiness = page.getByRole("region", { name: "Planning readiness" });
  await capacityReadiness.getByText("2 more ways to improve confidence").click();
  await capacityReadiness.getByRole("button", { name: "Review capacity" }).click();
  await expect(page.getByRole("group", { name: "Interior dimensions (optional)" })).toBeFocused();

  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  await page.getByRole("button", { name: "Generate move plan" }).click();
  await expect(page.getByText(/explainable moves added to the new plan/)).toBeVisible();
  const planCards = page.locator(".plan-list > div");
  await expect(planCards.first().getByText("Capacity unverified")).toBeVisible();
  await expect(planCards.first().getByRole("button", { name: "Review destination" })).toBeVisible();
  const readyMove = planCards.first().getByRole("button", { name: "Mark moved" });
  const blockedMove = planCards.nth(1).getByRole("button", { name: "Step 1 first" });
  await expect(readyMove).toBeEnabled();
  await expect(blockedMove).toBeDisabled();
  await expect(blockedMove).toHaveAttribute("data-step-state", "blocked");
  const moveStyles = await Promise.all([readyMove, blockedMove].map(
    (button) => button.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        background: styles.backgroundColor,
        color: styles.color,
        cursor: styles.cursor,
      };
    }),
  ));
  expect(moveStyles[1]?.background).not.toBe(moveStyles[0]?.background);
  expect(moveStyles[1]?.cursor).toBe("not-allowed");
  const planLayout = await planCards.first().evaluate((card) => {
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".plan-step-actions button")];
    const reviewBounds = buttons.slice(0, 2).map((button) => button.getBoundingClientRect());
    const moveBounds = buttons.at(-1)?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      narrowTargets: buttons
        .filter((button) => button.getBoundingClientRect().height < 44)
        .map((button) => button.textContent),
      reviewsShareRow: reviewBounds.length === 2
        ? Math.abs(reviewBounds[0]!.top - reviewBounds[1]!.top) < 2
        : false,
      moveFollowsReviews: reviewBounds.length === 2 && moveBounds
        ? moveBounds.top >= Math.max(reviewBounds[0]!.bottom, reviewBounds[1]!.bottom)
        : false,
    };
  });
  expect(planLayout.documentOverflow).toBe(false);
  expect(planLayout.narrowTargets).toEqual([]);
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    expect(planLayout.reviewsShareRow).toBe(true);
    expect(planLayout.moveFollowsReviews).toBe(true);
  }
  const planAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    planAccessibility.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);

  const generated = await localReplica(page) as {
    state: {
      activities: unknown[];
      items: { id: string; name: string }[];
      locations: { id: string; name: string }[];
      plans: {
        status: string;
        steps: {
          destinationId: string;
          itemId: string | null;
        }[];
      }[];
    };
  };
  const activePlan = generated.state.plans.find((plan) => plan.status === "active");
  const itemStep = activePlan?.steps.find((step) => step.itemId);
  const reviewedItem = generated.state.items.find((item) => item.id === itemStep?.itemId);
  expect(reviewedItem).toBeTruthy();

  await page.getByRole("button", { name: "Review item" }).first().click();
  const itemEditor = page.getByRole("dialog", { name: "Review item" });
  await expect(itemEditor.getByText(reviewedItem?.name ?? "", { exact: true })).toBeVisible();
  const afterItemReview = await localReplica(page) as typeof generated;
  expect(afterItemReview.state.activities).toEqual(generated.state.activities);
  expect(afterItemReview.state.plans).toEqual(generated.state.plans);
  await itemEditor.getByRole("button", { name: "Close item editor" }).click();

  const firstDestination = generated.state.locations.find(
    (location) => location.id === activePlan?.steps[0]?.destinationId,
  );
  expect(firstDestination).toBeTruthy();
  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  await page.getByRole("button", { name: "Review destination" }).first().click();
  await expect(page.getByRole("region", { name: `Edit ${firstDestination?.name ?? ""}` })).toBeFocused();
  const afterDestinationReview = await localReplica(page) as typeof generated;
  expect(afterDestinationReview.state.activities).toEqual(generated.state.activities);
  expect(afterDestinationReview.state.plans).toEqual(generated.state.plans);
});

test("suggests unique location codes without replacing a manual code", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);

  const code = page.getByLabel("Short ID");
  const name = page.getByLabel("Friendly name");
  await name.fill("Priority bin");
  await expect(code).toHaveValue("PB");
  await page.getByRole("button", { name: "Add inside Kitchen" }).click();
  await expect(page.locator(".capture-location-row", { hasText: "Priority bin" })).toBeVisible();

  await name.fill("Priority bin");
  await expect(code).toHaveValue("PB-2");
  await code.fill("MANUAL");
  await name.fill("Overflow bin");
  await expect(code).toHaveValue("MANUAL");
});

test("opens the exact item section needed for planning evidence", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);
  await page.getByLabel("What is it?").fill("Unclassified charger");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await page.locator(".nav:visible", { hasText: "Plan" }).click();

  const readiness = page.getByRole("region", { name: "Planning readiness" });
  await readiness.getByText(/more ways to improve confidence/).click();
  await readiness.getByRole("button", { name: "Review an item" }).click();

  const itemEditor = page.getByRole("dialog", { name: "Edit item" });
  await expect(itemEditor.getByText("Unclassified charger", { exact: true })).toBeVisible();
  const organizeSection = itemEditor.locator('[data-guidance-section="item_details"]');
  const coarsePointer = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (coarsePointer) await expect(organizeSection).toBeFocused();
  else await expect(itemEditor.getByLabel("Category")).toBeFocused();
});

test("preserves a failed creation draft and avoids narrow-screen overflow", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 860 });
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);

  await page.getByLabel("Short ID").fill("C-01");
  await page.getByLabel("Friendly name").fill("Keep this draft");
  await page.getByRole("button", { name: "Add inside Kitchen" }).click();
  await expect(page.locator(".feedback-toast[role='alert']")).toBeVisible();
  await expect(page.getByLabel("Short ID")).toHaveValue("C-01");
  await expect(page.getByLabel("Friendly name")).toHaveValue("Keep this draft");

  await page.getByLabel("Unit", { exact: true }).fill("extraordinarily-long-custom-unit-name");
  await page.getByLabel("What is it?").fill("Long unit test item");
  await page.getByRole("button", { name: "Save & add next" }).click();
  const metrics = await page.evaluate(() => ({
    bottomNavigation: (() => {
      const navigation = document.querySelector<HTMLElement>(".bottom");
      const main = document.querySelector<HTMLElement>(".app-shell > main");
      if (!navigation || !main) return null;
      const navigationBounds = navigation.getBoundingClientRect();
      const mainBounds = main.getBoundingClientRect();
      return {
        mainBottom: Math.round(mainBounds.bottom),
        navigationTop: Math.round(navigationBounds.top),
        width: Math.round(navigationBounds.width),
      };
    })(),
    captureStacked: (() => {
      const queue = document.querySelector<HTMLElement>(".capture > .queue");
      const card = document.querySelector<HTMLElement>(".capture > .capture-card");
      return Boolean(queue && card && card.getBoundingClientRect().top >= queue.getBoundingClientRect().bottom);
    })(),
    documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    finishOverflow: (() => {
      const finish = document.querySelector<HTMLElement>(".finish");
      return Boolean(finish && finish.scrollWidth > finish.clientWidth);
    })(),
    narrowTargets: [...document.querySelectorAll<HTMLElement>(".finish button, .breadcrumbs button")]
      .filter((target) => target.getBoundingClientRect().height < 44)
      .map((target) => target.textContent),
  }));
  expect(metrics.bottomNavigation?.width).toBe(412);
  expect(metrics.bottomNavigation?.mainBottom).toBe(
    metrics.bottomNavigation?.navigationTop,
  );
  expect({
    captureStacked: metrics.captureStacked,
    documentOverflow: metrics.documentOverflow,
    finishOverflow: metrics.finishOverflow,
    narrowTargets: metrics.narrowTargets,
  }).toEqual({
    captureStacked: true,
    documentOverflow: false,
    finishOverflow: false,
    narrowTargets: [],
  });

  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  await page.getByText("Plan priorities", { exact: true }).click();
  const suitabilityHelp = page.getByRole("button", { name: "How suitability affects a plan" });
  await suitabilityHelp.evaluate((button) => button.scrollIntoView({ block: "end" }));
  const occlusion = await suitabilityHelp.evaluate((button) => {
    const navigation = document.querySelector<HTMLElement>(".bottom");
    if (!navigation) throw new Error("Bottom navigation is missing");
    const buttonBounds = button.getBoundingClientRect();
    const navigationBounds = navigation.getBoundingClientRect();
    const hit = document.elementFromPoint(
      buttonBounds.left + buttonBounds.width / 2,
      buttonBounds.top + buttonBounds.height / 2,
    );
    return {
      buttonBottom: Math.round(buttonBounds.bottom),
      centerHitsButton: Boolean(hit && button.contains(hit)),
      navigationTop: Math.round(navigationBounds.top),
    };
  });
  expect(occlusion.buttonBottom).toBeLessThanOrEqual(occlusion.navigationTop);
  expect(occlusion.centerHitsButton).toBe(true);
});

test("distinguishes duplicate inventory actions by quantity and unit", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);

  await page.getByLabel("Qty").fill("2");
  await page.getByLabel("Unit", { exact: true }).fill("AA");
  await page.getByLabel("What is it?").fill("Batteries");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await expect(page.getByText("Batteries", { exact: true })).toHaveCount(1);
  await page.getByLabel("Qty").fill("3");
  await page.getByLabel("Unit", { exact: true }).fill("AAA");
  await page.getByLabel("What is it?").fill("Batteries");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await expect(page.getByText("Batteries", { exact: true })).toHaveCount(2);

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Search inventory").fill("Batteries");

  for (const amount of ["2 AA", "3 AAA"]) {
    await expect(page.getByRole("checkbox", { name: `Select Batteries, ${amount} in Kitchen` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Open Batteries, ${amount} in Kitchen` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Edit or move Batteries, ${amount} in Kitchen` })).toBeVisible();
  }
});

test("keeps the Capture hierarchy readable at compact desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1132, height: 900 });
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
  await page.mouse.move(0, 0);
  const usesFinePointer = await page.evaluate(() =>
    matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  if (usesFinePointer) {
    await expect.poll(() => page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".capture-location-row > .row-actions")]
        .filter((actions) => Number.parseFloat(getComputedStyle(actions).opacity) > 0.1)
        .length,
    )).toBe(1);
  }

  const metrics = await page.evaluate(() => {
    const capture = document.querySelector<HTMLElement>(".capture");
    const queue = document.querySelector<HTMLElement>(".capture > .queue");
    const card = document.querySelector<HTMLElement>(".capture > .capture-card");
    const codes = [...document.querySelectorAll<HTMLElement>(".capture-location-row .queue-name b")];
    const names = [...document.querySelectorAll<HTMLElement>(".capture-location-row .queue-name span")];
    const rows = [...document.querySelectorAll<HTMLElement>(".capture-location-row")];
    const visibleActions = [...document.querySelectorAll<HTMLElement>(".capture-location-row > .row-actions")]
      .filter((actions) => Number.parseFloat(getComputedStyle(actions).opacity) > 0.1);

    if (!capture || !queue || !card) throw new Error("Capture layout is missing");
    const queueBounds = queue.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    return {
      clippedCodes: codes.filter((code) => code.scrollWidth > code.clientWidth).map((code) => code.innerText),
      clippedNames: names.filter((name) => name.scrollWidth > name.clientWidth).map((name) => name.innerText),
      cardWidth: Math.round(cardBounds.width),
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      inactiveQueueRightGaps: rows
        .filter((row) => row.dataset.active !== "true")
        .map((row) => {
          const rowBounds = row.getBoundingClientRect();
          const queueBounds = row.querySelector<HTMLElement>(".queue-row")
            ?.getBoundingClientRect();
          return queueBounds
            ? Math.round(rowBounds.right - queueBounds.right)
            : Number.POSITIVE_INFINITY;
        }),
      maxNameHeight: Math.max(
        ...names.map((name) => name.getBoundingClientRect().height),
      ),
      maxRowHeight: Math.max(
        ...rows.map((row) => row.getBoundingClientRect().height),
      ),
      nonOverlayActions: [
        ...document.querySelectorAll<HTMLElement>(
          ".capture-location-row > .row-actions",
        ),
      ].filter((actions) => getComputedStyle(actions).position !== "absolute")
        .length,
      queueWidth: Math.round(queueBounds.width),
      rowOverflow: rows
        .filter((row) => row.scrollWidth > row.clientWidth)
        .map((row) => row.dataset.locationId),
      sideBySide: Math.abs(cardBounds.top - queueBounds.top) < 2 && cardBounds.left > queueBounds.right,
      usesFinePointer: matchMedia("(hover: hover) and (pointer: fine)").matches,
      visibleActions: visibleActions.length,
    };
  });

  expect(metrics.clippedCodes).toEqual([]);
  expect(metrics.clippedNames).toEqual([]);
  expect(metrics.documentOverflow).toBe(false);
  expect(Math.max(...metrics.inactiveQueueRightGaps)).toBeLessThanOrEqual(1);
  expect(metrics.maxNameHeight).toBeLessThanOrEqual(21);
  expect(metrics.maxRowHeight).toBeLessThanOrEqual(52);
  expect(metrics.nonOverlayActions).toBe(0);
  expect(metrics.sideBySide).toBe(true);
  expect(metrics.queueWidth).toBeGreaterThanOrEqual(260);
  expect(metrics.rowOverflow).toEqual([]);
  expect(metrics.cardWidth).toBeGreaterThanOrEqual(280);
  if (metrics.usesFinePointer) expect(metrics.visibleActions).toBe(1);

  await page.locator('.capture-location-row[data-location-id="loc_bin"] .queue-row').click();
  const populatedMetrics = await page.locator(".captured").evaluate((captured) => ({
    itemNameWidths: [...captured.querySelectorAll<HTMLElement>(".captured-row > .item-name")]
      .map((name) => Math.round(name.getBoundingClientRect().width)),
    rowOverflow: [...captured.querySelectorAll<HTMLElement>(".captured-row")]
      .filter((row) => row.scrollWidth > row.clientWidth)
      .map((row) => row.innerText),
  }));
  expect(populatedMetrics.itemNameWidths).toHaveLength(2);
  expect(Math.min(...populatedMetrics.itemNameWidths)).toBeGreaterThanOrEqual(120);
  expect(populatedMetrics.rowOverflow).toEqual([]);
});

test("executes a planned move and rolls it back from Activity", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(".nav:visible", { hasText: "Plan" }).click();
  await page.getByRole("button", { name: "Generate move plan" }).click();
  const before = await localReplica(page) as {
    state: {
      items: { id: string; locationId: string }[];
      locations: {
        captureStatus: string;
        id: string;
        parentId: string | null;
      }[];
      plans: {
        status: string;
        steps: {
          destinationId: string;
          itemId: string | null;
          locationId: string | null;
          sourceId: string;
          type: "item" | "location";
        }[];
      }[];
    };
  };
  const step = before.state.plans.find((plan) => plan.status === "active")!.steps[0]!;

  await page.getByRole("button", { name: "Mark moved" }).first().click();
  await expect.poll(async () => {
    const moved = await localReplica(page) as typeof before;
    return step.type === "item"
      ? moved.state.items.find((item) => item.id === step.itemId)?.locationId
      : moved.state.locations.find((location) => location.id === step.locationId)?.parentId;
  }).toBe(step.destinationId);
  const afterMove = await localReplica(page) as typeof before;
  for (const locationId of [step.sourceId, step.destinationId]) {
    expect(
      afterMove.state.locations.find((location) => location.id === locationId)
        ?.captureStatus,
    ).toBe("in_progress");
  }

  await page.locator(".nav:visible", { hasText: "Activity" }).click();
  await page.locator(".history>div").first().getByRole("button", { name: /^Undo Completed plan step:/ }).click();
  await expect.poll(async () => {
    const rolledBack = await localReplica(page) as typeof before;
    return step.type === "item"
      ? rolledBack.state.items.find((item) => item.id === step.itemId)?.locationId
      : rolledBack.state.locations.find((location) => location.id === step.locationId)?.parentId;
  }).toBe(step.sourceId);
  const afterUndo = await localReplica(page) as typeof before;
  for (const locationId of [step.sourceId, step.destinationId]) {
    expect(
      afterUndo.state.locations.find((location) => location.id === locationId)
        ?.captureStatus,
    ).toBe(
      before.state.locations.find((location) => location.id === locationId)
        ?.captureStatus,
    );
  }
});

test("supports drag organization and the partial-move fallback", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCaptureLocation(page, "loc_left");
  await reopenCaptureLocation(page, "loc_food");
  await reopenCaptureLocation(page, "loc_lower");
  await reopenCaptureLocation(page, "loc_bin");
  await reopenCaptureLocation(page, "loc_warm");
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  await expect(page.getByRole("list", { name: "Space hierarchy" })).toBeVisible();
  await expect(page.locator('[data-location-id="loc_bin"] .drag-handle[title="Drag Baking bin to move or nest it"]')).toBeVisible();
  await page.getByRole("button", { name: "Collapse Kitchen" }).click();
  await expect(page.locator('[data-location-id="loc_bin"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Kitchen" }).click();
  const bakingBin = page.locator('[data-location-id="loc_bin"]');
  const foodCabinet = page.locator('[data-location-id="loc_food"]');
  await expect(bakingBin).toBeVisible();
  await expect(foodCabinet).toBeVisible();
  if (testInfo.project.name === "desktop-chromium") {
    await foodCabinet.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await bakingBin.dragTo(foodCabinet);
  } else {
    await bakingBin.locator(".tree-select").click();
    await page.getByLabel("Parent space").selectOption("loc_food");
    await page.getByRole("button", { name: "Save space" }).click();
  }
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { id: string; parentId: string | null }[] } };
    return replica.state.locations.find((location) => location.id === "loc_bin")?.parentId;
  }).toBe("loc_food");

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await expect(page.locator('.inventory-row[data-item-id="item_sugar"] .drag-handle[title="Drag Brown sugar to reorder"]')).toHaveCount(0);
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  await expect(page.locator('.inventory-row[data-item-id="item_sugar"] .drag-handle[title="Drag Brown sugar to reorder"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Brown sugar, 2 bags up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Brown sugar, 2 bags down" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Brown sugar, 2 bags in Kitchen › Left side › Food cabinet › Baking bin" }).check();
  await expect(page.getByRole("combobox", { name: "Move selected items" }).locator('option[value="loc_bin"]')).toBeDisabled();
  await page.getByRole("button", { name: "Clear" }).click();
  if (testInfo.project.name === "desktop-chromium") {
    await page.locator('[data-item-id="item_sugar"]').dragTo(
      page.locator('[data-item-id="item_flour"]'),
    );
  } else {
    await page.getByRole("button", {
      name: "Move Brown sugar, 2 bags up",
    }).click();
  }
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { items: { id: string; order: number }[] } };
    const sugar = replica.state.items.find((item) => item.id === "item_sugar")?.order ?? 1;
    const flour = replica.state.items.find((item) => item.id === "item_flour")?.order ?? 0;
    return sugar < flour;
  }).toBe(true);

  await page.getByLabel("Filter by location").selectOption("");
  await page.locator('[data-item-id="item_pasta"] .item-name').click();
  await page.getByLabel("Quantity", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Save item" }).click();
  await page.getByLabel("How many?").fill("2");
  await page.getByLabel("Move to").selectOption("loc_food");
  await page.getByRole("button", { name: "Move quantity" }).click();
  await expect(
    page.getByRole("dialog", { name: "Review item" }),
  ).toBeHidden();
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.locator(".loading")).toHaveCount(0);
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { items: { id: string; locationId: string; name: string; quantity: number }[] } };
    return replica.state.items.filter((item) => item.name === "Pasta").map((item) => [item.locationId, item.quantity]).sort();
  }).toEqual([["loc_food", 2], ["loc_warm", 4]]);
  await expect(page.getByRole("checkbox", { name: "Select Pasta, 2 boxes in Kitchen › Left side › Food cabinet" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Pasta, 4 boxes in Kitchen › Left side › Cabinet above oven" })).toBeVisible();
});

test("confirms one atomic bulk move across completed spaces", async ({
  page,
}, testInfo) => {
  test.skip(
    !["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name),
    "Phone and desktop cover the responsive bulk-move confirmation",
  );
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  const pasta = page.getByRole("checkbox", {
    name: "Select Pasta, 6 boxes in Kitchen › Left side › Cabinet above oven",
  });
  const flour = page.getByRole("checkbox", {
    name: "Select All-purpose flour, 1 bag in Kitchen › Right side › Lower cabinet › Baking bin",
  });
  await pasta.check();
  await flour.check();
  const destination = page.getByRole("combobox", {
    name: "Move selected items",
  });
  const destinationStyle = await destination.evaluate((element) => {
    const styles = getComputedStyle(element);
    const luminance = (value: string) => {
      const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3)
        .map((channel) => Number(channel) / 255) ?? [];
      const linear = channels.map((channel) => channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
      );
      return 0.2126 * (linear[0] ?? 0) +
        0.7152 * (linear[1] ?? 0) +
        0.0722 * (linear[2] ?? 0);
    };
    const foreground = luminance(styles.color);
    const background = luminance(styles.backgroundColor);
    return {
      background: styles.backgroundColor,
      contrast: (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05),
      color: styles.color,
    };
  });
  expect(destinationStyle.color).not.toBe(destinationStyle.background);
  expect(destinationStyle.contrast).toBeGreaterThanOrEqual(4.5);
  const before = await localReplica(page) as {
    state: {
      activities: unknown[];
      items: { id: string; locationId: string }[];
      locations: { captureStatus: string; id: string }[];
    };
  };

  await destination.selectOption("loc_counter");
  const confirmation = page.getByRole("dialog", {
    name: "Reopen completed spaces and move items?",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(
    "Moving 2 selected records to CTR · Counter",
  );
  await expect(confirmation.locator(".hierarchy-review-list li")).toHaveCount(3);
  await expect(confirmation).toContainText("C-02 · Cabinet above oven");
  await expect(confirmation).toContainText("B-17 · Baking bin");
  await expect(confirmation).toContainText("CTR · Counter");
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(confirmation).toBeHidden();
  await expect(pasta).toBeChecked();
  await expect(flour).toBeChecked();
  await expect(destination).toHaveValue("");

  await destination.selectOption("loc_counter");
  await confirmation.getByRole("button", {
    name: "Move 2 and reopen",
  }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator(".floating")).toHaveCount(0);
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    return {
      activityCount: replica.state.activities.length,
      itemLocations: replica.state.items
        .filter((item) => ["item_flour", "item_pasta"].includes(item.id))
        .map((item) => [item.id, item.locationId])
        .sort(),
      locationStatuses: replica.state.locations
        .filter((location) =>
          ["loc_bin", "loc_counter", "loc_warm"].includes(location.id)
        )
        .map((location) => [location.id, location.captureStatus])
        .sort(),
    };
  }).toEqual({
    activityCount: before.state.activities.length + 1,
    itemLocations: [
      ["item_flour", "loc_counter"],
      ["item_pasta", "loc_counter"],
    ],
    locationStatuses: [
      ["loc_bin", "in_progress"],
      ["loc_counter", "in_progress"],
      ["loc_warm", "in_progress"],
    ],
  });

  await page.locator(".nav:visible", { hasText: "Activity" }).click();
  await page.getByRole("button", {
    name: "Undo Moved 2 item records and reopened affected spaces",
  }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page) as typeof before;
    return {
      itemLocations: replica.state.items
        .filter((item) => ["item_flour", "item_pasta"].includes(item.id))
        .map((item) => [item.id, item.locationId])
        .sort(),
      locationStatuses: replica.state.locations
        .filter((location) =>
          ["loc_bin", "loc_counter", "loc_warm"].includes(location.id)
        )
        .map((location) => [location.id, location.captureStatus])
        .sort(),
    };
  }).toEqual({
    itemLocations: [
      ["item_flour", "loc_bin"],
      ["item_pasta", "loc_warm"],
    ],
    locationStatuses: [
      ["loc_bin", "counted"],
      ["loc_counter", "counted"],
      ["loc_warm", "counted"],
    ],
  });
});

test("shows workspace backup state and removes only the device copy", async ({ page }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("1");
  await page.getByLabel("What is it?").fill("Waiting to sync");
  await page.getByRole("button", { name: "Save & add next" }).click();
  const pending = (
    await localReplica(page) as {
      outbox: { status: "blocked" | "pending" }[];
    }
  ).outbox.filter((entry) => entry.status === "pending").length;
  expect(pending).toBeGreaterThan(0);
  const statusLink = page.locator(
    ".sync:visible, .mobile-sync-status:visible, .sync-error-banner a:visible",
  ).first();
  await expect(statusLink).toBeVisible();
  await statusLink.click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page).toHaveTitle("Workspaces · Stowplan");
  await expect(page.getByRole("heading", {
    exact: true,
    name: "Your workspaces",
  })).toBeVisible();
  const card = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: "Kitchen reset",
    }),
  });
  await expect(card).toContainText("Local changes are waiting to upload");
  await expect(card.locator("dl div").filter({
    hasText: "Pending changes",
  }).locator("dd")).toHaveText(String(pending));
  await card.getByRole("button", {
    name: "Remove from this device",
  }).click();
  const removal = page.getByRole("dialog", {
    name: "Remove Kitchen reset from this device?",
  });
  await expect(removal).toContainText(
    "It does not delete the server copy or change membership",
  );
  await expect(removal).toContainText(`${pending} pending`);
  await expect(removal).toContainText("only known copy");
  await removal.getByRole("button", {
    name: "Remove device copy",
  }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText(
    "No workspaces match this search.",
    { exact: true },
  )).toBeVisible();
});

test("removes an inactive device copy without switching the active workspace", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers inactive workspace removal",
  );
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.getByLabel("Workspaces and backup status").click();
  await page.getByLabel("New device workspace").fill("Active workspace");
  await page.getByRole("button", {
    exact: true,
    name: "Create",
  }).click();
  await expect(page.getByRole("heading", {
    exact: true,
    name: "Capture",
  })).toBeVisible();
  await page.getByLabel("Workspaces and backup status").click();

  const inactiveCard = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: "Kitchen reset",
    }),
  });
  await inactiveCard.getByRole("button", {
    name: "Remove from this device",
  }).click();
  await page.getByRole("dialog", {
    name: "Remove Kitchen reset from this device?",
  }).getByRole("button", {
    name: "Remove device copy",
  }).click();

  await expect(inactiveCard).toHaveCount(0);
  await expect(page.getByRole("article").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: "Active workspace",
    }),
  }).getByRole("button", {
    name: "Continue",
  })).toBeVisible();
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: { workspace: { name: string } };
    };
    return replica.state.workspace.name;
  }).toBe("Active workspace");
});

test("presents unavailable backup as device storage without crushing workspace tools", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-compact",
    "The compact desktop project covers the constrained two-column action row",
  );
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({ configured: false, user: null }),
    contentType: "application/json",
    status: 200,
  }));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();

  await page.getByLabel("New device workspace").fill("Device home");
  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await expect(page.getByRole("heading", {
    exact: true,
    name: "Capture",
  })).toBeVisible();

  const statusLink = page.locator(".sync:visible");
  await expect(statusLink).toContainText("Device only");
  await expect(statusLink.locator("svg.lucide-hard-drive")).toBeVisible();
  await expect(statusLink.locator("svg.lucide-wifi-off")).toHaveCount(0);
  await statusLink.click();

  await expect(page.getByText(
    "This deployment is device-only. Local workspaces remain available.",
  )).toBeVisible();
  const card = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      exact: true,
      name: "Device home",
    }),
  });
  await expect(card).toContainText("Stored only on this device");
  await expect(card.locator("dl div").filter({
    hasText: "Last successful backup",
  })).toContainText("Not available");

  const tools = page.getByRole("region", { name: "Workspace tools" });
  const dimensions = await tools.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const control of [
    tools.getByLabel("Search workspaces"),
    tools.getByLabel("New device workspace"),
    tools.getByRole("button", { exact: true, name: "Create" }),
    tools.getByRole("button", { name: "Open kitchen demo" }),
  ]) {
    const bounds = await control.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
});

test("does not label the active workspace as backing up while another workspace syncs", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers concurrent background sync presentation",
  );
  let delayedWorkspaceId: string | null = null;
  let inactiveSyncObserved = false;
  let inactiveSyncReleased = false;
  let releaseInactiveSync!: () => void;
  const inactiveSyncGate = new Promise<void>((resolve) => {
    releaseInactiveSync = resolve;
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      user: { userId: MOCK_ACCOUNT_ID },
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/workspaces?*", (route) => route.fulfill({
    body: JSON.stringify({
      membershipRevision: 1,
      page: { hasMore: false, nextCursor: null },
      workspaces: [],
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/sync", async (route) => {
    const body = route.request().postDataJSON() as {
      commands: { id: string }[];
      snapshot: {
        workspace: {
          id: string;
          name: string;
          revision: number;
          updatedAt: string;
        };
      };
      workspaceId: string;
    };
    if (
      body.workspaceId === delayedWorkspaceId &&
      body.commands.length > 0
    ) {
      inactiveSyncObserved = true;
      await inactiveSyncGate;
    }
    await route.fulfill({
      body: JSON.stringify(mockOwnerSyncResponse(
        body.snapshot,
        body.commands,
      )),
      contentType: "application/json",
      headers: MOCK_ACCOUNT_HEADERS,
      status: 200,
    });
  });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();

  try {
    await page.getByRole("button", {
      name: "Open kitchen demo",
    }).click();
    await expect(page.locator(".sync")).toContainText("Backed up online");
    const firstReplica = await localReplica(page) as {
      state: { workspace: { id: string } };
    };
    delayedWorkspaceId = firstReplica.state.workspace.id;

    await reopenCurrentCapture(page);
    await page.getByLabel("What is it?").fill("Background backup");
    await page.getByRole("button", { name: "Save & add next" }).click();
    await page.getByLabel("Workspaces and backup status").click();
    await page.getByLabel("New device workspace").fill("Active workspace");
    await page.getByRole("button", { exact: true, name: "Create" }).click();

    await expect.poll(() => inactiveSyncObserved).toBe(true);
    await expect(page.locator(".sync")).toContainText("Backed up online");
    await expect(page.locator(".sync")).not.toContainText("Backing up");
    await page.getByLabel("Workspaces and backup status").click();
    const inactiveCard = page.getByRole("article").filter({
      has: page.getByRole("heading", {
        exact: true,
        name: "Kitchen reset",
      }),
    });
    await expect(inactiveCard).toContainText(
      "Local changes are waiting to upload",
    );
    inactiveSyncReleased = true;
    releaseInactiveSync();
    await expect(inactiveCard).toContainText(
      "Device and server are synchronized",
    );
  } finally {
    if (!inactiveSyncReleased) releaseInactiveSync();
  }
});

test("surfaces a background backup failure on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "The portrait phone project covers the mobile alert");
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({
      configured: true,
      user: { userId: MOCK_ACCOUNT_ID },
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/workspaces?*", (route) => route.fulfill({
    body: JSON.stringify({
      membershipRevision: 1,
      page: { hasMore: false, nextCursor: null },
      workspaces: [],
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/sync", (route) => route.fulfill({
    body: JSON.stringify({ error: "Backup service unavailable" }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 500,
  }));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await reopenCurrentCapture(page);
  await page.getByLabel("What is it?").fill("Locally safe");
  await page.getByRole("button", { name: "Save & add next" }).click();

  const alert = page.getByRole("alert", { name: "" })
    .filter({ hasText: "Backup needs attention" });
  await expect(alert).toContainText("Backup service unavailable");
  await expect(alert).toBeVisible();
  await alert.getByRole("link", { name: "Review backup" }).click();
  await expect(page).toHaveURL(/\/recovery$/);
  await expect(page.getByRole("heading", {
    name: "Sync & recovery",
  })).toBeVisible();
  await expect(page.getByText(
    "This export includes the current workspace plus pending or blocked commands and their errors. Export it before any reset.",
  )).toBeVisible();
});

test("keeps redacted post-ban accounts disabled in administration", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers redacted account controls",
  );
  await page.route("**/api/admin/overview*", (route) => route.fulfill({
    body: JSON.stringify({
      audit: [],
      guestLinks: [],
      identities: [],
      memberships: [],
      sessions: [],
      users: [{
        account_revision: 4,
        created_at: "2026-07-25T00:00:00.000Z",
        deleted_at: null,
        display_name: "Banned account",
        email: "ban_lifted@banned.invalid",
        global_role: "user",
        membership_revision: 0,
        retained_identity_ban_count: 1,
        status: "disabled",
        updated_at: "2026-07-25T01:00:00.000Z",
        user_id: "usr_ban_lifted",
      }],
      workspaces: [],
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));

  await page.goto("/admin");
  const user = page.getByRole("listitem", {
    name: "User ban_lifted@banned.invalid",
  });
  await expect(user).toContainText(
    "Identity redaction is permanent. This retained account cannot be enabled.",
  );
  await expect(user.getByRole("button", {
    name:
      "Redacted account ban_lifted@banned.invalid cannot be enabled",
  })).toBeDisabled();
  await expect(user.getByRole("button", {
    name: "Ban ban_lifted@banned.invalid",
  })).toBeEnabled();
});

test("surfaces transport failures from admin mutations", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers admin transport feedback",
  );
  await page.route("**/api/admin/overview", (route) => route.fulfill({
    body: JSON.stringify({
      audit: [],
      guestLinks: [],
      identities: [],
      memberships: [],
      sessions: [{
        email: "owner@example.test",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        revoked_at: null,
        session_id: "session_test",
      }],
      users: [],
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/admin/mutate", (route) =>
    route.abort("connectionfailed")
  );

  await page.goto("/admin");
  let confirmation = "";
  page.once("dialog", async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("button", {
    exact: true,
    name: "Revoke session session_test for owner@example.test",
  }).click();
  await expect.poll(() => confirmation).toContain(
    "session_test for owner@example.test",
  );

  await expect(page.locator(".admin-error strong")).toContainText(
    "Failed to fetch",
  );
});

test("sends concurrency revisions with global membership changes", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers administrative membership preconditions",
  );
  const mutations: Record<string, unknown>[] = [];
  await page.route("**/api/admin/overview*", (route) => route.fulfill({
    body: JSON.stringify({
      audit: [],
      guestLinks: [],
      identities: [],
      memberships: [{
        created_at: "2026-07-25T00:00:00.000Z",
        display_name: "Workspace member",
        email: "member@example.test",
        membership_revision: 12,
        role: "viewer",
        user_id: "usr_member",
        user_status: "active",
        workspace_access_revision: 7,
        workspace_id: "ws_membership",
        workspace_name: "Membership workspace",
        workspace_revision: 5,
      }],
      sessions: [],
      users: [],
      workspaces: [],
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/admin/mutate", async (route) => {
    mutations.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    await route.fulfill({
      body: JSON.stringify({
        message: "Workspace membership changed",
      }),
      contentType: "application/json",
      headers: MOCK_ACCOUNT_HEADERS,
      status: 200,
    });
  });

  await page.goto("/admin");
  const membership = page.getByRole("listitem", {
    name: "Workspace membership for member@example.test in Membership workspace",
  });
  await membership.getByRole("combobox", {
    name: "Workspace role for member@example.test in Membership workspace",
  }).selectOption("editor");
  await expect.poll(() => mutations[0]).toEqual({
    action: "member.role",
    expectedAccessRevision: 7,
    expectedMembershipRevision: 12,
    targetId: "ws_membership::usr_member",
    value: "editor",
  });

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await membership.getByRole("button", {
    exact: true,
    name: "Remove member@example.test from Membership workspace",
  }).click();
  await expect.poll(() => mutations[1]).toEqual({
    action: "member.remove",
    expectedAccessRevision: 7,
    expectedMembershipRevision: 12,
    targetId: "ws_membership::usr_member",
  });
});

test("shows and searches the member who accepted a retained guest link", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers retained guest-link attribution",
  );
  const requestedQueries: string[] = [];
  await page.route("**/api/admin/overview*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query) requestedQueries.push(query);
    return route.fulfill({
      body: JSON.stringify({
        audit: [],
        guestLinks: [{
          accepted_at: "2026-07-25T01:00:00.000Z",
          consumed_at: "2026-07-25T01:00:00.000Z",
          created_at: "2026-07-25T00:00:00.000Z",
          created_by_display_name: "Owner",
          created_by_email: "owner@example.test",
          created_by_user_id: "usr_owner",
          expires_at: "2026-07-26T00:00:00.000Z",
          guest_link_id: "guest_attributed",
          redeemed_by_display_name: "Accepted member",
          redeemed_by_email: "accepted@example.test",
          redeemed_by_user_id: "usr_accepted",
          redemption_id: "redemption_attributed",
          revoked_at: null,
          role: "viewer",
          workspace_id: "ws_attributed",
          workspace_name: "Attributed workspace",
        }],
        identities: [],
        memberships: [{
          created_at: "2026-07-25T01:00:00.000Z",
          display_name: "Accepted member",
          email: "accepted@example.test",
          membership_revision: 3,
          role: "viewer",
          user_id: "usr_accepted",
          user_status: "active",
          workspace_access_revision: 5,
          workspace_id: "ws_attributed",
          workspace_name: "Attributed workspace",
          workspace_revision: 2,
        }],
        sessions: [],
        users: [{
          created_at: "2026-07-25T00:30:00.000Z",
          display_name: "Accepted member",
          email: "accepted@example.test",
          global_role: "user",
          membership_revision: 3,
          status: "active",
          updated_at: "2026-07-25T01:00:00.000Z",
          user_id: "usr_accepted",
        }],
        workspaces: [],
      }),
      contentType: "application/json",
      headers: MOCK_ACCOUNT_HEADERS,
      status: 200,
    });
  });

  await page.goto("/admin");
  const acceptedLink = page.getByRole("listitem", {
    name: "Enrollment link guest_attributed for Attributed workspace",
  });
  await expect(acceptedLink).toContainText(
    "Accepted by Accepted member",
  );
  await expect(acceptedLink).toContainText("accepted@example.test");
  await expect(acceptedLink).toContainText("user usr_accepted");
  await expect(acceptedLink).not.toContainText("token");

  const search = page.getByLabel("Search server records");
  await search.fill("guest_attributed");
  await page.keyboard.press("Enter");
  await expect.poll(() => requestedQueries).toContain(
    "guest_attributed",
  );

  await acceptedLink.getByRole("link", {
    exact: true,
    name: "Find user Accepted member",
  }).click();
  await expect.poll(() => requestedQueries).toContain("usr_accepted");
  await expect(page).toHaveURL(/#admin-users$/u);
  await expect(page.locator("#admin-users")).toBeFocused();

  await page.getByRole("listitem", {
    name: "Enrollment link guest_attributed for Attributed workspace",
  }).getByRole("link", {
    exact: true,
    name: "Find membership for Accepted member",
  }).click();
  await expect(page).toHaveURL(/#admin-memberships$/u);
  await expect(page.locator("#admin-memberships")).toBeFocused();
});

test("lets a global administrator delete a retained guest-link record", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers the destructive admin confirmation",
  );
  let mutation: Record<string, unknown> | null = null;
  const overview = {
    audit: [],
    deletions: [],
    guestLinks: [{
      consumed_at: "2026-07-25T01:00:00.000Z",
      created_at: "2026-07-25T00:00:00.000Z",
      created_by_display_name: "Owner",
      created_by_email: "owner@example.test",
      created_by_user_id: "usr_owner",
      expires_at: "2026-07-26T00:00:00.000Z",
      guest_link_id: "guest_retained",
      redemption_id: "redemption_retained",
      revoked_at: null,
      role: "viewer",
      workspace_id: "ws_guest",
      workspace_name: "Guest workspace",
    }],
    identities: [],
    memberships: [],
    migrations: [],
    oauthStates: [],
    sessions: [],
    users: [],
    workspaces: [],
  };
  await page.route("**/api/admin/overview*", (route) => route.fulfill({
    body: JSON.stringify(overview),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));
  await page.route("**/api/admin/mutate", async (route) => {
    mutation = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ message: "Guest link deleted", ok: true }),
      contentType: "application/json",
      headers: MOCK_ACCOUNT_HEADERS,
      status: 200,
    });
  });

  await page.goto("/admin");
  await page.getByRole("button", {
    exact: true,
    name: "Delete record for enrollment link guest_retained in Guest workspace",
  }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Delete this guest-link record?",
  });
  await expect(dialog).toContainText(
    "does not remove the resulting workspace member",
  );
  await expect(dialog.getByRole("button", {
    exact: true,
    name: "Cancel",
  })).toBeFocused();
  await expect(dialog.getByRole("button", {
    exact: true,
    name: "Delete retained record",
  })).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => mutation).toEqual({
    action: "guest.delete",
    targetId: "guest_retained",
  });
  await expect(page.getByText("Guest link deleted")).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("keeps server administration searchable and responsive", async ({
  page,
}) => {
  await page.route("**/api/admin/overview*", (route) => route.fulfill({
    body: JSON.stringify({
      audit: [{
        action: "user.role",
        actor_email: "owner@example.test",
        created_at: new Date().toISOString(),
        detail_json: JSON.stringify({ role: "admin" }),
        event_id: "audit_capacity",
        target_id: "usr_capacity",
        target_type: "user",
      }],
      databaseInventory: {
        entries: [{
          key: "workspace-snapshots",
          label: "Workspace snapshots",
          metrics: [
            { kind: "bytes", label: "stored size", value: 42_000 },
            {
              kind: "date",
              label: "latest update",
              value: new Date().toISOString(),
            },
          ],
          rowCount: 2,
          table: "workspace_snapshots",
        }, {
          key: "sessions",
          label: "Sessions",
          metrics: [
            { kind: "count", label: "active", value: 2 },
            { kind: "count", label: "revoked", value: 1 },
          ],
          rowCount: 3,
          table: "sessions",
        }, {
          key: "migration-ledger:d1_migrations",
          label: "Migration ledger",
          metrics: [],
          rowCount: 5,
          table: "d1_migrations",
        }, ...[
          ["workspace-deletions", "Deletion tombstones", "workspace_deletions"],
          ["users", "Users", "users"],
          ["identities", "Linked identities", "identities"],
          ["workspace-members", "Workspace memberships", "workspace_members"],
          ["guest-links", "One-time invite links", "guest_links"],
          ["oauth-states", "OAuth state rows", "oauth_states"],
          ["auth-audit-events", "Authentication audit rows", "auth_audit_events"],
          ["migration-stream", "Migration stream marker", "stowplan_migration_stream"],
        ].map(([key, label, table]) => ({
          key,
          label,
          metrics: [],
          rowCount: 1,
          table,
        }))],
        generatedAt: new Date().toISOString(),
      },
      deletions: [{
        deleted_at: "2026-07-25T01:00:00.000Z",
        deleted_by_display_name: "Owner",
        deleted_by_email: "owner@example.test",
        deleted_by_user_id: "usr_owner",
        deletion_id: "deletion_test",
        final_access_revision: 9,
        final_snapshot_revision: 8,
        workspace_id: "ws_deleted",
      }],
      guestLinks: [],
      identities: [],
      listInfo: {
        audit: { hasMore: false, limit: 250 },
        deletions: { hasMore: false, limit: 250 },
        guestLinks: { hasMore: false, limit: 250 },
        identities: { hasMore: false, limit: 500 },
        memberships: { hasMore: false, limit: 500 },
        migrations: { hasMore: false, limit: 250 },
        oauthStates: { hasMore: false, limit: 250 },
        sessions: { hasMore: false, limit: 250 },
        users: { hasMore: false, limit: 250 },
        workspaces: { hasMore: false, limit: 250 },
      },
      memberships: [],
      migrations: [{
        applied_at: "2026-07-25T00:00:00.000Z",
        ledger_table: "d1_migrations",
        migration_id: "5",
        name: null,
      }],
      oauthStates: [{
        consumed_at: null,
        created_at: "2026-07-25T00:00:00.000Z",
        expires_at: "2026-07-25T00:10:00.000Z",
        provider: "github",
        status: "expired",
      }],
      sessions: [{
        created_at: "2026-07-25T00:00:00.000Z",
        display_name: "Owner",
        email: "owner@example.test",
        expires_at: "2099-07-25T00:00:00.000Z",
        global_role: "admin",
        ip_prefix: "192.0.2.0/24",
        last_seen_at: "2026-07-25T00:05:00.000Z",
        revoked_at: null,
        session_id: "ses_capacity",
        status: "active",
        user_agent: "Capacity browser",
        user_id: "usr_capacity",
        viewer_is_current: 1,
      }],
      users: [],
      workspaces: [{
        active_guest_link_count: 2,
        activity_count: 5,
        activity_patch_count: 12,
        audit_event_count: 3,
        command_receipt_count: 2,
        item_count: 3_200,
        location_count: 12,
        member_count: 3,
        owner_count: 1,
        plan_count: 1,
        plan_step_count: 4,
        retained_guest_link_count: 5,
        revision: 8,
        snapshot_bytes: 42_000,
        updated_at: new Date().toISOString(),
        viewer_is_member: 1,
        workspace_id: "ws_capacity",
        workspace_name: "Capacity workspace",
      }],
    }),
    contentType: "application/json",
    headers: MOCK_ACCOUNT_HEADERS,
    status: 200,
  }));

  await page.goto("/admin");
  await expect(page.getByRole("heading", {
    name: "Stowplan administration",
  })).toBeVisible();
  await expect(page.getByRole("link", {
    name: "Open member settings",
  })).toHaveAttribute(
    "href",
    "/workspaces/capacity-workspace@ws_capacity/settings",
  );
  const databaseInventory = page.getByRole("region", {
    name: "Database inventory",
  });
  await expect(databaseInventory).toContainText("workspace_snapshots");
  await expect(databaseInventory).toContainText("stored size: 42.0 kB");
  await expect(databaseInventory).toContainText("sessions");
  await expect(databaseInventory).toContainText("active: 2");
  await expect(databaseInventory).toContainText("d1_migrations");
  await expect(databaseInventory).toContainText("5 rows");
  for (const [label, section] of [
    ["Workspace snapshots", "admin-workspaces"],
    ["Deletion tombstones", "admin-deletions"],
    ["Users", "admin-users"],
    ["Linked identities", "admin-identities"],
    ["Workspace memberships", "admin-memberships"],
    ["Sessions", "admin-sessions"],
    ["One-time invite links", "admin-guest-links"],
    ["OAuth state rows", "admin-oauth-states"],
    ["Authentication audit rows", "admin-audit"],
    ["Migration stream marker", "admin-migrations"],
    ["Migration ledger", "admin-migrations"],
  ]) {
    await expect(databaseInventory.getByRole("link").filter({
      hasText: label,
    })).toHaveAttribute("href", `#${section}`);
  }
  await expect(page.locator("#admin-sessions")).toContainText(
    "Capacity browser",
  );
  await expect(page.locator("#admin-sessions")).toContainText(
    "192.0.2.0/24",
  );
  const sessionRecords = page.getByRole("list", {
    name: "Session records",
  });
  const currentSession = sessionRecords.getByRole("listitem", {
    name: "Session ses_capacity for owner@example.test",
  });
  await expect(currentSession).toContainText("Current browser session");
  await expect(currentSession.getByRole("button", {
    exact: true,
    name: "Revoke current session ses_capacity for owner@example.test and sign out",
  })).toHaveClass(/danger/u);
  await expect(page.locator("#admin-deletions")).toContainText(
    "deletion_test",
  );
  await expect(page.locator("#admin-oauth-states")).toContainText(
    "github",
  );
  await expect(page.locator("#admin-migrations")).toContainText(
    "d1_migrations",
  );
  const workspaceCapacity = page.locator(".admin-workspaces", {
    hasText: "Capacity workspace",
  });
  await expect(workspaceCapacity).toContainText("12/1000 spaces");
  await expect(workspaceCapacity).toContainText("3200/4000 items");
  await expect(workspaceCapacity).toContainText("4/5000 plan steps");
  await expect(workspaceCapacity).toContainText("5/10000 activities");
  await expect(workspaceCapacity).toContainText("12/50000 patches");
  await expect(workspaceCapacity).toContainText("3/10000 audit events");
  await expect(workspaceCapacity).toContainText("2/20000 compact receipts");
  await expect(workspaceCapacity.locator(
    'small[data-near-limit="true"]',
  )).toContainText("3200/4000 items");
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", {
    name: "Back to organizer",
  })).toBeFocused();
  await page.keyboard.press("Tab");
  const search = page.getByLabel("Search server records");
  await expect(search).toBeFocused();
  await expect.poll(() => search.locator("..").evaluate(element => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle}:${style.outlineWidth}`;
  })).toBe("solid:3px");
  await search.fill("capacity");
  await page.keyboard.press("Enter");
  await expect(page.locator(".admin-filter-note"))
    .toContainText("capacity");
  await expect(databaseInventory).toContainText(
    "Inventory row counts describe the full database",
  );
  const clearSearch = page.locator(".admin-filter-note").getByRole(
    "button",
    { name: "Clear" },
  );
  await expect.poll(() => clearSearch.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).minHeight)
  )).toBeGreaterThanOrEqual(44);
  await page.getByText("Details", { exact: true }).click();
  await expect(page.locator(".admin-audit pre")).toContainText(
    '"role": "admin"',
  );
  await databaseInventory.getByRole("link").filter({
    hasText: "Sessions",
  }).click();
  await expect(page.locator("#admin-sessions")).toBeFocused();
  let currentSessionConfirmation = "";
  page.once("dialog", async (dialog) => {
    currentSessionConfirmation = dialog.message();
    await dialog.dismiss();
  });
  await currentSession.getByRole("button", {
    exact: true,
    name: "Revoke current session ses_capacity for owner@example.test and sign out",
  }).click();
  await expect.poll(() => currentSessionConfirmation).toContain(
    "This signs you out immediately",
  );
});

test("keeps the newest admin search response", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers request ordering",
  );
  let initialStarted = false;
  let initialFinished = false;
  let releaseInitial = () => {};
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const body = (workspaceName: string, workspaceId: string) => JSON.stringify({
    audit: [],
    guestLinks: [],
    identities: [],
    memberships: [],
    sessions: [],
    users: [],
    workspaces: [{
      updated_at: new Date().toISOString(),
      viewer_is_member: 0,
      workspace_id: workspaceId,
      workspace_name: workspaceName,
    }],
  });
  await page.route("**/api/admin/overview*", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("q");
    if (!search) {
      initialStarted = true;
      await initialGate;
      await route.fulfill({
        body: body("Older unfiltered workspace", "ws_older"),
        contentType: "application/json",
        headers: {
          "x-stowplan-account-id": "usr_admin",
        },
        status: 200,
      });
      initialFinished = true;
      return;
    }
    await route.fulfill({
      body: body("Newest filtered workspace", "ws_newest"),
      contentType: "application/json",
      headers: {
        "x-stowplan-account-id": "usr_admin",
      },
      status: 200,
    });
  });

  try {
    await page.goto("/admin");
    await expect.poll(() => initialStarted).toBe(true);
    const search = page.getByLabel("Search server records");
    await search.fill("newest");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Newest filtered workspace")).toBeVisible();

    releaseInitial();
    await expect.poll(() => initialFinished).toBe(true);
    await expect(page.getByText("Newest filtered workspace")).toBeVisible();
    await expect(page.getByText("Older unfiltered workspace")).toHaveCount(0);
  } finally {
    releaseInitial();
  }
});

test("reports blocked safety and workspace downloads", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers download failure feedback",
  );
  await page.getByRole("button", {
    name: "Open kitchen demo",
  }).click();
  await expect(page.getByRole("heading", {
    name: "Capture",
    exact: true,
  })).toBeVisible();
  await page.goto("/recovery");
  await page.evaluate(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => {
        throw new Error("Downloads unavailable");
      },
    });
  });
  await page.getByRole("button", {
    name: "Export full recovery bundle",
  }).click();
  await expect(page.locator("output")).toContainText(
    "Could not start the download: Downloads unavailable",
  );
  await expect(page.getByText(
    "I saved this recovery file somewhere I can reopen it.",
  )).toHaveCount(0);

  await page.goBack();
  await page.evaluate(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => {
        throw new Error("Downloads unavailable");
      },
    });
  });
  await page.locator(".nav:visible", { hasText: "Settings" }).click();
  await page.getByRole("button", { name: "Export JSON backup" }).click();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Could not export this workspace: Downloads unavailable",
  );
});

test("has no serious accessibility violations and reloads offline", async ({ page, context }) => {
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
});
