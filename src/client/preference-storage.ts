export const PREFERENCE_STORAGE_ERROR_EVENT =
  "stowplan:preference-storage-error";

let storageUnavailable = false;

function markStorageUnavailable(): void {
  storageUnavailable = true;
  if (typeof window !== "undefined") {
    dispatchEvent(new Event(PREFERENCE_STORAGE_ERROR_EVENT));
  }
}

export function preferenceStorageUnavailable(): boolean {
  return storageUnavailable;
}

export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    markStorageUnavailable();
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    markStorageUnavailable();
  }
}
