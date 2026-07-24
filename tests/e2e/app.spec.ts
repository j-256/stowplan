import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { projectContextOptions } from "./project-context";

async function localReplica(page: Page) {
  return page.evaluate(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    const open = indexedDB.open("stowplan-v1", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction("records").objectStore("records").get("active");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
    };
  }));
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
  await page.getByLabel("Workspace name").fill("Jamie's apartment");
  await page.getByRole("button", { name: "Start my workspace" }).click();

  await expect(page.getByText("Jamie's apartment", { exact: true })).toBeVisible();
  const replica = await localReplica(page) as { state: { workspace: { name: string } } };
  expect(replica.state.workspace.name).toBe("Jamie's apartment");
});

test("starts workspaces and primary views at the top", async ({ page }) => {
  const demo = page.getByRole("button", {
    name: "Explore the kitchen demo instead",
  });
  await demo.scrollIntoViewIfNeeded();
  await demo.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("gives tabs, spaces, filters, and item editors restorable URLs", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  const replica = await localReplica(page) as {
    state: { workspace: { id: string } };
  };
  const workspacePrefix = `/workspaces/${encodeURIComponent(replica.state.workspace.id)}`;

  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/capture/locations/loc_kitchen$`),
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
    new RegExp(`${workspacePrefix}/capture/locations/loc_kitchen$`),
  );
  await page.locator(
    '.capture-location-row[data-location-id="loc_bin"] .queue-row',
  ).click();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/capture/locations/loc_bin$`),
  );

  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/inventory/locations/loc_bin$`),
  );
  await page.locator('[data-item-id="item_flour"] .item-name').click();
  await expect(page).toHaveURL(
    new RegExp(`${workspacePrefix}/inventory/items/item_flour$`),
  );
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Review item" })).toBeVisible();
  await page.getByRole("button", { name: "Close item editor" }).click();
  await expect(page).toHaveURL(new RegExp(`${workspacePrefix}/inventory$`));
});

test("opens a shared workspace URL on a clean collaborator device", async ({ page, browser }, testInfo) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  await page.locator('[data-location-id="loc_bin"] .tree-select').click();
  const sharedUrl = page.url();
  const replica = await localReplica(page) as {
    state: {
      workspace: { id: string };
    };
  };

  const collaboratorContext = await browser.newContext(
    projectContextOptions(page, testInfo),
  );
  try {
    const collaborator = await collaboratorContext.newPage();
    await collaborator.route(
      `**/api/snapshot?workspaceId=${encodeURIComponent(replica.state.workspace.id)}`,
      (route) => route.fulfill({
        body: JSON.stringify({ state: replica.state }),
        contentType: "application/json",
        status: 200,
      }),
    );
    await collaborator.goto(sharedUrl);
    await expect(collaborator.getByRole("heading", { name: "Spaces" })).toBeVisible();
    await expect(collaborator.getByRole("region", { name: "Edit Baking bin" }))
      .toBeVisible();
    await expect(collaborator).toHaveURL(sharedUrl);
    const collaboratorReplica = await localReplica(collaborator) as {
      state: { workspace: { id: string } };
    };
    expect(collaboratorReplica.state.workspace.id).toBe(
      replica.state.workspace.id,
    );
  } finally {
    await collaboratorContext.close();
  }
});

test("announces share success and failure in the visible feedback toast", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await expect(page.locator(".feedback-toast[role='status']")).toContainText(
    "Sharing was canceled",
  );
});

test("collapses the desktop sidebar and persists the icon-only preference", async ({ page }, testInfo) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) <= 799 ||
      testInfo.project.name === "mobile-landscape",
    "Phone, narrow-tablet, and short touch layouts use compact navigation",
  );
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

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
  await expect(page.getByRole("group", { name: "Space panels layout" })
    .getByRole("button", { name: "Side by side" })).toBeDisabled();
});

test("uses a compact icon rail at both narrow-tablet boundaries and orientations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "tablet-portrait", "The portrait tablet project covers the 761 to 799 pixel band");
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

  const capture = page.locator(".capture.resizable-panels");
  const captureLayout = page.getByRole("group", { name: "Capture panels layout" });
  const sideBySide = captureLayout.getByRole("button", { name: "Side by side" });
  const stacked = captureLayout.getByRole("button", { name: "Stacked" });
  await expect(capture).toBeVisible();

  if (await sideBySide.isDisabled()) {
    await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
    await expect(page.getByRole("separator", { name: "Resize capture queue" }))
      .toBeHidden();
  } else {
    await stacked.click();
    await expect(capture).toHaveAttribute("data-panel-layout", "stacked");
    await sideBySide.click();
    await expect(capture).toHaveAttribute("data-panel-layout", "side-by-side");
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
  if (await spacesSideBySide.isDisabled()) {
    await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");
  } else {
    await spacesLayout.getByRole("button", { name: "Stacked" }).click();
    await expect(spaces).toHaveAttribute("data-panel-layout", "stacked");
    await spacesSideBySide.click();
    await expect(spaces).toHaveAttribute("data-panel-layout", "side-by-side");
  }

  expect(await page.evaluate(() => ({
    body: document.body.scrollWidth <= document.body.clientWidth + 1,
    document: document.documentElement.scrollWidth <=
      document.documentElement.clientWidth + 1,
  }))).toEqual({ body: true, document: true });
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

  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
    name: "Explore the kitchen demo instead",
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
  const home = page.getByRole("link", { name: "Open main menu" });
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
});

test("searches and jumps with Control or Command K", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();

  const primaryShortcut = testInfo.project.name.startsWith("mobile")
    ? "Control+KeyK"
    : "Meta+KeyK";
  await page.keyboard.press(primaryShortcut);
  const palette = page.getByRole("dialog", { name: "Search and jump" });
  await expect(palette).toBeVisible();
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
  await expect(page).toHaveURL(/\/inventory\/items\/item_sugar$/);
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

  await page.keyboard.press("Meta+KeyK");
  await search.fill("Baking bin");
  await page.locator('[role="option"][data-kind="space"]', { hasText: "Baking bin" }).click();
  await expect(page.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/spaces\/locations\/loc_bin$/);

  await page.keyboard.press("Control+KeyK");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("reopens counted capture and empties a container as one undoable change", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await expect(page.getByRole("status")).toContainText("open for capture again");
  await expect(page.getByRole("button", { name: "Counted & next" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Known empty & next" }).click();
  await expect(page.getByRole("status")).toContainText(
    "was emptied and marked known empty",
  );
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
        .map((item) => item.id),
      status: replica.state.locations
        .find((location) => location.id === "loc_bin")?.captureStatus,
    };
  }).toEqual({ itemIds: [], status: "known_empty" });

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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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

test("visibly refuses known-empty capture while nested spaces remain", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await page.locator(
    '.capture-location-row[data-location-id="loc_unknown"] .queue-row',
  ).click();
  await page.getByRole("button", { name: "Known empty & next" }).click();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "still contains 1 nested space",
  );
  const replica = await localReplica(page) as {
    state: { locations: { captureStatus: string; id: string }[] };
  };
  expect(replica.state.locations
    .find((location) => location.id === "loc_unknown")?.captureStatus)
    .toBe("in_progress");
});

test("onboards, captures, edits, searches, plans, rolls back, and persists locally", async ({ page }) => {
  const consoleErrors: string[] = [];
  const syncRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sync") syncRequests.push(request.url());
  });

  await expect(page.getByRole("heading", { name: /Label it/ })).toBeVisible();
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
  await expect(page.locator(".queue-row", { hasText: "B-17" })).toHaveAttribute("data-depth", "3");
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("2");
  await page.getByLabel("What is it?").fill("Test tea towels");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();

  await page.getByLabel("Open main menu").click();
  await expect(page.getByRole("heading", { name: "Where to next?" })).toBeVisible();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  const before = await localReplica(page) as { state: { workspace: { id: string } } };
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("1");
  await page.getByLabel("What is it?").fill("Temporary demo item");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await page.getByLabel("Open main menu").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset kitchen demo" }).click();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
  await expect(page.getByText("Temporary demo item", { exact: true })).toHaveCount(0);
  const after = await localReplica(page) as { state: { workspace: { id: string } } };
  expect(after.state.workspace.id).not.toBe(before.state.workspace.id);
});

test("reorders sibling spaces in Capture and advances in visible hierarchy order", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

  await expect(page.locator('.capture-location-row[data-location-id="loc_right"] .drag-handle[title="Drag Right side to reorder within Kitchen"]')).toBeVisible();
  await reopenCurrentCapture(page);
  await page.getByLabel("What is it?").fill("Draft for the wrong space");
  await page.locator('.capture-location-row[data-location-id="loc_right"] .queue-row').click();
  await expect(page.getByLabel("What is it?")).toHaveCount(0);
  await reopenCurrentCapture(page);
  await page.getByLabel("Short ID").fill("NEW");
  await page.getByLabel("Friendly name").fill("Priority bin");
  await page.getByRole("button", { name: "Add inside Right side" }).click();

  const priority = page.locator(".capture-location-row", { hasText: "Priority bin" });
  await expect(priority.locator('.drag-handle[title="Drag Priority bin to reorder within Right side"]')).toBeVisible();
  const movePriorityUp = page.getByRole("button", { name: "Move Priority bin up" });
  await movePriorityUp.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { code: string; order: number }[] } };
    const created = replica.state.locations.find((location) => location.code === "NEW")?.order ?? Number.POSITIVE_INFINITY;
    const existing = replica.state.locations.find((location) => location.code === "C-04")?.order ?? Number.NEGATIVE_INFINITY;
    return created < existing;
  }).toBe(true);

  await page.getByRole("button", { name: "Counted & next" }).click();
  await expect(page.getByRole("heading", { name: "NEW · Priority bin" })).toBeVisible();

  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
  const overflow = await page.locator(".tree-panel").evaluate((panel) => ({
    labels: [...panel.querySelectorAll<HTMLElement>(".tree-name")].filter((label) => label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight).map((label) => label.innerText),
    panel: panel.scrollWidth > panel.clientWidth,
  }));
  expect(overflow).toEqual({ labels: [], panel: false });
});

test("previews desktop reorder destinations before committing them", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Native mouse feedback is a desktop contract");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await reopenCurrentCapture(page);

  const left = page.locator('.capture-location-row[data-location-id="loc_left"]');
  const right = page.locator('.capture-location-row[data-location-id="loc_right"]');
  const differentParent = page.locator('.capture-location-row[data-location-id="loc_warm"]');
  const idleDropStyles = await right.evaluate((row) => ({
    background: getComputedStyle(row).backgroundColor,
    boxShadow: getComputedStyle(row).boxShadow,
  }));
  await holdNativeDrag(page, left.locator(".drag-handle"), right, 0.8);
  await expect(left).toHaveAttribute("data-dragging", "true");
  await expect(right).toHaveAttribute("data-drop-valid", "true");
  await expect(right).toHaveAttribute("data-drop-intent", "after");
  await expect(differentParent).toHaveAttribute("data-drop-valid", "false");
  await expect(right.locator(".reorder-drop-copy")).toHaveText("Place after");
  const dropStyles = await right.evaluate((row) => ({
    background: getComputedStyle(row).backgroundColor,
    boxShadow: getComputedStyle(row).boxShadow,
  }));
  expect(dropStyles.background).not.toBe(idleDropStyles.background);
  expect(dropStyles.boxShadow).not.toBe(idleDropStyles.boxShadow);
  expect(dropStyles.boxShadow).toContain("inset");
  await page.mouse.up();
  await expect.poll(async () => {
    const replica = await localReplica(page) as {
      state: { locations: { id: string; order: number }[] };
    };
    const locations = replica.state.locations;
    return (locations.find((location) => location.id === "loc_left")?.order ?? 0) >
      (locations.find((location) => location.id === "loc_right")?.order ?? 0);
  }).toBe(true);

  await expect(left).not.toHaveAttribute("data-dragging", "true");
  await dispatchNativeDrop(page, left.locator(".drag-handle"), right, 0.8);
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Left side is already in that position",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await holdNativeDrag(page, left.locator(".drag-handle"), differentParent);
  await page.mouse.up();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Capture only reorders sibling spaces",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

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
  await holdNativeDrag(
    page,
    spacesBin.locator(".drag-handle"),
    page.locator(".app-shell > main > header"),
  );
  await page.mouse.up();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Choose a valid destination for Baking bin",
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

  await holdNativeDrag(
    page,
    inventoryFlour.locator(".drag-handle"),
    page.locator(".app-shell > main > header"),
  );
  await page.mouse.up();
  await expect(page.locator(".feedback-toast[role='alert']")).toContainText(
    "Choose a different destination for All-purpose flour",
  );
});

test("keeps touch reordering available on draggable handles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Touch input is a mobile contract");
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await reopenCaptureLocation(page, "loc_left");

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
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
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
    "Capture only reorders sibling spaces",
  );
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await page.locator(".nav:visible", { hasText: "Spaces" }).click();
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

test("guides incomplete evidence into a reviewable plan", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  expect(afterAdvance.state.locations.find((location) => location.id === "loc_unknown")?.captureStatus)
    .toBe(beforeAdvance.state.locations.find((location) => location.id === "loc_unknown")?.captureStatus);
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
      queueWidth: Math.round(queueBounds.width),
      sideBySide: Math.abs(cardBounds.top - queueBounds.top) < 2 && cardBounds.left > queueBounds.right,
      usesFinePointer: matchMedia("(hover: hover) and (pointer: fine)").matches,
      visibleActions: visibleActions.length,
    };
  });

  expect(metrics.clippedCodes).toEqual([]);
  expect(metrics.clippedNames).toEqual([]);
  expect(metrics.documentOverflow).toBe(false);
  expect(metrics.sideBySide).toBe(true);
  expect(metrics.queueWidth).toBeGreaterThanOrEqual(260);
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { items: { id: string; locationId: string; name: string; quantity: number }[] } };
    return replica.state.items.filter((item) => item.name === "Pasta").map((item) => [item.locationId, item.quantity]).sort();
  }).toEqual([["loc_food", 2], ["loc_warm", 4]]);
  await expect(page.getByRole("checkbox", { name: "Select Pasta, 2 boxes in Kitchen › Left side › Food cabinet" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Pasta, 4 boxes in Kitchen › Left side › Cabinet above oven" })).toBeVisible();
});

test("shows workspace backup state and removes only the device copy", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await reopenCurrentCapture(page);
  await page.getByLabel("Qty").fill("1");
  await page.getByLabel("What is it?").fill("Waiting to sync");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await page.getByLabel("Open main menu").click();
  const card = page.locator(".workspace-card", { hasText: "Kitchen reset" });
  await expect(card.getByText(/pending upload/)).toBeVisible();
  await card.getByText(/Queued changes/).click();
  await expect(card.getByText(/Recorded 1 each Waiting to sync/)).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("This does not delete any server copy");
    dialog.accept();
  });
  await card.getByRole("button", { name: /Remove Kitchen reset from this device/ }).click();
  await expect(page.getByRole("heading", { name: /Label it/ })).toBeVisible();
});

test("surfaces a background backup failure on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "The portrait phone project covers the mobile alert");
  await page.route("**/api/auth/me", (route) => route.fulfill({
    body: JSON.stringify({ configured: true, user: { id: "user_test" } }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route("**/api/sync", (route) => route.fulfill({
    body: JSON.stringify({ error: "Backup service unavailable" }),
    contentType: "application/json",
    status: 500,
  }));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await reopenCurrentCapture(page);
  await page.getByLabel("What is it?").fill("Locally safe");
  await page.getByRole("button", { name: "Save & add next" }).click();

  const alert = page.getByRole("alert", { name: "" })
    .filter({ hasText: "Backup needs attention" });
  await expect(alert).toContainText("Sync failed (500)");
  await expect(alert).toBeVisible();
  await alert.getByRole("link", { name: "Review backup" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.locator(".workspace-card", { hasText: "Kitchen reset" }))
    .toBeVisible();
});

test("has no serious accessibility violations and reloads offline", async ({ page, context }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
