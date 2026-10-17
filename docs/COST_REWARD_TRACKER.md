# Measured cost and income on the position page

The tracker adds annualized interest cost, income and their difference at the selected position's current quantities and source-oracle prices.
Historical points use observed rates with that same fixed notional. They are not actual paid interest, realized earnings or cumulative P&L.

The owner approved the recommended Q33/Q34 decisions recorded in membrane-board `design/Q33_Q34_APPROVAL.json`.
The approved design and claim contract remain on the Board. This document records this implementation's actual scope and limits.
No rate forecast, cumulative path, time-to-line or joint probability is emitted by this code.
Q33's first historical test failed every admission cell. This implementation has no forecast fallback or promotion switch.

## Current observations

- Aave/Spark collateral supply APR uses the already-read reserve `liquidityRate`, divided by RAY. It already deducts reserve fees.
- Debt APR remains the source adapter's current rate. Aave preserves its actual stable/variable weighted rate and separately states its rate basis.
- Compound and Morpho posted collateral earns no protocol supply interest. Token-native yield is independent and never inferred from that zero.
- Only explicitly listed plain tokens have no native-growth component. Other assets keep native income unavailable, preventing an incomplete income total or spread.
- Morpho's assumed stablecoin peg is tagged explicitly. It cannot supply a measured dollar headline or dollar-normalized history.
- Wallet venue balances do not prove debt allocation. No external deployment income is assigned by co-ownership, and collateral is never counted as deployed debt.
- Membrane protocol/curator charges and incentives are not silently netted into these rates. Unread charges and campaign payouts remain unpriced.

Current dollar figures require an actual pinned-block timestamp, obtained separately from the fetch time.
A missing or incorrect block, a 25-second observation-read deadline, an old block or an unsupported chain withholds current figures.
The freshness budget is 15 minutes. Observation and fetched timestamps are both in the receipt.
Changing address, selected position, venue identity or read ID rejects late receipts. A clock timer updates freshness while the page remains open.

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
  tests/unit/positionV0ViewModel.test.ts --pool=threads --maxWorkers=1
```

The six suites pass 96 tests, including source-rate scaling, fee basis, variable/fixed matching, exact identity, negative income, missing valuations, wrapper double counting, stale observation clocks, delayed reads and deadlines.
TypeScript reports 101 existing errors on both the PR111 base `4533ce22` and this implementation, with no added or removed normalized diagnostics.
New TypeScript/TSX files pass targeted ESLint. Existing touched files have pre-existing formatting debt; no broad reformat is included.

The test-only browser harness is `tests/e2e/harnesses/costReward.tsx`. Its synthetic positions and rates are clearly labeled and never imported by product routes.
Chromium checked 13 states in day/night editions at 390/1280px, including open receipts, with no overflow or JavaScript page errors.
Visible controls are at least 44px tall. Window buttons, keyboard date inspection, assumed-peg suppression and mixed-Comet copy were checked.
The actual Next position route returns 200 and omits the personal tracker before an address is read.
The browser matrix does not establish live RPC reliability or verify a real wallet's rates. Unit tests exercise the real adapters using explicit test-only source responses.

The app uses newspaper tokens, mono chart figures and direct solid/dashed labels. All observations remain accessible in the receipt table.
No source-native accrual, actual cash-flow accounting, probabilistic band or deployment attribution is claimed by this version.
