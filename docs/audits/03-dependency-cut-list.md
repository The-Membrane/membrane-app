# Phase 0 Audit 3: Dependency Cut List

Produced 2026-07-06 on the `evm-migration` branch. Goal: minimum viable dependencies.

## Package manager: pnpm (confirmed)

- `package.json` has a pnpm-specific `"pnpm": { "overrides": ... }` field; `pnpm-lock.yaml` is
  current (contains `lucide-react`); `package-lock.json` is stale (predates `lucide-react`,
  ~1 year old). **Deleted on this branch.**
- **Dockerfile bug**: installed pnpm, copied `pnpm-lock.yaml`, then ran `npm i` — ignoring the
  lockfile entirely — before `pnpm run build`. **Fixed to `pnpm i --frozen-lockfile`.**

## DELETE NOW (verified dead — removed on this branch)

| Dep | Evidence |
|---|---|
| `@million/lint` | Zero imports; no `withMillion`/plugin in `next.config.mjs` — never wired into the build |
| `@cosmos-kit/keplr-mobile`, `@cosmos-kit/leap-mobile` | Zero imports; usage removed earlier per `docs/load-time-progress.md:88`, package entries forgotten |
| `three`, `@react-three/fiber`, `@react-three/drei` | Only consumers are `components/Visualize/{GalaxyGraph,EventPulse,MyceliumTendril,HexDome}.tsx`, none imported by any live route (the old visualize page is gone). `components/Visualize/` deleted alongside. Settles pixi-vs-three: **pixi wins by default** |
| `package-lock.json` | Stale npm lockfile; pnpm is canonical |

`pixi.js` stays: single import at `components/NeutronHome/pipes/PipesCanvas.tsx:2`, consumer
temporarily commented out (`components/NeutronHome/index.tsx:68`) — paused WIP, and it's the
plan's chosen engine for Phase 3.

## DELETE ON MIGRATION (Cosmos runtime deps — removed at EVM cutover, tracked in audit 01)

`@chain-registry/*`, `chain-registry`, `@cosmjs/*`, `cosmjs-types`, `@cosmos-kit/*` (remaining),
`@osmonauts/math`, `osmojs`, `cosmwasm`, `@cosmwasm/ts-codegen`, `@leapwallet/elements`,
`@skip-go/widget` (+ its `transpilePackages` entry and the chain-registry webpack alias at
`next.config.mjs:9,20-31`). Note: Skip's EVM-mode support unverified — irrelevant if bridging
is dropped, revisit only if an EVM bridge widget is wanted.

## REPLACE WITH NATIVE

- `numeral` → `Intl.NumberFormat` + small abbreviation helper. Isolated to `helpers/formatter.ts`
  (4 call sites, 14 downstream consumers of the wrapper — wrapper API can stay identical). Low risk, do early.
- `dayjs` (11 files, relativeTime + duration plugins; 2 of the 11 were in the deleted Visualize dir)
  → `Intl.RelativeTimeFormat` + small duration util. Moderate effort, after numeral.

## KEEP (verified need)

- `bignumber.js` — decimal-precision token math in `helpers/{math,num}.ts`; BigInt/Number unsafe substitutes.
- `framer-motion` (27 files), Chakra stack (`@chakra-ui/react` in **326 files** — quantified, not touchable this pass), `html-to-image` (share cards), `react-dom`/`typescript`/`eslint`/`prettier`/`tsx`/`@types/react-dom` (depcheck false positives — framework/CLI usage).
- `react-icons` (18) vs `lucide-react` (19): comparable footprint, no cheap consolidation; revisit during page rework. `@chakra-ui/icons` (75 files) rides with Chakra.
- Small-footprint, low priority: `react-hook-form` (4), `tinycolor2` (2), `use-file-picker` (1), `fast-average-color` (1).

## Build-safety debt (flagged, not fixed here)

`next.config.mjs:13-19` sets `typescript.ignoreBuildErrors: true` and
`eslint.ignoreDuringBuilds: true` — type and lint errors ship silently. Worth revisiting once
the EVM migration stabilizes the type surface.
