import type { MetadataRoute } from "next";
import { PUBLIC_PAGE_PATHS, PUBLIC_SITE_URL } from "../src/site-metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PAGE_PATHS.map((path) => ({
    url: new URL(path, PUBLIC_SITE_URL).href,
  }));
}
