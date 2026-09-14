export const PUBLIC_SITE_URL = new URL(
  process.env.NEXT_PUBLIC_SITE_URL || "https://stowplan.lasers.app/",
);

export const PUBLIC_PAGE_PATHS = Object.freeze(["/", "/privacy", "/terms"]);
