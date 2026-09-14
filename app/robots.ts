import type { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "../src/site-metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: new URL("/sitemap.xml", PUBLIC_SITE_URL).href,
  };
}
