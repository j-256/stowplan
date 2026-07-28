const DEFAULT_DOCUMENTATION_URL =
  "https://j-256.github.io/stowplan/";
const DEFAULT_REPOSITORY_URL =
  "https://github.com/j-256/stowplan";

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export const FULL_DOCUMENTATION_URL = trailingSlash(
  process.env.NEXT_PUBLIC_DOCS_URL || DEFAULT_DOCUMENTATION_URL,
);
export const ACCOUNT_DATA_URL =
  `${FULL_DOCUMENTATION_URL}guide/account-data`;
export const USER_GUIDE_URL =
  `${FULL_DOCUMENTATION_URL}guide/getting-started`;
export const SOURCE_REPOSITORY_URL =
  process.env.NEXT_PUBLIC_REPOSITORY_URL || DEFAULT_REPOSITORY_URL;
