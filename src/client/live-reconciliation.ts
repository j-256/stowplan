import {
  ACCOUNT_CONTEXT_HEADER,
  accountContextHeaders,
} from "../shared/account-context";
import {
  LIVE_PROTOCOL_VERSION,
  LIVE_SUBPROTOCOL,
  parseLiveWireMessage,
  type LiveWireMessage,
} from "../shared/live-collaboration";
import { parseRetryAfter } from "./sync-scheduling";

export const LIVE_NOTIFICATION_COALESCE_MS = 40;
export const LIVE_RECONNECT_BASE_MS = 1_000;
export const LIVE_RECONNECT_MAXIMUM_MS = 60_000;
export const LIVE_RECONNECT_STABLE_MS = 30_000;

type LiveCapability = {
  accessRevision: number;
  revision: number;
} & (
  | { transport: "unavailable" }
  | { endpoint: string; transport: "sse" }
  | {
      endpoint: string;
      protocols: string[];
      transport: "websocket";
    }
);

interface LiveSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
}

interface LiveConnectionErrorOptions {
  kind: "access" | "account" | "authentication" | "retry";
  retryAfterMs?: number | null;
}

class LiveConnectionError extends Error {
  readonly kind: LiveConnectionErrorOptions["kind"];
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: LiveConnectionErrorOptions,
  ) {
    super(message);
    this.name = "LiveConnectionError";
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface LiveWorkspaceConnectionOptions {
  accessRevision: number;
  accountId: string;
  connectionId: string;
  fetcher?: typeof fetch;
  isOnline?: () => boolean;
  onAccessLost(): void;
  onAccountMismatch(): void;
  onAuthenticationRequired(): void;
  onMessage(message: LiveWireMessage): void;
  random?: () => number;
  revision: number;
  socketFactory?: (endpoint: string, protocols: string[]) => LiveSocket;
  workspaceId: string;
}

export interface LiveWorkspaceConnection {
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" &&
    !Array.isArray(value);
}

function safeRevision(value: unknown): number | null {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : null;
}

export function parseLiveCapability(value: unknown): LiveCapability {
  if (!isRecord(value)) {
    throw new Error("Live collaboration capability is invalid");
  }
  const accessRevision = safeRevision(value.accessRevision);
  const revision = safeRevision(value.revision);
  if (accessRevision === null || revision === null) {
    throw new Error("Live collaboration capability revisions are invalid");
  }
  if (value.transport === "unavailable") {
    return { accessRevision, revision, transport: "unavailable" };
  }
  if (
    value.transport === "sse" &&
    typeof value.endpoint === "string" &&
    value.endpoint.startsWith("/api/live/events?")
  ) {
    return {
      accessRevision,
      endpoint: value.endpoint,
      revision,
      transport: "sse",
    };
  }
  if (
    value.transport === "websocket" &&
    typeof value.endpoint === "string" &&
    Array.isArray(value.protocols) &&
    value.protocols.length === 2 &&
    value.protocols.every(protocol =>
      typeof protocol === "string" && protocol.length > 0
    ) &&
    value.protocols[0] === LIVE_SUBPROTOCOL
  ) {
    let endpoint: URL;
    try {
      endpoint = new URL(value.endpoint);
    } catch {
      throw new Error("Live collaboration WebSocket endpoint is invalid");
    }
    if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") {
      throw new Error("Live collaboration WebSocket endpoint is invalid");
    }
    return {
      accessRevision,
      endpoint: endpoint.toString(),
      protocols: value.protocols as string[],
      revision,
      transport: "websocket",
    };
  }
  throw new Error("Live collaboration capability transport is invalid");
}

export function liveReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(
    0,
    Math.min(30, Math.floor(Number.isFinite(attempt) ? attempt : 0)),
  );
  const ceiling = Math.min(
    LIVE_RECONNECT_MAXIMUM_MS,
    LIVE_RECONNECT_BASE_MS * 2 ** boundedAttempt,
  );
  const fraction = Math.min(1, Math.max(0, random()));
  return Math.floor(ceiling / 2 + fraction * ceiling / 2);
}

export function createLiveConnectionId(): string {
  return `live_${crypto.randomUUID()}`;
}

function messagePriority(type: LiveWireMessage["type"]): number {
  if (type === "deleted") return 4;
  if (type === "access") return 3;
  if (type === "change") return 2;
  return 1;
}

function mergedMessage(
  left: LiveWireMessage,
  right: LiveWireMessage,
): LiveWireMessage {
  return {
    accessRevision: Math.max(
      left.accessRevision,
      right.accessRevision,
    ),
    revision: Math.max(left.revision, right.revision),
    type: messagePriority(right.type) > messagePriority(left.type)
      ? right.type
      : left.type,
    version: LIVE_PROTOCOL_VERSION,
  };
}

async function responseProblem(response: Response): Promise<{
  code: string | null;
  message: string;
}> {
  const body = await response.clone().json().catch(() => null) as unknown;
  return {
    code: isRecord(body) && typeof body.code === "string"
      ? body.code
      : null,
    message: isRecord(body) && typeof body.error === "string"
      ? body.error
      : `Live collaboration request failed (${response.status})`,
  };
}

async function requireLiveResponse(
  response: Response,
  accountId: string,
): Promise<void> {
  const responseAccountId = response.headers.get(ACCOUNT_CONTEXT_HEADER);
  if (
    (response.ok && responseAccountId !== accountId) ||
    (responseAccountId !== null && responseAccountId !== accountId)
  ) {
    throw new LiveConnectionError(
      "The signed-in account changed while live collaboration connected",
      { kind: "account" },
    );
  }
  if (response.ok) return;
  const problem = await responseProblem(response);
  if (
    response.status === 409 &&
    problem.code === "ACCOUNT_CONTEXT_CHANGED"
  ) {
    throw new LiveConnectionError(problem.message, { kind: "account" });
  }
  if (response.status === 401) {
    throw new LiveConnectionError(problem.message, {
      kind: "authentication",
    });
  }
  if (
    response.status === 403 ||
    response.status === 404 ||
    response.status === 410
  ) {
    throw new LiveConnectionError(problem.message, { kind: "access" });
  }
  throw new LiveConnectionError(problem.message, {
    kind: "retry",
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
  });
}

async function consumeLiveEventStream(
  response: Response,
  onMessage: (message: LiveWireMessage) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("Live collaboration response has no event stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = () => {
    buffer = buffer.replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        onMessage(parseLiveWireMessage(JSON.parse(data) as unknown));
      }
      boundary = buffer.indexOf("\n\n");
    }
  };
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    consume();
  }
  buffer += decoder.decode();
  consume();
}

export function startLiveWorkspaceConnection(
  options: LiveWorkspaceConnectionOptions,
): LiveWorkspaceConnection {
  const fetcher = options.fetcher ?? fetch;
  const isOnline = options.isOnline ?? (() =>
    typeof navigator === "undefined" || navigator.onLine !== false
  );
  const random = options.random ?? Math.random;
  const socketFactory = options.socketFactory ?? (
    (endpoint, protocols) =>
      new WebSocket(endpoint, protocols) as unknown as LiveSocket
  );
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingMessage: LiveWireMessage | null = null;
  let activeAbort: AbortController | null = null;
  let activeSocket: LiveSocket | null = null;
  let observedAccessRevision = options.accessRevision;
  let observedRevision = options.revision;

  const clearReconnectStability = () => {
    if (reconnectStabilityTimer) {
      clearTimeout(reconnectStabilityTimer);
      reconnectStabilityTimer = null;
    }
  };

  const startReconnectStability = () => {
    clearReconnectStability();
    reconnectStabilityTimer = setTimeout(() => {
      reconnectStabilityTimer = null;
      reconnectAttempt = 0;
    }, LIVE_RECONNECT_STABLE_MS);
  };

  const flushPendingMessage = () => {
    notificationTimer = null;
    const message = pendingMessage;
    pendingMessage = null;
    if (!stopped && message) options.onMessage(message);
  };

  const receiveMessage = (message: LiveWireMessage) => {
    if (stopped) return;
    const accessAdvanced =
      message.accessRevision > observedAccessRevision;
    const revisionAdvanced = message.revision > observedRevision;
    if (
      message.type !== "deleted" &&
      !accessAdvanced &&
      !revisionAdvanced
    ) {
      return;
    }
    observedAccessRevision = Math.max(
      observedAccessRevision,
      message.accessRevision,
    );
    observedRevision = Math.max(observedRevision, message.revision);
    pendingMessage = pendingMessage
      ? mergedMessage(pendingMessage, message)
      : message;
    if (!notificationTimer) {
      notificationTimer = setTimeout(
        flushPendingMessage,
        LIVE_NOTIFICATION_COALESCE_MS,
      );
    }
  };

  const scheduleReconnect = (retryAfterMs: number | null = null) => {
    if (stopped || reconnectTimer || !isOnline()) return;
    const backoff = liveReconnectDelay(reconnectAttempt, random);
    reconnectAttempt += 1;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void establish();
    }, delay);
  };

  const handleFailure = (error: unknown) => {
    if (stopped) return;
    if (error instanceof LiveConnectionError) {
      if (error.kind === "account") {
        options.onAccountMismatch();
        return;
      }
      if (error.kind === "authentication") {
        options.onAuthenticationRequired();
        return;
      }
      if (error.kind === "access") {
        options.onAccessLost();
        return;
      }
      scheduleReconnect(error.retryAfterMs);
      return;
    }
    scheduleReconnect();
  };

  const connectWebSocket = (capability: Extract<
    LiveCapability,
    { transport: "websocket" }
  >) => {
    const socket = socketFactory(
      capability.endpoint,
      capability.protocols,
    );
    activeSocket = socket;
    socket.onopen = () => {
      if (activeSocket === socket) startReconnectStability();
    };
    socket.onmessage = (event) => {
      if (activeSocket !== socket || typeof event.data !== "string") return;
      try {
        receiveMessage(parseLiveWireMessage(
          JSON.parse(event.data) as unknown,
        ));
      } catch {}
    };
    socket.onerror = () => {
      if (activeSocket === socket) socket.close();
    };
    socket.onclose = () => {
      if (activeSocket !== socket) return;
      activeSocket = null;
      clearReconnectStability();
      scheduleReconnect();
    };
  };

  async function establish(): Promise<void> {
    if (stopped || !isOnline()) return;
    const capabilityAbort = new AbortController();
    activeAbort = capabilityAbort;
    try {
      const query = new URLSearchParams({
        connectionId: options.connectionId,
        workspaceId: options.workspaceId,
      });
      const response = await fetcher(
        `/api/live/capability?${query}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: accountContextHeaders(options.accountId),
          signal: capabilityAbort.signal,
        },
      );
      await requireLiveResponse(response, options.accountId);
      const capability = parseLiveCapability(await response.json());
      receiveMessage({
        accessRevision: capability.accessRevision,
        revision: capability.revision,
        type: "ready",
        version: LIVE_PROTOCOL_VERSION,
      });
      if (stopped || capability.transport === "unavailable") return;
      activeAbort = null;
      if (capability.transport === "websocket") {
        connectWebSocket(capability);
        return;
      }
      const streamAbort = new AbortController();
      activeAbort = streamAbort;
      const streamResponse = await fetcher(capability.endpoint, {
        cache: "no-store",
        credentials: "same-origin",
        headers: accountContextHeaders(options.accountId),
        signal: streamAbort.signal,
      });
      await requireLiveResponse(streamResponse, options.accountId);
      startReconnectStability();
      try {
        await consumeLiveEventStream(streamResponse, receiveMessage);
      } finally {
        clearReconnectStability();
      }
      if (activeAbort === streamAbort) activeAbort = null;
      if (!stopped) scheduleReconnect();
    } catch (error) {
      handleFailure(error);
    } finally {
      if (activeAbort === capabilityAbort) activeAbort = null;
    }
  }

  void establish();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      activeAbort?.abort();
      activeAbort = null;
      const socket = activeSocket;
      activeSocket = null;
      socket?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (notificationTimer) clearTimeout(notificationTimer);
      clearReconnectStability();
      reconnectTimer = null;
      notificationTimer = null;
      pendingMessage = null;
    },
  };
}
