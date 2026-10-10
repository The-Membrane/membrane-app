# Aave V3 USDC cash-flow history for holder headroom

The exact frozen route is `USDC → supply on Aave V3` on Ethereum. The Pool is
`0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`, USDC is
`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, and the USDC aToken cash
custodian is `0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c`.

## Existing source and exact scope

`scripts/research/aave-usdc-24h-flow-pilot.mjs --verify` replays 30 immutable
receipts across finalized blocks **26,072,386–26,079,860**, exactly **90,000
seconds**. It includes four Pool operation types (466 Supply, 649 Withdraw, 433
Borrow, 226 Repay) and 1,830 USDC Transfers involving the aToken. Gross cash
entering the aToken was 352,060,735.691242 USDC; gross leaving was
352,727,310.280132 USDC. Their signed difference equals the pinned endpoint
`balanceOf(aToken)` change of **−666,574.588890 USDC** in raw units. The
largest observed complete 24-hour gross cash outflow within that 25-hour pilot
was **352,204,847.830858 USDC**. This is one historical market-wide day, and
the original source receipt used one RPC provider. It is not holder exitability
or a forecast.

The separate direct supplier archive contains two-origin, receipt-reconciled
historical supplier Withdraw and Supply events. The withdrawal side begins at
block **26,079,847**, while the initial supply side began at **26,093,530**.
`backfill-carry-direct-supplier-flow.mjs --flow supply` extends the latter
backward using 64-block, two-origin immutable slices with a 1 GiB free-space
reserve. It must replay and join all blocks through 26,093,529 before its
coverage can be called contiguous with the later supply side. A supplier
Supply/Withdraw pair alone does not explain cash: Borrow, cash Repay,
liquidation, flash-loan, and other USDC Transfers can change the same custody
balance.

At the **2026-10-01** bounded backfill checkpoint, the earlier chain replayed
**66** segments over B26,079,847–26,084,070 with **250** reconciled supplier
supplies. B26,084,071–26,093,529 remains uncaptured before the existing later
supply chain; the earlier and later segments must not be merged into one
continuous flow window yet.

The local Mac job `com.membrane.carry-aave-usdc-supply-gap` runs
`scripts/carry-aave-usdc-supply-gap-tick.sh` every five minutes. Its fixed
campaign covers only B26,084,071–26,093,529, at most four 64-block segments
per tick, with a 1 GiB disk reserve. The first live tick sealed four two-origin
segments through **B26,084,326**, with 14 reconciled supplies in those new
segments. The campaign remains incomplete; an exit-flow study must verify the
whole gap before joining the old and new supply records.

## Independent pilot attestation

`scripts/research/aave-usdc-pilot-two-origin-attest.mjs --run` processes at most
one of the 30 pilot receipts per invocation. It rereads and verifies the
original receipt chain, then requires Infura and Ankr to return the **same raw
logs** for every original Pool Supply/Withdraw/Borrow/Repay and USDC Transfer
query. Both sources must also agree on the finalized chain and the original
two block hashes and pinned endpoint USDC balances. The v2 sidecar retains
both complete returned log sets for offline comparison. It seals a separate
exclusive, fsynced sidecar; `--verify` replays available sidecars against the
original receipt data and reports `verifiedReceipts`, `expectedReceipts`, and
`complete`; `--verify-complete` exits nonzero until all 30 receipts are sealed.
An incomplete attestation does not upgrade the 25-hour source to
two-origin evidence. A valid matching pair is source agreement, not absolute
proof that both providers returned every log.

On **2026-10-01**, `--verify-complete` passed **30/30** sidecars for the
90,000-second pilot. This supplies one complete historical 24-hour joint
gross-in/gross-out window under two-origin agreement and endpoint cash
reconciliation. It does not establish independent day-to-day flow episodes.

## Native full-cash continuation

`scripts/research/aave-usdc-market-cash-archive.mjs --tick` starts exactly at
the attested pilot's B26,079,860 endpoint and advances at most 128 blocks
per tick toward fixed B26,095,417. The first two slices used Infura and Ankr;
subsequent slices use Alchemy and Ankr because the configured Infura endpoint
returned HTTP 429. Alchemy's current plan rejected a single 128-block
historical `eth_getLogs` request but accepted 10-block requests. The collector
therefore divides each new 128-block accounting slice into at most 10-block
log-query chunks on both origins. Each slice writes separate complete Aave Core collector
receipts, reruns the collector's raw-log and endpoint verifier on both, then
publishes a no-overwrite joint sidecar only if the Pool operations, USDC cash
Transfers, endpoint identity and cash accounting match exactly. The sidecar
validator is reused by `--verify`; source files are bounded regular files,
and a 1 GiB reserve protects each tick. The local Mac job
`com.membrane.carry-aave-usdc-cash-archive` runs one slice every five minutes.

The first paired slice **B26,079,860–26,079,988** was live captured and
`--verify` replayed its single accepted sidecar. It contains 9 Supply, 12
Withdraw, 6 Borrow, 3 Repay and 32 aToken-facing USDC Transfers. Gross cash
in was 235,105.177655 USDC, gross cash out 179,952.267663 USDC, and the
endpoint cash residual was exactly zero. This is one 128-block accounting
slice, not an independent day or a future flow estimate. The full campaign
remains incomplete. Repeated native Infura retries returned HTTP 429 without
advancing. QuickNode also rejected this historical log range on its plan, and
DRPC rejected the tested range. The configured authenticated Ankr endpoint is
the second source for the Alchemy continuation.

The scheduled job also completed the adjacent second slice through
**B26,080,116** before origin-witness hardening. Those first two source pairs
now have immutable **post-capture local origin witnesses** that bind each
source receipt SHA to its configured Infura or Ankr origin; later slices write
the witness immediately after each source capture. The verifier requires the
two source receipts to differ, checks each witness and the joint sidecar, and
preflights every source file as a bounded regular non-symlink before calling
the legacy full receipt verifier. The source collector now fsyncs its file
and directory before publishing. This is a record of local collection, not a
provider signature: a machine operator able to rewrite all local files could
forge it. The pre-witness binding mode is explicit so the first two slices
do not appear to have capture-time provenance. A locked live Alchemy/Ankr
tick sealed the third, contiguous slice **B26,080,116–26,080,126**, with
capture-time origin witnesses. A second locked tick sealed
**B26,080,126–26,080,136**. A native `launchctl kickstart` completed the
fifth contiguous slice through **B26,080,146** with exit code zero. A 64-block
chunked trial then sealed through **B26,080,210**; a full 128-block chunked
trial sealed through **B26,080,338**. The reloaded native job then sealed a
further 128-block slice through **B26,080,466** with exit code zero. The same
offline verifier accepts all eight contiguous slices and rejects a relabeled
third-slice origin. A subsequent locked live trial using 256-block accounting
slices and the same 10-block per-origin query windows sealed the ninth slice
through **B26,080,722**; the offline verifier accepted it. The native
five-minute job then exited zero and sealed the tenth contiguous slice through
**B26,080,978** using this 256-block setting. The campaign remains incomplete,
and provider limits may still interrupt ticks.

This continuation is adjacent to the original 25-hour pilot. Chronological
independent day windows and a held-out later period must be assembled only
after enough accepted contiguous slices exist. No model fitting or holder
forecast is promoted by this archive job.

## Forecast gate

The full flow identity requires all cash-moving USDC Transfers plus the Pool
operation context, checked against the beginning and ending aToken balance for
each contiguous interval. Gross in and gross out must remain separate;
`Withdraw` is only supplier demand, while `Borrow` also consumes reserve cash.
`Repay` with `useATokens` may not bring in USDC. Mixed transactions and
operation/Transfer mismatches remain explicit in the pilot receipt ledger.
Atomic flash-loan out-and-back legs belong in gross cash accounting but must
be separated from persistent competing demand when estimating future headroom.

To publish a future holder-amount headroom or duration claim, accumulate many
independent joint gross-in/gross-out windows, compare predictions against
later held-out same-holder executable checks, and report missing observations
and regime changes. A single complete 24-hour period can validate accounting
for that period but cannot establish a likely future flow distribution.
