"use client";

import { StowplanProvider } from "./store";
import { WorkspaceApplication } from "./workspace-application";

interface StowplanAppProps {
  directDemo?: boolean;
}

export function StowplanApp({
  directDemo = false,
}: StowplanAppProps) {
  return <StowplanProvider>
    <WorkspaceApplication directDemo={directDemo} />
  </StowplanProvider>;
}
