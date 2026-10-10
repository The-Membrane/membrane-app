# Contract-to-App File Mapping

Complete mapping between membrane-core contracts and the membrane-app files that depend on them.

## Core Contract Mappings

### CDP Organ

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/cdp.rs` | `contracts/generated/positions/Positions.types.ts`, `services/cdp.ts` |
| `packages/membrane/src/collateral.rs` | `services/cdp.ts` (collateral queries) |
| `packages/membrane/src/debt.rs` | `services/cdp.ts` (debt/interest queries), `components/NeutronMint/hooks/` |
| `packages/membrane/src/liq_queue.rs` | `contracts/generated/liquidation_queue/`, `components/Bid/` |
| `packages/membrane/src/liquidation_engine.rs` | `services/cdp.ts` (liquidation simulation) |
| `contracts/cdp/src/contract.rs` | `services/cdp.ts` |
| `contracts/collateral/src/` | `components/NeutronMint/mockCollateralData.ts`, `types.ts` |
| `contracts/debt/src/` | `components/NeutronMint/hooks/useBorrowTransaction.ts`, `useRepayTransaction.ts` |
| `contracts/liq-queue/src/` | `contracts/generated/liquidation_queue/` |
| `contracts/liquidation-engine/src/` | `components/NeutronMint/hooks/useLiquidationQueueSimulation.ts`, `useMarketSaleSimulation.ts` |

### Transmuter Organ

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/transmuter.rs` | `services/transmuter.ts`, `hooks/useTransmuterData.ts` |
| `contracts/transmuter/src/` | `services/transmuter.ts`, `contracts/transmuterContract.ts` (Ditto) |
| `docs/organs/transmuter/` | `contracts/transmuterContract.ts` (facts/thresholds) |

### LTV Disco Organ

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/ltv_disco.rs` | `services/disco.ts`, `hooks/useDiscoData.ts`, `components/Disco/types.ts` |
| `contracts/ltv_disco/src/` | `services/disco.ts`, `contracts/discoContract.ts` (Ditto) |
| `packages/membrane/src/emissions_voting.rs` | `services/disco.ts` (voting queries) |
| `docs/organs/ltv-disco/` | `contracts/discoContract.ts`, `components/Disco/` |

### Acquisition Organ

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/acquisition.rs` | `services/acquisition.ts`, `types/acquisitionIntents.ts`, `hooks/useAcquisition.ts` |
| `contracts/acquisition/src/` | `services/acquisition.ts`, `hooks/useUserAcquisitionIntents.ts` |
| `docs/organs/acquisition/` | `components/acquisition/`, Ditto sections |

### Governance Organ

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/staking.rs` | `contracts/generated/staking/`, `services/staking.ts` (if exists) |
| `packages/membrane/src/governance.rs` | `contracts/generated/governance/` |
| `packages/membrane/src/vesting.rs` | `contracts/generated/vesting/` |
| `contracts/staking/src/` | Staking UI components |
| `contracts/governance/src/` | Governance UI components |

### Revenue Organ

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/revenue_distributor.rs` | `hooks/useRevenuePerSecond.ts` (in Portfolio) |
| `packages/membrane/src/auction.rs` | `contracts/generated/auction/` (if exists) |
| `contracts/revenue-distributor/src/` | Revenue display components |

### Shared Contracts

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/oracle.rs` | `contracts/generated/oracle/`, `services/oracle.ts` (if exists) |
| `packages/membrane/src/system_discounts.rs` | `services/systemDiscounts.ts` |
| `packages/membrane/src/types.rs` | Multiple — shared types (Asset, Basket, cAsset, etc.) used across all services |
| `packages/membrane/src/points_system.rs` | Points display components |

### Infrastructure

| membrane-core | membrane-app files |
|---|---|
| `packages/membrane/src/osmosis_proxy.rs` | `services/osmosisProxy.ts` (if exists) |
| `packages/membrane/src/neutron_proxy.rs` | `hooks/useNeutronProxy.ts`, `services/neutronProxy.ts` |
| `contracts/osmosis-proxy/src/` | Chain interaction services |
| `contracts/neutron-proxy/src/` | `hooks/useNeutronProxy.ts` |

## Documentation Mappings

### Cross-Organ Flow Docs (highest priority)

| membrane-core doc | membrane-app counterparts |
|---|---|
| `docs/cross-organ/revenue-flow.md` | `hooks/useRevenuePerSecond.ts`, `contracts/portfolioContract.ts` |
| `docs/cross-organ/liquidation-flow.md` | `components/Bid/`, liquidation simulation hooks |
| `docs/cross-organ/acquisition-to-disco-flow.md` | `services/acquisition.ts`, `services/disco.ts`, Ditto sections |
| `docs/cross-organ/flywheel.md` | `components/Flywheel/`, `docs.md`, `membrane_about.md` |

### Organ Docs

| membrane-core doc | membrane-app counterparts |
|---|---|
| `docs/organs/cdp/` | `docs.md` (Minting Mechanism section), `components/NeutronMint/` |
| `docs/organs/transmuter/` | `docs.md` (Market Making section), `pages/[chain]/transmuter.tsx` |
| `docs/organs/ltv-disco/` | `components/Disco/`, Ditto disco sections |
| `docs/organs/acquisition/` | `components/acquisition/`, acquisition dashboard |
| `docs/organs/governance/` | `docs.md` (Governance Framework section) |
| `docs/organs/revenue/` | Revenue display components |

## Config & Address Mappings

| membrane-core | membrane-app |
|---|---|
| Contract deployment addresses | `config/contracts.json` |
| Supported collateral assets | `config/lpAssets.json`, `components/NeutronMint/mockCollateralData.ts` |

## Type Mirroring Files

These files explicitly note they mirror Rust structs — always check when core changes:

| membrane-app file | mirrors |
|---|---|
| `types/acquisitionIntents.ts` | `packages/membrane/src/acquisition.rs` |
| `services/q-racing.ts` | `rps_engine.rs` and `types.rs` |

## Codegen Pipeline

When JSON schemas in `contracts/schema/` are updated:

```
contracts/schema/*.json → scripts/codegen.js → contracts/generated/*
```

If schemas are not yet regenerated from membrane-core, manually update the TypeScript types
in `contracts/generated/<contract>/<Contract>.types.ts` to match the new Rust definitions.
