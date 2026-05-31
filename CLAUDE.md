# CLAUDE.md

This file gives Claude Code project context for `nocode-inventory-sync`.

## Project Overview

This is a Vite + React inventory counting tool for factory/warehouse use. The app supports two main workflows:

- Half-finished inventory: guided entry for material attributes, roll specs, quantities, area calculation, sync, preview, and Excel export.
- Finished inventory: guided entry for product code, product name lookup from uploaded Excel data, roll quantities, tail quantities, sync, preview, and Excel export.

The app is intended to run both as a browser-based Vite app and as a packaged local EXE that starts a local web server for PC/mobile use on the same LAN.

## Common Commands

```bash
npm install
npm run dev
npm run build
npm run build:exe:web
npm run build:exe
```

Notes:

- Dev server defaults to port `8080` and listens on LAN addresses.
- `npm run build` should output to `build/` in normal local builds.
- `npm run lint` currently exists in `package.json`, but the repo has no ESLint config, so it fails until a config is added.
- The README mentions Node 16, but the current Vite/React stack also builds under the installed local environment used here.

## Important Files

- `src/pages/Index.jsx`: main application logic and UI. This contains most state, guided question flow, sync, import, preview, and export behavior.
- `src/lib/inventoryTools.js`: Excel source-data cleanup, field inference, grouping, formula reference sheet, and inventory workbook export helpers.
- `src/components/SelectionQuestion.jsx`: mobile-friendly selection buttons with touch/click duplicate-submit guards.
- `src/components/CustomKeypad.jsx`: numeric keypad used by guided input questions.
- `vite.config.js`: Vite config plus the development local-sync API used by PC/mobile sync during development.
- `scripts/exe-server.cjs`: local server runtime used by packaged EXE.
- `scripts/package-exe.ps1`: Windows packaging script.
- `同步说明.md`: user-facing sync workflow notes.
- `EXE使用说明.md`: Windows EXE usage and troubleshooting notes.

## Data And Sync Model

The app uses a `syncBatch` value to group records from the same counting session. The default batch is the current date, and the batch is also stored in `localStorage` and URL query params.

In development, `USE_LOCAL_SYNC_IN_DEV` sends sync reads/writes to the Vite middleware endpoint:

- `GET /__local_sync__/inventory?batch=...`
- `POST /__local_sync__/inventory`
- `DELETE /__local_sync__/inventory?batch=...`
- `GET /__local_sync__/network`

The local dev sync store is persisted under the OS temp directory at `.nocode-dev-logs/inventory-sync-store.json`, so dev-server restarts do not immediately wipe in-progress local sync data.

Outside dev/local-sync mode, records go through `Inventory` from `src/integrations/backend/entities.js`.

## Export Behavior

Excel export builds separate sheets depending on available data:

- Half-finished product sheet: grouped by sequence/product identity, with combined specs and area totals.
- Finished product sheet: product code/name, quantity detail, and total quantity.
- Raw records sheet: full record dump for troubleshooting.

When changing save/export behavior, be careful with React state timing. Some handlers save a just-created record and immediately export, so the export path must receive that saved record explicitly instead of assuming `setState` has already landed.

## Implementation Notes

- Keep changes scoped. `Index.jsx` is large and stateful; prefer extracting only when it materially reduces risk or duplication.
- Avoid changing Excel column names lightly. Users may depend on current exported headers.
- Do not store secrets, tokens, cookies, or backend credentials in the repo.
- For mobile interactions, preserve duplicate-submit guards. Touch devices can emit both pointer and click events.
- For LAN/mobile testing, use the Network URL printed by Vite or the EXE runtime, not `127.0.0.1` from a phone.
- If adding tests later, prioritize `src/lib/inventoryTools.js` first because it is the easiest place to cover parsing, grouping, and workbook output logic.

## Current Known Gaps

- ESLint is configured as a script but no ESLint config file is present.
- `Index.jsx` still mixes UI, workflow state, sync, and export orchestration in one component.
- The `xlsx` dependency is large; it is currently split into its own build chunk, but source-data import still loads it at app startup because it is statically imported.
