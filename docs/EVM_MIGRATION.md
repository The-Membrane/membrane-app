# EVM Migration — Phase 0

**Decision (2026-07-06): membrane-app is going EVM-only.** No dual-chain support. The
entire Cosmos stack is removed, not quarantined. All work on the `evm-migration` branch.

Master plan: `~/.claude/plans/membrane-ui-build-plan.md` (Phase 0 section).

## Target stack

| Concern | Choice | Version (verified on npm 2026-07-06) |
|---|---|---|
| Wallet/react bindings | wagmi | ^3.6.21 |
| EVM client | viem | ^2.54.6 |
| Primary connector | MetaMask SDK (via wagmi connector) | sdk 0.34.0 |
| Query cache | @tanstack/react-query | already installed (^5.90) |
| Contract types | ABIs from `membrane-solidity/out/` (Foundry) → abitype/wagmi codegen | — |

- **Contracts**: `/Users/EBmic/membrane-solidity/src` — Cdp, LtvDisco, LiquidationEngine,
  LiqQueue, Transmuter, Acquisition, Staking, Governance, RevenueDistributor, Oracle/TwalOracle,
  PointsSystem, SystemDiscounts, Vesting, FounderRevenue, vaults/.
- **Dev chain**: no live deployment yet. First target is a local **anvil** run of
  `script/DeployFullSystem.s.sol` (see `membrane-solidity/script/anvil-test.sh`). Chain config
  must be parameterized (env-driven chainId + RPC + address book), not hardcoded.

## Architecture rule: the chain-client seam

Pages and components never import viem/wagmi primitives directly (same rule that was violated
with CosmJS). All chain access goes through:

```
components/pages → domain hooks (useUserPositions, useMarketRates, ...)
                → services/chain/*  (typed contract reads/writes, one module per contract)
                → wagmi/viem        (the only layer that knows about transports/connectors)
```

Reads must work **walletless** (public RPC transport) — full app visibility without connecting
is a product requirement. Wallet connection only gates *writes* and user-scoped convenience.

## Migration ledger

Populated by the Phase 0 audits (Cosmos call-site map, dependency cut list, wallet-gating
route audit) — results land in `docs/audits/` as they complete. Every Cosmos call site gets
one of: **REPLACE** (EVM equivalent via the seam) or **DELETE** (Cosmos-only feature).

## Out of scope for Phase 0

Persona pages, gamification, Ditto changes — see master plan Phases 2–4.
