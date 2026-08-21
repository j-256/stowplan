import type { Metadata } from "next";
import { AdminApplicationShell } from "../../src/client/admin-application-shell";

export const metadata: Metadata = {
  title: "Administration",
};

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AdminApplicationShell>{children}</AdminApplicationShell>;
}
