"use client";

import { usePathname } from "next/navigation";
import {
  Activity,
  Boxes,
  ClipboardList,
  Home,
  Map as MapIcon,
  PackagePlus,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
} from "react";
import {
  WORKSPACE_LIST_PATH,
  type WorkspaceView,
} from "../domain/app-url";
import type { WorkspaceState } from "../domain/types";
import { AccountMenu } from "./account-menu";
import {
  ApplicationNavigationLink,
  ApplicationShell,
  ApplicationThemeToggle,
  PreferenceStorageBanner,
  type ApplicationNavigationItem,
} from "./application-shell";
import { useApplicationShellPreferences } from "./application-shell-preferences";
import { readReplica } from "./local-replica";
import { stateWorkspacePath } from "./workspace-view-helpers";

const WORKSPACE_DESTINATIONS: readonly {
  icon: LucideIcon;
  label: string;
  view: WorkspaceView;
}[] = Object.freeze([
  { icon: PackagePlus, label: "Capture", view: "capture" },
  { icon: MapIcon, label: "Spaces", view: "spaces" },
  { icon: Boxes, label: "Inventory", view: "inventory" },
  { icon: ClipboardList, label: "Plan", view: "plan" },
  { icon: Activity, label: "Activity", view: "activity" },
  { icon: Settings, label: "Settings", view: "settings" },
]);

function adminHeading(pathname: string): {
  eyebrow: string;
  title: string;
} {
  if (pathname === "/admin/recovery") {
    return {
      eyebrow: "Break-glass control plane",
      title: "Admin recovery",
    };
  }
  if (pathname.startsWith("/admin/workspaces/")) {
    return {
      eyebrow: "Audited control plane",
      title: "Workspace inspection",
    };
  }
  return {
    eyebrow: "Server-enforced control plane",
    title: "Stowplan administration",
  };
}

function workspaceNavigation(
  state: WorkspaceState | null,
): ApplicationNavigationItem[] {
  if (!state) return [];
  return WORKSPACE_DESTINATIONS.map((destination) => ({
    active: false,
    href: stateWorkspacePath(state, { view: destination.view }),
    icon: destination.icon,
    label: destination.label,
  }));
}

export function AdminApplicationShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [state, setState] = useState<WorkspaceState | null>(null);
  const {
    appliedTheme,
    preferenceStorageMessageDismissed,
    preferencesSessionOnly,
    selectTheme,
    setPreferenceStorageMessageDismissed,
    setSidebarCollapsed,
    sidebarCollapsed,
  } = useApplicationShellPreferences();

  useEffect(() => {
    let active = true;
    void readReplica().then((replica) => {
      if (active) setState(replica?.state ?? null);
    }).catch(() => {
      // Local workspace navigation is optional for the admin control plane
    });
    return () => {
      active = false;
    };
  }, []);

  const heading = adminHeading(pathname);
  const navigation: ApplicationNavigationItem[] = [
    {
      active: false,
      href: WORKSPACE_LIST_PATH,
      icon: Home,
      label: "Workspaces",
    },
    ...workspaceNavigation(state),
    {
      active: true,
      href: "/admin",
      icon: ShieldCheck,
      label: "Administration",
    },
  ];
  const mobileNavigation = [
    navigation[0],
    ...navigation.filter((item) =>
      item.label === "Capture" ||
      item.label === "Inventory" ||
      item.label === "Settings"
    ),
    navigation[navigation.length - 1],
  ];

  return <ApplicationShell
    eyebrow={heading.eyebrow}
    headerActions={<>
      <ApplicationThemeToggle
        appliedTheme={appliedTheme}
        className="header-mobile-secondary icon"
        onChange={selectTheme}
      />
      <AccountMenu returnTo={pathname} />
    </>}
    mobileNavigation={<nav
      aria-label="Primary application navigation"
      className="bottom application-bottom"
    >
      {mobileNavigation.map((item) => <ApplicationNavigationLink
        key={`${item.label}:${item.href}`}
        {...item}
      />)}
    </nav>}
    navigation={navigation}
    onSidebarCollapsedChange={setSidebarCollapsed}
    sidebarCollapsed={sidebarCollapsed}
    title={heading.title}
  >
    {preferencesSessionOnly &&
      !preferenceStorageMessageDismissed &&
      <PreferenceStorageBanner
        onDismiss={() => setPreferenceStorageMessageDismissed(true)}
      />}
    {children}
  </ApplicationShell>;
}
