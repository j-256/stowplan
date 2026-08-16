import { accountScopedJson } from "../../../../src/server/account-context";
import { notifyWorkspaceChange } from "../../../../src/server/live-notifications";
import {
  deleteServerWorkspace,
  readWorkspaceAccessBody,
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../src/server/workspace-access";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const workspaceId = (await params).workspaceId;
    const result = await deleteServerWorkspace(
      principal.database,
      workspaceId,
      principal.user.userId,
      body,
    );
    await notifyWorkspaceChange(principal.database, workspaceId, {
      deleted: {
        accessRevision: result.finalAccessRevision,
        revision: result.finalSnapshotRevision,
      },
    });
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
