# Cloudflare Workers documentation

The canonical documentation at `docs.stowplan.lasers.app` is an assets-only Cloudflare Worker named `stowplan-docs`. It has no Worker script, runtime bindings, secrets, D1 access, application routes, or authority over the Stowplan application. `wrangler.docs.jsonc` keeps its `workers.dev` route available for bootstrap and provider-level diagnosis while disabling per-version preview URLs.

## Build and validate

The Worker serves the ordinary VitePress output from `docs/.vitepress/dist`. Build the canonical root-hosted artifact and validate both the site and the Worker configuration without deployment credentials:

```bash
DOCS_BASE=/ npm run docs:build
DOCS_BASE=/ npm run docs:check
npm run docs:publish:stamp -- --revision "$(git rev-parse HEAD)"
npm run deploy:docs:dry-run
```

Use `npm run docs:preview` after the build for a local browser preview. The release gate also builds with `DOCS_BASE=/stowplan/` so forks and alternative static hosts retain project-subpath compatibility; production always uses `/`.

## Protected GitHub environment

The Documentation workflow separates verification from deployment authority. Its unprivileged job builds and checks the site, stamps the artifact with the source revision, dry-runs Wrangler, and uploads the exact `docs/.vitepress/dist` directory. Only after that job passes does the `documentation` environment expose deployment authority to a second job, which downloads the same artifact without rebuilding it.

Configure the GitHub Actions environment named `documentation` with a deployment branch policy that allows only `main`, an environment variable named `CLOUDFLARE_ACCOUNT_ID`, and an environment secret named `CLOUDFLARE_WORKERS_DEPLOY_TOKEN`. The secret is an account-owned token limited to the deployment account and Workers Scripts Write. Keep its returned-once value in the maintainer password manager and the GitHub environment only. This token can upload the Worker but cannot change DNS or attach the custom domain.

Routine pushes that change documentation inputs deploy automatically. A maintainer can request an exact redeployment of `main` with:

```bash
gh workflow run docs.yml --ref main
```

The deployment job verifies `https://docs.stowplan.lasers.app/publication.json` identifies the workflow revision, a nested clean URL renders, and an unknown URL uses the VitePress 404 page. This prevents a successful `workers.dev` upload from masking a stale or incorrectly routed canonical hostname.

## First deployment and custom-domain cutover

Keep GitHub Pages enabled until the Worker and canonical hostname both pass. The one-time order is:

1. Merge the Worker configuration and workflow to `main`, then let the deployment step create `stowplan-docs` and its stable `workers.dev` endpoint. The final public-verification step will fail while the canonical hostname still points to Pages; the Worker upload remains available for inspection.
2. Open **Cloudflare Dashboard -> Workers & Pages -> stowplan-docs -> Settings -> Domains & Routes** and verify the `workers.dev` URL serves the expected revision from `/publication.json`.
3. In the `lasers.app` DNS zone, delete the unproxied `docs.stowplan.lasers.app` CNAME that points to `j-256.github.io`. Cloudflare does not permit a Workers Custom Domain on a hostname with an existing CNAME.
4. Immediately choose **Add -> Custom Domain** for `stowplan-docs` and attach `docs.stowplan.lasers.app`. Cloudflare creates the Worker-owned DNS record and certificate. This operation needs separate Workers domain and DNS authority; do not broaden the CI deployment token.
5. Rerun the Documentation workflow from `main`. Require the deploy job and exact public-revision verification to pass, then check the homepage, a nested guide, search assets, and the 404 page in a normal browser.
6. Delete the obsolete Pages site only after the Worker is verified:

```bash
gh api --method DELETE 'repos/{owner}/{repo}/pages'
```

If custom-domain attachment fails before Pages is deleted, remove any partial Worker domain, restore the unproxied CNAME to `j-256.github.io`, and leave the existing Pages site enabled. After Pages retirement, list Worker deployments and roll back to a known version when a documentation deployment is defective:

```bash
npx wrangler deployments list --config wrangler.docs.jsonc
npx wrangler rollback VERSION_ID --config wrangler.docs.jsonc
```

Do not add the custom domain to `wrangler.docs.jsonc`. Keeping it in Cloudflare lets the Workers Scripts Write token remain narrowly scoped and prevents routine deployments from claiming DNS authority.
