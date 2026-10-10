# StUsds local holder exit observations

Frozen route: `USDS → StUsds [USDS]`, Spark StUsds vault `0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9`, original USDS `0xdc035d45d973e3ec169d2276ddab16f1e407384f`. This is distinct from Sky `USDS → SUsds [USDS]`.

The local Mac issue job selects a receipt screened EOA with StUsds shares at a recent finalized Ethereum block. Two independent public RPC origins must agree on the baseline, the EIP-1967 proxy implementation `0x7a61b7adcfd493f7cf0f86dfcecb94b72c227f22`, and its pinned runtime code hash. The route's vault and USDS asset both have 18 decimals. A successful issue freezes six exact original USDS Q cases and H1/H4/H24/H48/H168 target windows in a private SHA linked record. Each baseline uses same holder `withdraw(Q,holder,holder)` simulation and share coverage proof.

The score job follows baseline success and covered baseline revert cases as separate cohorts at the first finalized block crossing each target, witnessed by independent origins. A covered revert may be followed by simulated recovery, continued revert, holder attrition, or censoring. A missed capture window is sealed only after both origins agree on a finalized block past the deadline. Native attempt receipts record every run and link any new issue or score seals. Private holder, exact Q and clocks stay under `data/research/venue-signals/carry-public-stusds-exit-*`.

The local development API verifies this route's issue and score chains and returns only coarse route/horizon counts. Repeated Q cases in one issue share a holder episode. Later issues exclude prior holders; exhausted scans record a `no_fresh_holder` attempt without creating a duplicate issue. A simulation is not a mined USDS payout, and this lane alone supports no current user exit guarantee, likely duration, probability, or calibrated forecast.

Run `scripts/carry-public-stusds-exit-tick.sh issue|score`. The launchd templates schedule issues at minute 31 and scores at minutes 6/16/26/36/46/56, with minute 36 deferred when the issue slot is active. Each research script supports `--verify`; no Neon connection is needed.
