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
  await expect(page.getByRole("button", { name: "Drag Test tea towels to reorder" })).toHaveCount(0);
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
  expect(consoleErrors).toEqual([]);
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

test("supports drag organization and the partial-move fallback", async ({ page }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  await page.locator("button.nav:visible", { hasText: "Spaces" }).click();
  await expect(page.getByRole("tree", { name: "Space hierarchy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Drag Baking bin to move or nest it" })).toBeVisible();
  await page.getByRole("button", { name: "Collapse Kitchen" }).click();
  await expect(page.locator('[data-location-id="loc_bin"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Kitchen" }).click();
  await page.locator('[data-location-id="loc_bin"]').dragTo(page.locator('[data-location-id="loc_food"]'));
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { id: string; parentId: string | null }[] } };
    return replica.state.locations.find((location) => location.id === "loc_bin")?.parentId;
  }).toBe("loc_food");

  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
  await expect(page.getByRole("button", { name: "Drag Brown sugar to reorder" })).toHaveCount(0);
  await page.getByLabel("Filter by location").selectOption("loc_bin");
  await expect(page.getByRole("button", { name: "Drag Brown sugar to reorder" })).toBeVisible();
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
  await card.getByText(/What is waiting/).click();
  await expect(card.getByText(/Recorded 1 item Waiting to sync/)).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("This does not delete any server copy");
    dialog.accept();
  });
  await card.getByRole("button", { name: /Remove Kitchen reset from this device/ }).click();
  await expect(page.getByRole("heading", { name: /Label it/ })).toBeVisible();
});

test("has no critical accessibility violations and reloads offline", async ({ page, context }) => {
  await page.getByRole("button", { name: "Explore the kitchen demo instead" }).click();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((violation) => violation.impact === "critical")).toEqual([]);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Capture" })).toBeVisible();
});
