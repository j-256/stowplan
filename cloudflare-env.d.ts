declare namespace Cloudflare {
    interface Env {
        ASSETS: Fetcher;
        DB: D1Database;
        AUTH_ACCESS_MIGRATION_ENABLED?: string;
        AUTH_ADMIN_RECOVERY_TOKEN?: string;
        AUTH_ADMIN_REQUIRE_ACCESS?: string;
        AUTH_BASE_URL?: string;
        AUTH_CLOUDFLARE_ACCESS_AUD?: string;
        AUTH_CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
        AUTH_DEV_ALLOWED_HOSTS?: string;
        AUTH_DEV_ENABLED?: string;
        AUTH_GOOGLE_CLIENT_ID?: string;
        AUTH_GOOGLE_CLIENT_SECRET?: string;
        AUTH_IDENTITY_DIGEST_KEY?: string;
        AUTH_SESSION_TTL_SECONDS?: string;
        AUTH_TURNSTILE_SECRET_KEY?: string;
        AUTH_TURNSTILE_SITE_KEY?: string;
        NEXT_PUBLIC_REPOSITORY_URL?: string;
    }
}
