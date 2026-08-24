import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const CSV_FILE = [
  "Name,Quantity,Unit,Category,Description,Tags,Frequency,Location",
  "Imported olive oil,2,bottles,Pantry,Cold pressed glass,oil|cooking,monthly,C-01",
  '"Imported, whisk",3,each,Utensils,12 inch whisk,baking;tools,daily,D-01',
  "Mystery crate,1,box,Misc,Needs mapping,storage,rarely,Overflow",
  ",1,each,Misc,Blank name,,monthly,C-01",
  "Bad quantity,-2,each,Misc,Invalid row,,rarely,C-01",
].join("\n");
const CSV_IMPORT_PROJECTS = new Set([
  "desktop-chromium",
  "mobile-chromium",
]);
const IMPORTED_ITEM_NAMES = [
  "Imported olive oil",
  "Imported, whisk",
  "Mystery crate",
];

interface StoredReplica {
  state: {
    activities: { label: string }[];
    items: { id: string; name: string }[];
    locations: { captureStatus: string; id: string }[];
  };
}

async function localReplica(page: Page): Promise<StoredReplica> {
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
    return await handle.jsonValue() as unknown as StoredReplica;
  } finally {
    await handle.dispose();
  }
}

async function openActivity(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await page.locator(".app-shell > aside .nav", {
      hasText: "Activity",
    }).click();
    return;
  }
  await page.getByRole("button", { exact: true, name: "More" }).click();
  const dialog = page.getByRole("dialog", { name: "More" });
  await dialog.getByRole("link", { exact: true, name: "Activity" }).click();
}

async function openSettings(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await page.locator(".app-shell > aside .nav", {
      hasText: "Settings",
    }).click();
    return;
  }
  await page.getByRole("button", { exact: true, name: "More" }).click();
  const dialog = page.getByRole("dialog", { name: "More" });
  await dialog.getByRole("link", { exact: true, name: "Settings" }).click();
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

test("imports mapped valid rows offline and undoes the whole change", async ({
  context,
  page,
}, testInfo) => {
  test.skip(
    !CSV_IMPORT_PROJECTS.has(testInfo.project.name),
    "Phone and desktop cover the responsive CSV import workflow",
  );
  const before = await localReplica(page);
  const originalStatuses = new Map(before.state.locations.map((location) => [
    location.id,
    location.captureStatus,
  ]));
  const trigger = page.getByRole("button", { name: "Import CSV" });
  await expect(trigger).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    const toolbarWidth = await page.locator(".inventory-tools")
      .evaluate((element) => element.getBoundingClientRect().width);
    const triggerWidth = await trigger.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(triggerWidth).toBeGreaterThanOrEqual(toolbarWidth - 1);
  }

  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Import inventory from CSV",
  });
  await expect(dialog.getByRole("heading", {
    name: "Choose a CSV file",
  })).toBeFocused();
  await expect(dialog.locator([
    "input:not([id]):not([name])",
    "select:not([id]):not([name])",
    "textarea:not([id]):not([name])",
  ].join(", "))).toHaveCount(0);
  await dialog.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from(CSV_FILE),
    mimeType: "text/csv",
    name: "inventory.csv",
  });

  await expect(dialog.getByRole("heading", {
    name: "Map inventory columns",
  })).toBeFocused();
  await expect(dialog.getByRole("combobox", {
    name: /Item name/,
  })).toHaveValue("0");
  await expect(dialog.getByRole("combobox", {
    name: /Location column/,
  })).toHaveValue("7");
  await expect(dialog.getByRole("combobox", {
    name: "Destination for C-01",
  })).toHaveValue("loc_food");
  await expect(dialog.getByRole("combobox", {
    name: "Destination for D-01",
  })).toHaveValue("loc_drawer");
  await dialog.getByRole("combobox", {
    name: "Destination for Overflow",
  }).selectOption("loc_box");
  await dialog.getByRole("button", { name: "Review rows" }).click();

  await expect(dialog.getByRole("heading", {
    name: "Review and commit",
  })).toBeFocused();
  await expect(dialog.getByText("3", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("2", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole("rowheader", { name: "5" })).toBeVisible();
  await expect(dialog.getByRole("cell", {
    name: "Item name is blank",
  })).toBeVisible();
  await expect(dialog.getByRole("cell", {
    name: /Quantity must be a positive decimal/,
  })).toBeVisible();
  const submit = dialog.getByRole("button", {
    name: "Import 3 item records",
  });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", {
    name: "Reopen 2 completed spaces as part of this import",
  }).check();
  await dialog.getByRole("checkbox", {
    name: "Skip these 2 invalid rows and import only the ready records",
  }).check();
  await expect(submit).toBeEnabled();
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]:not([hidden])')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious"
  )).toEqual([]);
  const layout = await dialog.evaluate((element) => ({
    dialogOverflow: element.scrollWidth > element.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
  }));
  expect(layout).toEqual({ dialogOverflow: false, pageOverflow: false });

  const secondTab = await context.newPage();
  try {
    await secondTab.goto(page.url());
    await openSettings(secondTab);
    await secondTab.getByLabel("Workspace name").fill(
      `CSV review update ${Date.now()}`,
    );
    await secondTab.getByRole("button", { name: "Rename workspace" }).click();

    await expect(dialog.getByText(
      "The workspace changed while this review was open",
    )).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("checkbox", {
      name: "Reopen 2 completed spaces as part of this import",
    })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox", {
      name: "Skip these 2 invalid rows and import only the ready records",
    })).not.toBeChecked();
    await dialog.getByRole("button", {
      name: "Accept refreshed review",
    }).click();
    await dialog.getByRole("checkbox", {
      name: "Reopen 2 completed spaces as part of this import",
    }).check();
    await dialog.getByRole("checkbox", {
      name: "Skip these 2 invalid rows and import only the ready records",
    }).check();
    await expect(submit).toBeEnabled();
  } finally {
    await secondTab.close();
  }

  await context.setOffline(true);
  await submit.click();
  await expect(page.getByText(
    "3 item records imported. Undo the whole import from Activity.",
  )).toBeVisible();
  for (const name of IMPORTED_ITEM_NAMES) {
    await expect(page.locator(".inventory-row", { hasText: name }))
      .toBeVisible();
  }
  await expect.poll(async () => {
    const replica = await localReplica(page);
    return {
      activity: replica.state.activities.some((activity) =>
        activity.label === "Imported 3 item records and reopened affected spaces"
      ),
      imported: replica.state.items.filter((item) =>
        IMPORTED_ITEM_NAMES.includes(item.name)
      ).map((item) => item.name).sort(),
      statuses: ["loc_food", "loc_drawer"].map((id) =>
        replica.state.locations.find((location) => location.id === id)
          ?.captureStatus
      ),
    };
  }).toEqual({
    activity: true,
    imported: [...IMPORTED_ITEM_NAMES].sort(),
    statuses: ["in_progress", "in_progress"],
  });

  await openActivity(page);
  await page.getByRole("button", {
    name: /^Undo this Imported 3 item records and reopened affected spaces/,
  }).click();
  await expect.poll(async () => {
    const replica = await localReplica(page);
    return {
      imported: replica.state.items.filter((item) =>
        IMPORTED_ITEM_NAMES.includes(item.name)
      ).length,
      statuses: ["loc_food", "loc_drawer"].map((id) =>
        replica.state.locations.find((location) => location.id === id)
          ?.captureStatus
      ),
    };
  }).toEqual({
    imported: 0,
    statuses: [
      originalStatuses.get("loc_food"),
      originalStatuses.get("loc_drawer"),
    ],
  });
  await context.setOffline(false);
});

test("keeps malformed CSV local and recoverable", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One desktop project covers file-level recovery",
  );
  const before = await localReplica(page);
  await page.getByRole("button", { name: "Import CSV" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Import inventory from CSV",
  });
  const fileInput = dialog.locator('input[type="file"]');
  await fileInput.setInputFiles({
    buffer: Buffer.from('Name,Location\n"Unclosed,C-01'),
    mimeType: "text/csv",
    name: "malformed.csv",
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "CSV field has an unclosed quote at line 2, column 15",
  );
  await expect(dialog.getByRole("heading", {
    name: "Choose a CSV file",
  })).toBeVisible();

  await fileInput.setInputFiles({
    buffer: Buffer.from("Name,Location\nRecovered item,BX-09"),
    mimeType: "text/csv",
    name: "recovered.csv",
  });
  await expect(dialog.getByRole("heading", {
    name: "Map inventory columns",
  })).toBeVisible();
  const after = await localReplica(page);
  expect(after.state.items).toEqual(before.state.items);
  expect(after.state.activities).toEqual(before.state.activities);
});
