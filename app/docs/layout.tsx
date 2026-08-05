import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quick guide",
};

export default function DocsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
