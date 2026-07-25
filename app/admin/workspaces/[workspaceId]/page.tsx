import type { Metadata } from "next";
import { AdminWorkspaceInspector } from "../../../../src/client/admin-workspace-inspector";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Workspace inspection · Stowplan administration",
};

export default async function AdminWorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <AdminWorkspaceInspector workspaceId={workspaceId} />;
}
