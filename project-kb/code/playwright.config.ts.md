---
type: Project Code
title: playwright.config.ts
description: Playwright release verification config; runs with system Edge and serial workers.
source_path: playwright.config.ts
tags: [test, e2e, edge, release]
timestamp: 2026-06-23T22:10:00+08:00
---

# playwright.config.ts

## Capability and boundary

This config makes Playwright use the installed Microsoft Edge channel and fixes `workers` to 1. Serial execution is intentional for release verification because each E2E file starts a real production server and temporary DATA_DIR; parallel startup can cause health-check timeouts and resource contention.

## Related files

- `test/e2e/*.spec.ts` covers release main flow, history, terminal input, and failure recovery.
- `test/performance/terminal-throughput.spec.ts` verifies terminal input responsiveness in Edge.
- AGENTS.md requires browser verification to prefer Edge; when no CDP Edge session exists, the system Edge channel is used.

## Verification

Run `node_modules/.bin/playwright.cmd test test/e2e test/performance --project=edge` before release.

# Citations

- [Source](../../playwright.config.ts)