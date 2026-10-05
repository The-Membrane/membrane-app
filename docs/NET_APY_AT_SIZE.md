# Net APY at size

What a deposit or a borrow of a given size nets on a venue. The venue's own rate curve
is read at one block. Lane: umbrella "ONE GOAL, THREE LAYERS", layer DATA+PRODUCT.
Research driver: DeFi Dojo F4. Net APY at the user's size is data need #3 (18 msgs / 16
authors). Rate-spike risk is #4 (15 / 14).

## Contract terms this lane shares

Reconciled with the umbrella on 2026-10-05 (owner rulings).

| Term | Definition | Where |
|---|---|---|
| venue-key | The venue's `name` in the one venue registry, `tools/venue-recorder.config.json`, exact case. No lane mints its own IDs. This lane's keys are `<protocol>-<market>` slugs, all registered. The ones the recorder does not record yet are `enabled: false`. A test enforces it. | `lib/netApy/venues.ts`, `tests/unit/netApyVenueRegistry.test.ts` |
| block anchor | `{chainId, blockNumber, blockTimestamp, blockHash}`. Every on-chain number in a snapshot is read at this block. It is the **finalized** block, or a block pinned with `block=<n>`. A pinned block above finalized is refused with a 400. It is never `latest`, which can be reorged. A pinned replay's `asOf` is that block's own time. The finalized block is about 13–19 min old, so wall-clock questions (cache age, which campaigns are live, days left) use the read's `asOf`, through `asOfOf`, and never the anchor time. | `lib/netApy/types.ts` `BlockAnchor`, `lib/netApy/read.ts` `resolveAnchor` |
| label class | Where a number comes from: `measured` · `derived` · `projected` · `reported` · `curator-set`. Every row carries one. | `lib/netApy/types.ts` `LabelClass` |
| claim class | The umbrella's five classes, kept as a separate field: `measured-change` · `observed-driver` · `possible-leading-signal` · `stress-scenario` · `calibrated-forecast`. The last is empty until the forecaster's promotion gate passes. Today only the rate-spike axis carries one: `stress-scenario`. A `measured` label (one read) and a `measured-change` claim (a change between reads) are different things. | `lib/netApy/types.ts` `ClaimClass`, `lib/netApy/ratePath.ts` |

## Pieces

| Piece | File |
|---|---|
| IRM math, bit-exact: Aave v3 strategy V2, SparkLend VariableBorrow, Morpho AdaptiveCurveIrm, Euler IRMLinearKink | `lib/netApy/irm/*` |
| On-chain reader, one anchor block, registry re-checked on every read | `lib/netApy/read.ts` |
| Merkl incentives: APR, end date, conditions, dilution at size, decay calendar | `lib/netApy/incentives.ts` |
| Net breakdown: gross → venue fee → Membrane split → net, plus the worst case | `lib/netApy/breakdown.ts` |
| Rate path and rate-spike axis (the Risk Frontier hand-off) | `lib/netApy/ratePath.ts` |
| Local-first store under `.data/net-apy/` (no Neon) | `lib/netApy/store.ts` |
| Recorder tick: snapshot + Merkl pull + change log (`events.jsonl`) | `scripts/record-net-apy.ts`, `lib/netApy/history.ts` |
| API | `pages/api/net-apy/index.ts` |
| Card, mounted on `/[chain]/venue/[name]` for covered venues | `components/NetApy/NetApyCard.tsx` |

## API

```
GET /api/net-apy?size=100000&side=supply            all venues, one row each
GET /api/net-apy?venue=aave-v3-usdc&size=1000000    one venue, full breakdown
    &side=supply|borrow  &path=1  &block=<n>  &protocolShare=<0-1>  &curatorShare=<0-1>
```

If you omit `protocolShare` and `curatorShare`, the Membrane rows read "curator-set" and
the net is an upper bound (≤). A share of 0 is refused, because it would print as a 0%
Membrane charge.

## Rules

- Membrane charges through the venue: a curator-set share of realized gain. The split
  copies `CuratorVault.settleProtocolPayment`: the protocol leg comes first, then the
  curator leg, capped at the gain that is left. Never write 0%, $0 or "free".
- A projection is labelled a projection. Nothing here promises positive carry.
- A campaign with conditions (loop, borrow, holding, whitelist) is listed but kept out of
  the net. A plain deposit does not qualify.
- If Merkl data is missing, the card says "unavailable", not "no incentives". Royco and
  protocol-native programs are declared not covered.
- RPC URLs come from `.env.local` (`NET_APY_RPC_URL`, `RECORDER_RPC_URL`,
  `NEXT_PUBLIC_MAINNET_RPC_URL`). Only the `env:<host>` label leaves the process. Every
  error that is surfaced has URLs redacted.

## Continuous fetch

`pnpm netapy:record` runs one tick. It reads every venue at the finalized block, pulls
Merkl, and appends changes to `.data/net-apy/events.jsonl`:
- `campaign_new`
- `campaign_end_changed`
- `campaign_gone_early`: the campaign left Merkl before its end date (it lapsed)
- `campaign_ended`
- `param_changed`: a slope, kink, fee or cap

A failed Merkl pull skips the campaign diff, so an outage never reads as "all campaigns
ended". It runs hourly as one step of `scripts/recorder-tick.sh` (the existing launchd
recorder), after the strats refresh and non-fatal:

```
/opt/homebrew/bin/node --import tsx scripts/record-net-apy.ts || echo "netapy:record failed (non-fatal)"
```

It uses `--import tsx`, not `node_modules/.bin/tsx`: launchd runs with a bare PATH, and
the tsx shim finds `node` on PATH. History builds from the first tick; that tick only
sets the baseline.

## Risk Frontier hand-off

`rateSpikeAxis(snapshot, { size?, stressUtilizations?, horizonSeconds?, steps? })`
returns one path per level: now, at-size, kink, and stress levels (default 95% and 100%).
Each level holds utilization fixed. Static curves give a flat path. On Morpho the rate
doubles about every 5.1 days at 100% utilization, up to a 200%/yr rateAtTarget. This
lane does not modify `lib/position-sim/stressGrid.ts`.

## Tests

```
pnpm vitest run tests/unit/netApy*.test.ts                 offline, fixture-pinned
NET_APY_LIVE=1 pnpm vitest run tests/unit/netApy.live.test.ts
NET_APY_LIVE=1 NET_APY_RECORD=1 …                          re-record the fixture
```

The live test calls each venue's own getter with the post-size inputs at block
26,120,000:
- Aave and Spark: `calculateInterestRates`
- Morpho: `borrowRateView`
- Euler: `computeInterestRateView`

It demands exact equality with our math: 107 cases, 13 venues, $0 to $500M, supply and
borrow. Mutating Aave rounding, the Morpho trapezoid or the Euler kink boundary makes it
fail.
