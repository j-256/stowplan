import { createHash } from "node:crypto";
import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  createEmptyState,
  createItem,
  createLocation,
} from "../../src/domain/factories";
import type { WorkspaceState } from "../../src/domain/types";
import type {
  ServerWorkspaceSummary,
  WorkspaceAccessState,
  WorkspaceRole,
} from "../../src/domain/workspace-access";
import { ACCOUNT_CONTEXT_HEADER } from "../../src/shared/account-context";
import { GUEST_LINK_EXPIRY_HOURS } from "../../src/shared/api-quotas";

const DATABASE_NAME = "stowplan-v1";
const DATABASE_STORE = "records";
const ORIGIN_FALLBACK = "https://localhost:3100";
const SYNTHETIC_TIMESTAMP = "2026-07-25T12:00:00.000Z";
const WORKSPACE_KEY_PREFIX = "workspace:";

export interface StoredBrowserReplica {
  authorization?: WorkspaceAccessState;
  outbox: Array<{
    accountId?: string | null;
    envelope: {
      command: { type: string };
      id: string;
    };
    error?: string;
    status: "blocked" | "pending";
  }>;
  state: WorkspaceState;
  updatedAt: string;
}

export interface SyntheticIdentity {
  displayName: string;
  email: string;
  userId: string;
}

export interface SyntheticWorkspace {
  authorization: WorkspaceAccessState;
  state: WorkspaceState;
  summary: ServerWorkspaceSummary;
}

export interface SyntheticInvite {
  accessRevision: number;
  guestLink: {
    expiresAt: string;
    guestLinkId: string;
    role: "editor" | "viewer";
    status: "active" | "expired" | "revoked" | "used";
  };
  oneTimeUrl: string;
}

export interface SyntheticMember {
  createdAt: string;
  displayName: string;
  email: string | null;
  membershipRevision: number;
  role: WorkspaceRole;
  userId: string;
}

export interface SafeBetaFixture {
  changeMemberRole: (
    context: BrowserContext,
    workspaceId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ) => Promise<{
    accessRevision: number;
    member: SyntheticMember;
  }>;
  createInvite: (
    context: BrowserContext,
    workspaceId: string,
    role: "editor" | "viewer",
    expiresInHours?: number,
    returnTo?: string,
  ) => Promise<SyntheticInvite>;
  createWorkspace: (
    context: BrowserContext,
    label: string,
    name: string,
  ) => Promise<SyntheticWorkspace>;
  identity: (label: string) => {
    email: string;
    name: string;
  };
  listMembers: (
    context: BrowserContext,
    workspaceId: string,
  ) => Promise<{
    accessRevision: number;
    members: SyntheticMember[];
  }>;
  namespace: string;
  origin: string;
  redeemInvite: (
    context: BrowserContext,
    oneTimeUrl: string,
    label: string,
  ) => Promise<SyntheticIdentity>;
  signIn: (
    context: BrowserContext,
    label: string,
  ) => Promise<SyntheticIdentity>;
  workspaceId: (label: string) => string;
}

interface WorkspaceAccessResponse {
  access: WorkspaceAccessState;
  workspace: ServerWorkspaceSummary;
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "").slice(0, 28);
}

function namespaceFor(testInfo: TestInfo): string {
  const seed = [
    testInfo.project.name,
    testInfo.file,
    testInfo.title,
    testInfo.retry,
  ].join(":");
  return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

function originFor(testInfo: TestInfo): string {
  const configured = testInfo.project.use.baseURL;
  return typeof configured === "string" ? configured : ORIGIN_FALLBACK;
}

async function responseJson<T>(
  response: APIResponse,
  expectedStatus: number,
): Promise<T> {
  const text = await response.text();
  if (response.status() !== expectedStatus) {
    throw new Error(
      `API request returned HTTP ${response.status()}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${response.url()} returned unreadable JSON`,
    );
  }
}

async function mutationJson<T>(
  request: APIRequestContext,
  origin: string,
  path: string,
  options: {
    accountId: string;
    data: unknown;
    method?: "delete" | "patch" | "post";
    status?: number;
  },
): Promise<T> {
  const method = options.method ?? "post";
  return responseJson<T>(
    await request[method](`${origin}${path}`, {
      data: options.data,
      headers: {
        [ACCOUNT_CONTEXT_HEADER]: options.accountId,
        origin,
      },
    }),
    options.status ?? 200,
  );
}

async function installSessionCookie(
  context: BrowserContext,
  origin: string,
  response: APIResponse,
): Promise<void> {
  const setCookie = response.headers()["set-cookie"] ?? "";
  const raw = /^__Host-stowplan_session=([^;]+)/u.exec(setCookie)?.[1];
  if (!raw) {
    throw new Error("The authentication response did not set a session");
  }
  const cookieUrl = new URL(origin);
  cookieUrl.protocol = "https:";
  await context.addCookies([{
    httpOnly: true,
    name: "__Host-stowplan_session",
    sameSite: "Lax",
    secure: true,
    url: cookieUrl.toString(),
    value: raw,
  }]);
}

function workspaceState(
  workspaceId: string,
  name: string,
  label: string,
): WorkspaceState {
  const state = createEmptyState(name, SYNTHETIC_TIMESTAMP);
  state.workspace.id = workspaceId;
  const location = createLocation({
    code: `E2E-${label.slice(0, 8).toLocaleUpperCase()}`,
    kind: "shelf",
    name: `${name} shelf`,
  }, SYNTHETIC_TIMESTAMP);
  location.id = `loc_${label}_shelf`;
  location.captureStatus = "in_progress";
  const item = createItem({
    category: "Synthetic",
    locationId: location.id,
    name: `${name} marker`,
    quantity: 2,
    unit: "pieces",
  }, SYNTHETIC_TIMESTAMP);
  item.id = `item_${label}_marker`;
  state.locations = [location];
  state.items = [item];
  return state;
}

async function workspaceAccess(
  context: BrowserContext,
  origin: string,
  workspaceId: string,
): Promise<WorkspaceAccessResponse> {
  return responseJson<WorkspaceAccessResponse>(
    await context.request.get(
      `${origin}/api/workspaces/${encodeURIComponent(workspaceId)}/access`,
    ),
    200,
  );
}

async function resetBrowserStorage(page: Page): Promise<void> {
  await page.goto("/workspaces");
  await page.evaluate((databaseName) => new Promise<void>(
    (resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(
        request.error ?? new Error("Could not delete the local test database"),
      );
      request.onblocked = () => reject(
        new Error("The local test database remained open during reset"),
      );
    },
  ), DATABASE_NAME);
  await page.reload();
}

export async function readLocalReplicas(
  page: Page,
): Promise<Record<string, StoredBrowserReplica>> {
  return page.evaluate(
    ({ databaseName, storeName, workspacePrefix }) =>
      new Promise<Record<string, StoredBrowserReplica>>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 1);
        open.onerror = () => reject(open.error);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains(storeName)) {
            open.result.createObjectStore(storeName);
          }
        };
        open.onsuccess = () => {
          const result: Record<string, StoredBrowserReplica> = {};
          const transaction = open.result.transaction(storeName);
          const cursorRequest = transaction.objectStore(storeName).openCursor();
          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              open.result.close();
              resolve(result);
              return;
            }
            const key = typeof cursor.key === "string" ? cursor.key : "";
            const replica = cursor.value as StoredBrowserReplica | undefined;
            if (
              key.startsWith(workspacePrefix) &&
              replica?.state?.workspace?.id
            ) {
              result[replica.state.workspace.id] = replica;
            } else if (
              key === "active" &&
              replica?.state?.workspace?.id &&
              !result[replica.state.workspace.id]
            ) {
              result[replica.state.workspace.id] = replica;
            }
            cursor.continue();
          };
        };
      }),
    {
      databaseName: DATABASE_NAME,
      storeName: DATABASE_STORE,
      workspacePrefix: WORKSPACE_KEY_PREFIX,
    },
  );
}

export async function readActiveReplica(
  page: Page,
): Promise<StoredBrowserReplica | null> {
  return page.evaluate(
    ({ databaseName, storeName }) =>
      new Promise<StoredBrowserReplica | null>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(storeName)
            .objectStore(storeName).get("active");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            open.result.close();
            resolve(
              (request.result as StoredBrowserReplica | undefined) ?? null,
            );
          };
        };
      }),
    { databaseName: DATABASE_NAME, storeName: DATABASE_STORE },
  );
}

// `keyboard.press` resolves once the key event is dispatched, not once the
// browser has moved focus. Reading activeElement immediately after can therefore
// still observe the pre-Tab element, so the walk tabs past its target and a later
// keypress lands on the wrong control -- a race that only appears when the
// browser is contended.
//
// Focus staying put is not a stop condition: a radio group is a single tab stop,
// so Tab legitimately leaves activeElement unchanged while walking through it.
// Only that ambiguous case waits, so an unimpeded walk costs nothing
const FOCUS_SETTLE_TIMEOUT_MS = 2000;

export async function tabTo(
  page: Page,
  target: Locator,
  maximumTabs = 80,
): Promise<void> {
  // Node identity, not markup: repeated controls can be structurally identical
  const activeElementHandle = () =>
    page.evaluateHandle(() => document.activeElement);
  const focused = () =>
    target.evaluate((element) => element === document.activeElement);
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await focused()) return;
    const before = await activeElementHandle();
    await page.keyboard.press("Tab");
    const moved = await page.evaluate(
      (previous) => document.activeElement !== previous,
      before,
    );
    await before.dispose();
    if (moved) continue;
    // Either focus has not caught up yet or this is one tab stop spanning
    // several controls, such as a radio group. Give the target a settle window;
    // if it is genuinely elsewhere, keep walking rather than failing here
    try {
      await expect(target).toBeFocused({ timeout: FOCUS_SETTLE_TIMEOUT_MS });
      return;
    } catch {
      continue;
    }
  }
  await expect(target).toBeFocused();
}

export const test = base.extend<{ safeBeta: SafeBetaFixture }>({
  safeBeta: async ({ page }, provide, testInfo) => {
    await resetBrowserStorage(page);
    const namespace = namespaceFor(testInfo);
    const origin = originFor(testInfo);
    const accountIds = new WeakMap<BrowserContext, string>();
    const workspaceId = (label: string) =>
      `ws_e2e_${namespace}_${slug(label)}`;
    const identity = (label: string) => ({
      email: `${namespace}-${slug(label)}@example.test`,
      name: `E2E ${label} ${namespace}`,
    });
    const signIn = async (
      context: BrowserContext,
      label: string,
    ): Promise<SyntheticIdentity> => {
      const account = identity(label);
      const response = await context.request.post(`${origin}/api/auth/dev`, {
        data: account,
        headers: { origin },
      });
      const body = await responseJson<{ user: SyntheticIdentity }>(
        response,
        200,
      );
      await installSessionCookie(context, origin, response);
      await context.setExtraHTTPHeaders({
        [ACCOUNT_CONTEXT_HEADER]: body.user.userId,
      });
      accountIds.set(context, body.user.userId);
      return body.user;
    };
    const accountIdFor = async (
      context: BrowserContext,
    ): Promise<string> => {
      const known = accountIds.get(context);
      if (known) return known;
      const body = await responseJson<{
        user: SyntheticIdentity | null;
      }>(
        await context.request.get(`${origin}/api/auth/me`),
        200,
      );
      if (!body.user) {
        throw new Error("Synthetic mutation requires a signed-in account");
      }
      accountIds.set(context, body.user.userId);
      return body.user.userId;
    };
    const createWorkspace = async (
      context: BrowserContext,
      label: string,
      name: string,
    ): Promise<SyntheticWorkspace> => {
      const id = workspaceId(label);
      const state = workspaceState(id, name, `${namespace}_${slug(label)}`);
      const body = await mutationJson<{
        authorization: WorkspaceAccessState;
        state: WorkspaceState;
        workspace: ServerWorkspaceSummary;
      }>(
        context.request,
        origin,
        "/api/sync",
        {
          accountId: await accountIdFor(context),
          data: { commands: [], snapshot: state, workspaceId: id },
        },
      );
      return {
        authorization: body.authorization,
        state: body.state,
        summary: body.workspace,
      };
    };
    const createInvite = async (
      context: BrowserContext,
      workspaceIdValue: string,
      role: "editor" | "viewer",
      expiresInHours: number = GUEST_LINK_EXPIRY_HOURS.default,
      returnTo = `/workspaces/${workspaceIdValue}/capture`,
    ): Promise<SyntheticInvite> => {
      const access = await workspaceAccess(
        context,
        origin,
        workspaceIdValue,
      );
      return mutationJson<SyntheticInvite>(
        context.request,
        origin,
        `/api/workspaces/${encodeURIComponent(workspaceIdValue)}/guest-links`,
        {
          accountId: await accountIdFor(context),
          data: {
            expectedAccessRevision: access.access.accessRevision,
            expiresInHours,
            returnTo,
            role,
          },
          status: 201,
        },
      );
    };
    const redeemInvite = async (
      context: BrowserContext,
      oneTimeUrl: string,
      label: string,
    ): Promise<SyntheticIdentity> => {
      const invite = new URL(oneTimeUrl);
      const fragment = new URLSearchParams(invite.hash.slice(1));
      const token = fragment.get("token") ?? "";
      const returnTo = fragment.get("returnTo") ?? "/workspaces";
      const user = await signIn(context, label);
      const response = await context.request.post(
        `${origin}/api/auth/guest`,
        {
          data: {
            expectedAccountId: user.userId,
            returnTo,
            token,
          },
          headers: {
            [ACCOUNT_CONTEXT_HEADER]: user.userId,
            origin,
          },
          maxRedirects: 0,
        },
      );
      if (response.status() !== 200) {
        throw new Error(
          `Invite redemption returned HTTP ${response.status()}`,
        );
      }
      const me = await responseJson<{
        user: SyntheticIdentity | null;
      }>(
        await context.request.get(`${origin}/api/auth/me`),
        200,
      );
      if (!me.user) {
        throw new Error("Invite redemption did not preserve the session");
      }
      if (me.user.userId !== user.userId) {
        throw new Error("Invite redemption replaced the signed-in account");
      }
      return user;
    };
    const listMembers = async (
      context: BrowserContext,
      workspaceIdValue: string,
    ) => responseJson<{
      accessRevision: number;
      members: SyntheticMember[];
    }>(
      await context.request.get(
        `${origin}/api/workspaces/${encodeURIComponent(workspaceIdValue)}/members`,
      ),
      200,
    );
    const changeMemberRole = async (
      context: BrowserContext,
      workspaceIdValue: string,
      targetUserId: string,
      role: WorkspaceRole,
    ) => {
      const result = await listMembers(context, workspaceIdValue);
      const target = result.members.find(
        member => member.userId === targetUserId,
      );
      if (!target) throw new Error("Synthetic workspace member was not found");
      return mutationJson<{
        accessRevision: number;
        member: SyntheticMember;
      }>(
        context.request,
        origin,
        `/api/workspaces/${encodeURIComponent(workspaceIdValue)}/members/${encodeURIComponent(targetUserId)}`,
        {
          accountId: await accountIdFor(context),
          data: {
            expectedAccessRevision: result.accessRevision,
            expectedMembershipRevision: target.membershipRevision,
            role,
          },
          method: "patch",
        },
      );
    };
    await provide({
      changeMemberRole,
      createInvite,
      createWorkspace,
      identity,
      listMembers,
      namespace,
      origin,
      redeemInvite,
      signIn,
      workspaceId,
    });
  },
});

export { expect };
