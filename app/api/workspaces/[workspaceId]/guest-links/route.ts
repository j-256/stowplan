import { guestInvitationUrl } from "../../../../../src/domain/app-url";
import { accountScopedJson } from "../../../../../src/server/account-context";
import {
  createWorkspaceGuestLink,
  listWorkspaceGuestLinks,
  readWorkspaceAccessBody,
  requireWorkspacePrincipal,
  workspaceAccessErrorResponse,
} from "../../../../../src/server/workspace-access";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request);
    const result = await listWorkspaceGuestLinks(
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const principal = await requireWorkspacePrincipal(request, true);
    const body = await readWorkspaceAccessBody(request);
    const result = await createWorkspaceGuestLink(
      principal.database,
      (await params).workspaceId,
      principal.user.userId,
      body,
    );
    const oneTimeUrl = guestInvitationUrl(
      principal.baseUrl,
      result.raw,
      result.returnTo,
    );
    return accountScopedJson(
      {
        accessRevision: result.accessRevision,
        guestLink: result.guestLink,
        oneTimeUrl,
      },
      principal.user.userId,
      { status: 201 },
    );
  } catch (error) {
    return workspaceAccessErrorResponse(error);
  }
}
