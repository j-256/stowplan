export const BROWSER_PROJECTS = Object.freeze({
  phone: "mobile-chromium",
  landscapePhone: "mobile-landscape",
  tablet: "tablet-portrait",
  landscapeTablet: "tablet-landscape",
  compactDesktop: "desktop-compact",
  desktop: "desktop-chromium",
  webkitPhone: "webkit-phone",
  webkitTablet: "webkit-tablet-landscape",
});

export type BrowserProject =
  typeof BROWSER_PROJECTS[keyof typeof BROWSER_PROJECTS];

const PROJECT_TAG_PREFIX = "@project:";

export function forProjects(
  projects: readonly BrowserProject[],
  description?: string,
) {
  if (projects.length === 0) {
    throw new Error("A browser test must select at least one project");
  }
  return {
    tag: projects.map(project => `${PROJECT_TAG_PREFIX}${project}`),
    ...(description ? { annotation: { type: "coverage", description } } : {}),
  };
}

export function projectFilter(project: string): RegExp {
  if (!Object.values(BROWSER_PROJECTS).includes(project as BrowserProject)) {
    throw new Error(`Unknown browser project: ${project}`);
  }
  return new RegExp(
    `^(?!.*${PROJECT_TAG_PREFIX})|${PROJECT_TAG_PREFIX}${project}(?:\\s|$)`,
  );
}

// Keep project order intact while balancing the heavier phone and desktop flows
export const BROWSER_SHARDS: readonly (readonly BrowserProject[])[] = [
  [BROWSER_PROJECTS.phone, BROWSER_PROJECTS.webkitPhone, BROWSER_PROJECTS.webkitTablet],
  [BROWSER_PROJECTS.desktop],
  [BROWSER_PROJECTS.landscapePhone, BROWSER_PROJECTS.tablet],
  [BROWSER_PROJECTS.landscapeTablet, BROWSER_PROJECTS.compactDesktop],
];

export function projectsForShard(shard: string | undefined) {
  if (!shard || !/^[1-9]\d*$/.test(shard)) {
    throw new Error("STOWPLAN_BROWSER_SHARD must select a configured shard");
  }
  const projects = BROWSER_SHARDS[Number(shard) - 1];
  if (!projects) {
    throw new Error(`Unknown browser shard: ${shard}`);
  }
  return projects;
}
