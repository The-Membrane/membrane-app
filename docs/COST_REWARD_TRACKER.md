# Measured cost and income on the position page

The tracker adds annualized interest cost, income and their difference at the selected position's current quantities and source-oracle prices.
Historical points use observed rates with that same fixed notional. They are not actual paid interest, realized earnings or cumulative P&L.

The owner approved the recommended Q33/Q34 decisions recorded in membrane-board `design/Q33_Q34_APPROVAL.json`.
The approved design and claim contract remain on the Board. This document records this implementation's actual scope and limits.
No rate forecast, cumulative path, time-to-line or joint probability is emitted by this code.
Q33's first historical test failed every admission cell. This implementation has no forecast fallback or promotion switch.

## Current observations

- Aave/Spark collateral supply APR uses the already-read reserve `liquidityRate`, divided by RAY. It already deducts reserve fees.
- Aave preserves its actual stable/variable weighted debt rate and separately states its rate basis. Morpho keeps its source interval-average accrual rate separate from its qualified current debt rate.
- Compound and Morpho posted collateral earns no protocol supply interest. Token-native yield is independent and never inferred from that zero.
- Only explicitly listed plain tokens have no native-growth component. Other assets keep native income unavailable, preventing an incomplete income total or spread.
- Morpho reads loan-token USD prices from the Aave V3 oracle at the pinned block, including stablecoins. A finite positive source price takes precedence over a $1 assumption. Only explicitly allowlisted stablecoins may fall back to an assumed peg; that fallback is tagged and cannot supply tracker dollar figures.
- Wallet venue balances do not prove debt allocation. No external deployment income is assigned by co-ownership, and collateral is never counted as deployed debt.
- Membrane protocol/curator charges and incentives are not silently netted into these rates. Unread charges and campaign payouts remain unpriced.

Current dollar figures require an actual pinned-block timestamp, obtained separately from the fetch time.
A missing or incorrect block, a 25-second observation-read deadline, an old block or an unsupported chain withholds current figures.
The freshness budget is 15 minutes. Observation and fetched timestamps are both in the receipt.
Changing address, selected position, venue identity or read ID rejects late receipts. A clock timer updates freshness while the page remains open.

## Morpho current-rate qualification

Morpho's `borrowRateView` is the interval-average rate used to accrue from the last market update. It is preserved for native balance accounting and the existing lender block.
The tracker uses separate optional current-rate metadata for both borrowing and supplying. It never substitutes that interval average when current-rate qualification fails.

For the known Ethereum AdaptiveCurveIRM, the adapter reads the stored target, market state, source average and timestamp at one block.
It replays the AdaptiveCurve integer math with zero-integer tolerance against the actual source average, accrues balances using that original average, then evaluates the adapted target on accrued utilization.
The supplier APR multiplies that instantaneous borrow rate by accrued utilization and deducts the same market's source fee once.
Only the final annualization converts to floating point, using 31,536,000 seconds/year. Amount conversion retains the protocol's virtual shares, virtual asset and fee-share dilution.
Unknown IRMs, absent timestamps/targets, invalid uint128/domain/fee state, replay mismatches and invalid accrued state withhold both current rates.
The zero IRM qualifies zero protocol interest only with valid state and time; it says nothing about other borrowing costs.

An independent public-source check at Ethereum block `26209321` captured ten read-only receipts, with matching block headers before and after the calls.
The source average was `1546339617` per-second WAD; exact replay differed by zero. The separately evaluated current borrow and supply rates were `1546377315` and `1393404823` per-second WAD.
The resolved loan-token oracle reported USDC at `$0.99987931`, demonstrating that the source path does not impose a peg.
A separate offline verifier checked the receipt hashes, market identity, calldata and integer arithmetic without importing product arithmetic.
This is one market, block and provider; it does not qualify historical coverage, a forecast or a wallet's positions.
A recent block establishes the time of the source read. It does not establish the underlying oracle feed's update age or independent state inclusion.
The bounded summary and raw-receipt hashes are in `docs/research/q34-tracker-verification.json`; raw receipts remain private research evidence.

## Historical coverage and regeneration

`lib/position/rateHistory.generated.json` contains four bounded daily aggregates: Aave Ethereum Core USDC/USDT, variable borrow and fee-net supply.
There are 90 nominal daily slots per series, currently July 10 through October 7, 2026.
Actual archive block timestamps remain separate from nominal calendar dates. Missing inputs and parameter-regime seams remain null gaps.
The generated file is approximately 113KB and includes exact chain/protocol/venue/market/token identity, source hashes and regime metadata.
No account flow, private wallet record, full training series or forecast output is exported.

```bash
MEMBRANE_DATASETS_DIR=/absolute/private/membrane-datasets \
  node scripts/position/build-rate-history.mjs --check
```

Omit `--check` to regenerate and review a changed aggregate. No source input is written.
Without an override, the builder reads the sibling `membrane-datasets` checkout. `MEMBRANE_DATASETS_ROOT` is a compatibility alias.
The builder rejects uncommitted source inputs. It pins the last revision that changed an input file, so unrelated research commits cannot change output metadata.
Source bytes and SHA-256 values are checked independently of that revision.
In the managed cloud sandbox, read-only Git subprocesses may require the execution tool's additional-permission process environment.

Historical matching requires all identity fields. A variable reserve history never substitutes for a fixed, mixed or unknown user debt basis.
The two sides align their own component timestamps independently, within one minute. Missing income therefore does not erase valid cost history.
Multiple unmatched or mistimed components cannot produce a complete side total.

Spark, Compound, Morpho supply, WETH rate history and LST native growth have no admitted historical series in this version.
The LST file's nominal grid lacks exact observation times and is not relabeled as a fresh staking-rate feed.
The cWETHv3 wstETH/WETH-only copy is restricted to that exact active asset pair. A mixed collateral book receives no blanket ETH/USD cancellation claim.

## Verification

```bash
node node_modules/vitest/vitest.mjs run \
  tests/unit/positionCostReward.test.ts \
  tests/unit/positionRateHistory.test.ts \
  tests/unit/positionRateMetadata.test.ts \
  tests/unit/positionAdapters.test.ts \
  tests/unit/morphoBlueAdapter.test.ts \
  tests/unit/positionV0ViewModel.test.ts \
  tests/unit/positionLender.test.ts \
  tests/unit/positionTouchTime.test.ts \
  tests/unit/morphoCurrentRates.test.ts \
  tests/unit/morphoSourceQualification.test.ts --pool=threads --maxWorkers=1
```

The ten suites pass 134 tests, including source-rate scaling, fee basis, variable/fixed matching, exact identity, negative income, missing valuations, wrapper double counting, stale observation clocks, delayed reads and deadlines, plus upstream lender and time-to-touch behavior.
PR111 base `e5782f3dde51e7c59073a37645f6e565d1a993bf` was merged into the feature with merge commit `76e992b34fd207ccbcc78a9128bf6faf0e1cae96`.
The fixed-horizon time-to-touch chart and supply-only lender block remain intact alongside the keyed cost/income tracker and its source metadata.
TypeScript reports 101 existing errors on both that new PR111 base and this implementation, with no added or removed normalized diagnostics.
New TypeScript/TSX files pass targeted ESLint. Existing touched files have pre-existing formatting debt; no broad reformat is included.

The test-only browser harness is `tests/e2e/harnesses/costReward.tsx`. Its synthetic positions and rates are clearly labeled and never imported by product routes.
Chromium checked 15 states in day/night editions at 390/1280px, including open receipts, with no overflow or JavaScript page errors.
Visible controls are at least 44px tall. Window buttons, keyboard date inspection, assumed-peg suppression and mixed-Comet copy were checked.
The actual Next position route returns 200 and omits the personal tracker before an address is read.
The two Morpho harness states verify that a qualified current cost differs from the stored average, and that independently missing debt-current-rate metadata withholds cost while retaining supplied-rate metadata. This synthetic partial-input case is not a same-market adapter replay failure; real replay failure suppresses both qualified rates. The browser matrix does not establish live RPC reliability or verify a real wallet's rates. Unit tests exercise the real adapters using explicit test-only source responses.

The app uses newspaper tokens, mono chart figures and direct solid/dashed labels. All observations remain accessible in the receipt table.
The tracker emits no actual cash-flow accounting, probabilistic band or deployment attribution.
