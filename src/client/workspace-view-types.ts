import type {
  Command,
  FieldExpectation,
} from "../domain/types";

export type Commit = (command: Command) => Promise<void>;

export type LocationHierarchyCommand = Extract<
  Command,
  { type: "location.move" | "location.update" }
>;

export type LocationPlacementCommand = Extract<
  Command,
  { type: "location.move" | "location.reorder" }
>;

export type LocationChangeCommand =
  | LocationHierarchyCommand
  | LocationPlacementCommand;

export type DragPayload = { id: string; type: "item" | "location" };
export type DropIntent = "before" | "inside" | "after";
export type DropTarget = {
  id: string | null;
  intent: DropIntent;
  kind: "item" | "location" | "root";
};

export type GuidanceFocus =
  | "item_capacity"
  | "item_details"
  | "space_capacity"
  | "space_suitability";

export type GuidanceTarget = {
  focus?: GuidanceFocus;
  id: string;
  token: number;
  view: "capture" | "inventory" | "spaces";
};

export type TreeEntry = {
  childCount: number;
  depth: number;
  location: import("../domain/types").Location;
};

export type FeedbackDetail = {
  message: string;
  tone: "error" | "info" | "success";
};

export type PendingHierarchyChange = {
  command: LocationHierarchyCommand;
  completedParentIds: string[];
  expectations: FieldExpectation[];
};

export type ItemBulkMoveCommand = Extract<
  Command,
  { type: "item.bulkMove" }
>;

export type PendingItemBulkMove = {
  command: ItemBulkMoveCommand;
  completedLocationIds: string[];
  expectations: FieldExpectation[];
};

export type LocationPlacementResult =
  | {
      command: LocationPlacementCommand;
      destinationParentId: string | null;
    }
  | { error: string };

export type ContainerReview = {
  items: {
    id: string;
    name: string;
    quantity: number;
    unit: string;
  }[];
  locationId: string;
  locationName: string;
};

export type AppliedTheme = "dark" | "light";
