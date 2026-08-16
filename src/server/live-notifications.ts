import type { D1DatabaseLike } from "../adapters/d1-snapshot-store";
import {
  LIVE_PROTOCOL_VERSION,
  LIVE_CONNECTION_ID_HEADER,
  type LiveNotification,
  type LiveWireMessage,
  LIVE_RELAY_SIGNATURE_HEADER,
  LIVE_RELAY_TIMESTAMP_HEADER,
  normalizeLiveConnectionId,
  parseLiveNotification,
  signLiveRelayRequest,
} from "../shared/live-collaboration";
import { runtimeEnv } from "./runtime";

export {
  LIVE_CONNECTION_ID_HEADER,
  LIVE_RELAY_SIGNATURE_HEADER,
  LIVE_RELAY_TIMESTAMP_HEADER,
} from "../shared/live-collaboration";
const LOCAL_LIVE_HUB_KEY = "__STOWPLAN_LOCAL_LIVE_HUB";
export const LIVE_RELAY_PUBLISH_TIMEOUT_MS = 2_000;

export interface LiveNotificationState {
  accessRevision: number;
  allowedUserIds: string[];
  revision: number;
  workspaceId: string;
}

export interface LiveNotificationEnvironment {
  LIVE_RELAY_SECRET?: string;
  LIVE_RELAY_URL?: string;
  STOWPLAN_LIVE_LOCAL_ENABLED?: string;
}

export interface LiveNotificationResult {
  status: "delivered" | "failed" | "unavailable" | "unchanged";
}

export interface LocalLiveSubscriptionInput {
  accessRevision: number;
  connectionId: string;
  userId: string;
  workspaceId: string;
}

export interface LocalLiveSubscriptionHandlers {
  close(): void;
  send(message: LiveWireMessage): void;
}

interface LocalLiveSubscriber extends LocalLiveSubscriptionInput {
  handlers: LocalLiveSubscriptionHandlers;
}

interface LocalLiveHub {
  subscribers: Map<string, Set<LocalLiveSubscriber>>;
}

interface NotificationRow {
  access_revision: number;
  revision: number;
  user_id: string;
}

interface PublishWorkspaceChangeOptions {
  deleted?: {
    accessRevision: number;
    revision: number;
  };
  environment?: LiveNotificationEnvironment;
  fetcher?: typeof fetch;
  force?: boolean;
  previousRevision?: number;
  sourceConnectionId?: string | null;
}

type LiveTransport =
  | { kind: "local" }
  | { kind: "remote"; secret: string; url: URL }
  | { kind: "unavailable" };

function localLiveHub(): LocalLiveHub {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [LOCAL_LIVE_HUB_KEY]?: LocalLiveHub;
  };
  runtimeGlobal[LOCAL_LIVE_HUB_KEY] ??= {
    subscribers: new Map(),
  };
  return runtimeGlobal[LOCAL_LIVE_HUB_KEY];
}

function safeRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function liveConnectionIdFromRequest(
  request: Request,
): string | null {
  return normalizeLiveConnectionId(
    request.headers.get(LIVE_CONNECTION_ID_HEADER),
  );
}

export function liveRelayBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LIVE_RELAY_URL must be a valid absolute URL");
  }
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "LIVE_RELAY_URL must be an HTTPS origin or a local HTTP origin",
    );
  }
  url.pathname = "/";
  return url;
}

export function liveTransport(
  environment: LiveNotificationEnvironment,
): LiveTransport {
  const relayUrl = environment.LIVE_RELAY_URL?.trim();
  const relaySecret = environment.LIVE_RELAY_SECRET?.trim();
  if (relayUrl || relaySecret) {
    if (!relayUrl || !relaySecret) {
      throw new Error(
        "LIVE_RELAY_URL and LIVE_RELAY_SECRET must be configured together",
      );
    }
    return {
      kind: "remote",
      secret: relaySecret,
      url: liveRelayBaseUrl(relayUrl),
    };
  }
  if (environment.STOWPLAN_LIVE_LOCAL_ENABLED === "true") {
    return { kind: "local" };
  }
  return { kind: "unavailable" };
}

export async function loadLiveNotificationState(
  database: D1DatabaseLike,
  workspaceId: string,
): Promise<LiveNotificationState | null> {
  const result = await database.prepare(
    `SELECT snapshot.revision,
            snapshot.access_revision,
            member.user_id
     FROM workspace_snapshots snapshot
     JOIN workspace_members member
       ON member.workspace_id = snapshot.workspace_id
     JOIN users account
       ON account.user_id = member.user_id
      AND account.status = 'active'
      AND account.deleted_at IS NULL
     WHERE snapshot.workspace_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_deletions deleted
         WHERE deleted.workspace_id = snapshot.workspace_id
       )
     ORDER BY member.user_id`,
  ).bind(workspaceId).all<NotificationRow>();
  if (!result.success) {
    throw new Error("Live workspace notification state could not be loaded");
  }
  const first = result.results[0];
  if (!first) return null;
  const revision = safeRevision(first.revision, "Workspace revision");
  const accessRevision = safeRevision(
    first.access_revision,
    "Workspace access revision",
  );
  const allowedUserIds = result.results.map((row) => {
    if (
      row.revision !== revision ||
      row.access_revision !== accessRevision ||
      typeof row.user_id !== "string" ||
      !row.user_id
    ) {
      throw new Error("Live workspace notification state is inconsistent");
    }
    return row.user_id;
  });
  return {
    accessRevision,
    allowedUserIds,
    revision,
    workspaceId,
  };
}

function wireMessage(
  notification: LiveNotification,
  type: LiveWireMessage["type"],
): LiveWireMessage {
  return {
    accessRevision: notification.accessRevision,
    revision: notification.revision,
    type,
    version: LIVE_PROTOCOL_VERSION,
  };
}

function publishLocally(notification: LiveNotification): void {
  const subscriptions = localLiveHub().subscribers.get(
    notification.workspaceId,
  );
  if (!subscriptions) return;
  const allowed = new Set(notification.allowedUserIds);
  for (const subscription of [...subscriptions]) {
    if (notification.deleted) {
      subscription.handlers.send(wireMessage(notification, "deleted"));
      subscription.handlers.close();
      subscriptions.delete(subscription);
      continue;
    }
    if (!allowed.has(subscription.userId)) {
      subscription.handlers.send(wireMessage(notification, "access"));
      subscription.handlers.close();
      subscriptions.delete(subscription);
      continue;
    }
    const accessChanged =
      notification.accessRevision > subscription.accessRevision;
    subscription.accessRevision = Math.max(
      subscription.accessRevision,
      notification.accessRevision,
    );
    if (
      !accessChanged &&
      notification.sourceConnectionId === subscription.connectionId
    ) {
      continue;
    }
    subscription.handlers.send(wireMessage(
      notification,
      accessChanged ? "access" : "change",
    ));
  }
  if (subscriptions.size === 0) {
    localLiveHub().subscribers.delete(notification.workspaceId);
  }
}

export function subscribeLocalLiveWorkspace(
  input: LocalLiveSubscriptionInput,
  handlers: LocalLiveSubscriptionHandlers,
): () => void {
  const connectionId = normalizeLiveConnectionId(input.connectionId);
  if (!connectionId || !input.userId || !input.workspaceId) {
    throw new Error("Local live subscription identity is invalid");
  }
  const subscriber: LocalLiveSubscriber = {
    ...input,
    accessRevision: safeRevision(
      input.accessRevision,
      "Workspace access revision",
    ),
    connectionId,
    handlers,
  };
  const hub = localLiveHub();
  const subscriptions = hub.subscribers.get(input.workspaceId) ?? new Set();
  subscriptions.add(subscriber);
  hub.subscribers.set(input.workspaceId, subscriptions);
  return () => {
    subscriptions.delete(subscriber);
    if (subscriptions.size === 0) {
      hub.subscribers.delete(input.workspaceId);
    }
  };
}

async function publishRemotely(
  notification: LiveNotification,
  transport: Extract<LiveTransport, { kind: "remote" }>,
  fetcher: typeof fetch,
): Promise<void> {
  const body = JSON.stringify(notification);
  const timestamp = String(Date.now());
  const signature = await signLiveRelayRequest(
    body,
    timestamp,
    transport.secret,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    LIVE_RELAY_PUBLISH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetcher(
      new URL("/v1/publish", transport.url),
      {
        body,
        headers: {
          "content-type": "application/json",
          [LIVE_RELAY_SIGNATURE_HEADER]: signature,
          [LIVE_RELAY_TIMESTAMP_HEADER]: timestamp,
        },
        method: "POST",
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Live relay publish failed (${response.status})`);
  }
}

export async function notifyWorkspaceChange(
  database: D1DatabaseLike,
  workspaceId: string,
  options: PublishWorkspaceChangeOptions = {},
): Promise<LiveNotificationResult> {
  try {
    const environment = options.environment ?? await runtimeEnv();
    const transport = liveTransport(environment);
    if (transport.kind === "unavailable") {
      return { status: "unavailable" };
    }
    const state = options.deleted
      ? {
          accessRevision: safeRevision(
            options.deleted.accessRevision,
            "Workspace access revision",
          ),
          allowedUserIds: [],
          revision: safeRevision(
            options.deleted.revision,
            "Workspace revision",
          ),
          workspaceId,
        }
      : await loadLiveNotificationState(database, workspaceId);
    if (!state) return { status: "unavailable" };
    if (
      !options.force &&
      options.previousRevision !== undefined &&
      state.revision <= options.previousRevision
    ) {
      return { status: "unchanged" };
    }
    const sourceConnectionId = normalizeLiveConnectionId(
      options.sourceConnectionId,
    );
    const notification = parseLiveNotification({
      ...state,
      deleted: Boolean(options.deleted),
      ...(sourceConnectionId ? { sourceConnectionId } : {}),
      type: "workspace-change",
      version: LIVE_PROTOCOL_VERSION,
    });
    if (transport.kind === "local") {
      publishLocally(notification);
    } else {
      await publishRemotely(
        notification,
        transport,
        options.fetcher ?? fetch,
      );
    }
    return { status: "delivered" };
  } catch {
    return { status: "failed" };
  }
}

export async function notifyWorkspaceChanges(
  database: D1DatabaseLike,
  workspaceIds: readonly string[],
  options: PublishWorkspaceChangeOptions = {},
): Promise<LiveNotificationResult[]> {
  const uniqueWorkspaceIds = [...new Set(
    workspaceIds.filter(workspaceId => workspaceId.length > 0),
  )];
  if (uniqueWorkspaceIds.length === 0) return [];
  const environment = options.environment ?? await runtimeEnv();
  return Promise.all(uniqueWorkspaceIds.map(workspaceId =>
    notifyWorkspaceChange(database, workspaceId, {
      ...options,
      environment,
    })
  ));
}
