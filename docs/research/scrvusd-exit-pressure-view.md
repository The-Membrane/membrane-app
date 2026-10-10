# scrvUSD exit pressure research view

`node scripts/research/scrvusd-exit-pressure-view.mjs [asOfUtc]` reads verified local sources without RPC or database writes. It joins the current fixed holder/q trend to prospective exit issue outcomes at the requested UTC cutoff.

For historical replay, the reader verifies the entire saved selection, quote, and holder ledgers at read time, then uses only checkpoints and holder probes captured by `asOfUtc`. A later saved probe does not contaminate an earlier trend. Before the holder selection certificate existed, trend status is `selection_not_yet_available`.

An `observed_shrinking_candidate` requires two adjacent, comparable successful fixed holder probes with falling `maxWithdraw − q` headroom. The candidate is research output, not a user alert or a prediction. Stale captures, missing checkpoints, provider ambiguity, holder attrition, and structured reverts retain their distinct trend statuses and do not become a numeric shrinking claim.

Flow context appears only when a verified prospective issue matches the trend's exact current block, holder, amount, and direct route. Its historical suffix was frozen at that issue's earlier evidence cutoff. Gross withdrawal and signed net depletion maxima retain separate 24h/7d statuses and window timestamps; an incomplete archive bridge remains visible. No matching issue means flow context is unavailable. The readiness section keeps outcome denominators and qualification gates. Probability and likely duration remain unavailable until prospective coverage and calibration justify them.

The pure composition also checks that a matched issue follows the saved holder probe and precedes the requested as-of time. The production evaluation reader already filters future issues; this check keeps synthetic and downstream calls from attaching future flow context to an earlier replay.
