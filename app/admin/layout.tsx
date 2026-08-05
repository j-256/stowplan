import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Administration",
};

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
