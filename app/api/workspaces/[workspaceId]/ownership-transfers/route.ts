import { accountScopedJson } from "../../../../../src/server/account-context";
import {
  readWorkspaceAccessBody,
  requireWorkspacePrincipal,
  transferWorkspaceOwnership,
  workspaceAccessErrorResponse,
} from "../../../../../src/server/workspace-access";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const result = await transferWorkspaceOwnership(
      principal.database,
      (await params).workspaceId,
      principal.user.userId,
      body,
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
