# Light Mode ("Parchment") — CSS Variable Migration Scope

**Status:** ALL PHASES SHIPPED 2026-09-04. Phase 0+1: 66df17e9. Phase 2: 7650161f.
Phase 3: e86c6186 (~250 literals across 50+ files; grep budget for palette literals
outside comments is zero-equivalent). Phase 4: 040cf7ca (theme e2e spec; theme +
smoke suites 10/10). Dark stays the default; the nav toggle follows system
preference. Light text scale is espresso (user-approved): #43331f / #6b5942 /
#94836a, espresso hairlines. Added tokens: --m-border-faint, --m-overlay.

IMPLEMENTATION NOTES:
- Theme attribute is `data-membrane-theme` (namespaced) — Chakra's
  ColorModeProvider re-stamps plain `[data-theme]` on hydration and clobbers it.
- Canvas can parse neither var() nor color-mix(): canvas values resolve via
  helpers/resolveToken.ts + JS alpha composition; DOM alpha variants use color-mix.
- Intentional literals that remain: Chakra phosphor/teal ramps and accent entries
  in config/defaults.ts (CTA fills stay phosphor both themes), bespoke series
  tints (NeutronMint ASSET_COLORS rainbow, RiskChart #fbbf24, ProgressBar
  #c19a3a), RainbowKit accentColor in _app, theme-color maps in
  _document/useThemeMode, and the legacy cyan neon headline on the storefront
  TOS page (candidate for a Living Typeface redesign, out of palette scope).

**Strategy:** Keep every `SEMANTIC_COLORS` token name. Change the values from hex
strings to `var(--m-*)` references. Define both palettes on `:root[data-theme]`.
The 282 importing files then switch with zero edits. Only code that *parses* a token
as hex needs work.

---

## Palette

| Token | Dark (current) | Light (Parchment) |
|---|---|---|
| bgPrimary | `#09090a` | `#e7dfcc` |
| bgSecondary (card) | `#0e0d10` | `#efe9d9` |
| bgTertiary (raised) | `#100f12` | `#f5f0e3` |
| textPrimary | `#ece6d8` bone | `#1c1a14` ink |
| textSecondary | `#8d877b` | `#5b5443` |
| textTertiary | `#56524a` | `#8b8371` |
| primary / success | `#9bdc4f` phosphor | `#3f7212` moss (text use) |
| secondary / info | `#46d39a` teal | `#0f6b4b` |
| warning | `#d8b24a` | `#7f651a` |
| danger | `#cf4034` | `#a92e22` |
| borderSubtle / Medium | bone @ 0.10 | ink @ 0.14 |
| borderStrong | bone @ 0.22 | ink @ 0.30 |

CTA button fill stays phosphor `#9bdc4f` with ink text in both modes. All light-mode
text tokens pass WCAG 4.5:1 on their surfaces.

Logo: `components/Logo.tsx` now has `variant="bone" | "ink"`;
`public/images/membrane-wordmark-ink.svg` shipped in commit `70115daa`. Phase 0 wires
the variant to the active theme.

---

## Phase 0 — Token layer (small, enables everything)

1. New `styles/themes.css` (or a block in the global stylesheet): both palettes as
   `--m-*` custom properties under `:root[data-theme='dark']` and
   `:root[data-theme='light']`.
2. `config/semanticColors.ts`: values become `var(--m-...)`. Token names stay.
3. Theme boot: inline script in `pages/_document.tsx` stamps `data-theme` before
   paint (localStorage `membrane.theme`, fallback `prefers-color-scheme`), so there
   is no flash of wrong theme. Default: dark.
4. Toggle control in `components/HorizontalNav.tsx`; writes localStorage and the
   attribute.
5. `components/Logo.tsx` reads the active theme and picks the ink variant.
6. `pages/_document.tsx:17` `theme-color` meta follows the stamped theme.

## Phase 1 — Hex parsers (BREAKS without this, do with Phase 0)

Canvas code needs resolved color strings; the Canvas 2D API leaves `var()`
unresolved and silently keeps the last valid fillStyle.

1. Add one shared resolver, e.g. `helpers/resolveToken.ts`:
   `getComputedStyle(el).getPropertyValue('--m-danger')`, cached per paint.
2. `components/Position/utils.ts:23-29` `withAlpha` + call sites at `:180`, `:214`,
   `:242-243`, `:278`, `:300` — resolve first, then apply alpha (or
   `color-mix(...)` where the target is CSS, resolver where the target is canvas).
3. `components/EarnPage/utils.ts:7-12` — same helper pattern; confirm call sites
   before editing.
4. Canvas paints: `components/Position/DeliveriesChart.tsx:80`,
   `components/Position/ThroughputHero.tsx`, `components/Position/utils.ts:57`
   (`drawChart`) — route colors through the resolver.

## Phase 2 — Duplicate token sources (parallel swap, mechanical)

These hardcode palette hexes and would stay dark-themed without a swap:

- `helpers/typography.ts:64-105` `TEXT_STYLES` inline hexes → `var(--m-*)`.
- `config/transitions.ts` (18 hits, hairline rgba values) → `var(--m-border-*)`.
- `theme/components/*` (input.ts and siblings) and `theme/colors.ts` /
  `config/defaults.ts` ramps.
- `config/chartTheme.tsx:23-44` axis and series palette.
- `config/dittoThemes.ts` (12 hits).
- `pages/_document.tsx:17` theme-color meta (covered in Phase 0).

## Phase 3 — Component long tail (staged, non-blocking)

Top literal-hex offenders by hit count: `components/Home/CyberpunkHome.tsx` (22),
`components/Home/StorefrontTOSModal.tsx` (18), `StorefrontRulesSection.tsx` (12),
`LevelsDisplay.tsx` (11), `LevelsControlPanel.tsx` (9), `components/HorizontalNav.tsx`
(8), `components/NeutronMint/CollateralRow.tsx` (6), `components/Bid/RiskChart.tsx`
(6, incl. the `:91` label fallback). Plus canvas constants in
`components/Builder/hooks/useBuilderEngine.ts`, `components/Defend/hooks/useCanvasPainter.ts`,
`lib/position-sim/share.ts`, `components/Carry/OracleCard.tsx`.

Dark remains default, so these render correctly in dark mode on day one and migrate
file by file. Track with a grep budget: `#ece6d8|#09090a|#9bdc4f|#46d39a` count
trending to zero outside `themes.css`.

## Phase 4 — Verification

- Playwright: existing computed-style assertions keep passing (browser resolves
  `var()` in computed style). Add one spec that flips `data-theme` and asserts page
  and card backgrounds.
- Contrast check on the light palette tokens (all pass 4.5:1 at scoping time).
- Visual smoke of the five key pages in both themes.

---

## Confirmed non-breakage (from the code sweep)

- Chakra style props: pass-through to CSS, `var()` resolves. 282 importer files need
  zero edits.
- Recharts (`components/Carry/CrossingChart.tsx:60-86`,
  `components/Bid/RiskChart.tsx:91,173`): SVG presentation attributes resolve
  `var()`.
- Template literals like `` `1px solid ${token}` ``: safe, still a valid CSS value.
- `tinycolor2` call sites (`components/ManagedMarkets/IncreaseExposureCards.tsx:6`,
  `components/NeutronHome/hooks/useMyceliumState.ts:5`): tokens only appear as
  Chakra-prop fallbacks, never parsed. Fragile if usage changes; noted.
- Playwright `toHaveCSS` assertions: compare post-resolution computed values.

## Risks

1. **Silent canvas failures.** Canvas ignores bad color strings instead of throwing.
   Phase 1 must land in the same PR as Phase 0.
2. **Duplicate palettes drift.** `chartTheme.tsx`, `dittoThemes.ts`, and the canvas
   constant files each hold their own hexes; any missed file reads as a dark-mode
   island inside light mode. The grep budget in Phase 3 is the guard.
3. **Worktree copies.** `.claude/worktrees/*` mirror several affected files; a merge
   from those branches reintroduces raw hexes. Re-run the sweep after any worktree
   merge.
4. **SSR flash.** Stamping `data-theme` after hydration flashes dark for light-mode
   users. The inline `_document` script (Phase 0.3) is the fix; keep it tiny.

## Effort

| Phase | Size |
|---|---|
| 0 + 1 (must ship together) | ~1 day |
| 2 | ~0.5 day, mechanical |
| 3 | 1–2 days, stageable file by file |
| 4 | ~0.5 day |
