import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import { applyCommand, createEnvelope } from "../../src/domain";
import type { Command, WorkspaceState } from "../../src/domain/types";
import type { LocalReplica } from "../../src/client/local-replica";
import { expect, readActiveReplica, test, type SafeBetaFixture, type SyntheticWorkspace } from "./safe-beta-fixtures";
import { projectContextOptions } from "./project-context";

async function seedReplica(page: Page, replica: LocalReplica) {
  await page.evaluate((serialized) => new Promise<void>((resolve, reject) => {
    const value = JSON.parse(serialized) as LocalReplica;
    const open = indexedDB.open("stowplan-v1", 1);
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => open.result.createObjectStore("records");
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("records", "readwrite");
      transaction.objectStore("records").put(value, "active");
      transaction.objectStore("records").put(value, `workspace:${value.state.workspace.id}`);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }), JSON.stringify(replica));
}

function deviceReplica(workspace: SyntheticWorkspace, accountId: string, commands: Command[]): LocalReplica {
  let state = workspace.state;
  const outbox = commands.map((command) => {
    const envelope = createEnvelope(state, command, { actorId: accountId, authorization: { membershipRevision: workspace.authorization.membershipRevision, workspaceAccessRevision: workspace.authorization.accessRevision } });
    state = applyCommand(state, envelope).state;
    return { accountId, envelope, status: "blocked" as const, error: "A newer online edit changed this field" };
  });
  return { authorization: { ...workspace.authorization, accountId }, serverSummary: { ...workspace.summary, accountId }, state, outbox, updatedAt: new Date().toISOString() };
}

async function editOnline(context: BrowserContext, origin: string, state: WorkspaceState, command: Command): Promise<SyntheticWorkspace> {
  const response = await context.request.post(`${origin}/api/sync`, {
    headers: { origin },
    data: { workspaceId: state.workspace.id, commands: [createEnvelope(state, command)] },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.receipts[0].status).toBe("applied");
  return { authorization: body.authorization, state: body.state, summary: body.workspace };
}

async function prepare(page: Page, context: BrowserContext, safeBeta: SafeBetaFixture, twoChanges = false) {
  const account = await safeBeta.signIn(context, "conflict owner");
  const workspace = await safeBeta.createWorkspace(context, "review", "Review pantry");
  const item = workspace.state.items[0];
  const commands: Command[] = [{ type: "item.update", id: item.id, changes: { category: "Grains", frequency: "daily" } }];
  if (twoChanges) commands.push({ type: "workspace.rename", name: "Device pantry" });
  const replica = deviceReplica(workspace, account.userId, commands);
  let online = await editOnline(context, safeBeta.origin, workspace.state, { type: "item.update", id: item.id, changes: { category: "Staples", description: "Shared online note" } });
  if (twoChanges) online = await editOnline(context, safeBeta.origin, online.state, { type: "workspace.rename", name: "Online pantry" });
  await page.goto("/recovery");
  await expect(page.getByRole("heading", { name: "Sync & recovery" })).toBeVisible();
  await seedReplica(page, replica);
  await page.reload();
  return { account, item, online, replica, workspace };
}

async function saveBundleAndCompare(page: Page) {
  await page.getByRole("button", { name: "Load authorized server copy" }).click();
  await expect(page.getByRole("button", { name: "Review queued changes" })).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export full recovery bundle" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^stowplan-recovery-/u);
  const stream = await file.createReadStream();
  let contents = "";
  for await (const chunk of stream!) contents += chunk.toString();
  const backup = JSON.parse(contents);
  expect(backup.format).toBe("stowplan-recovery-v1");
  await page.getByRole("checkbox", { name: "I saved this recovery file somewhere I can reopen it." }).check();
  await page.getByRole("button", { name: "Review queued changes" }).click();
  return { backup, dialog: page.getByRole("dialog", { name: "Review queued changes" }) };
}

test("reviews mixed field choices, revisits decisions, persists, and backs up through normal sync", async ({ page, context, safeBeta }, testInfo) => {
  if (testInfo.project.name === "desktop-compact") await page.emulateMedia({ colorScheme: "dark" });
  const { replica, workspace } = await prepare(page, context, safeBeta, true);
  if (testInfo.project.name === "desktop-compact") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath("recovery-page.png") });
  const { backup, dialog } = await saveBundleAndCompare(page);
  expect(backup.replica.outbox).toEqual(replica.outbox);
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await dialog.getByRole("radio", { name: "Keep online: Staples", exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath("conflict-choices.png") });
  const accessibility = await new AxeBuilder({ page }).include('[aria-modal="true"]').analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("radio", { name: "Use device: Device pantry", exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Ready to save your choices" })).toBeFocused();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Use device: Device pantry", exact: true })).not.toBeChecked();
  await dialog.getByRole("radio", { name: "Keep online: Online pantry", exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Save reviewed choices" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("output")).toContainText("Reviewed choices saved on this device");
  const saved = (await readActiveReplica(page))!;
  expect(saved.state.items[0]).toMatchObject({ category: "Staples", frequency: "daily", description: "Shared online note" });
  expect(saved.state.workspace.name).toBe("Online pantry");
  expect(saved.outbox).toHaveLength(1);
  expect(saved.outbox[0].envelope.command).toMatchObject({ type: "item.update", changes: { frequency: "daily" } });
  expect(saved.outbox[0].envelope.id).not.toBe(replica.outbox[0].envelope.id);
  await page.reload();
  expect((await readActiveReplica(page))?.outbox).toEqual(saved.outbox);
  await page.goto(`/workspaces/${workspace.state.workspace.id}/capture`);
  await expect.poll(async () => (await readActiveReplica(page))?.outbox.length).toBe(0);
  const snapshot = await context.request.get(`${safeBeta.origin}/api/snapshot?workspaceId=${workspace.state.workspace.id}`);
  expect((await snapshot.json()).state.items[0]).toMatchObject({ category: "Staples", frequency: "daily", description: "Shared online note" });
});

test("cancels without writes and keeps choices through a failed offline save", async ({ page, context, safeBeta }, testInfo) => {
  test.skip(!["mobile-chromium", "desktop-chromium"].includes(testInfo.project.name), "Phone and desktop cover cancellation and an offline retry");
  const { replica } = await prepare(page, context, safeBeta);
  const { dialog } = await saveBundleAndCompare(page);
  await dialog.getByRole("radio", { name: "Use device: Grains", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Review queued changes" })).toBeFocused();
  expect((await readActiveReplica(page))?.outbox).toEqual(replica.outbox);
  await page.getByRole("button", { name: "Review queued changes" }).click();
  await expect(dialog.getByRole("radio", { name: "Use device: Grains", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Cancel review", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await readActiveReplica(page))?.outbox).toEqual(replica.outbox);
  await page.getByRole("button", { name: "Review queued changes" }).click();
  await dialog.getByRole("radio", { name: "Use device: Grains", exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await context.setOffline(true);
  await dialog.getByRole("button", { name: "Save reviewed choices" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nothing was changed");
  expect((await readActiveReplica(page))?.outbox).toEqual(replica.outbox);
  expect((await readActiveReplica(page))?.state).toEqual(replica.state);
  await context.setOffline(false);
  await dialog.getByRole("button", { name: "Save reviewed choices" }).click();
  await expect(dialog).toBeHidden();
  expect((await readActiveReplica(page))?.state.items[0]).toMatchObject({ category: "Grains", description: "Shared online note" });
});

test("invalidates changed online values and refuses to replace a newer device queue", async ({ page, context, safeBeta }) => {
  const { replica, online, item } = await prepare(page, context, safeBeta);
  const { dialog } = await saveBundleAndCompare(page);
  await dialog.getByRole("radio", { name: "Use device: Grains", exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await editOnline(context, safeBeta.origin, online.state, { type: "item.update", id: item.id, changes: { category: "Latest online" } });
  await dialog.getByRole("button", { name: "Save reviewed choices" }).click();
  await expect(dialog.getByRole("alert")).toContainText("online copy changed");
  await expect(dialog.getByRole("radio", { name: "Use device: Grains", exact: true })).not.toBeChecked();
  expect((await readActiveReplica(page))?.outbox).toEqual(replica.outbox);
  await dialog.getByRole("radio", { name: "Keep online: Latest online", exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  const second = await context.newPage();
  try {
    await second.goto("/recovery");
    const envelope = createEnvelope(replica.state, { type: "workspace.rename", name: "Changed in another tab" });
    const concurrent: LocalReplica = { ...replica, state: applyCommand(replica.state, envelope).state, outbox: [...replica.outbox, { accountId: replica.outbox[0].accountId, envelope, status: "pending" }], updatedAt: new Date(Date.now() + 1).toISOString() };
    await seedReplica(second, concurrent);
    await dialog.getByRole("button", { name: "Save reviewed choices" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("output")).toContainText("changed after recovery was reviewed");
    expect((await readActiveReplica(page))?.outbox).toEqual(concurrent.outbox);
    expect((await readActiveReplica(page))?.state).toEqual(concurrent.state);
    await expect(page.getByRole("checkbox", { name: "I saved this recovery file somewhere I can reopen it." })).toHaveCount(0);
  } finally { await second.close(); }
});

test("rechecks editor access before saving and keeps the recovery bundle available", async ({ browser, page, context, safeBeta }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One desktop project covers a real membership change during review");
  await safeBeta.signIn(context, "recovery owner");
  const workspace = await safeBeta.createWorkspace(context, "permissions", "Permission pantry");
  const invite = await safeBeta.createInvite(context, workspace.state.workspace.id, "editor");
  const editorContext = await browser.newContext(projectContextOptions(page, testInfo));
  try {
    const editor = await safeBeta.redeemInvite(editorContext, invite.oneTimeUrl, "recovery editor");
    const response = await editorContext.request.get(`${safeBeta.origin}/api/snapshot?workspaceId=${workspace.state.workspace.id}`);
    const body = await response.json();
    const writable: SyntheticWorkspace = { authorization: body.authorization, state: body.state, summary: body.workspace };
    const item = writable.state.items[0];
    const replica = deviceReplica(writable, editor.userId, [{ type: "item.update", id: item.id, changes: { category: "Grains" } }]);
    await editOnline(context, safeBeta.origin, workspace.state, { type: "item.update", id: item.id, changes: { category: "Staples" } });
    const editorPage = await editorContext.newPage();
    await editorPage.goto("/recovery");
    await seedReplica(editorPage, replica);
    await editorPage.reload();
    const { dialog } = await saveBundleAndCompare(editorPage);
    await dialog.getByRole("radio", { name: "Use device: Grains", exact: true }).check();
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await safeBeta.changeMemberRole(context, workspace.state.workspace.id, editor.userId, "viewer");
    await dialog.getByRole("button", { name: "Save reviewed choices" }).click();
    await expect(dialog).toBeHidden();
    await expect(editorPage.locator("output")).toContainText("Write access changed");
    await expect(editorPage.getByRole("button", { name: "Review queued changes" })).toBeDisabled();
    await expect(editorPage.getByRole("button", { name: "Export full recovery bundle" })).toBeEnabled();
    expect((await readActiveReplica(editorPage))?.outbox).toEqual(replica.outbox);
  } finally { await editorContext.close(); }
});
