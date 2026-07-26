export const ACCOUNT_CHANGE_MESSAGE_TYPE = "account-changed";
export const WORKSPACE_CHANNEL_NAME = "stowplan-workspaces-v1";

export function broadcastAccountChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(WORKSPACE_CHANNEL_NAME);
  channel.postMessage({ type: ACCOUNT_CHANGE_MESSAGE_TYPE });
  channel.close();
}
