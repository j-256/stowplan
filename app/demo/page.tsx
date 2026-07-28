import type { Metadata } from "next";
import { StowplanApp } from "../../src/client/stowplan-app";

export const metadata: Metadata = {
  title: "Kitchen demo",
};

export default function Demo() {
  return <StowplanApp directDemo />;
}
