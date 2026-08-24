import { Home, ShieldCheck } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ApplicationShell,
  ApplicationThemeToggle,
  PreferenceStorageBanner,
} from "../src/client/application-shell";

describe("application shell", () => {
  it("keeps global navigation, page heading, actions, and content in one frame", () => {
    const markup = renderToStaticMarkup(createElement(
      ApplicationShell,
      {
        eyebrow: "Kitchen",
        headerActions: createElement("button", null, "Header action"),
        mobileNavigation: createElement(
          "nav",
          { "aria-label": "Mobile destinations" },
          "Mobile navigation",
        ),
        navigation: [
          {
            active: true,
            href: "/workspaces",
            icon: Home,
            label: "Workspaces",
          },
          {
            active: false,
            href: "/admin",
            icon: ShieldCheck,
            label: "Administration",
          },
        ],
        onSidebarCollapsedChange: () => undefined,
        sidebarCollapsed: true,
        sidebarFooter: createElement("a", { href: "/recovery" }, "Backup status"),
        title: "Workspaces",
      },
      createElement("section", null, "Route content"),
    ));

    expect(markup.match(/<main\b/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Application navigation"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('data-sidebar-collapsed="true"');
    expect(markup).toContain("Header action");
    expect(markup).toContain("Route content");
    expect(markup).toContain("Mobile navigation");
  });

  it("keeps theme and storage controls explicitly labeled", () => {
    const lightToggle = renderToStaticMarkup(createElement(
      ApplicationThemeToggle,
      {
        appliedTheme: "light",
        onChange: () => undefined,
      },
    ));
    const storageBanner = renderToStaticMarkup(createElement(
      PreferenceStorageBanner,
      { onDismiss: () => undefined },
    ));

    expect(lightToggle).toContain(
      'aria-label="Light theme active. Switch to dark theme"',
    );
    expect(storageBanner).toContain("Preferences are session-only");
    expect(storageBanner).toContain(
      'aria-label="Dismiss preference storage message"',
    );
  });
});
