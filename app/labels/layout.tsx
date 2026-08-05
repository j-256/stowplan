import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Printable labels",
};

export default function LabelsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
