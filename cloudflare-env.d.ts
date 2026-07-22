declare namespace Cloudflare {
    interface Env {
        ASSETS: Fetcher;
        DB: D1Database;
        AUTH_ADMIN_EMAILS?: string;
        AUTH_ADMIN_REQUIRE_ACCESS?: string;
        AUTH_BASE_URL?: string;
        AUTH_CLOUDFLARE_ACCESS_AUD?: string;
        AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
        AUTH_DEV_ENABLED?: string;
        AUTH_GITHUB_CLIENT_ID?: string;
        AUTH_GITHUB_CLIENT_SECRET?: string;
        AUTH_GOOGLE_CLIENT_ID?: string;
        AUTH_GOOGLE_CLIENT_SECRET?: string;
        AUTH_SESSION_TTL_SECONDS?: string;
        NEXT_PUBLIC_REPOSITORY_URL?: string;
    }
}
