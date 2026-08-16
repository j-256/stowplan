import { API_QUOTAS } from "./quotas.js";

export const LIVE_PROTOCOL_VERSION = 1 as const;
export const LIVE_SUBPROTOCOL = "stowplan-live-v1";
export const LIVE_AUTH_SUBPROTOCOL_PREFIX = "stowplan-auth.";
export const LIVE_CAPABILITY_AUDIENCE = "stowplan-live-relay";
export const LIVE_CAPABILITY_TTL_MS = 60_000;
export const LIVE_RELAY_CLOCK_SKEW_MS = 60_000;
export const LIVE_RELAY_REQUEST_MAX_BYTES = 16_384;
export const LIVE_CONNECTION_ID_MAX_CHARACTERS = 128;
export const LIVE_RELAY_SIGNATURE_HEADER =
  "x-stowplan-live-signature";
export const LIVE_RELAY_TIMESTAMP_HEADER =
  "x-stowplan-live-timestamp";

const LIVE_IDENTIFIER_MAX_CHARACTERS = 128;
const LIVE_ORIGIN_MAX_CHARACTERS = 512;
const LIVE_TOKEN_MAX_CHARACTERS = 4_096;
const LIVE_SECRET_MINIMUM_BYTES = 32;
const CAPABILITY_SIGNATURE_CONTEXT = "stowplan-live-capability-v1";
const RELAY_SIGNATURE_CONTEXT = "stowplan-live-publish-v1";

export class LiveProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProtocolError";
  }
}

export interface LiveCapabilityPayload {
  accessRevision: number;
  audience: typeof LIVE_CAPABILITY_AUDIENCE;
  connectionId: string;
  expiresAt: number;
  issuedAt: number;
  origin: string;
  revision: number;
  userId: string;
  version: typeof LIVE_PROTOCOL_VERSION;
  workspaceId: string;
}

export type LiveCapabilityInput = Omit<
  LiveCapabilityPayload,
  "audience" | "version"
>;

export interface LiveNotification {
  accessRevision: number;
  allowedUserIds: string[];
  deleted: boolean;
  revision: number;
  sourceConnectionId?: string;
  type: "workspace-change";
  version: typeof LIVE_PROTOCOL_VERSION;
  workspaceId: string;
}

export interface LiveWireMessage {
  accessRevision: number;
  revision: number;
  type: "access" | "change" | "deleted" | "ready";
  version: typeof LIVE_PROTOCOL_VERSION;
}

export interface LiveRequestCostInput {
  committedBatches: number;
  connectedTabs: number;
  reconnects: number;
}

export interface LiveRequestCost {
  applicationRequests: number;
  durableObjectRequests: number;
  relayWorkerRequests: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maximum = LIVE_IDENTIFIER_MAX_CHARACTERS,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maximum
  ) {
    throw new LiveProtocolError(`Live ${label} is invalid`);
  }
  return value;
}

export function normalizeLiveConnectionId(value: unknown): string | null {
  try {
    return requiredString(
      value,
      "connection ID",
      LIVE_CONNECTION_ID_MAX_CHARACTERS,
    );
  } catch {
    return null;
  }
}

function safeRevision(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new LiveProtocolError(`Live ${label} revision is invalid`);
  }
  return value;
}

function safeTimestamp(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new LiveProtocolError(`Live ${label} timestamp is invalid`);
  }
  return value;
}

function normalizedOrigin(value: unknown): string {
  const origin = requiredString(
    value,
    "origin",
    LIVE_ORIGIN_MAX_CHARACTERS,
  );
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new LiveProtocolError("Live origin is invalid");
  }
  if (parsed.origin !== origin || parsed.pathname !== "/") {
    throw new LiveProtocolError("Live origin is invalid");
  }
  return origin;
}

function parseCapabilityPayload(value: unknown): LiveCapabilityPayload {
  if (!isRecord(value)) {
    throw new LiveProtocolError("Live capability payload is invalid");
  }
  if (value.audience !== LIVE_CAPABILITY_AUDIENCE) {
    throw new LiveProtocolError("Live capability audience is invalid");
  }
  if (value.version !== LIVE_PROTOCOL_VERSION) {
    throw new LiveProtocolError("Live capability version is invalid");
  }
  const issuedAt = safeTimestamp(value.issuedAt, "issued-at");
  const expiresAt = safeTimestamp(value.expiresAt, "expiry");
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > LIVE_CAPABILITY_TTL_MS
  ) {
    throw new LiveProtocolError("Live capability lifetime is invalid");
  }
  return {
    accessRevision: safeRevision(value.accessRevision, "access"),
    audience: LIVE_CAPABILITY_AUDIENCE,
    connectionId: requiredString(
      value.connectionId,
      "connection ID",
      LIVE_CONNECTION_ID_MAX_CHARACTERS,
    ),
    expiresAt,
    issuedAt,
    origin: normalizedOrigin(value.origin),
    revision: safeRevision(value.revision, "workspace"),
    userId: requiredString(value.userId, "user ID"),
    version: LIVE_PROTOCOL_VERSION,
    workspaceId: requiredString(value.workspaceId, "workspace ID"),
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new LiveProtocolError("Live signature encoding is invalid");
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(
    standard.length + (4 - standard.length % 4) % 4,
    "=",
  );
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new LiveProtocolError("Live signature encoding is invalid");
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodedJson(value: unknown): string {
  return encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

function decodedJson(value: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64Url(value),
      ),
    ) as unknown;
  } catch (error) {
    if (error instanceof LiveProtocolError) throw error;
    throw new LiveProtocolError("Live capability payload is invalid");
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < LIVE_SECRET_MINIMUM_BYTES) {
    throw new LiveProtocolError(
      "Live relay secret must contain at least 32 UTF-8 bytes",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

async function signText(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function verifyText(
  value: string,
  signature: string,
  secret: string,
): Promise<void> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64Url(signature);
  } catch {
    throw new LiveProtocolError("Live signature is invalid");
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    new Uint8Array(signatureBytes).buffer,
    new TextEncoder().encode(value),
  );
  if (!verified) throw new LiveProtocolError("Live signature is invalid");
}

export async function signLiveCapability(
  input: LiveCapabilityInput,
  secret: string,
): Promise<string> {
  const payload = parseCapabilityPayload({
    ...input,
    audience: LIVE_CAPABILITY_AUDIENCE,
    version: LIVE_PROTOCOL_VERSION,
  });
  const encoded = encodedJson(payload);
  const signature = await signText(
    `${CAPABILITY_SIGNATURE_CONTEXT}\n${encoded}`,
    secret,
  );
  return `${encoded}.${signature}`;
}

export async function verifyLiveCapability(
  token: string,
  secret: string,
  options: { now?: number; origin: string },
): Promise<LiveCapabilityPayload> {
  if (
    typeof token !== "string" ||
    token.length > LIVE_TOKEN_MAX_CHARACTERS
  ) {
    throw new LiveProtocolError("Live capability token is invalid");
  }
  const segments = token.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new LiveProtocolError("Live capability token is invalid");
  }
  await verifyText(
    `${CAPABILITY_SIGNATURE_CONTEXT}\n${segments[0]}`,
    segments[1],
    secret,
  );
  const payload = parseCapabilityPayload(decodedJson(segments[0]));
  const now = options.now ?? Date.now();
  if (payload.expiresAt < now) {
    throw new LiveProtocolError("Live capability has expired");
  }
  if (payload.issuedAt > now + LIVE_RELAY_CLOCK_SKEW_MS) {
    throw new LiveProtocolError("Live capability is not active yet");
  }
  if (payload.origin !== normalizedOrigin(options.origin)) {
    throw new LiveProtocolError("Live capability origin does not match");
  }
  return payload;
}

function relaySignatureValue(body: string, timestamp: string): string {
  return `${RELAY_SIGNATURE_CONTEXT}\n${timestamp}\n${body}`;
}

export function liveBodyBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

export async function signLiveRelayRequest(
  body: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  if (liveBodyBytes(body) > LIVE_RELAY_REQUEST_MAX_BYTES) {
    throw new LiveProtocolError("Live relay request body is too large");
  }
  return signText(relaySignatureValue(body, timestamp), secret);
}

export async function verifyLiveRelayRequest(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): Promise<void> {
  if (liveBodyBytes(body) > LIVE_RELAY_REQUEST_MAX_BYTES) {
    throw new LiveProtocolError("Live relay request body is too large");
  }
  if (!/^\d+$/u.test(timestamp)) {
    throw new LiveProtocolError("Live relay timestamp is invalid");
  }
  const parsed = Number(timestamp);
  if (
    !Number.isSafeInteger(parsed) ||
    Math.abs(now - parsed) > LIVE_RELAY_CLOCK_SKEW_MS
  ) {
    throw new LiveProtocolError("Live relay timestamp is outside the allowed window");
  }
  await verifyText(
    relaySignatureValue(body, timestamp),
    signature,
    secret,
  );
}

export function parseLiveNotification(value: unknown): LiveNotification {
  if (!isRecord(value)) {
    throw new LiveProtocolError("Live workspace notification is invalid");
  }
  if (
    value.type !== "workspace-change" ||
    value.version !== LIVE_PROTOCOL_VERSION ||
    typeof value.deleted !== "boolean" ||
    !Array.isArray(value.allowedUserIds) ||
    value.allowedUserIds.length > API_QUOTAS.membersPerWorkspace
  ) {
    throw new LiveProtocolError("Live workspace notification is invalid");
  }
  const allowedUserIds = [...new Set(value.allowedUserIds.map(
    userId => requiredString(userId, "allowed user ID"),
  ))].sort();
  if (!value.deleted && allowedUserIds.length === 0) {
    throw new LiveProtocolError(
      "Live workspace notification requires an allowed user",
    );
  }
  const sourceConnectionId = value.sourceConnectionId === undefined
    ? undefined
    : requiredString(
        value.sourceConnectionId,
        "source connection ID",
        LIVE_CONNECTION_ID_MAX_CHARACTERS,
      );
  return {
    accessRevision: safeRevision(value.accessRevision, "access"),
    allowedUserIds,
    deleted: value.deleted,
    revision: safeRevision(value.revision, "workspace"),
    ...(sourceConnectionId ? { sourceConnectionId } : {}),
    type: "workspace-change",
    version: LIVE_PROTOCOL_VERSION,
    workspaceId: requiredString(value.workspaceId, "workspace ID"),
  };
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function liveRequestCost(input: LiveRequestCostInput): LiveRequestCost {
  const connectedTabs = nonnegativeInteger(
    input.connectedTabs,
    "Connected tabs",
  );
  const committedBatches = nonnegativeInteger(
    input.committedBatches,
    "Committed batches",
  );
  const reconnects = nonnegativeInteger(input.reconnects, "Reconnects");
  const establishments = connectedTabs + reconnects;
  const liveRequests = establishments + committedBatches;
  return {
    applicationRequests: liveRequests,
    durableObjectRequests: liveRequests,
    relayWorkerRequests: liveRequests,
  };
}

export function pollingRequestsPerDay(
  intervalSeconds: number,
  tabs: number,
): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new RangeError("Polling interval must be positive");
  }
  return Math.ceil(86_400 / intervalSeconds) * nonnegativeInteger(tabs, "Tabs");
}
