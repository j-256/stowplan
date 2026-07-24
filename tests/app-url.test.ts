import { describe, expect, it } from "vitest";
import {
  parseAppUrl,
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
    expect(WORKSPACE_LIST_PATH).toBe("/workspaces");
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

  it("keeps guest and sign-in returns inside the authorized workspace", () => {
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
});
