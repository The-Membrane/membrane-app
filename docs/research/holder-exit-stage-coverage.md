# Holder exit stage coverage

Run the read-only audit with:

```sh
NODE_OPTIONS='--max-old-space-size=384' node --import tsx scripts/research/holder-exit-stage-coverage.mjs --verify
```

The audit uses the frozen 25-group, 67-subject Carry manifest and each route's existing verified issue and score reader. A stage joins the cohort only on **exact route key, destination, and manifest asset**. The manifest asset identifies the vault's underlying for Hastra; the route input is a separate asset. Output contains group and subject counts, stage labels, uncovered subjects, and out-of-cohort diagnostics. It omits holder addresses and never writes a ledger or calls RPC.

| Stage                      | Ledger           | What it establishes                                                               |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| Request initiation         | ApyUSD           | Same-holder hypothetical receipt initiation; no owned receipt payout              |
| Queue request              | Staked USDat     | Same-holder queue request simulation; no ticket or AUSD delivery                  |
| Cooldown redeem call       | Umbrella stkGHO  | Same-holder call at a cooldown state; no mined GHO receipt                        |
| Cooldown initiation        | sUSDe            | Hypothetical cooldown initiation; no unstake or claim                             |
| Pending claim              | sUSDe            | Existing pending amount and later pending state                                   |
| Mined delivery             | sUSDe            | Exact USDe paid to a sampled holder; attribution to the earlier queue unresolved  |
| First leg simulation       | FluidBridge USDC | First-leg same-holder simulation; no complete route payout                        |
| PRIME to wYLDS first stage | Hastra           | Callable first stage; wYLDS is the matched vault underlying, PYUSD is route input |

The Hastra study verifies a PRIME to wYLDS `eth_call`. Its vault underlying is wYLDS (`0x6ad0…6cc`), which matches the frozen `PYUSD → StakingVault [wYLDS]` subject's manifest asset. PYUSD (`0x6c3e…0e8`) is the route input, shown separately as `routeInputAsset`. This stage can join the subject, but the downstream wYLDS to USDC and USDC to PYUSD legs remain unassessed.

`paidExitProofs` counts verified exact original-asset delivery, separately reported as `minedDeliveryAttestations`. `sameEpisodePaidExitProofs` and `calibratedImpairmentDurations` remain zero until the paid transaction is tied to the earlier queue episode and independent duration support exists. A successful `eth_call`, request initiation, queue observation, or first-leg simulation still does not prove delivery. This audit is complementary to `holder-exit-support-audit.mjs`; it does not merge stage observations into impairment/recovery duration cells.
