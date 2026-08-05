import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Recovery",
};

export default function RecoveryLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
