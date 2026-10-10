# Morpho stable fixed-$10k exact-call transition audit

Run:

```bash
node scripts/research/morpho-stable-fixed-10k-transition-audit.mjs
```

The offline audit verifies the canonical sealed plan and every canonical cell artifact in `lib/carry/research/morpho-stable-exit-history-v1/`. It uses the exact same holder, vault, nominal fixed **$10,000** stablecoin withdrawal call, anchor, and sampled horizons at 1, 4, 24, 48, and 168 hours.

This is a post-archive descriptive slice. The fixed 10,000-unit size was frozen before each archived outcome call, but the later decision to report this member of the six-size ladder was not predeclared. The anchor at block 26,000,000 is therefore a named reserved-anchor stratum only. It is not an untouched holdout for this slice.

One holder-vault-anchor is an episode. Episodes from repeated anchors for the same holder and vault belong to one dependent holder-vault cluster. The three development anchors and the reserved-anchor stratum stay separate, as do USDC and USDT.

## Observed counts

| Baseline risk set         | Development USDC | Development USDT | Reserved USDC | Reserved USDT | Total episodes |
| ------------------------- | ---------------: | ---------------: | ------------: | ------------: | -------------: |
| Callable exact call       |               28 |                4 |            11 |             0 |         **43** |
| Covered exact-call revert |                7 |                0 |             1 |             0 |          **8** |

The 43 baseline-callable episodes come from 43 holder-vault clusters, each observed at one anchor. Two episodes have a first later exact-call impairment. The USDC development onset is interval censored to **(24h, 48h]** and its first later recovery is **(48h, 168h]**. The USDT development onset is **(48h, 168h]** and recovery is right censored at 168 hours. Of the 41 episodes without an observed onset, 25 remain callable through the sampled horizon and are right censored at 168 hours, 15 holder-attrition censor before an onset can be assessed, and one holder-type change censors assessment.

The eight baseline covered-revert episodes come from five holder-vault clusters: four clusters occur at one anchor, and one dependent cluster occurs at all four anchors. One reserved USDC episode first succeeds in **(48h, 168h]**. Five episodes remain impaired and are right censored at 168 hours. Two holder-attrition censor before recovery can be assessed, one in **(24h, 48h]** and one in **(48h, 168h]**. No holder-vault cluster appears in both baseline risk sets.

## Interpretation boundary

These are post-archive retrospective episode counts with interval and right censoring. The repeated-anchor episodes are not independent observations. Two observed onsets and the two recovery observations across the distinct risk sets do not support a fitted probability or a likely-duration claim. The endpoint is **exact-call impairment**: a hash-pinned same-holder `eth_call` reverted while the recorded holder state covered the requested shares. The evidence does not identify liquidity as the cause.

The common 25-route panel remains a separate cohort and denominator. Its rows are not pooled into this wider stable-vault archive audit.
