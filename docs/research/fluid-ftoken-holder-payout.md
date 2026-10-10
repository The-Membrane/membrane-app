# Fluid fToken historical holder payout evidence

Scope: the three frozen August Carry subjects `USDC → Fluid USD Coin [USDC]`, `USDT → fToken [USDT]`, and `GHO → fToken [GHO]`. This is a local historical mined-payout study, separate from the current same-holder `eth_call` check and any forward forecast.

## Deployed route proof

At finalized Ethereum block **26,095,447**, hash `0xec73dacf97e6dfe51de36859e0da63526df80d094da5159bc1cb11fb8cf6e0a4`, Alchemy and Ankr agreed on each frozen fToken's `asset()`, `getData().liquidity`, runtime code hash, and two empty EIP-1967 implementation/beacon slots. These are **direct runtime deployments** in the observed block; treating them as beacon proxies would be false. All three point to Fluid Liquidity `0x52Aa899454998Be5b000Ad077a46Bbe360F4e497`. The sealed proof is `proof-26095447.json`, SHA-256 `06a83fe9a4abbaa0f252e49f376981b765352fa7a6a5c9841e5f3d48ec5738a5` in `data/research/venue-signals/local-fluid-ftoken-payout-v1/`.

The [official fToken implementation](https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/protocols/lending/fToken/main.sol) calls Liquidity `operate(asset, -assets, 0, receiver, 0, ...)` during withdrawal, burns owner shares, then emits fToken `Withdraw`. The [official Liquidity event definition](https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/liquidity/userModule/events.sol) defines `LogOperate(user, token, supplyAmount, borrowAmount, withdrawTo, ...)`. The two-source on-chain proof binds deployed runtime identity and Liquidity address; it does **not** establish byte-for-byte correspondence between deployed bytecode and a particular compiler build of the official source. The app's `implementationSourceAttested:false` must remain until that independent build-level attestation exists.

## Same-transaction payout reconciliation

For each raw fToken `Withdraw` log in a bounded ten-block range, the local collector requires two RPC origins to agree on range boundary hashes and the complete queried raw log set. It then requires two matching mined receipts and exact equality between the queried fToken `Withdraw` logs and all such logs in each receipt. A receipt is classified `reconciled` only if a successful transaction contains one matching fToken `Withdraw`, exactly one matching Liquidity `LogOperate` for the fToken user, underlying token, negative exact asset amount and receiver, and exactly one underlying ERC-20 `Transfer` from Liquidity to that receiver for the exact amount. Two same-amount withdrawals to the same receiver are ambiguous rather than reusing one operation or transfer. A missing leg is missing. A successful simulation is never a payout.

| Route                        |         Witness range | Candidate transactions | Reconciled | Quiet pilot |
| ---------------------------- | --------------------: | ---------------------: | ---------: | ----------: |
| USDC fToken                  | 26,095,438–26,095,447 |                      1 |          1 |           0 |
| USDT fToken                  | 26,095,130–26,095,139 |                      1 |          1 |           0 |
| GHO fToken                   | 26,095,400–26,095,409 |                      1 |          1 |           0 |
| USDT and GHO control windows | 26,095,438–26,095,447 |                 0 each |          0 |      1 each |

The reconciled transaction hashes are USDC `0xc1635c40812312ff78194ba32b55114ae47bd5f7c07cac119bd58008cab2ea68`, USDT `0xe44ade3914b31b521c2a81e733c40422fc707bc2fe2150bae319774b8c134381`, and GHO `0x99ca971505e437371aa21495cb7cd48830853b84c252de2bc40f6a2b125418cf`. `node scripts/research/carry-fluid-ftoken-payout.mjs verify` replays the immutable source witnesses, classification and digests offline. `node --test scripts/research/carry-fluid-ftoken-payout.test.mjs` covers the required and absent/mismatched/duplicate payout legs.

Collection is bounded to ten blocks and at most twelve candidate receipts per pilot, requires two distinct configured origins, preserves each origin's normalized raw query response and complete receipt logs, publishes fsynced no-overwrite sidecars, and leaves at least 1 GiB disk reserve. A provider disagreement or RPC error publishes nothing. This pilot demonstrates three observed historical payouts. It does not prove that a user's present exact amount can exit, that each route has sustained liquidity, or that a future exit remains possible. To forecast shrinking ability, collect longer gross Liquidity outflow and replenishment history alongside prospective fixed holder amount cases, then test duration predictions on later independent episodes.
