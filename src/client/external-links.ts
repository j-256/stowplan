const DEFAULT_DOCUMENTATION_URL =
  "https://docs.stowplan.lasers.app/";
const DEFAULT_PRIVACY_POLICY_URL =
  "https://stowplan.jklein.dev/privacy";
const DEFAULT_REPOSITORY_URL =
  "https://github.com/j-256/stowplan";
const DEFAULT_TERMS_OF_SERVICE_URL =
  "https://stowplan.jklein.dev/terms";

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export const FULL_DOCUMENTATION_URL = trailingSlash(
  process.env.NEXT_PUBLIC_DOCS_URL || DEFAULT_DOCUMENTATION_URL,
);
export const ACCOUNT_DATA_URL =
  `${FULL_DOCUMENTATION_URL}guide/account-data`;
export const PRIVACY_POLICY_URL =
  process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL ||
  DEFAULT_PRIVACY_POLICY_URL;
export const TERMS_OF_SERVICE_URL =
  process.env.NEXT_PUBLIC_TERMS_OF_SERVICE_URL ||
  DEFAULT_TERMS_OF_SERVICE_URL;
export const USER_GUIDE_URL =
  `${FULL_DOCUMENTATION_URL}guide/getting-started`;
export const SOURCE_REPOSITORY_URL =
  process.env.NEXT_PUBLIC_REPOSITORY_URL || DEFAULT_REPOSITORY_URL;
