---
layout: home
title: Stowplan
hero:
  name: Stowplan
  text: Know where everything lives.
  tagline: A mobile-first, local-first organizer for boxes, cabinets, drawers, and every container inside them.
  actions:
    - theme: brand
      text: Start the first pass
      link: /guide/getting-started
    - theme: alt
      text: Deploy Stowplan
      link: /deploy/
features:
  - title: Capture without friction
    details: Label a container, enter quantity + unit + item, add nested containers in place, and jump to the next uncounted space.
  - title: Keep working through outages
    details: Every command commits to IndexedDB first. Server backup is delayed, batched, idempotent, and never required for continued organizing.
  - title: Make explainable moves
    details: Plans consider suitability, capacity, grouping, access, distance, and whole-container moves. Every completed change is reversible.
---

Stowplan is free-tier-friendly and adapter-oriented. Cloudflare Workers + D1 is the reference production deployment; the domain, sync protocol, and storage contract do not depend on Cloudflare.
