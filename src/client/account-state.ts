export interface AuthenticatedAccount {
  displayName: string;
  email: string;
  globalRole: "admin" | "user";
  userId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeAuthenticatedAccount(
  value: unknown,
): AuthenticatedAccount | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.userId !== "string") return null;
  const email = typeof candidate.email === "string"
    ? candidate.email
    : "";
  const displayName = typeof candidate.displayName === "string" &&
      candidate.displayName.trim()
    ? candidate.displayName
    : email || "Signed-in account";
  return {
    displayName,
    email,
    globalRole: candidate.globalRole === "admin" ? "admin" : "user",
    userId: candidate.userId,
  };
}
