import { accountScopedJson } from "../../../../../src/server/account-context";
import {
  listWorkspaceMembers,
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../../src/server/workspace-access";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request);
    const result = await listWorkspaceMembers(
      principal.database,
      (await params).workspaceId,
      principal.user.userId,
      new URL(request.url).searchParams,
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
