import type { Metadata } from "next";
import {
  GuestInvitation,
} from "../../src/client/guest-invitation";

export const metadata: Metadata = {
  title: "Accept workspace invitation · Stowplan",
  robots: { index: false, follow: false },
};

export default function GuestAccess() {
  return <GuestInvitation />;
}
