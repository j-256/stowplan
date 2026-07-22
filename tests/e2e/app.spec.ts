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
  await page.getByLabel("Qty").fill("2");
  await page.getByLabel("What is it?").fill("Test tea towels");
  await page.getByRole("button", { name: "Save & add next" }).click();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();

  await page.getByLabel("Open main menu").click();
  await expect(page.getByRole("heading", { name: "Where to next?" })).toBeVisible();
  await page.getByRole("button", { name: "Continue current workspace" }).click();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Edit Test tea towels" }).click();
  await page.getByLabel("Category").fill("Linens");
  await page.getByLabel("Tags, comma-separated").fill("washable, prep");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved on this device.")).toBeVisible();
  await page.getByRole("button", { name: "Close item editor" }).click();

  await page.reload();
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();
  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
  await page.getByPlaceholder("Search names, categories, tags, constraints, and notes").fill("washable");
  await expect(page.getByText("Test tea towels", { exact: true })).toBeVisible();
  await page.locator("button.nav:visible", { hasText: "Plan" }).click();
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
  await page.locator('[data-location-id="loc_bin"]').dragTo(page.locator('[data-location-id="loc_food"]'));
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { locations: { id: string; parentId: string | null }[] } };
    return replica.state.locations.find((location) => location.id === "loc_bin")?.parentId;
  }).toBe("loc_food");

  await page.locator("button.nav:visible", { hasText: "Inventory" }).click();
  await page.getByLabel("Filter by location").selectOption("loc_bin");
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
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByLabel("Move quantity", { exact: true }).fill("2");
  await page.getByLabel("Destination").selectOption("loc_food");
  await page.getByRole("button", { name: "Move quantity" }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page) as { state: { items: { id: string; locationId: string; name: string; quantity: number }[] } };
    return replica.state.items.filter((item) => item.name === "Pasta").map((item) => [item.locationId, item.quantity]).sort();
  }).toEqual([["loc_food", 2], ["loc_warm", 4]]);
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
