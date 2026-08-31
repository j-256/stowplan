# Retired GitHub Pages documentation

GitHub Pages was the original host for the Stowplan documentation. The canonical site now uses the assets-only [Cloudflare Workers deployment](/deploy/documentation-worker) at the same `docs.stowplan.lasers.app` hostname.

Do not enable Pages as a second publisher for the canonical hostname. During an emergency rollback before the Pages site is deleted, detach the Workers Custom Domain and restore the unproxied `docs.stowplan.lasers.app` CNAME to `j-256.github.io`. After Pages retirement, use a previous `stowplan-docs` Worker deployment instead.

The release gate continues to build the docs with both `/stowplan/` and `/` bases, so a fork may choose GitHub Pages or another project-subpath static host without changing documentation source links.
