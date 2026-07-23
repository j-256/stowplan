import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

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
  await expect(page.getByRole("heading", { name: "Edit item" })).toBeVisible();
  await expect(page.getByText("What is it?", { exact: true })).toBeVisible();
  await expect(page.getByText("Organize and find it", { exact: true })).toBeVisible();
  await page.getByLabel("Category").fill("Linens");
  await page.getByLabel("Search tags").fill("washable, prep");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByText("Saved on this device.")).toBeVisible();
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
    documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    finishOverflow: (() => {
      const finish = document.querySelector<HTMLElement>(".finish");
      return Boolean(finish && finish.scrollWidth > finish.clientWidth);
    })(),
    narrowTargets: [...document.querySelectorAll<HTMLElement>(".finish button, .breadcrumbs button")]
      .filter((target) => target.getBoundingClientRect().height < 44)
      .map((target) => target.textContent),
  }));
  expect(metrics).toEqual({
    documentOverflow: false,
    finishOverflow: false,
    narrowTargets: [],
  });
});

test("keeps the Capture hierarchy readable at compact desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1132, height: 900 });
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();

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
  await page.locator(".history>div").first().getByRole("button", { name: "Undo this" }).click();
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
  await page.locator('[data-location-id="loc_bin"]').dragTo(page.locator('[data-location-id="loc_food"]'));
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { id: string; parentId: string | null }[] } };
    return replica.state.locations.find((location) => location.id === "loc_bin")?.parentId;
  }).toBe("loc_food");

  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
  await expect(page.locator('.inventory-row[data-item-id="item_sugar"] .drag-handle[title="Drag Brown sugar to reorder"]')).toHaveCount(0);
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  await expect(page.locator('.inventory-row[data-item-id="item_sugar"] .drag-handle[title="Drag Brown sugar to reorder"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Brown sugar up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move Brown sugar down" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Brown sugar in Kitchen › Right side › Lower cabinet › Baking bin" }).check();
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
  await expect(page.getByRole("checkbox", { name: "Select Pasta in Kitchen › Left side › Food cabinet" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Pasta in Kitchen › Left side › Cabinet above oven" })).toBeVisible();
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
  await expect(card.getByText(/Recorded 1 item Waiting to sync/)).toBeVisible();
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
