# GitHub Pages documentation

GitHub Pages is the canonical docs host and is deliberately independent of the Worker.

1. Push the repository to GitHub.
2. Open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push `main`, or run **Actions → Documentation → Run workflow**.

The checked-in workflow derives `DOCS_BASE` from the Pages site's published base path, uploads `docs/.vitepress/dist`, and deploys through the `github-pages` environment. It uses `/<repository-name>/` on the default project URL and `/` on a custom domain. Both forms are tested locally:

```bash
DOCS_BASE=/stowplan/ npm run docs:build
DOCS_BASE=/stowplan/ npm run docs:preview
DOCS_BASE=/ npm run docs:build
DOCS_BASE=/ npm run docs:preview
```

The base comes from `actions/configure-pages`, and `DOCS_REPOSITORY_URL` is derived from the current GitHub repository, so forks, renamed repositories, and custom domains do not require a source edit. Set the repository variable `DOCS_APPLICATION_URL` when the docs should send **Try Stowplan** to a different application origin. The docs build applies it to every direct demo link, and the build checker verifies those destinations. VitePress rewrites navigation, search assets, the favicon, styles, and JavaScript to the published base. The CI release gate separately builds both a project subpath and `/` to catch host-specific link regressions.

The repository includes an idempotent CLI path for the one-time Pages setting and later manual deployments:

```bash
bash scripts/github-pages.sh status
bash scripts/github-pages.sh enable
bash scripts/github-pages.sh deploy
```

`enable` creates the Pages site when absent or changes its build type to `workflow`; it does not select a branch directory because the custom workflow uploads the built docs artifact directly. `deploy` dispatches `.github/workflows/docs.yml` from the repository's default branch, finds the exact workflow run for that branch head, waits for success, and verifies the published Pages URL. Both commands use the current `gh` repository unless `GH_REPO` is set. Set `PAGES_RUN_DISCOVERY_ATTEMPTS` only if a busy Actions queue needs more than the default discovery window.

The canonical site uses `docs.stowplan.lasers.app` as the repository's Pages custom domain. Cloudflare publishes an unproxied `CNAME` from that hostname to `j-256.github.io`, leaving GitHub Pages responsible for the site and its TLS certificate. The custom Actions workflow does not need a checked-in `CNAME` file.

The workflow uses the current Node 24 LTS and current major releases verified on 2026-07-22: `actions/checkout@v6`, `actions/setup-node@v6`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, and `actions/deploy-pages@v5`.
