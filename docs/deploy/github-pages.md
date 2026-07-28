# GitHub Pages documentation

GitHub Pages is the canonical docs host and is deliberately independent of the Worker.

1. Push the repository to GitHub.
2. Open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push `main`, or run **Actions → Documentation → Run workflow**.

The checked-in workflow builds with `DOCS_BASE=/<repository-name>/`, uploads `docs/.vitepress/dist`, and deploys through the `github-pages` environment. That subpath build is also tested locally:

```bash
DOCS_BASE=/stowplan/ npm run docs:build
DOCS_BASE=/stowplan/ npm run docs:preview
```

The base is derived from `github.event.repository.name`, and `DOCS_REPOSITORY_URL` is derived from the current GitHub repository, so forks and renamed repositories do not require a source edit. Set the repository variable `DOCS_APPLICATION_URL` when the docs should send **Try Stowplan** to a different application origin. The docs build applies it to every direct demo link, and the build checker verifies those destinations. VitePress rewrites navigation, search assets, the favicon, styles, and JavaScript to the docs subpath. The CI release gate separately builds both a project subpath and `/` to catch host-specific link regressions.

The repository includes an idempotent CLI path for the one-time Pages setting and later manual deployments:

```bash
bash scripts/github-pages.sh status
bash scripts/github-pages.sh enable
bash scripts/github-pages.sh deploy
```

`enable` creates the Pages site when absent or changes its build type to `workflow`; it does not select a branch directory because the custom workflow uploads the built docs artifact directly. `deploy` dispatches `.github/workflows/docs.yml` from the repository's default branch, finds the exact workflow run for that branch head, waits for success, and verifies the published Pages URL. Both commands use the current `gh` repository unless `GH_REPO` is set. Set `PAGES_RUN_DISCOVERY_ATTEMPTS` only if a busy Actions queue needs more than the default discovery window.

For a user/organization Pages repository served at the domain root, set `DOCS_BASE=/` in the workflow. For a custom domain, add the domain in Pages settings and adjust the base only if the site is served from a subpath.

The workflow uses the current Node 24 LTS and current major releases verified on 2026-07-22: `actions/checkout@v6`, `actions/setup-node@v6`, `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, and `actions/deploy-pages@v5`.
