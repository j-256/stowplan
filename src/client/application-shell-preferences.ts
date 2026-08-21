"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import type { ThemePreference } from "../domain/types";
import {
  PREFERENCE_STORAGE_ERROR_EVENT,
  preferenceStorageUnavailable,
  readPreference,
  writePreference,
} from "./preference-storage";
import type { AppliedTheme } from "./workspace-view-types";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "stowplan-sidebar-collapsed";
const THEME_STORAGE_KEY = "stowplan-theme";
const THEME_PREFERENCES = new Set<ThemePreference>([
  "dark",
  "light",
  "system",
]);

function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && THEME_PREFERENCES.has(value as ThemePreference);
}

function applyThemePreference(theme: ThemePreference): AppliedTheme {
  const appliedTheme = theme === "dark" || (
    theme === "system" &&
    matchMedia("(prefers-color-scheme:dark)").matches
  )
    ? "dark"
    : "light";
  document.documentElement.dataset.theme = appliedTheme;
  return appliedTheme;
}

export function useApplicationShellPreferences() {
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [appliedTheme, setAppliedTheme] = useState<AppliedTheme>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarReady, setSidebarReady] = useState(false);
  const [preferencesSessionOnly, setPreferencesSessionOnly] = useState(false);
  const [preferenceStorageMessageDismissed, setPreferenceStorageMessageDismissed] =
    useState(false);

  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydrate device-only preferences after the server-consistent first render */
    const saved = readPreference(THEME_STORAGE_KEY) as ThemePreference | null;
    const nextTheme = isThemePreference(saved) ? saved : "system";
    setTheme(nextTheme);
    setAppliedTheme(applyThemePreference(nextTheme));
    setThemeReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- hydrate device-only preferences after the server-consistent first render */
    setSidebarCollapsed(
      readPreference(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true",
    );
    if (preferenceStorageUnavailable()) setPreferencesSessionOnly(true);
    setSidebarReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    writePreference(THEME_STORAGE_KEY, theme);
    if (theme !== "system") return;
    const media = matchMedia("(prefers-color-scheme:dark)");
    const applySystemTheme = () => {
      setAppliedTheme(applyThemePreference("system"));
    };
    media.addEventListener("change", applySystemTheme);
    return () => media.removeEventListener("change", applySystemTheme);
  }, [theme, themeReady]);

  useEffect(() => {
    if (!sidebarReady) return;
    writePreference(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed, sidebarReady]);

  useEffect(() => {
    const receivePreferenceStorageError = () =>
      setPreferencesSessionOnly(true);
    addEventListener(
      PREFERENCE_STORAGE_ERROR_EVENT,
      receivePreferenceStorageError,
    );
    /* eslint-disable react-hooks/set-state-in-effect -- storage can fail before the effect subscribes */
    if (preferenceStorageUnavailable()) setPreferencesSessionOnly(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => removeEventListener(
      PREFERENCE_STORAGE_ERROR_EVENT,
      receivePreferenceStorageError,
    );
  }, []);

  const selectTheme = useCallback((nextTheme: ThemePreference) => {
    setTheme(nextTheme);
    setAppliedTheme(applyThemePreference(nextTheme));
  }, []);

  return {
    appliedTheme,
    preferenceStorageMessageDismissed,
    preferencesSessionOnly,
    selectTheme,
    setPreferenceStorageMessageDismissed,
    setSidebarCollapsed,
    sidebarCollapsed,
    theme,
  };
}
