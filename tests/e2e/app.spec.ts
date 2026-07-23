import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("stowplan-v1");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }));
  await page.reload();
});

test("names a new workspace during first run", async ({ page }) => {
  await page.getByLabel("Workspace name").fill("Jamie’s apartment");
  await page.getByRole("button", { name: "Start my workspace" }).click();

  await expect(page.getByText("Jamie’s apartment", { exact: true })).toBeVisible();
  const replica = await localReplica(page) as { state: { workspace: { name: string } } };
  expect(replica.state.workspace.name).toBe("Jamie’s apartment");
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
  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
  await expect(page.getByRole("heading", { name: "All item records" })).toBeVisible();
  await expect(page.getByText("Showing the containerless inventory.")).toBeVisible();
  await expect(page.locator('.inventory-row .drag-handle[title="Drag Test tea towels to reorder"]')).toHaveCount(0);
  await page.getByPlaceholder("Search names, categories, tags, constraints, and notes").fill("washable");
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();
  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
  await page.getByText("Plan priorities", { exact: true }).click();
  await page.getByRole("button", { name: "How accessibility affects a plan" }).focus();
  await expect(page.getByRole("tooltip", { name: /Score bonus = max/ })).toBeVisible();
  await page.getByRole("button", { name: "Generate move plan" }).click();
  await page.locator("button.nav:visible", { hasText: "Activity" }).click();
  await expect(page.getByText(/recorded changes/)).toBeVisible();
  await page.getByLabel("Change theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(consoleErrors).toEqual([]);
  expect(syncRequests).toEqual([]);
});

test("prevents repeated form submission from creating duplicate records", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
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
  await page.getByLabel("What is it?").fill("Draft for the wrong space");
  await page.locator('.capture-location-row[data-location-id="loc_right"] .queue-row').click();
  await expect(page.getByLabel("What is it?")).toHaveValue("");
  await page.getByLabel("Short ID").fill("NEW");
  await page.getByLabel("Friendly name").fill("Priority bin");
  await page.getByRole("button", { name: "Add inside Right side" }).click();

  const priority = page.locator(".capture-location-row", { hasText: "Priority bin" });
  const corner = page.locator('.capture-location-row[data-location-id="loc_unknown"]');
  await expect(priority.locator('.drag-handle[title="Drag Priority bin to reorder within Right side"]')).toBeVisible();
  await priority.dragTo(corner);
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { code: string; order: number }[] } };
    const created = replica.state.locations.find((location) => location.code === "NEW")?.order ?? Number.POSITIVE_INFINITY;
    const existing = replica.state.locations.find((location) => location.code === "C-04")?.order ?? Number.NEGATIVE_INFINITY;
    return created < existing;
  }).toBe(true);

  await page.locator('.capture-location-row[data-location-id="loc_kitchen"] .queue-row').click();
  await page.getByRole("button", { name: "Mark counted & next" }).click();
  await expect(page.getByRole("heading", { name: "NEW · Priority bin" })).toBeVisible();

  await page.locator("button.nav:visible", { hasText: "Spaces" }).click();
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

  await page.locator('.capture-location-row[data-location-id="loc_bin"] .queue-row').click();
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

  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
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
});

test("keeps touch reordering available on draggable handles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Touch input is a mobile contract");
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

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
});

test("guides incomplete evidence into a reviewable plan", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await page.locator("button.nav:visible", { hasText: "Plan" }).click();

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

  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
  const refreshedReadiness = page.getByRole("region", { name: "Planning readiness" });
  await refreshedReadiness.getByText("2 more ways to improve confidence").click();
  await refreshedReadiness.getByRole("button", { name: "Review a space" }).click();
  await expect(page.getByRole("group", { name: "Suitability" })).toBeFocused();

  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
  const capacityReadiness = page.getByRole("region", { name: "Planning readiness" });
  await capacityReadiness.getByText("2 more ways to improve confidence").click();
  await capacityReadiness.getByRole("button", { name: "Review capacity" }).click();
  await expect(page.getByRole("group", { name: "Interior dimensions (optional)" })).toBeFocused();

  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
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
  const itemEditor = page.getByRole("dialog", { name: "Edit item" });
  await expect(itemEditor.getByText(reviewedItem?.name ?? "", { exact: true })).toBeVisible();
  const afterItemReview = await localReplica(page) as typeof generated;
  expect(afterItemReview.state.activities).toEqual(generated.state.activities);
  expect(afterItemReview.state.plans).toEqual(generated.state.plans);
  await itemEditor.getByRole("button", { name: "Close item editor" }).click();

  const firstDestination = generated.state.locations.find(
    (location) => location.id === activePlan?.steps[0]?.destinationId,
  );
  expect(firstDestination).toBeTruthy();
  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
  await page.getByRole("button", { name: "Review destination" }).first().click();
  await expect(page.getByRole("region", { name: `Edit ${firstDestination?.name ?? ""}` })).toBeFocused();
  const afterDestinationReview = await localReplica(page) as typeof generated;
  expect(afterDestinationReview.state.activities).toEqual(generated.state.activities);
  expect(afterDestinationReview.state.plans).toEqual(generated.state.plans);
});

test("suggests unique location codes without replacing a manual code", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

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
  await page.getByLabel("What is it?").fill("Unclassified charger");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await page.locator("button.nav:visible", { hasText: "Plan" }).click();

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

  await page.getByLabel("Short ID").fill("C-01");
  await page.getByLabel("Friendly name").fill("Keep this draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Add inside Kitchen" }).click();
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

  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
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

  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
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
  expect(metrics.queueWidth).toBeGreaterThanOrEqual(360);
  expect(metrics.cardWidth).toBeGreaterThan(360);
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
  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
  await page.getByRole("button", { name: "Generate move plan" }).click();
  const before = await localReplica(page) as {
    state: {
      items: { id: string; locationId: string }[];
      locations: { id: string; parentId: string | null }[];
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

  await page.locator("button.nav:visible", { hasText: "Activity" }).click();
  await page.locator(".history>div").first().getByRole("button", { name: /^Undo Completed plan step:/ }).click();
  await expect.poll(async () => {
    const rolledBack = await localReplica(page) as typeof before;
    return step.type === "item"
      ? rolledBack.state.items.find((item) => item.id === step.itemId)?.locationId
      : rolledBack.state.locations.find((location) => location.id === step.locationId)?.parentId;
  }).toBe(step.sourceId);
});

test("supports drag organization and the partial-move fallback", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await page.locator("button.nav:visible", { hasText: "Spaces" }).click();
  await expect(page.getByRole("list", { name: "Space hierarchy" })).toBeVisible();
  await expect(page.locator('[data-location-id="loc_bin"] .drag-handle[title="Drag Baking bin to move or nest it"]')).toBeVisible();
  await page.getByRole("button", { name: "Collapse Kitchen" }).click();
  await expect(page.locator('[data-location-id="loc_bin"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Kitchen" }).click();
  const bakingBin = page.locator('[data-location-id="loc_bin"]');
  const foodCabinet = page.locator('[data-location-id="loc_food"]');
  await expect(bakingBin).toBeVisible();
  await expect(foodCabinet).toBeVisible();
  await foodCabinet.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await bakingBin.dragTo(foodCabinet);
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { id: string; parentId: string | null }[] } };
    return replica.state.locations.find((location) => location.id === "loc_bin")?.parentId;
  }).toBe("loc_food");

  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
  await expect(page.locator('.inventory-row[data-item-id="item_sugar"] .drag-handle[title="Drag Brown sugar to reorder"]')).toHaveCount(0);
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  await expect(page.locator('.inventory-row[data-item-id="item_sugar"] .drag-handle[title="Drag Brown sugar to reorder"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Brown sugar, 2 bags up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Brown sugar, 2 bags down" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Brown sugar, 2 bags in Kitchen › Left side › Food cabinet › Baking bin" }).check();
  await expect(page.getByRole("combobox", { name: "Move selected items" }).locator('option[value="loc_bin"]')).toBeDisabled();
  await page.getByRole("button", { name: "Clear" }).click();
  await page.locator('[data-item-id="item_sugar"]').dragTo(page.locator('[data-item-id="item_flour"]'));
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
