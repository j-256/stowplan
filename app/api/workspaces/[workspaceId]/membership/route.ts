import { accountScopedJson } from "../../../../../src/server/account-context";
import { notifyWorkspaceChange } from "../../../../../src/server/live-notifications";
import {
  leaveWorkspace,
  readWorkspaceAccessBody,
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../../src/server/workspace-access";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const workspaceId = (await params).workspaceId;
    const result = await leaveWorkspace(
      principal.database,
      workspaceId,
      principal.user.userId,
      body,
    );
    await notifyWorkspaceChange(
      principal.database,
      workspaceId,
      { force: true },
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
