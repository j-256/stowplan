import { expect, test } from "@playwright/test";
import { WORKSPACE_LIST_PATH } from "../../src/domain/app-url";

test.describe("landing page", () => {
  test("shows the hero to a first-time visitor and opens the demo", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Stowplan" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Try the kitchen demo" }).click();
    // /demo immediately client-redirects onward into the demo workspace, so
    // assert the settled capture deep-link rather than the transient /demo URL
    await expect(page).toHaveURL(/\/workspaces\/.*ws_demo/);
  });

  test("keeps account sign-in available before any workspace is local", async ({
    page,
  }) => {
    await page.goto("/?welcome");
    const trigger = page.getByRole("button", {
      name: /Open user menu/,
    });
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    const viewport = page.viewportSize();
    expect(triggerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(triggerBox!.x + triggerBox!.width).toBeGreaterThan(
      viewport!.width / 2,
    );
    expect(triggerBox!.y).toBeLessThan(viewport!.height / 3);

    await trigger.click();
    const accountLink = page.getByRole("dialog", {
      name: "User menu",
    }).getByRole("link", {
      name: "Sign in or connect",
    });
    await expect(accountLink).toHaveAttribute(
      "href",
      "/account?returnTo=%2Fworkspaces",
    );
  });

  test("redirects a returning visitor with local workspaces to the hub", async ({
    page,
  }) => {
    // Seed a local workspace by creating one through the hub, then revisit /
    await page.goto(WORKSPACE_LIST_PATH);
    await page.getByPlaceholder("Workspace name").fill("Return visit test");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE_LIST_PATH}/`));

    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE_LIST_PATH}(/|$)`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Stowplan" }),
    ).toHaveCount(0);
  });

  test("keeps the hero on ?welcome even for a known visitor", async ({
    page,
  }) => {
    await page.goto(WORKSPACE_LIST_PATH);
    await page.getByPlaceholder("Workspace name").fill("Welcome bypass test");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE_LIST_PATH}/`));

    await page.goto("/?welcome");
    await expect(
      page.getByRole("heading", { level: 1, name: "Stowplan" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/\?welcome$/);
  });
});
