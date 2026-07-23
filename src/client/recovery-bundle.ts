import { parseSnapshot } from "../domain/import";
import type { WorkspaceState } from "../domain/types";
import type { LocalReplica } from "./local-replica";

export interface ParsedRecoveryUpload {
  bundle: LocalReplica | null;
  state: WorkspaceState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRecoveryUpload(text: string): ParsedRecoveryUpload {
  const value = JSON.parse(text) as unknown;
  if (
    !isRecord(value) ||
    value.format !== "stowplan-recovery-v1"
  ) {
    return { bundle: null, state: parseSnapshot(text) };
  }
  if (
    !isRecord(value.replica) ||
    !isRecord(value.replica.state) ||
    !Array.isArray(value.replica.outbox) ||
    typeof value.replica.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.replica.updatedAt))
  ) {
    throw new Error("Recovery bundle is malformed");
  }
  const state = parseSnapshot(JSON.stringify(value.replica.state));
  const commandIds = new Set<string>();
  for (const entry of value.replica.outbox) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.envelope) ||
      (entry.status !== "pending" && entry.status !== "blocked") ||
      (entry.error !== undefined && typeof entry.error !== "string")
    ) {
      throw new Error("Recovery bundle is malformed");
    }
    const envelope = entry.envelope;
    if (
      typeof envelope.id !== "string" ||
      !envelope.id.trim() ||
      commandIds.has(envelope.id) ||
      envelope.workspaceId !== state.workspace.id ||
      typeof envelope.actorId !== "string" ||
      !envelope.actorId.trim() ||
      typeof envelope.deviceId !== "string" ||
      !envelope.deviceId.trim() ||
      typeof envelope.timestamp !== "string" ||
      !Number.isFinite(Date.parse(envelope.timestamp)) ||
      !Number.isSafeInteger(envelope.baseRevision) ||
      Number(envelope.baseRevision) < 0 ||
      !isRecord(envelope.command) ||
      typeof envelope.command.type !== "string" ||
      !envelope.command.type.trim() ||
      !Array.isArray(envelope.expectations)
    ) {
      throw new Error("Recovery bundle contains a malformed queued command");
    }
    const represented =
      state.activities.some((activity) => activity.commandId === envelope.id) ||
      state.audit.some((event) => event.id === `audit_${envelope.id}`);
    if (!represented) {
      throw new Error(
        "Recovery bundle contains a queued command that is not represented in its saved state",
      );
    }
    commandIds.add(envelope.id);
  }
  return {
    bundle: {
      ...value.replica,
      state,
    } as unknown as LocalReplica,
    state,
  };
}
