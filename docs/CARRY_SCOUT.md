# Weekly carry scout (umbrella product #10)

A weekly scan of Ethereum stablecoin venues, ranked on **(a) market carry** with **(b) Membrane carry** beside it.
Page: `/[chain]/carry-scout`. Strip: "New this week" on `/carry`, right after the route board.

**v1 design of record:** the workflow design `carry-scout-design.md` (2026-10-10, written against `origin/evm-migration` 661711c5), with the owner answers below applied.
This file records what was built and where it differs from that design.

## Owner answers, 2026-10-10

| # | Question | Answer, as built |
|---|---|---|
| Q1 | Is (b) true after launch? | **Show (b) for ALL rows.** The owner says no owner allowlist will make it into prod, so there is no "no coverage: Cdp rate applies" caveat and no routing of candidates to "scout intake" CuratorVaults. **Conflict, not changed here (a contract question for the agent board):** the contract coverage gate still exists. `Cdp.registerDeploymentVenue` reverts with `VenueNotCoverageEligible` unless `DeploymentVaultFactory.canonicalVenue(venue)` is true (membrane-solidity `contracts/Cdp.sol` ~3176-3182), and `canonicalVenue` requires `canonicalCoverageVault[v]`, set only by the owner-only `registerCanonicalCoverageVault` (`contracts/vaults/DeploymentVaultFactory.sol:241`), which freezes at renounce. With no allowlisted vault, no vault is coverage-eligible, so (b) as shown (no borrow term) is not what a post-launch borrower would get until that gate changes. |
| Q2 | Base yield only for (b)? | **Both.** (b) shows base-only, and base + eligible incentives labelled **"if vaults claim rewards (not yet)"**: `DeploymentVaultBase._claimRewards` is a no-op and CuratorVault has no claim path; a contract task for vault reward claiming is open. (a) keeps eligible incentives with a base-only sub-value. |
| Q3 | Non-USDC stables, and stables with no benchmark? | **Rank every stable that has a benchmark on (a)**; grey out non-USDC rows as **"not deployable yet (vaults hold USDC)"** (a contract task for vault swaps is open). Stables with no same-stable benchmark are listed unranked with (b) only, never borrowing another stable's rate. |
| Q4 | Where does the cron live? | `.github/workflows/carry-scan.yml` **on `main`** (scheduled workflows only run from the default branch). This branch carries the file for review. It checks out the scan code at `inputs.ref || vars.CARRY_SCAN_REF || 'evm-migration'`; until `feat/carry-scout` merges, set the repo variable `CARRY_SCAN_REF=feat/carry-scout`. |

## Owner rulings, 2026-10-11

### Ruling 1: "Vaults should average the APYs with hoverable data to show data sources"

A **vault row** is a MetaMorpho (v1), Morpho Vault V2 or any other ERC-4626 vault (`kind` `metamorpho`, `morpho-vault-v2`, `erc4626`; Euler Earn and Fluid fTokens enter as `erc4626`).
Direct lending reserves (Aave v3, Spark, Euler EVK `euler`) stay priced on-chain through `netBreakdown`. LPs and unresolved rows stay DeFiLlama's.

The rule, as built (`lib/carryScan/venueApy.ts`, stamped into each weekly file as `venueApyRule`):

| | Sources | Figure |
|---|---|---|
| base | DeFiLlama `apyBase` (else `apy − apyReward`), Morpho API `netApyExcludingRewards` (Morpho vaults), on-chain 7-day `convertToAssets` growth (finalists that verified; the anchor vs 50,400 blocks earlier, annualised over the span their block timestamps give, not a nominal 7 days) | **B** = mean of the figures present |
| with rewards | DeFiLlama `apy`, Morpho API `netApy` (after fee, with rewards); the on-chain 7-day growth has no reward view | **W** = mean of one figure per source: its own with-rewards figure, else its base + R̄, where R̄ = mean of (with − base) over the sources that report both (0 when none does) |

- With every source holding a base figure, W = B + R̄ exactly: the base average plus the average reward. With no reward view anywhere, W = B.
- A missing source is left out of the mean, never counted as 0, and is listed as missing. A MetaMorpho or Vault V2 row with no Morpho API entry lists Morpho's two figures as missing ("no Morpho API entry for this vault"), not silently absent. A failed read (a vault younger than 7 days, no archive state, a failed verification) is listed as failed, with its reason.
- At a size, the averaged figure is diluted as before: `× TVL/(TVL+size)`, unpriced above 5% of TVL. (a), (b) and the rank use the averaged figures.
- The scan averages twice: at S4 with DeFiLlama and Morpho (the screen, before any RPC), and at S6 again with the on-chain 7-day figure once a finalist has verified. The 30-day check stays DeFiLlama's `apyMean30d` (no other source has a 30-day mean).
- **Source disagreement**: the averaged figures of one basis spread more than 1pp (max − min). The chip shows the spread. On a non-averaged ERC-4626 row (Euler EVK) the old check stays: 7-day growth vs `apyBase7d`, else the base APY.
- **Stored per row** (schema 2): `venueApy = {method, base, withRewards, spread, sources[]}`, each source `{source, label, basis, value, status, asOf, url, averaged, note}`. The field is `source`, not `name`: a scout row carries no field that reads as a venue-registry name (`carryScanDedupe` "never mints a venue key").
- **Schema**: `schemaVersion` is 2. The loader still reads a version-1 file (the data branch until the first version-2 scan, or an old fallback): `upgradeFile` gives each row a `venueApy` built from what it holds (DeFiLlama's figures, which priced it; the on-chain 7-day figure listed, not averaged) and a `venueApyRule` that says the snapshot predates averaging. `readLatest` also accepts version 1 (gate 1 reads only `counts`).
- **UI**: the venue-APY cell (page row and strip) is a `<button>` that opens a sources panel on hover, keyboard focus and tap: a tap (or Enter/Space) pins it open, a second tap, Escape, a tap outside or focus leaving closes it (`components/CarryScout/ApySources.tsx`, `popoverReducer`). Hover means a mouse or pen pointer only (pointer events): iOS Safari withholds the click from a tap whose mouseover changed the page, so a touch "hover" would make the first tap open, the second pin and only the third close. The panel lists every source with its value, basis, as-of, label class and whether it was averaged, then "N sources averaged (M figures)" (the cell's "avg of N" counts sources too), the means, the spread and the at-size figure. It stays in the markup (`hidden` while closed), so a server render carries every source. It is kept inside the layout viewport (`document.documentElement.clientWidth`): on a phone the open panel widens the page, and `window.innerWidth` then reads the widened width (536px on a 375px screen, 2026-10-11 refuter). A row or strip card rises (`z-index` 1500, `:has([data-apy-open="true"])`) while its panel is open, since a greyed row's grayscale filter makes it a stacking context the next greyed row would otherwise paint over.

### Ruling 2: "we want specific vaults for everything"

A venue counts as on the app **only as a specific contract**. The R4 waivers are gone (`lib/carryScan/onAppAliases.json`, `lib/carryScan/onApp.ts`).
Each /carry route label resolves, through the route-cohort seed (`scripts/route-cohort/aug-2026-ab-vault-seed.json` on `origin/chore/data-capture-snapshot` 72326cac), to the seed route with the same source stable and the same position count, and from it to its destination contract(s):

| Contracts | Meaning | Effect |
|---|---|---|
| one | the label IS that venue | its address joins the on-app set (deduped) |
| several | a route **class** | no address joins the set: a class never hides a vault. A scout row on one of them stays listed, with "also behind /carry route <label>" |
| none | unresolved | counts as nothing; listed below |

| /carry label | Seed route | Positions | Resolves to |
|---|---|---|---|
| AUSD → Staked USDat | AUSD → Staked USDat [USDat] | 15 | 1 contract (on app) |
| apxUSD → ApyUSD | apxUSD → ApyUSD [apxUSD] | 19 | 1 contract (on app) |
| USDT → Fluid | USDT → FluidBridgeAggregatorProxy [USDC] | 15 | Fluid Lite USD Vault, fLiteUSD `0x273da948…` (on app; read on-chain 2026-10-11) |
| USDC → Morpho Vault V2 | USDC → VaultV2 [USDC] | 182 | **class of 33** vaults (annotated) |
| USDS → StUsds | USDS → StUsds [USDS] | 21 | 1 contract (on app) |
| PYUSD → StakingVault | PYUSD → StakingVault [wYLDS] | 26 | 1 contract (on app) |
| USDe → Staked USDe | USDe → Staked USDe [USDe] | 25 | sUSDe (on app) |
| USDC → USD3 | USDC → USD3 [USDC] | 78 | 1 contract (on app) |
| RLUSD → Morpho Vault V2 | RLUSD → VaultV2 [RLUSD] | 37 | 1 contract `0x6dc58a0f…` (on app) |
| USDC → Compound | — | 20 | **unresolved**: the A+B vault seed has no Compound destination (Comet is not ERC-4626). Counts as nothing. |
| PYUSD → Morpho Vault V2 | PYUSD → VaultV2 [PYUSD] | 54 | **class of 3** vaults (annotated; SENPYUSDPRIMEV2 is no longer removed) |
| GHO → UmbrellaStakeToken | GHO → UmbrellaStakeToken [GHO] | 21 | 1 contract (on app) |

- **Correction to the 2026-10-11 refuter note.** The /carry "USDT → Fluid" route's 15 positions all went to fLiteUSD (`0x273da948…`), not Fluid fUSDC (`0x9fb7b447…`). fUSDC is the seed's separate "USDT → Fluid USD Coin [USDC]" route (3 positions), which /carry does not show, so fUSDC is neither deduped nor annotated.
- **Judgment call to confirm:** a label whose name is a class ("RLUSD → Morpho Vault V2") but whose seed positions all went to one contract is treated as that one venue (on the app). If the owner reads such a label as a class, give its entry a second address or move it to the class branch; nothing else changes.
- A contract that is also named on its own elsewhere (R1–R3, or a one-contract label) is on the app; the class note is dropped for it.
- Each weekly file's `notes` list the classes and the unresolved labels, and the page prints them under the table.

## Pipeline (`lib/carryScan/scan.ts`)

```
S0 fetch     DeFiLlama /pools, /lendBorrow, /protocols · Morpho GraphQL · Merkl      sources.ts   (any failure → fail)
S1 universe  Ethereum ∧ stablecoin ∧ every underlying in stables.json → single + LP   universe.ts
S2 filters   TVL ≥ $10M ∧ > 0 · count ≥ 30 · !outlier · apy > 0 · reward ≤ 50% · category/project rules
S3 bench     cheapest same-stable borrow: Aave Core/Prime, Spark, listed blue-chip Morpho, ≥ $5M borrowed   benchmark.ts
             (the same rules bind the on-chain registry reads)
S4 columns   (a) and (b) at $100K / $1M / $10M → positive (a) ∧ positive 30-day-mean (a)                   columns.ts, venueApy.ts
             vault rows: the average of DeFiLlama and the Morpho API (ruling 1)
S5 dedupe    on-app set R1–R4 by 1:<address>; address resolution; a route class annotates  onApp.ts, verify.ts
S6 finalists ≤ 80: chart stability (≤ 20 calls/min), on-chain verify at the finalized anchor, on-chain pricing of lending rows,
             vault rows re-averaged with the on-chain 7-day figure
S7 status    NEW / STILL / RETURNING / DROPPED / NOW ON APP vs the last 8 weekly files  status.ts
S8 gate      publish · hold (churn) · fail closed                                      gate.ts, publish.ts
```

`scripts/carry-scan/run.ts --out <data>/carry-scan [--accept-churn]` runs it and writes the outcome.
Exit codes: 0 published, 1 failed, 2 held for churn review.

## The two columns

- **(a) market carry** = venue net APY at size − Bench(stable, size).
  - A vault row is priced from the AVERAGE of its sources (ruling 1), at size as `average × TVL/(TVL+size)` (`projected`).
  - Any other DeFiLlama-only row is priced at size as `apy × TVL/(TVL+size)` (`projected`).
  - A size above 5% of TVL is unpriced ("size > 5% of TVL") and unranked at that size.
  - A verified Aave v3 / Spark / Euler LinearKink row is re-priced on-chain through `netBreakdown`, and its breakdown is stored.
  - For an LP, Bench = the minimum over its underlying stables; no swap leg is added.
- **(b) Membrane carry** = `aprToApy(membraneSplit(gainApr, shares).user)`, with no borrow term.
  - The shares have no default and a share of 0 throws, so with no share given (b) is an upper bound: "≤ x% · curator-set".
  - The page takes what-if shares and recomputes (b) client-side from the stored gain APRs.

**Benchmark (S3).**
- Where the net-APY registry covers the market (Aave/Spark USDC, USDT, USDS, Aave USDe, the 4 Morpho markets), the rate is the on-chain `netBreakdown(b, {side:'borrow', sizeUsd}).net.apy`.
- A null at size is skipped. It is never read as 0 and never replaced by that market's DeFiLlama rate.
- Every other market uses DeFiLlama `apyBaseBorrow − apyRewardBorrow`, labelled `reported`.
  - For Aave v3 and SparkLend, DeFiLlama's `apyBaseBorrow` is the on-chain APR, not an APY (Spark USDC 4.36881 and PYUSD 4.28875 equal `currentVariableBorrowRate` to 5 dp). S3 converts it with `aprToApy` (`projects.json` `benchmark.borrowRateIsAprProjects`). Morpho rows are already APYs. With the conversion, gate 2's USDC on-chain vs DeFiLlama gap fell from 0.107pp to 0.010pp.
- On-chain registry reads pass the same eligibility rules as DeFiLlama rows (`onchainBenchRejection`). The registry also holds Euler vaults and thin markets: Euler eUSDC-2 / eUSDT-2 and Aave v3 USDS ($0.34M borrowed) are rejected, not ranked. A rejected read still replaces that market's DeFiLlama row.
- On a Morpho row the loan is `mintedCoin`; the row's symbol, underlying and TVL describe the collateral.

## Readiness (`lib/carryScan/readiness.ts`)

| Tier | When |
|---|---|
| `ready-cv` | USDC ERC-4626 (MetaMorpho V1, Euler, other 4626) with instant exits. A CuratorVault curator calls `submitCap`; after the vault's timelock, anyone calls `acceptCap`. |
| `ready-dv` | Aave v3 / Spark USDC reserve: a DeploymentVault from `aave-v3`, venueData `(pool, aToken)` |
| `needs-adapter` | Morpho Vault V2 (`maxWithdraw` = 0), queued-exit vaults (Maple, cooldowns), Compound, LPs, anything not ERC-4626 |
| `not-deployable` | asset is not USDC: "not deployable yet (vaults hold USDC)". Greyed with a grayscale filter, not opacity, so the text keeps its contrast |
| `unresolved` | no deposit contract was found, so the venue type is unknown: "address not resolved", never a guess at the type |

An Unverified row keeps its readiness tier (it says what the venue is) but gets no segue and no CTA.

Blockers G1 (6-decimal USDC vs `CuratorAllocator`) and G3 (no fork conformance test) apply to every USDC row.
The CTA stays disabled until launch, when the factory addresses are in `config/evm/addresses.json` and no blockers remain.
Until then a row reads "After launch: <route>".

## Storage and serving

- **Results:** pushed to an orphan `data` branch, under `carry-scan/{latest.json, status.json, weeks/YYYY-Www.json, borrow-benchmarks/YYYY-Www.json}`. A `vercel.json` at the branch root disables Vercel builds.
- **Two jobs, so the write token never shares a runner with third-party code.**
  - `scan` (read-only token) checks out the scan ref, stops with a named reason if that ref has no carry-scan code, runs `pnpm install`, the carryScan unit tests (gate 5) and the scan, and uploads `data/carry-scan` as an artifact.
  - `publish` (`contents: write`) runs no repo or dependency code. It copies only regular `.json` files from the artifact onto the `data` branch. When the scan job left no result (checkout, setup, install or tests failed, or it was cancelled), it writes a failed `status.json` naming the stage and keeping `lastGoodWeek`, so the page shows "Last scan failed". The token goes per command as an HTTP header, never into a remote URL or `.git/config`.
  - The artifact also holds the data-branch copy the scan started from. A `status.json` byte-identical to the data branch's means the scan step died before writing one (an OOM kill, a broken import), so it counts as no result and gets a failed status too.
- **Serving:** `lib/carryScan/load.ts` reads raw.githubusercontent.com in `getServerSideProps`, with `s-maxage=3600, stale-while-revalidate=86400`. On any failure it falls back to the committed `public/data/carry-scan-fallback.json`.
- **The strip:** reads `/api/carry-scan?view=strip`.
- **The fallback snapshot:** schema 2, produced by a local dry run on 2026-10-11 at about 14:44 UTC (week 2026-W41, anchor block 26,169,803) with both owner rulings and the refuter fixes applied (fluid-lite resolved, 7-day figure annualised over block timestamps): 14 ranked, 3 with no same-stable benchmark, 26 Unverified, 0 LP; 5 removed as on the app (fLiteUSD among them), 6 kept with "also behind /carry route"; gate 2 agreement USDC 0.010pp, USDT 0.001pp. Three ranked rows carry "source disagreement" (reservoirUSDC base spread 1.25pp, humaUSDC 1.07pp, gtUSDCf 1.31pp). Fluid fUSDC (#7 in the earlier snapshot) left on the stability gate (current APY about 2× its 90-day median), not on ruling 2.

## Deviations from the design

- **Universe.** `stables.json` lists 32 plain USD stables, read back on-chain. Yield-bearing wrappers are not listed, so 529 pools dropped as "an underlying is not a listed USD stable" on 2026-10-11.
- **Filters.** Stable LPs need a category in `lpCategoryAllow` (Dexs, Yield, Yield Aggregator), since the design's category list has no Dexs. Pools need apy > 0. `projectDeny` removes zerobase-cedefi (yield earned off-chain) and pendle-v2 (Pendle PTs are out of scope, design §7).
- **Gate 1.** A single failed 90-day chart call sends its row to Unverified. The run fails only when more than half the finalists' chart calls fail.
- **Gate 3.** The 50% share counts only finalists that resolved to an address. Finalists with not one resolved address fail closed.
- **Gate 4.** The first run, with no earlier weekly file, is exempt from the churn hold, since every row is NEW by definition.
- **Copy guard.** `ZERO_OR_FREE` (`format.ts`) flags only a standalone 0 / 0.00% / $0 / "free". The design's literal pattern also matched "10%".

## Known gaps and follow-ups

- **Address resolution.** Only Morpho vaults (GraphQL), Aave/Spark reserves (`getReserveData`) and the hand-kept `poolAddresses.json` resolve. Every other finalist is listed as Unverified. On 2026-10-10 that was 21 rows, among them Sentora, Lagoon, Yearn, fluid-lite, Ember, ether.fi Liquid, Fluid USDT/GHO and Spark Savings USDT.
- **Maple syrup pools fail the ±15% TVL check.** On-chain `totalAssets` is about 40% of DeFiLlama's TVL, so they stay Unverified until the gap is explained.
- **`KNOWN_VENUES` sfrxUSD has no code.** `lib/position-sim/venues.ts` lists sfrxUSD at `0xcF62F305562bA0170A4fa456be9BcB6fa6Ca6A70`, which has no code on mainnet. The live vault is `0xcf62F905562626CfcDD2261162a51fd02Fc9c5b6` (read 2026-10-10). R3 therefore does not dedupe the real vault. It is excluded today only by its DeFiLlama category.
- **DeFiLlama benchmark rows do not vary with size.** A DeFiLlama benchmark row is used at $10M even when the market holds less spare liquidity than that. A size-aware check (supply − borrow ≥ size) is a cheap follow-up.
- **Ruled 2026-10-11 (ruling 1): vault APYs are averaged.** Before, the trailing 7-day figure was only a flag and every row was priced on DeFiLlama's `apy`, which differed from Morpho's `netApy` by up to about 0.5pp on ranked rows (humaUSDC, fee 0: 7.57% vs 7.04%). Both now enter the average with the 7-day figure.
- **Ruled 2026-10-11 (ruling 2): no R4 waivers.** The "USDC → Morpho Vault V2" class (33 vaults) and "PYUSD → Morpho Vault V2" (3) annotate their rows instead of hiding or ignoring them; "USDT → Fluid" resolves to fLiteUSD; "USDC → Compound" is unresolved.
- **Fixed 2026-10-11: fluid-lite USDC is deduped.** DeFiLlama's fluid-lite USDC pool (`488f06db-5a36-450e-9ba9-b4321be39c7c`) is fLiteUSD (`0x273da948…`), the one-contract /carry route "USDT → Fluid". It had no resolver, so the first schema-2 snapshot listed it as an Unverified row on a page of venues not on the app (and the dedupe test skipped keyless rows). `poolAddresses.json` now maps it (symbol `fLiteUSD`, asset USDC, `totalAssets` $43.84M vs DeFiLlama $43.80M, read at block 26,169,803), S5 removes it, and `carryScanDedupe` checks every snapshot row, keyed or not, through `poolAddresses.json`.
- **Fixed 2026-10-11: the 7-day figure's span.** The 50,400 blocks behind the anchor span more than 7 days when slots are missed (7.025 days at block 26,169,675). Annualising over a nominal 7 days overstated the figure (reservoirUSDC 5.625% vs about 5.605%); it is now annualised over the span the two blocks' timestamps give. A failed timestamp read leaves the source listed as failed, like any failed 7-day read.
- **A working `maxWithdraw` is decided by venue type, not read on-chain.** Morpho Vault V2 is needs-adapter, and so is a queued-exit pool (`poolAddresses.json` `withdraw: "queued"`, or "unstake"/"cooldown" in its pool meta). Any other USDC ERC-4626 is `ready-cv`. `maxWithdraw(owner)` is 0 for any address that holds no shares, so a read needs a real holder. That read is a follow-up.
- **Not done on this branch.** The Q1 contract conflict is not posted to the agent board yet; that needs a membrane-board commit and push. The page and the strip are server-rendered in tests (`carryScanRender`, `carryScanStrip`). The 2026-10-11 refuter opened a row's sources popover in a browser (desktop, and 375px mobile emulation): hover, click to pin, outside click, Tab, Escape and hydration worked; the viewport clamp overflowed the phone screen. The clamp fix (`layoutViewportWidth`, `panelShiftX`), the touch-is-never-hover wiring (`hoverEventFor`) and the raised open row are unit-tested as pure helpers and server-rendered markup, and have not been re-opened in a browser. A real touch tap (iOS Safari, Android Chrome) is untested.
- **Banner lag.** The stale (> 8 days) and failed banners are computed server-side under `s-maxage=3600, stale-while-revalidate=86400`, so a cached page can show them up to about 25h late.
