# Primary events and conditional NET scenarios

The route-context API now returns `primaryEvents` separately from RSS headlines.
The enrolled primary source is the canonical dataset
`governance-changes/aave-v3-ethereum-core.json`, SHA256
`17e896684f87f87eb65ba446fa87093647f1a953da522a8b421a4423ae7c003b`.
Its Oct12 01:09:18.636Z collection clock is availability, never first publication
or occurrence. Each retained event identifies its native transaction/log index,
occurrence timestamp, exact affected Aave USDC or USDe destination and asset,
Core PoolConfigurator and `aave_v3_ethereum_core` version. A different contract,
asset, unit or version cannot receive those facts. At most twenty facts are
returned, after the collection became available. These old configuration
changes do not establish today's configuration; the source lacks block hashes.

The actual API also returns `conditionalScenarios` for the latest recorded
pause and freeze parameter separately, selected before the twenty-fact display
limit. Each preserves original bounded typed event arguments and source block/
log index. The explicit assumption is that this last recorded parameter remains
unchanged through issue+H. A true pause conditionally bounds deposits and exits
at zero; a true freeze bounds new deposits at zero while imposing no withdrawal
bound from that parameter. A false flag imposes no bound from that flag and
does not establish an executable deposit or exit. Other protocol checks and
current configuration remain unknown. The dataset contains no supply-cap event,
so no cap amount or NET flow magnitude is invented.

This follows Q13's measured-change layer. The separately authored Wire branch
`7c9112d` is recorded on the synced board, but its git object is not in this
checkout. None of its code or board prose has been overwritten. Its anomaly
stories are measured facts, not reviewed primary news or evidence of causality.

`buildPrimaryEventNetScenario` accepts an original qualified holder outlook and
an independently reviewed primary event plus an explicitly declared signed NET
rate. The event retains occurrence, publication (nullable), fetch and actual
availability clocks, primary URL, content digest and review reference. Every
event binding must match the exact venue version, asset, units and contract.
The caller's original qualifier must approve both authorities before cloning.
The assumed rate replaces NET; it does not add a shock to historical NET. It
starts from qualified current cash and accounts for source age through issue+H,
clips after additional M by fixed full entitlement, and subtracts Q once.
Out-of-range cash is rejected rather than presented as a known endpoint.
The selector recomputes arithmetic and checks the full question/current source;
the enclosing retained holder receipt supplies authority.

No event magnitude or news effect is inferred from a headline, log name or
historical aggregate cash movement. There is currently no reviewed event NET
assumption in the provided package, so the actual primary-fact API returns no
invented scenario. Scheduled-future events, broad event catalogues, causal
estimation, calibrations and fresh governance/current-state qualification remain
unprovided. Native Morphov2 cash measurements have a separate compact envelope
(`nativePrimaryEventImpact`) and retain historical adverse NET stress explicitly
as an assumption; they are capacity facts, never presented as primary news.

Offline suites cover genuine pinned Aave facts and availability exclusion,
exact subjects, declared NET arithmetic, copied authority rejection, owner and
result tampering, version drift and out-of-range censorship. The parent runs
these through newly sealed Linux limits; this work ran no runtime or network.
