import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { LocalReplica } from "../../src/client/local-replica";

const SELECTED_IDS = ["item_pasta", "item_rice"];

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

async function openEditor(page: Page) {
  for (const id of SELECTED_IDS) await page.locator(`input[name="selectedItem"][value="${id}"]`).check();
  await page.getByRole("button", { name: "Edit selected", exact: true }).click();
  return page.getByRole("dialog", { name: "Edit selected items" });
}

async function openActivity(page: Page) {
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await page.locator(".app-shell > aside .nav", { hasText: "Activity" }).click();
  } else {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Activity", exact: true }).click();
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/workspaces");
  await page.evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("stowplan-v1");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }));
  await page.reload();
  await page.getByRole("button", { name: "Open kitchen demo" }).click();
  await page.locator(".nav:visible", { hasText: "Inventory" }).click();
});

test("reviews a bulk edit, saves offline, and undoes every change together", async ({ context, page }) => {
  const before = await localReplica(page);
  const dialog = await openEditor(page);
  await expect(dialog.getByRole("heading", { name: "Choose shared changes" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Review changes" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Change category" }).check();
  await dialog.getByRole("textbox", { name: "Category", exact: true }).fill("Camping");
  await dialog.getByRole("combobox", { name: "Usage frequency" }).selectOption("rarely");
  await dialog.getByRole("combobox", { name: "Tags", exact: true }).selectOption("add");
  await dialog.getByRole("textbox", { name: "Tags to add", exact: true }).fill("camping");
  await dialog.getByText("Placement requirements", { exact: true }).click();
  await dialog.getByRole("combobox", { name: "Avoid warmth" }).selectOption("false");
  await dialog.getByRole("combobox", { name: "Required space tags", exact: true }).selectOption("add");
  await dialog.getByRole("textbox", { name: "Required space tags to add" }).fill("dry");
  expect(await dialog.locator("select:visible").evaluateAll((elements) =>
    elements.every((element) => element.getBoundingClientRect().height >= 44)
  )).toBe(true);
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog.getByRole("heading", { name: "Review changes" })).toBeFocused();
  await expect(dialog.getByText("Pasta", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Rice", { exact: true })).toBeVisible();
  await expect(dialog.getByText("dry goods, camping", { exact: true }).first()).toBeVisible();
  const save = dialog.getByRole("button", { name: "Save 2 items", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Reopen 2 completed spaces with these edits" }).check();
  await expect(save).toBeEnabled();
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  expect(await dialog.evaluate((element) => ({
    dialogOverflow: element.scrollWidth > element.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
  }))).toEqual({ dialogOverflow: false, pageOverflow: false });
  expect((await localReplica(page)).state).toEqual(before.state);
  await context.setOffline(true);
  await save.click();
  await expect(dialog).not.toBeVisible();
  const saved = await localReplica(page);
  expect(saved.outbox).toHaveLength(before.outbox.length + 1);
  expect(saved.outbox.at(-1)?.envelope.command.type).toBe("item.bulkUpdate");
  for (const id of SELECTED_IDS) {
    const original = before.state.items.find((item) => item.id === id)!;
    const edited = saved.state.items.find((item) => item.id === id)!;
    expect(edited).toMatchObject({
      category: "Camping", frequency: "rarely", name: original.name,
      quantity: original.quantity, description: original.description, tags: [...original.tags, "camping"],
      constraints: { ...original.constraints, avoidWarmth: false, requiredTags: ["dry"] },
    });
  }
  await openActivity(page);
  await page.getByRole("button", { name: /^Undo this Updated 2 item records and reopened affected spaces/ }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page);
    return replica.state.items.filter((item) => SELECTED_IDS.includes(item.id)).map((item) => ({ category: item.category, tags: item.tags, constraints: item.constraints }));
  }).toEqual(before.state.items.filter((item) => SELECTED_IDS.includes(item.id)).map((item) => ({ category: item.category, tags: item.tags, constraints: item.constraints })));
  const undone = await localReplica(page);
  for (const id of ["loc_food", "loc_warm"]) expect(undone.state.locations.find((location) => location.id === id)?.captureStatus).toBe("counted");
});

test("cancel preserves data and keyboard focus, and no-op values cannot be submitted", async ({ page }) => {
  const before = await localReplica(page);
  const dialog = await openEditor(page);
  await dialog.getByRole("combobox", { name: "Tags", exact: true }).selectOption("remove");
  await dialog.getByRole("textbox", { name: "Tags to remove", exact: true }).fill("not-present");
  await expect(dialog.getByRole("button", { name: "Review changes" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Tags", exact: true }).selectOption("clear");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog.getByText("None", { exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Back to editing" }).click();
  await expect(dialog.getByRole("combobox", { name: "Tags", exact: true })).toHaveValue("clear");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Edit selected", exact: true })).toBeFocused();
  expect((await localReplica(page)).state).toEqual(before.state);
  expect((await localReplica(page)).outbox).toEqual(before.outbox);
  await page.getByRole("textbox", { name: "Search inventory" }).fill("Food");
  const visibleItems = page.locator('input[name="selectedItem"]');
  await expect(visibleItems).not.toHaveCount(0);
  await page.getByRole("button", { name: /^Select all .* results?$/ }).click();
  expect(await visibleItems.count()).toBe(await page.locator('input[name="selectedItem"]:checked').count());
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(page.locator('input[name="selectedItem"]:checked')).toHaveCount(0);
});

test("requires a fresh review after another tab changes a selected field", async ({ context, page }) => {
  const dialog = await openEditor(page);
  await dialog.getByRole("checkbox", { name: "Change category" }).check();
  await dialog.getByRole("textbox", { name: "Category", exact: true }).fill("Camping");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await dialog.getByRole("checkbox", { name: "Reopen 2 completed spaces with these edits" }).check();
  const second = await context.newPage();
  try {
    await second.goto(page.url());
    const otherDialog = await openEditor(second);
    await otherDialog.getByRole("checkbox", { name: "Change category" }).check();
    await otherDialog.getByRole("textbox", { name: "Category", exact: true }).fill("Remote category");
    await otherDialog.getByRole("button", { name: "Review changes" }).click();
    await otherDialog.getByRole("checkbox", { name: "Reopen 2 completed spaces with these edits" }).check();
    await otherDialog.getByRole("button", { name: "Save 2 items" }).click();
    await expect(otherDialog).not.toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save 2 items" })).toBeDisabled();
    await expect(dialog.getByText("The selected items or affected spaces changed. Refresh the preview before saving.")).toBeVisible();
    await dialog.getByRole("button", { name: "Refresh review" }).click();
    await expect(dialog.getByText("Remote category", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Reopen/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save 2 items" }).click();
    await expect(dialog).not.toBeVisible();
    expect((await localReplica(page)).state.items.filter((item) => SELECTED_IDS.includes(item.id)).every((item) => item.category === "Camping")).toBe(true);
  } finally {
    await second.close();
  }
});
