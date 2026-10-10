# scrvUSD score replay under late file arrival

Each prospective score seals the exact verified quote, fixed-holder probe, and optional code-attestation references visible when scoring ran. The score is an immutable observation of that source set. A receipt's `captureEndUtc` being before the outcome deadline does not prove its file was persisted before the score was sealed.

If a selected-path code-attestation file is malformed, the score also seals its filename, block number, and physical SHA-256. Verification requires those same malformed bytes to remain available; removal or replacement fails replay even if the point exit result is unchanged. The sampled code identity remains `unknown` for the malformed attestation.

`scrvusd-exit-forecast-score.mjs --verify` replays the sealed source set and compares the current eligible set. If newly present evidence would change the selected point result, intervening samples, trajectory, or sampled code identity, verification fails closed. This also stops downstream labels and later scoring until the discrepancy is adjudicated. It does not rewrite the sealed score or classify missing evidence as a failed exit.

`--audit-late` returns the verified sealed score count, additional eligible source counts, and affected score filenames with `wouldChangeResult`. It is diagnostic only: a contested score remains excluded by ordinary verification. Extra evidence that cannot change the result is reported but does not block it. The local snapshot is not independent proof of when each file reached durable storage; prospective schedule and publisher evidence must establish that separately.
