import { accountScopedJson } from "../../../../../../src/server/account-context";
import { notifyWorkspaceChange } from "../../../../../../src/server/live-notifications";
import {
  readWorkspaceAccessBody,
  requireWorkspacePrincipal,
  revokeWorkspaceGuestLink,
  workspaceAccessErrorResponse,
} from "../../../../../../src/server/workspace-access";

interface RouteParams {
  guestLinkId: string;
  workspaceId: string;
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<RouteParams> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const route = await params;
    const result = await revokeWorkspaceGuestLink(
      principal.database,
      route.workspaceId,
      principal.user.userId,
      route.guestLinkId,
      body,
    );
    await notifyWorkspaceChange(
      principal.database,
      route.workspaceId,
      { force: true },
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
