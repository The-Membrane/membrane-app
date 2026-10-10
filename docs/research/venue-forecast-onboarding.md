# Venue forecast onboarding

**Implementation map, 2026-10-07.** This is the next-venue and maintenance contract; it does not advance the dated [runtime coverage checkpoints](venue-forecast-coverage-25.md). Keep the frozen August cohort unchanged and enroll new subjects in an explicit, versioned supplemental cohort.

```text
Exact subject + native final payout + complete exit mechanism
  ├─ fresh agreed source → holder stages, clocks, windows and fees
  ├─ sealed own cash history → conditional sampled endpoint cash paths
  └─ transfer-complete reserve flows + same-source holder execution
       → conditional exit headroom
Sparse own history → disclosed mechanical bounds / proposed mechanism analog scenarios
                     (neither is calibrated probability)
```

## 1. Define the object before collecting data

Register chain, route, destination and deployed implementation; requested **final token address and decimals**; holder/receiver/authority; and the complete sequence of share conversion, request, queue, claim, swap and delivery stages. Share units and intermediate-token units are separate from payout Q. Bind code/implementation and current parameters to the same finalized header; a later implementation or fee rule is a new mechanism version. The [trusted subject resolver](../../lib/carry/holderExitSubjectRegistry.ts#L165) and [mechanism evidence gate](../../lib/carry/holderExitMechanisms.ts#L93) are the current abstraction boundary.

For the four current foreign-payout gaps, the missing route composition is AUSD: shares → queued USDat → USDC → AUSD; PYUSD: PRIME → wYLDS/admin settlement → USDC → PYUSD; PT wrapper: borrower collateral → PT → USDe; Fluid USDT: vault USDC → USDT. Collect native amounts, ownership and independently attested conversion/delivery evidence for **every** leg. First-leg cash or a quote alone cannot establish final payout. Preserve existing-ticket entitlements separately from a new Q.

### Foreign-payout ticket quotes

Saturn's `claim(tokenId)` takes no partial amount. Quote the **whole recorded USDat owed** for the independently owned ticket; retain sufficient, insufficient or unknown funding separately. Historical conversion quotes must use that same native input. A missing size bucket requires an exact-size capture, never linear rescaling or clipping the ticket amount to current cash. Subtract original AUSD Q once after the sized USDat → USDC → AUSD quote calculation.

A recorded owed amount is conditional on delivery: raw status does not establish an enum meaning, fees or deployed-source equivalence. An independently simulated owner claim provides the actual return amount; keep its `claim_return` basis separate from `recorded_owed_if_delivered` with unknown fees. Agree the optional raw request tuple independently across two origins, and agree conversion quote, basis and fee metadata together or clear them together. Optional disagreement must preserve the agreed core holder assay and execution status. The [native bridge](../../lib/carry/holderExitAssessment.ts) retains these channels without promoting final AUSD payout.

Historical quote targets are conversion-quote clocks, not promised queue release or holder payment times. Preserve unknown release, restrictions and censoring, and distinguish historical backtests from fresh conditional quotes. No new network capture is established by these rules. Verify actual emitted source pins before changing transport: installed Viem **2.54.6** passes EIP-1898 block-hash/canonical parameters through `readContract`, `call`, `getCode` and `getStorageAt`, as checked by the [offline SDK wire test](../../tests/unit/saturnTicketConversionQuote.test.ts). Do not infer a pin defect from older SDK behavior.

## 2. Keep cash, flow and execution evidence distinct

| Evidence | Sound use | Required next evidence for full exit capacity |
|---|---|---|
| Underlying `balanceOf(destination)` | Conditional sampled **endpoint cash proxy** | Pullable allocated liquidity, authority, gates, final delivery and exact-holder execution |
| Cash difference | Net change combining inflows/outflows | Complete reserve transfers to identify gross directions |
| Deposit/Withdraw contract events | Those event amounts in their native units | Settlement reconciliation and omitted borrow/repay/allocation/fee movements |
| Same-holder withdrawal simulation | Present execution at its checked source | Conditional future assumptions and dated outcomes; never a mined payout claim |

The [cash collector](../../scripts/backfill-carry-cash-archive.mjs#L303) reads underlying balance and decimals. **Morpho idle vault cash is not maximum withdrawable assets:** allocated markets may supply liquidity during withdrawal. Cash below Q therefore does not establish holder failure; the [generic claim](../../lib/carry/conditionalSampledCashPathProjection.ts#L400) states this, while the [Morpho reader](../../lib/carry/morphoExitQuote.ts#L257) tests the actual withdrawal call.

For reserve flow, require `startCash + grossIn − grossOut = endCash`, complete block/time coverage, and separately classified supplier subsets. The [existing join](../../scripts/research/aave-usdc-cash-direct-flow-join.mjs#L474) enforces this conservation. Expected **other-user** flows remain joint historical scenarios: do not combine independent inflow/outflow percentiles, count net cash changes again as gross flow, or reserve Q twice. Current [Aave scenarios](../../lib/carry/conditionalGrossFlowHeadroom.ts#L185) floor each joint translated reserve balance and subtract Q once.

## 3. Use own history when available

The implemented generic method has static pins for **64 native-payout subjects**. Verified extraction retains source blocks/hashes, exact units, predeployment coverage and interior holes. It partitions complete eight-observation paths advancing seven observations; rejects gap-crossing paths; translates cumulative changes from fresh cash, floors each path at zero, then subtracts Q. It averages those floored outcomes using raw rationals and retains empirical joint ranges, earliest physical trough ties and every sampled shortfall run. [Implementation](../../lib/carry/conditionalSampledCashPathProjection.ts#L321).

Publish all seven **observed** elapsed-time horizons and their future target brackets. Daily anchors do not imply exact H24, interpolation or continuous below-Q duration. Preserve onset/recovery brackets and left/right censoring. Use the shared 30-minute current-source limit; history must precede C2, genuine receipt/read clocks must precede issue time, and targets must remain future at render. Browser selection recomputes the full result against frozen history pins and external native Q/current metadata: [selector](../../lib/carry/conditionalSampledCashPathProjection.ts#L439).

The observed maximum sampled net depletion is not a protocol-enforced maximum outflow. A hard flow bound requires an attested contract limit, correct scope and reset interval, all bypass paths, and its current configuration. Unlimited or unassessed outflow has no invented finite bound.

## 4. Cold start: mechanical bounds and conditional analog cash

Known cooldown expiry, inclusive claim windows and attested fee endpoints can provide a conditional **not-before** bound immediately. Unknown authority release, queue service or final conversion leaves completion's upper bound unknown. Do not turn a claim-window end into a promised completion deadline, interpolate a fee curve from two quotes, or reuse an older ticket's eligibility for new Q. The [mechanical projection](../../lib/carry/holderExitMechanicalProjection.ts#L294) preserves windows and unknown restrictions; [fee/ticket prongs](../../lib/carry/holderExitMechanicalProjection.ts#L407) retain exact amounts and independent entitlements.

For queues, identify actual ordering/priority, amounts ahead, cancellations, partial fills, admission rules, service capacity and conversion conditions. Expected aggregate cash does not prove that this holder reaches the front. Any modeled service scenario must conserve both cash and queued claims.

A same-mechanism analog fallback is **implemented for conditional native cash only** in the [analog builder](../../lib/carry/venueForecastAnalogPrior.ts#L142). The [reviewed profile registry](../../lib/carry/analogCashProfileRegistry.server.ts#L80) requires matching mechanism family/version, cash meaning and asset risk class. The [server issuer](../../lib/carry/analogCashScenarioIssuer.server.ts#L178) uses authenticated donor history only when verified own native history is insufficient, binding fresh current source, native assets/units, Q and horizon; the [forecast API](../../pages/api/carry/forecast.ts#L2520) supplies this fallback and the [card selector](../../components/Carry/ExitPressureCard.tsx#L2357) checks the same question and source before displaying it. Donor endpoint intervals retain their identities, dates, cadence and actual cash-before normalization denominator, with explicit constant-rate interpolation/extrapolation assumptions. Future news and regime changes remain unknown; daily donors do not establish hourly observations. Holder entitlement (`Ea`), authority, allocated pullability, queue/service, admission, initial-deposit effects and final conversion/delivery remain unresolved. Historical extremes are not confidence bands; conditional ranges do not establish calibrated success probability, executable exit or a full-holder forecast. Do not conceal sparse own history by mixing analogs into an “own history” label.

## 5. Exact holder and maintainable onboarding

Keep two independently bound holder uses distinct. The [execution-backed holder selector](../../lib/carry/conditionalHolderFlowProjection.ts#L129) requires the same route, owner, native Q, final asset and source header to pass agreed full-route execution and every required mechanical prong. A conditional capacity scenario may instead use independently agreed final-native holder entitlement even when the requested withdrawal reverts: validate the [capacity agreement](../../lib/carry/holderExitCapacity.ts) against that exact owner, Q, asset, source and issue clock, apply protocol prongs before clipping by entitlement, then subtract Q once. Intermediate receipts and staged assets do not become final-native entitlement. The [API source reference](../../pages/api/carry/holder-exit-assessment.ts) pins the source check. Neither future result establishes execution, prospective validation or a calibrated probability. Qualification comes later from immutable issue records and untouched dated outcomes for that exact question.

The checked-in [offline generator](../../scripts/research/carry-sampled-cash-history-pins.mjs) reproduces **64 native-payout pins** from fixed registered roots and SHA-linked receipt prefixes. Version 1 fixes the core grid through October 3 (237-receipt prefix) and supplemental USDe through October 4 (120-receipt prefix); later appends or backfills do not move those cutoffs. It reuses the existing ledger verifiers and compact-history adapter, preserves actual source/availability clocks and gaps, and rejects foreign payout identities. The [versioned pin artifact](../../data/research/venue-signals/conditional-sampled-cash-history-v1.pins.json) is separate from its [audit histories](../../data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json); the audit file is not a browser import. The embedded browser table remains unchanged pending review of exact parity.

```sh
NODE_OPTIONS=--max-old-space-size=384 node --import tsx scripts/research/carry-sampled-cash-history-pins.mjs generate --cohort frozen-aug2026-plus-aave-usde-v1 --version 1
NODE_OPTIONS=--max-old-space-size=384 node --import tsx scripts/research/carry-sampled-cash-history-pins.mjs check --cohort frozen-aug2026-plus-aave-usde-v1 --version 1
```

Generation is exclusive and refuses existing outputs; with the committed artifacts present, use `check`, which regenerates and compares bytes without writing. Each root is limited to 512 receipts, with 128 KiB core / 32 KiB supplemental per-file limits and 96 MiB combined input; each artifact is limited to 2 MiB, and generation retains 1.25 GiB disk reserve. There are no arbitrary roots, histories, assets or cutoff flags. A new cohort, cutoff or version requires an explicitly reviewed profile and new artifact paths. Network calls and scheduler creation are outside this command.

Before adopting a new pin version, review its diff and preserve the previous artifact. Run focused identity/math/browser/API tests and fresh adversarial review. Validate the actual default handler on real-clock saved data before advancing the coverage checkpoint. New subjects require registered native-payout/mechanism adapters, their own immutable cohort evidence and an explicit pin version before the browser accepts their scenarios.

## Position entitlement and cash-limited exit routes

For a cash-limited ERC4626 route such as sGHO, retain current redeemable entitlement, current owner maximum and pause state separately from full-position `previewRedeem(balanceOf(owner))`. Full-position evidence is optional: independent read failure or two-origin disagreement clears that channel while preserving current execution and quote evidence. Existing quotes without the optional field retain their original shape.

Select each venue's pinned native-asset cash paths and current source independently. Apply translated physical cash and the unchanged pause state before clipping to separately agreed full-position entitlement, then subtract Q once. Recompute holder shortfall onset/recovery brackets and censoring after clipping. A current cash-constrained maximum must not become a permanent ceiling on recovery. Reject native integer overflow. Actual observed targets remain dated; selecting H1 does not turn daily observations into hourly evidence.

Do not apply this recipe to allocated-liquidity, issuer-mint/burn or foreign-payout routes without verifying their actual exit mechanism. Allocated routes need their pullable adapter liquidity; issuer routes may create the payout asset without holding idle cash; conversion routes need the complete native-unit conversion chain at matching headers. Sparse/new protocols can use an explicit unchanged-regime scenario with known mechanical prongs and independently quoted entitlement while unknown prongs, release timing and execution remain separate.
