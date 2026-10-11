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

## Pipeline (`lib/carryScan/scan.ts`)

```
S0 fetch     DeFiLlama /pools, /lendBorrow, /protocols · Morpho GraphQL · Merkl      sources.ts   (any failure → fail)
S1 universe  Ethereum ∧ stablecoin ∧ every underlying in stables.json → single + LP   universe.ts
S2 filters   TVL ≥ $10M ∧ > 0 · count ≥ 30 · !outlier · apy > 0 · reward ≤ 50% · category/project rules
S3 bench     cheapest same-stable borrow: Aave Core/Prime, Spark, listed blue-chip Morpho, ≥ $5M borrowed   benchmark.ts
             (the same rules bind the on-chain registry reads)
S4 columns   (a) and (b) at $100K / $1M / $10M → positive (a) ∧ positive 30-day-mean (a)                   columns.ts
S5 dedupe    on-app set R1–R4 by 1:<address>; address resolution                     onApp.ts, verify.ts
S6 finalists ≤ 80: chart stability (≤ 20 calls/min), on-chain verify at the finalized anchor, on-chain pricing of lending rows
S7 status    NEW / STILL / RETURNING / DROPPED / NOW ON APP vs the last 8 weekly files  status.ts
S8 gate      publish · hold (churn) · fail closed                                      gate.ts, publish.ts
```

`scripts/carry-scan/run.ts --out <data>/carry-scan [--accept-churn]` runs it and writes the outcome.
Exit codes: 0 published, 1 failed, 2 held for churn review.

## The two columns

- **(a) market carry** = venue net APY at size − Bench(stable, size).
  - A DeFiLlama-only row is priced at size as `apy × TVL/(TVL+size)` (`projected`).
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
- **The fallback snapshot:** produced by a local dry run on 2026-10-11 at about 04:45 UTC (week 2026-W41, anchor block 26,166,806): 13 ranked, 3 with no same-stable benchmark, 26 Unverified; gate 2 agreement USDC 0.010pp, USDT 0.001pp.

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
- **The trailing 7-day cross-check is a flag, not a rank input.** On-chain `convertToAssets` growth over 7 days is compared with DeFiLlama's `apyBase7d` where it is published (167 of 1,315 pools on 2026-10-10, none of the ranked rows), else with the base APY. More than 1pp apart marks the row "source disagreement"; it stays ranked on DeFiLlama's figure. On 2026-10-10 a refuter found that ranking on realized 7-day yield would put steakcUSDC above humaUSDC.
- **Vault APYs are DeFiLlama's `apy`, not Morpho's `netApy`.** The design (§1, §7) said vault rows use Morpho's reported `netApy`; the build prices every row from DeFiLlama, and the page's notes say so. `sources.ts` still fetches `netApy` and `fee` but nothing reads them. The two sources differ by up to about 0.5pp on ranked rows, and the gap is not just the performance fee: on 2026-10-11 humaUSDC (fee 0) read 7.57% on DeFiLlama against 7.04% `netApy`, while steakcUSDC matched to 0.0002pp. Switching sources is an owner decision, since it changes the ranking.
- **R4 waivers hide some routes already on /carry.** The "USDC → Morpho Vault V2" waiver covers a class of 33 seed vaults. Five of this week's 13 ranked rows (reservoirUSDC #5, roxUSDCy #6, hyperUSDCa #8, bbqUSDC V2 #9, gtUSDCf #12) are among them, and Fluid fUSDC #7 is the destination of the waived "USDT → Fluid" route (refuter 2026-10-11), and they show as NEW only because of the waiver. "PYUSD → Morpho Vault V2" lists its 3 vaults instead, which removes SENPYUSDPRIMEV2. Listing the 33 USDC addresses the same way would remove those four. Open question.
- **A working `maxWithdraw` is decided by venue type, not read on-chain.** Morpho Vault V2 is needs-adapter, and so is a queued-exit pool (`poolAddresses.json` `withdraw: "queued"`, or "unstake"/"cooldown" in its pool meta). Any other USDC ERC-4626 is `ready-cv`. `maxWithdraw(owner)` is 0 for any address that holds no shares, so a read needs a real holder. That read is a follow-up.
- **Not done on this branch.** The Q1 contract conflict is not posted to the agent board yet; that needs a membrane-board commit and push. The page and the strip are server-rendered in tests (`carryScanRender`, `carryScanStrip`) but have not been opened in a browser.
- **Banner lag.** The stale (> 8 days) and failed banners are computed server-side under `s-maxage=3600, stale-while-revalidate=86400`, so a cached page can show them up to about 25h late.
