import { accountScopedJson } from "../../../../../../src/server/account-context";
import {
  changeWorkspaceMemberRole,
  readWorkspaceAccessBody,
  removeWorkspaceMember,
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../../../src/server/workspace-access";

interface RouteParams {
  userId: string;
  workspaceId: string;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<RouteParams> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const route = await params;
    const result = await changeWorkspaceMemberRole(
      principal.database,
      route.workspaceId,
      principal.user.userId,
      route.userId,
      body,
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<RouteParams> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const route = await params;
    const result = await removeWorkspaceMember(
      principal.database,
      route.workspaceId,
      principal.user.userId,
      route.userId,
      body,
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
