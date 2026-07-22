# GitHub OAuth setup

GitHub OAuth Apps allow one callback URL per app, so use separate OAuth Apps for local and production environments.

## Web UI path

1. Open **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Homepage URL: your Stowplan origin.
3. Authorization callback URL: `https://YOUR_ORIGIN/api/auth/github/callback`.
4. Create the app, generate a client secret, and copy it once into your secret manager.

## CLI/API path

GitHub does not provide a generally available `gh` command to create a user-owned OAuth App. The initial app/client creation is a UI step. Afterward, Cloudflare secret installation is CLI-driven:

```bash
npx wrangler secret put AUTH_GITHUB_CLIENT_ID
npx wrangler secret put AUTH_GITHUB_CLIENT_SECRET
```

Stowplan requests `read:user user:email`, then chooses a verified primary email (or another verified email). It never stores the GitHub access token after profile retrieval.

If login fails, confirm the exact callback, ensure the app was not suspended, verify the client/secret belong to the same environment, and check that the GitHub account exposes at least one verified email through the API.
