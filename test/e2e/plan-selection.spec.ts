import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { LocalReplica } from "../../src/client/local-replica";

async function localReplica(page: Page): Promise<LocalReplica> {
  return page.evaluate(() => new Promise<LocalReplica>((resolve, reject) => {
    const open = indexedDB.open("stowplan-v1", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("records").objectStore("records").get("active");
      request.onerror = () => { database.close(); reject(request.error); };
      request.onsuccess = () => { database.close(); resolve(request.result as LocalReplica); };
    };
  }));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/workspaces");
  await page.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("stowplan-v1");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }));
  await page.reload();
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(".nav:visible", { hasText: "Plan" }).click();
});

test("selects areas and pins, saves a plan offline, and retains its choices on reload", async ({ context, page }) => {
  const before = await localReplica(page);
  await page.getByRole("button", { name: "Areas Whole workspace", exact: true }).click();
  const areas = page.getByRole("dialog", { name: "Plan areas" });
  await areas.getByRole("checkbox", { name: "Include Left side", exact: true }).check();
  await expect(areas.getByRole("checkbox", { name: "Include Food cabinet", exact: true })).toBeChecked();
  await expect(areas.getByRole("checkbox", { name: "Include Food cabinet", exact: true })).toBeDisabled();
  await areas.getByRole("searchbox", { name: "Search areas" }).fill("Left");
  await areas.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Areas 1 selected", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Pins Keep placements", exact: true }).click();
  const pins = page.getByRole("dialog", { name: "Pinned placements" });
  await pins.getByRole("searchbox", { name: "Search placements" }).fill("Rice");
  await pins.getByRole("checkbox", { name: "Pin Rice", exact: true }).check();
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  expect(await pins.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  await pins.getByRole("button", { name: "Done", exact: true }).click();
  expect((await localReplica(page)).state).toEqual(before.state);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Generate move plan", exact: true }).click();
  await expect(page.getByRole("region", { name: "Next move" })).toBeFocused();
  const saved = await localReplica(page);
  const plan = saved.state.plans.find((candidate) => candidate.status === "active")!;
  expect(plan.selection).toEqual({ locationIds: ["loc_left"], pinnedItemIds: ["item_rice"], pinnedLocationIds: [] });
  expect(plan.steps.length).toBeGreaterThan(0);
  expect(plan.steps.every((step) => ["loc_food", "loc_warm", "loc_drawer"].includes(step.sourceId) && ["loc_food", "loc_warm", "loc_drawer"].includes(step.destinationId) && step.itemId !== "item_rice")).toBe(true);
  expect(saved.outbox.at(-1)?.envelope.command).toMatchObject({ type: "plan.create", plan: { selection: plan.selection } });
  await page.reload();
  await expect(page.getByLabel("Saved plan areas and pins")).toContainText("Left side");
  await expect(page.getByLabel("Saved plan areas and pins")).toContainText("1 pin");
  if (await page.locator(".planner-options-summary").isVisible()) {
    await page.locator(".planner-options-summary").click();
  }
  await expect(page.getByRole("button", { name: "Pins 1 kept in place", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Areas 1 selected", exact: true }).click();
  await expect(areas).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(areas).toBeHidden();
  await expect(page.getByRole("button", { name: "Areas 1 selected", exact: true })).toBeFocused();
  await context.setOffline(false);
});

test("pins spaces and their contents, makes empty selection explicit, and restores the default", async ({ page }) => {
  const readiness = page.getByRole("button", { name: /Review planning readiness/ });
  if (await readiness.isVisible()) {
    await readiness.click();
    await page.getByRole("dialog", { name: "Planning readiness" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(readiness).toBeFocused();
  }
  await page.getByRole("button", { name: "Pins Keep placements", exact: true }).click();
  const pins = page.getByRole("dialog", { name: "Pinned placements" });
  await pins.getByRole("button", { name: "Spaces", exact: true }).click();
  await pins.getByRole("checkbox", { name: "Pin Baking bin", exact: true }).check();
  await pins.getByRole("button", { name: "Items", exact: true }).click();
  await expect(pins.getByRole("checkbox", { name: "Pin All-purpose flour", exact: true })).toBeChecked();
  await expect(pins.getByRole("checkbox", { name: "Pin All-purpose flour", exact: true })).toBeDisabled();
  await pins.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Areas Whole workspace", exact: true }).click();
  const areas = page.getByRole("dialog", { name: "Plan areas" });
  await areas.getByRole("button", { name: "Clear areas", exact: true }).click();
  await areas.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate move plan", exact: true })).toBeDisabled();
  await expect(page.getByText("Choose an area to begin.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Areas 0 selected", exact: true }).click();
  await areas.getByRole("button", { name: "Whole workspace", exact: true }).click();
  await areas.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Generate move plan", exact: true }).click();
  await expect(page.getByRole("region", { name: "Next move" })).toBeVisible();
  const saved = await localReplica(page);
  const plan = saved.state.plans[0]!;
  expect(plan.steps.some((step) => step.locationId === "loc_bin" || ["item_flour", "item_sugar"].includes(step.itemId ?? "") || step.destinationId === "loc_bin")).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
