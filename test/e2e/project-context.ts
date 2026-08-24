import type {
  BrowserContextOptions,
  Page,
  TestInfo,
} from "@playwright/test";

export function projectContextOptions(
  page: Page,
  testInfo: TestInfo,
): BrowserContextOptions {
  const use = testInfo.project.use as typeof testInfo.project.use &
    BrowserContextOptions;
  return {
    ...use.contextOptions,
    colorScheme: use.colorScheme,
    deviceScaleFactor: use.deviceScaleFactor,
    hasTouch: use.hasTouch,
    isMobile: use.isMobile,
    locale: use.locale,
    reducedMotion: use.reducedMotion,
    screen: use.contextOptions?.screen ?? use.screen,
    timezoneId: use.timezoneId,
    userAgent: use.userAgent,
    viewport: page.viewportSize() ?? use.viewport,
  };
}
