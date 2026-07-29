"use client";

import {
  BookOpen,
  CircleUserRound,
  LockKeyhole,
  LogIn,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  clearActiveServerWorkspaceCatalogAccount,
} from "./local-replica";
import {
  normalizeAuthenticatedAccount,
  type AuthenticatedAccount,
} from "./account-state";
import {
  ACCOUNT_CHANGE_MESSAGE_TYPE,
  broadcastAccountChange,
  WORKSPACE_CHANNEL_NAME,
} from "./account-channel";
import {
  PRIVACY_POLICY_URL,
  USER_GUIDE_URL,
} from "./external-links";

export interface AccountMenuState {
  configured: boolean | null;
  ready: boolean;
  user: AuthenticatedAccount | null;
}

interface AccountMenuProps {
  accountState?: AccountMenuState;
  className?: string;
  returnTo: string;
  workspaceId?: string;
}

const INITIAL_ACCOUNT_STATE: AccountMenuState = {
  configured: null,
  ready: false,
  user: null,
};

function accountHref(returnTo: string, workspaceId?: string): string {
  const query = new URLSearchParams({ returnTo });
  if (workspaceId) query.set("workspace", workspaceId);
  return `/account?${query.toString()}`;
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = await response.json().catch(() => null) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string" && body.error
    ? body.error
    : fallback;
}

export function AccountMenu({
  accountState,
  className,
  returnTo,
  workspaceId,
}: AccountMenuProps) {
  const [localState, setLocalState] = useState(INITIAL_ACCOUNT_STATE);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const state = accountState ?? localState;
  const user = state.user;
  const href = accountHref(returnTo, workspaceId);
  const rootClassName = ["account-menu", className]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (accountState) return;
    let active = true;
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void fetch("/api/auth/me", {
        cache: "no-store",
        signal,
      }).then(async (response) => {
        const body = await response.json().catch(() => null) as {
          configured?: unknown;
          error?: unknown;
          user?: unknown;
        } | null;
        if (!response.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : "Could not check account status",
          );
        }
        if (!active) return;
        setLocalState({
          configured: typeof body?.configured === "boolean"
            ? body.configured
            : null,
          ready: true,
          user: normalizeAuthenticatedAccount(body?.user),
        });
        setLoadError("");
      }).catch((error) => {
        if (!active || signal.aborted) return;
        setLocalState({
          configured: null,
          ready: true,
          user: null,
        });
        setLoadError(
          error instanceof Error && error.message
            ? error.message
            : "Could not check account status",
        );
      });
    };
    const focus = () => refresh();
    const channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(WORKSPACE_CHANNEL_NAME);
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === ACCOUNT_CHANGE_MESSAGE_TYPE
        ) {
          refresh();
        }
      };
    }
    addEventListener("focus", focus);
    refresh();
    return () => {
      active = false;
      controller?.abort();
      channel?.close();
      removeEventListener("focus", focus);
    };
  }, [accountState]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [open]);

  const signOut = async () => {
    if (signingOut) return;
    setSignOutError("");
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await responseError(response, "Could not sign out"));
      }
      await clearActiveServerWorkspaceCatalogAccount()
        .catch(() => undefined);
      broadcastAccountChange();
      location.reload();
    } catch (error) {
      setSignOutError(
        error instanceof Error && error.message
          ? error.message
          : "Could not sign out",
      );
      setSigningOut(false);
    }
  };

  const triggerLabel = user
    ? `Open user menu for ${user.displayName}`
    : state.ready
      ? state.configured === false
        ? "Open user menu; online accounts unavailable"
        : "Open user menu to sign in"
      : "Open user menu; checking account";

  return <div
    className={rootClassName}
    data-account-role={user?.globalRole ?? "signed-out"}
    ref={root}
  >
    <button
      aria-controls={panelId}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={triggerLabel}
      className="account-menu-trigger"
      data-signed-in={Boolean(user)}
      onClick={() => {
        setSignOutError("");
        setOpen(current => !current);
      }}
      ref={trigger}
      title={triggerLabel}
      type="button"
    >
      <CircleUserRound aria-hidden="true" />
    </button>
    <div
      aria-label="User menu"
      className="account-menu-panel"
      hidden={!open}
      id={panelId}
      role="dialog"
    >
      {!state.ready && !user
        ? <p className="account-menu-status" role="status">
            Checking account...
          </p>
        : user
          ? <>
              <div className="account-menu-identity">
                <span aria-hidden="true">
                  {user.displayName.trim().slice(0, 1).toLocaleUpperCase()}
                </span>
                <p>
                  <strong>{user.displayName}</strong>
                  {user.email && <small>{user.email}</small>}
                </p>
              </div>
              <a href={href} onClick={() => setOpen(false)}>
                <UserRound aria-hidden="true" />
                Account and sessions
              </a>
              {user.globalRole === "admin" && <a
                className="account-menu-admin"
                href="/admin"
                onClick={() => setOpen(false)}
              >
                <ShieldCheck aria-hidden="true" />
                Administration
              </a>}
              <button
                disabled={signingOut}
                onClick={() => void signOut()}
                type="button"
              >
                <LogOut aria-hidden="true" />
                {signingOut ? "Signing out..." : "Sign out"}
              </button>
            </>
          : state.configured === false
            ? <p className="account-menu-status">
                Online accounts and backup are unavailable in this deployment.
              </p>
            : <>
                <p className="account-menu-status">
                  Remote backup and collaboration are optional. Sign in to use them.
                </p>
                <a href={href} onClick={() => setOpen(false)}>
                  <LogIn aria-hidden="true" />
                  Sign in or connect
                </a>
              </>}
      <a
        href={USER_GUIDE_URL}
        onClick={() => setOpen(false)}
        rel="noreferrer"
        target="_blank"
      >
        <BookOpen aria-hidden="true" />
        User guide
      </a>
      <a
        href={PRIVACY_POLICY_URL}
        onClick={() => setOpen(false)}
      >
        <LockKeyhole aria-hidden="true" />
        Privacy policy
      </a>
      {loadError && <p className="account-menu-error" role="alert">
        {loadError}
      </p>}
      {signOutError && <p className="account-menu-error" role="alert">
        {signOutError}
      </p>}
    </div>
  </div>;
}
