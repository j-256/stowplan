"use client";

import Script from "next/script";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { OAUTH_TURNSTILE_ACTION } from "../shared/authentication";
import {
  SESSION_PERSISTENCE,
  TERMS_ACCEPTANCE_VALUE,
} from "../shared/terms";
import {
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "./external-links";
import styles from "./google-sign-in.module.css";

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
  const persistentSignInId = useId();
  const termsInputId = useId();
  const termsLabelId = useId();
  const [message, setMessage] = useState("");
  const [persistentSignIn, setPersistentSignIn] =
    useState(false);
  const [startIntent, setStartIntent] = useState(intent);
  const [submitting, setSubmitting] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [token, setToken] = useState("");
  const ordinarySignIn = intent === "sign-in";

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
    if (ordinarySignIn && !termsAccepted) {
      setMessage(
        "Accept the Terms of Service before continuing.",
      );
      return;
    }
    setMessage("");
    setSubmitting(true);
    try {
      const form = new URLSearchParams({
        "cf-turnstile-response": token,
        intent: startIntent,
      });
      if (ordinarySignIn) {
        form.set("termsAccepted", TERMS_ACCEPTANCE_VALUE);
        form.set(
          "sessionPersistence",
          persistentSignIn
            ? SESSION_PERSISTENCE.PERSISTENT
            : SESSION_PERSISTENCE.BROWSER_SESSION,
        );
      }
      const response = await fetch(
        `/api/auth/google/start?returnTo=${encodeURIComponent(
          startIntent === "reauthenticate" && intent === "link"
            ? `${location.pathname}${location.search}${location.hash}`
            : returnTo,
        )}`,
        {
          body: form,
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
    <form className={styles.form} onSubmit={startGoogle}>
      <div ref={containerRef} />
      {ordinarySignIn && <div className={styles.choices}>
        <div className={styles.choice}>
          <input
            aria-labelledby={termsLabelId}
            checked={termsAccepted}
            id={termsInputId}
            onChange={(event) =>
              setTermsAccepted(event.currentTarget.checked)}
            type="checkbox"
          />
          <span id={termsLabelId}>
            I agree to the <a
              href={TERMS_OF_SERVICE_URL}
              rel="noreferrer"
              target="_blank"
            >
              Terms of Service
            </a> and acknowledge the <a
              href={PRIVACY_POLICY_URL}
              rel="noreferrer"
              target="_blank"
            >
              Privacy Policy
            </a>.
          </span>
        </div>
        <label className={styles.choice}>
          <input
            checked={persistentSignIn}
            id={persistentSignInId}
            onChange={(event) =>
              setPersistentSignIn(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>
            Keep me signed in after I close the browser
          </span>
        </label>
        <small>
          Leave this unchecked to use a browser-session cookie.
        </small>
      </div>}
      <button
        className="auth-button"
        disabled={
          !token
          || submitting
          || (ordinarySignIn && !termsAccepted)
        }
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
