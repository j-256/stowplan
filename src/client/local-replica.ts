import { applyCommand } from "../domain/commands";
import { normalizeWorkspaceState } from "../domain/import";
import type { CommandEnvelope, SyncReceipt, WorkspaceState } from "../domain/types";

const DATABASE = "stowplan-v1";
const STORE = "records";

export interface OutboxEntry {
  envelope: CommandEnvelope;
  status: "pending" | "blocked";
  error?: string;
}

export interface LocalReplica {
  state: WorkspaceState;
  outbox: OutboxEntry[];
  updatedAt: string;
}

export interface LocalWorkspaceSummary {
  id: string;
  name: string;
  pending: number;
  updatedAt: string;
}

const workspaceKey = (workspaceId: string) => `workspace:${workspaceId}`;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readReplica(): Promise<LocalReplica | null> {
  return readStoredReplica("active");
}

async function readStoredReplica(key: string): Promise<LocalReplica | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => {
      const replica=request.result as LocalReplica|undefined;
      if(replica)normalizeWorkspaceState(replica.state);
      resolve(replica??null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function readWorkspaceReplica(workspaceId: string): Promise<LocalReplica | null> {
  return readStoredReplica(workspaceKey(workspaceId));
}

export async function listWorkspaceReplicas(): Promise<LocalWorkspaceSummary[]> {
  const db = await database();
  const replicas = await new Promise<LocalReplica[]>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as LocalReplica[]);
    request.onerror = () => reject(request.error);
  });
  const unique = new Map<string, LocalWorkspaceSummary>();
  for (const replica of replicas) {
    if (!replica?.state?.workspace) continue;
    normalizeWorkspaceState(replica.state);
    const summary = { id: replica.state.workspace.id, name: replica.state.workspace.name, pending: replica.outbox.length, updatedAt: replica.updatedAt };
    const previous = unique.get(summary.id);
    if (!previous || previous.updatedAt < summary.updatedAt) unique.set(summary.id, summary);
  }
  return [...unique.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function writeReplica(replica: LocalReplica): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    store.put(replica, "active");
    store.put(replica, workspaceKey(replica.state.workspace.id));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function clearReplica(): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export function reconcileReplica(latest:LocalReplica,sent:OutboxEntry[],serverState:WorkspaceState,receipts:SyncReceipt[]):LocalReplica{
  const sentIds=new Set(sent.map(entry=>entry.envelope.id)),byId=new Map(receipts.map(receipt=>[receipt.commandId,receipt]));
  const outbox=latest.outbox.flatMap(entry=>{if(!sentIds.has(entry.envelope.id))return[entry];const receipt=byId.get(entry.envelope.id);if(receipt?.status!=="rejected")return[];const error=receipt.message??receipt.conflicts?.map(conflict=>conflict.message).join("; ")??"Server rejected this change";return[{...entry,error,status:"blocked" as const}]});
  let state=serverState;
  if(outbox.some(entry=>entry.status==="blocked"))state=latest.state;
  else for(const entry of outbox)state=applyCommand(state,entry.envelope).state;
  return{state,outbox,updatedAt:new Date().toISOString()};
}
