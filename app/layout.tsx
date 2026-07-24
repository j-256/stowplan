import type { Metadata, Viewport } from "next";
import { KeyboardNavigation } from "../src/client/keyboard-navigation";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Stowplan", template: "%s · Stowplan" },
  description: "A local-first organizer for boxes, cabinets, drawers, and everything nested inside.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  other: { "codex-preview": "development" },
};
export const viewport: Viewport = { colorScheme: "light dark", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f3eee5" }, { media: "(prefers-color-scheme: dark)", color: "#151814" }] };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:`try{const t=localStorage.getItem('stowplan-theme')||'system';const d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch{}`}}/></head><body><KeyboardNavigation />{children}</body></html>;
}
