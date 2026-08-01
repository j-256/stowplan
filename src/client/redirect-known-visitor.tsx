"use client";

import { useEffect } from "react";
import { WORKSPACE_LIST_PATH } from "../domain/app-url";
import {
  listWorkspaceReplicas,
  readActiveServerWorkspaceCatalogAccount,
} from "./local-replica";
import { hasWelcomeBypass } from "./landing-bypass";
import { classifyVisitor, VISITOR_KIND } from "./visitor-classification";

export default function RedirectKnownVisitor(): null {
  useEffect(() => {
    if (hasWelcomeBypass(location.search)) return;
    let cancelled = false;
    void (async () => {
      // Two fast local reads, no network. Either failing means we cannot
      // prove the visitor is known, so we leave them on the rendered hero
      const [workspaces, rememberedAccount] = await Promise.all([
        listWorkspaceReplicas().catch(() => []),
        readActiveServerWorkspaceCatalogAccount().catch(() => null),
      ]);
      if (cancelled) return;
      const kind = classifyVisitor({
        bypass: false,
        hasLocalWorkspaces: workspaces.length > 0,
        hasRememberedAccount: rememberedAccount !== null,
      });
      if (kind === VISITOR_KIND.KNOWN) location.replace(WORKSPACE_LIST_PATH);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
