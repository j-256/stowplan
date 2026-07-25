import { accountScopedJson } from "../../../src/server/account-context";
import {
  listMemberWorkspaces,
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../src/server/workspace-access";

export async function GET(request: Request) {
  try {
    const principal = await requireWorkspacePrincipal(request);
    const result = await listMemberWorkspaces(
      principal.database,
      principal.user.userId,
      new URL(request.url).searchParams,
    );
    return accountScopedJson(result, principal.user.userId);
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
