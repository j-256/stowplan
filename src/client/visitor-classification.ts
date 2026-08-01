export const VISITOR_KIND = Object.freeze({
  KNOWN: "known",
  NEWCOMER: "newcomer",
} as const);

export type VisitorKind = (typeof VISITOR_KIND)[keyof typeof VISITOR_KIND];

export interface VisitorSignals {
  bypass: boolean;
  hasLocalWorkspaces: boolean;
  hasRememberedAccount: boolean;
}

// A bypass always wins so ?welcome can force the hero for QA and demos
export function classifyVisitor({
  bypass,
  hasLocalWorkspaces,
  hasRememberedAccount,
}: VisitorSignals): VisitorKind {
  if (bypass) return VISITOR_KIND.NEWCOMER;
  return hasLocalWorkspaces || hasRememberedAccount
    ? VISITOR_KIND.KNOWN
    : VISITOR_KIND.NEWCOMER;
}
