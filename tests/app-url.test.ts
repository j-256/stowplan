import { describe, expect, it } from "vitest";
import {
  GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS,
  guestInvitationUrl,
  INVITATION_OAUTH_RESUME_PATH,
  oauthReturnTo,
  parseAppUrl,
  parseGuestInvitationFragment,
  WORKSPACE_LIST_PATH,
  workspaceReturnTo,
  workspacePath,
} from "../src/domain/app-url";

describe("workspace URLs", () => {
  it("builds meaningful paths for primary views and durable view context", () => {
    expect(workspacePath({ workspaceId: "ws_home", view: "capture" }))
      .toBe("/workspaces/ws_home/capture");
    expect(workspacePath({
      locationId: "loc_pantry",
      workspaceId: "ws_home",
      view: "spaces",
    })).toBe("/workspaces/ws_home/spaces/locations/loc_pantry");
    expect(workspacePath({
      itemId: "item_flour",
      workspaceId: "ws_home",
      view: "inventory",
    })).toBe("/workspaces/ws_home/inventory/items/item_flour");
    expect(workspacePath({
      locationId: "loc_bin",
      workspaceId: "ws_home",
      view: "inventory",
    })).toBe("/workspaces/ws_home/inventory/locations/loc_bin");
    expect(workspacePath({
      workspaceId: "ws_home",
      workspaceLabel: "My Home",
      view: "access",
    })).toBe("/workspaces/my-home@ws_home/access");
    expect(WORKSPACE_LIST_PATH).toBe("/workspaces");
  });

  it("pairs readable labels with stable identifiers", () => {
    const path = workspacePath({
      locationId: "loc_corner",
      locationLabel: "C-04 · Corner cabinet",
      view: "capture",
      workspaceId: "ws_demo_123",
      workspaceLabel: "Kitchen reset",
    });
    expect(path).toBe(
      "/workspaces/kitchen-reset@ws_demo_123/capture/locations/c-04-corner-cabinet@loc_corner",
    );
    expect(parseAppUrl(path)).toEqual({
      itemId: null,
      kind: "workspace",
      locationId: "loc_corner",
      view: "capture",
      workspaceId: "ws_demo_123",
    });
    expect(workspacePath({
      itemId: "item_flour",
      itemLabel: "All-purpose flour",
      view: "inventory",
      workspaceId: "ws_home",
      workspaceLabel: "My Home",
    })).toBe(
      "/workspaces/my-home@ws_home/inventory/items/all-purpose-flour@item_flour",
    );
  });

  it("parses canonical workspace, location, item, and workspace-list routes", () => {
    expect(parseAppUrl("/workspaces/ws_home/plan")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: null,
      view: "plan",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl("/workspaces/ws_home/capture/locations/loc_bin")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: "loc_bin",
      view: "capture",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl("/workspaces/ws_home/inventory/items/item_flour")).toEqual({
      kind: "workspace",
      itemId: "item_flour",
      locationId: null,
      view: "inventory",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl("/workspaces/ws_home/access")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: null,
      view: "access",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl(WORKSPACE_LIST_PATH)).toEqual({ kind: "workspace-list" });
  });

  it("accepts legacy label and guest destinations for canonicalization", () => {
    expect(parseAppUrl("/?workspace=ws_home&container=loc_bin")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: "loc_bin",
      view: "capture",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl("/?workspace=ws_home&view=activity")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: null,
      view: "activity",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl("/?workspace=ws_home&view=access")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: null,
      view: "access",
      workspaceId: "ws_home",
    });
  });

  it("encodes identifiers and ignores malformed or unrelated detail segments", () => {
    const path = workspacePath({
      locationId: "loc/tea shelf",
      workspaceId: "ws/home",
      view: "spaces",
    });
    expect(path).toBe(
      "/workspaces/ws%2Fhome/spaces/locations/loc%2Ftea%20shelf",
    );
    expect(parseAppUrl(path)).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: "loc/tea shelf",
      view: "spaces",
      workspaceId: "ws/home",
    });
    expect(parseAppUrl("/workspaces/ws_home/not-a-view/private/data")).toEqual({
      kind: "workspace",
      itemId: null,
      locationId: null,
      view: "capture",
      workspaceId: "ws_home",
    });
    expect(parseAppUrl("/account")).toEqual({ kind: "home" });
  });

  it("keeps label separators unambiguous for imported identifiers", () => {
    const path = workspacePath({
      locationId: "loc/@tea shelf",
      locationLabel: "Crème & 茶",
      view: "spaces",
      workspaceId: "ws/@home",
      workspaceLabel: "",
    });
    expect(path).toBe(
      "/workspaces/workspace@ws%2F%40home/spaces/locations/creme-%E8%8C%B6@loc%2F%40tea%20shelf",
    );
    expect(parseAppUrl(path)).toEqual({
      itemId: null,
      kind: "workspace",
      locationId: "loc/@tea shelf",
      view: "spaces",
      workspaceId: "ws/@home",
    });
  });

  it("keeps guest and sign-in returns inside the authorized workspace", () => {
    const readableSettingsPath =
      "/workspaces/my-home@ws_home/settings";
    expect(workspaceReturnTo(readableSettingsPath, "ws_home"))
      .toBe(readableSettingsPath);
    const readableAccessPath =
      "/workspaces/my-home@ws_home/access";
    expect(workspaceReturnTo(readableAccessPath, "ws_home"))
      .toBe(readableAccessPath);
    const readableItemPath =
      "/workspaces/my-home@ws_home/inventory/items/all-purpose-flour@item_flour";
    expect(workspaceReturnTo(readableItemPath, "ws_home"))
      .toBe(readableItemPath);
    expect(workspaceReturnTo(
      "/workspaces/ws_home/inventory/items/item_flour",
      "ws_home",
    )).toBe("/workspaces/ws_home/inventory/items/item_flour");
    expect(workspaceReturnTo(
      "/?workspace=ws_home&container=loc_bin",
      "ws_home",
    )).toBe("/workspaces/ws_home/capture/locations/loc_bin");
    expect(workspaceReturnTo("/workspaces/ws_other/plan", "ws_home"))
      .toBe("/workspaces/ws_home/capture");
    expect(workspaceReturnTo("//attacker.test/workspaces/ws_home/plan", "ws_home"))
      .toBe("/workspaces/ws_home/capture");
  });

  it("keeps raw invitation tokens out of persisted OAuth return state", () => {
    expect(oauthReturnTo("/workspaces/ws_home/settings"))
      .toBe("/workspaces/ws_home/settings");
    expect(oauthReturnTo("/guest/raw_invite?returnTo=%2Fworkspaces"))
      .toBe(INVITATION_OAUTH_RESUME_PATH);
    expect(oauthReturnTo(
      "/account?returnTo=%252Fguest%252Fraw_invite",
    )).toBe(INVITATION_OAUTH_RESUME_PATH);
    expect(oauthReturnTo(
      "/guest#token=raw_invite&returnTo=%2Fworkspaces",
    )).toBe(INVITATION_OAUTH_RESUME_PATH);
    let deeplyEncodedInvitation = "/guest#token=raw_invite";
    for (let pass = 0; pass < 12; pass += 1) {
      deeplyEncodedInvitation = encodeURIComponent(
        deeplyEncodedInvitation,
      );
    }
    expect(oauthReturnTo(
      `/account?returnTo=${deeplyEncodedInvitation}`,
    )).toBe(INVITATION_OAUTH_RESUME_PATH);
    expect(oauthReturnTo("//attacker.test/guest/raw_invite")).toBe("/");
  });

  it("keeps new invitation credentials in a fixed-path fragment", () => {
    const token = "raw_invite_secret";
    const invitation = new URL(guestInvitationUrl(
      "https://stowplan.test/api/workspaces/ws_home/guest-links",
      token,
      "/workspaces/ws_home/settings",
    ));

    expect(invitation.pathname).toBe("/guest");
    expect(invitation.search).toBe("");
    expect(invitation.href.slice(0, invitation.href.indexOf("#")))
      .not.toContain(token);
    expect(parseGuestInvitationFragment(invitation.hash)).toEqual({
      returnTo: "/workspaces/ws_home/settings",
      token,
    });
    expect(parseGuestInvitationFragment("#token=one&token=two")).toBeNull();
    expect(parseGuestInvitationFragment("#returnTo=%2Fworkspaces")).toBeNull();
    const oversizedReturn = "x".repeat(
      GUEST_INVITATION_RETURN_TO_MAX_CHARACTERS + 1,
    );
    expect(parseGuestInvitationFragment(
      `#token=raw&returnTo=${oversizedReturn}`,
    )).toBeNull();
    expect(() => guestInvitationUrl(
      "https://stowplan.test",
      "raw",
      oversizedReturn,
    )).toThrow("Invitation URL is invalid");
  });
});
