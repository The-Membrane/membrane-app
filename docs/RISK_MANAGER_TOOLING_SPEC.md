# Risk Manager Tooling — Planning Spec

Oct 5, 2026 · @Someone

## Context & thesis

Curators already have market-risk tools; the gap is configuration risk that changes after an asset is onboarded. Chaos, Gauntlet, and LlamaRisk mostly model liquidity, volatility, and liquidation cascades, and risk reviews are usually point-in-time at onboarding.

The Kelp rsETH exploit (Apr 18, 2026, \~$292M) is the reference case. Kelp's LayerZero bridge route was downgraded from 2-of-2 to a 1-of-1 DVN before the exploit. No price feed or onboarding report would have caught that change; a config-diff alert would have.

The Bloomberg lesson: it didn't win on better analytics. It won by normalizing messy data everyone needed and becoming the shared layer. Build to complement curators' existing tools, not to replace them.

## Config cards & diff alerts

Extend the planned Oracle registry: one card per asset, showing its full trust configuration and every change to it, color-coded by state. Pending changes matter most, because a timelock is the window where a curator can still act.

| State | Color | Meaning | Curator action |
| --- | --- | --- | --- |
| Pending | Amber | Queued in a timelock, not yet live | Act now: reduce caps, exit, or flag |
| Proposed | Blue | In governance discussion or vote | Watch, comment, prepare |
| Historical | Grey | Already executed | Audit trail, pattern-spotting |

What each card monitors:

- Bridge verification: DVN count and threshold, verifier operators, per-route configs (each L2 path separately)
- Oracles: source, aggregation method, TWAP window, heartbeat, fallback
- Admin control: multisig signers and threshold, timelock length, proxy upgrades, role grants
- Mint/redeem logic: rate providers, pause guardians, caps

Alert rules:

- Any downgrade in security (fewer verifiers, lower threshold, shorter timelock) is flagged red, regardless of state
- Changes with no prior governance post are flagged as unannounced
- Alerts link back to the card and push to Telegram (existing alert bot) so they land in curators' war rooms

## Oracle manipulation warnings

Each oracle card shows how close manipulation is to being profitable, as a ratio of cost to move the price versus value extractable from that move. Warnings go yellow, then red, as the ratio shrinks.

Inputs per card:

1. Cost to move the price X%: pool depth along the oracle's source path, TWAP window length, number of blocks an attacker must hold the price
2. Extractable value at X%: total borrowable against that collateral across every market using the same oracle, not just Membrane's
3. Safety ratio = cost ÷ extractable value

| Ratio | Warning |
| --- | --- |
| ≥ 3× | None |
| 1.5× – 3× | Yellow |
| < 1.5× | Red |

Thresholds are placeholders; calibrate against past incidents. The cross-market input matters: the Aug 2026 Morpho PT-reUSD TWAP manipulation was profitable because of how much could be borrowed against it, not only because the pool was thin.

## Curator action feed & communication

Don't try to replace curators' war rooms; feed them instead. Bloomberg chat worked because everyone was already on the terminal all day, and Membrane would be bootstrapping presence from zero.

- Curator action feed: log when curators change caps, delist, or exit an asset. Clustered moves are themselves a risk signal ("3 curators removed rsETH in 24h"). Steakhouse delisting rsETH in 2025 was a signal anyone could have followed.
- Threads on config cards: discussion attached to a specific change, not general chat.
- Push to existing channels: alerts go out via the Telegram bot with links back to the card, so each forwarded alert is distribution.
- In-app chat: later, only once curators spend time in the app.

## Build order & open questions

1. Config cards with historical diffs for a handful of high-exposure assets (LRTs, bridged assets, PTs)
2. Pending and proposed states: timelock and governance-forum ingestion
3. Telegram alert push with card links
4. Oracle cost-vs-profit ratio and yellow/red warnings
5. Curator action feed
6. Card threads; in-app chat deferred

Open questions:

- [ ] Validate with 3–5 curators (Steakhouse, Gauntlet, Re7, MEV Capital, kpk): "How did you find out about Kelp, and what would you have needed to know a week earlier?"
- [ ] How to detect off-chain config (e.g. DVN settings) reliably across chains
- [ ] Calibrate oracle warning thresholds against past manipulation incidents
- [ ] Which data is free and public vs. a paid tier
