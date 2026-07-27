"use client";

import Script from "next/script";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { OAUTH_TURNSTILE_ACTION } from "../shared/authentication";

interface TurnstileOptions {
  action: string;
  appearance: "interaction-only";
  callback: (token: string) => void;
  "error-callback": () => void;
  execution: "render";
  "expired-callback": () => void;
  "response-field": false;
  retry: "auto";
  sitekey: string;
  size: "flexible";
  theme: "auto";
}

interface TurnstileApi {
  remove(widgetId: string): void;
  render(
    container: HTMLElement,
    options: TurnstileOptions,
  ): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface GoogleSignInProps {
  hasLinkedGoogleIdentity?: boolean;
  intent?: "link" | "reauthenticate" | "sign-in";
  returnTo: string;
  siteKey: string;
}

interface OAuthStartResponse {
  authorizationUrl?: string;
  code?: string;
  error?: string;
  hasLinkedGoogleIdentity?: boolean;
}

const GOOGLE_AUTHORIZATION_ORIGIN =
  "https://accounts.google.com";
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function GoogleSignIn({
  hasLinkedGoogleIdentity = false,
  intent = "sign-in",
  returnTo,
  siteKey,
}: GoogleSignInProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [message, setMessage] = useState("");
  const [startIntent, setStartIntent] = useState(intent);
  const [submitting, setSubmitting] = useState(false);
  const [token, setToken] = useState("");

  const renderWidget = useCallback(() => {
    if (
      widgetIdRef.current
      || !containerRef.current
      || !window.turnstile
    ) {
      return;
    }
    widgetIdRef.current = window.turnstile.render(
      containerRef.current,
      {
        action: OAUTH_TURNSTILE_ACTION,
        appearance: "interaction-only",
        callback: (nextToken) => {
          setMessage("");
          setToken(nextToken);
        },
        "error-callback": () => {
          setMessage(
            "Browser verification could not be completed. Check your connection and try again.",
          );
          setToken("");
        },
        execution: "render",
        "expired-callback": () => {
          setMessage(
            "Browser verification expired. Complete it again to continue.",
          );
          setToken("");
        },
        "response-field": false,
        retry: "auto",
        sitekey: siteKey,
        size: "flexible",
        theme: "auto",
      },
    );
  }, [siteKey]);

  useEffect(() => {
    renderWidget();
    return () => {
      if (
        widgetIdRef.current
        && window.turnstile
      ) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget]);

  const resetWidget = useCallback(() => {
    setToken("");
    if (
      widgetIdRef.current
      && window.turnstile
    ) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, []);

  const startGoogle = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!token || submitting) {
      setMessage(
        "Complete the browser verification before continuing.",
      );
      return;
    }
    setMessage("");
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/auth/google/start?returnTo=${encodeURIComponent(
          startIntent === "reauthenticate" && intent === "link"
            ? `${location.pathname}${location.search}${location.hash}`
            : returnTo,
        )}`,
        {
          body: new URLSearchParams({
            "cf-turnstile-response": token,
            intent: startIntent,
          }),
          headers: {
            "content-type":
              "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      );
      const body = await response.json()
        .catch(() => null) as OAuthStartResponse | null;
      if (
        intent === "link"
        && startIntent === "link"
        && response.status === 401
        && body?.code === "REAUTHENTICATION_REQUIRED"
      ) {
        const linkedGoogleIdentity =
          body.hasLinkedGoogleIdentity
          ?? hasLinkedGoogleIdentity;
        if (linkedGoogleIdentity) {
          setStartIntent("reauthenticate");
          setMessage(
            "Confirm with an existing Google identity, then choose link again when you return.",
          );
        } else {
          setMessage(
            body.error
            ?? "Sign out and sign in again with this account's existing method, then link Google when you return.",
          );
        }
        resetWidget();
        setSubmitting(false);
        return;
      }
      if (!response.ok || !body?.authorizationUrl) {
        throw new Error(
          body?.error
          ?? "Google sign-in could not be started",
        );
      }
      const authorization = new URL(body.authorizationUrl);
      if (
        authorization.origin !== GOOGLE_AUTHORIZATION_ORIGIN
        || authorization.protocol !== "https:"
      ) {
        throw new Error(
          "The server returned an invalid Google sign-in destination",
        );
      }
      location.assign(authorization.toString());
    } catch (error) {
      setMessage(
        error instanceof Error && error.message
          ? error.message
          : "Google sign-in could not be started",
      );
      resetWidget();
      setSubmitting(false);
    }
  };

  return <>
    <Script
      onError={() => setMessage(
        "Browser verification could not load. Check content blockers and try again.",
      )}
      onReady={renderWidget}
      src={TURNSTILE_SCRIPT_URL}
      strategy="afterInteractive"
    />
    <form onSubmit={startGoogle}>
      <div ref={containerRef} />
      <button
        className="auth-button"
        disabled={!token || submitting}
        type="submit"
      >
        {submitting
          ? "Opening Google..."
          : startIntent === "link"
            ? hasLinkedGoogleIdentity
              ? "Link another Google identity"
              : "Link Google identity"
            : startIntent === "reauthenticate"
              ? "Confirm with Google"
              : "Continue with Google"}
      </button>
      {message && <output aria-live="polite">{message}</output>}
    </form>
  </>;
}
