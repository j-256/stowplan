import type { Metadata } from "next";
import {
  GuestInvitation,
} from "../../../src/client/guest-invitation";

export const metadata: Metadata = {
  title: "Accept workspace invitation · Stowplan",
  robots: { index: false, follow: false },
};

export default async function GuestAccess({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const { token } = await params;
  const requestedReturn = (await searchParams).returnTo;
  const returnTo = Array.isArray(requestedReturn)
    ? requestedReturn[0]
    : requestedReturn;
  return <GuestInvitation
    legacyReturnTo={returnTo}
    legacyToken={token}
  />;
}
