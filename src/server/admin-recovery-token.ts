export {
  ADMIN_RECOVERY_TOKEN_HEADER,
} from "../shared/admin-recovery";
export const MAXIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS = 256;
export const MINIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS = 43;

const INVALID_TOKEN_PLACEHOLDER =
  "invalid-admin-recovery-token-placeholder-000000000000000000000000";

function usableToken(value: string | null | undefined): value is string {
  return typeof value === "string"
    && value.length >= MINIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS
    && value.length <= MAXIMUM_ADMIN_RECOVERY_TOKEN_CHARACTERS
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
}

export async function adminRecoveryTokenMatches(
  configured: string | null | undefined,
  presented: string | null | undefined,
): Promise<boolean> {
  const configuredUsable = usableToken(configured);
  const presentedUsable = usableToken(presented);
  const [expected, actual] = await Promise.all([
    digest(configuredUsable ? configured : INVALID_TOKEN_PLACEHOLDER),
    digest(presentedUsable ? presented : INVALID_TOKEN_PLACEHOLDER),
  ]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ actual[index]!;
  }
  return configuredUsable && presentedUsable && difference === 0;
}
