"use client";

import {
  Info,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  MouseEventHandler,
  ReactNode,
} from "react";
import type { AppliedTheme } from "./workspace-view-types";

export interface ApplicationNavigationItem {
  active: boolean;
  href: string;
  icon: LucideIcon;
  label: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

interface ApplicationShellProps {
  children?: ReactNode;
  eyebrow: string;
  headerActions: ReactNode;
  mobileNavigation?: ReactNode;
  navigation: readonly ApplicationNavigationItem[];
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  sidebarCollapsed: boolean;
  sidebarFooter?: ReactNode;
  title: string;
}

export function ApplicationBrand() {
  return <div className="brand" aria-label="Stowplan">
    <b>S</b>
    <span>
      <strong>Stowplan</strong>
      <small>Know where everything lives</small>
    </span>
  </div>;
}

export function ApplicationNavigationLink({
  active,
  href,
  icon: Icon,
  label,
  onClick,
}: ApplicationNavigationItem) {
  return <a
    aria-current={active ? "page" : undefined}
    className="nav"
    data-active={active}
    href={href}
    onClick={onClick}
    title={label}
  >
    <Icon aria-hidden="true" />
    <span>{label}</span>
  </a>;
}

export function ApplicationThemeToggle({
  appliedTheme,
  className = "icon",
  onChange,
}: {
  appliedTheme: AppliedTheme;
  className?: string;
  onChange: (theme: "dark" | "light") => void;
}) {
  const label = appliedTheme === "dark"
    ? "Dark theme active. Switch to light theme"
    : "Light theme active. Switch to dark theme";
  return <button
    aria-label={label}
    className={className}
    onClick={() => onChange(appliedTheme === "dark" ? "light" : "dark")}
    title={label}
    type="button"
  >
    {appliedTheme === "dark"
      ? <Moon aria-hidden="true" />
      : <Sun aria-hidden="true" />}
  </button>;
}

export function PreferenceStorageBanner({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  return <section className="preference-storage-banner" role="status">
    <Info aria-hidden="true" />
    <span>
      <strong>Preferences are session-only</strong>
      <small>Theme, sidebar, and panel choices will reset after reload because browser preference storage is unavailable.</small>
    </span>
    <button
      aria-label="Dismiss preference storage message"
      className="icon small"
      onClick={onDismiss}
      type="button"
    >
      <X aria-hidden="true" />
    </button>
  </section>;
}

export function ApplicationShell({
  children,
  eyebrow,
  headerActions,
  mobileNavigation,
  navigation,
  onSidebarCollapsedChange,
  sidebarCollapsed,
  sidebarFooter,
  title,
}: ApplicationShellProps) {
  return <div
    className="app-shell"
    data-sidebar-collapsed={sidebarCollapsed}
  >
    <aside aria-label="Application navigation">
      <ApplicationBrand />
      <nav aria-label="Primary destinations">
        {navigation.map((item) => <ApplicationNavigationLink
          key={`${item.label}:${item.href}`}
          {...item}
        />)}
      </nav>
      <button
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="sidebar-toggle"
        onClick={() => onSidebarCollapsedChange(!sidebarCollapsed)}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        type="button"
      >
        {sidebarCollapsed
          ? <PanelLeftOpen aria-hidden="true" />
          : <PanelLeftClose aria-hidden="true" />}
        <span>{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
      </button>
      {sidebarFooter}
    </aside>
    <main tabIndex={-1}>
      <header>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
        </div>
        <div className="header-actions">{headerActions}</div>
      </header>
      {children}
    </main>
    {mobileNavigation}
  </div>;
}
