export const STOWPLAN_HISTORY_EVENT = "stowplan:history-pop";
export const STOWPLAN_HISTORY_OWNER_ATTRIBUTE =
  "data-stowplan-history-owner";

const STOWPLAN_WORKSPACE_ROUTE_PREFIX = "/workspaces";

export const STOWPLAN_HISTORY_BRIDGE_SCRIPT = [
  'addEventListener("popstate",function(event){',
  "var path=location.pathname;",
  "var appRoute=path==='/'||",
  `path===${
    JSON.stringify(STOWPLAN_WORKSPACE_ROUTE_PREFIX)
  }||path.startsWith(${
    JSON.stringify(`${STOWPLAN_WORKSPACE_ROUTE_PREFIX}/`)
  });`,
  "if(appRoute&&event.state&&event.state.stowplan===true&&",
  `document.documentElement.hasAttribute(${
    JSON.stringify(STOWPLAN_HISTORY_OWNER_ATTRIBUTE)
  })){`,
  "event.stopImmediatePropagation();",
  `dispatchEvent(new Event(${JSON.stringify(STOWPLAN_HISTORY_EVENT)}));`,
  "}",
  "},true);",
].join("");
