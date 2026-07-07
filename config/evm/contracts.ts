/**
 * EVM contract address book, keyed by chainId. Replaces the bech32 address tables in
 * config/contracts.json / config/defaults.ts under the EVM-only migration.
 *
 * Addresses live in ./addresses.json, written by `pnpm sync-addresses` from the
 * membrane-solidity Foundry broadcast (deterministic on a fresh anvil given fixed
 * deployer nonce ordering). Where no address exists, entries are undefined and
 * services return null (never throw) — matching the existing service-layer contract.
 */
import addressBook from './addresses.json'

export type ContractName =
  | 'cdp'
  | 'ltvDisco'
  | 'liquidationEngine'
  | 'liqQueue'
  | 'transmuter'
  | 'acquisition'
  | 'staking'
  | 'governance'
  | 'revenueDistributor'
  | 'oracle'
  | 'twalOracle'
  | 'pointsSystem'
  | 'systemDiscounts'
  | 'auction'
  | 'vesting'
  | 'cdt'
  | 'mbrn'
  | 'collateral'
  | 'frontendLens'
  | 'cdpRouter'

export type Address = `0x${string}`

const ADDRESSES = addressBook as Record<string, Partial<Record<ContractName, Address>>>

export function getContractAddress(chainId: number, name: ContractName): Address | undefined {
  return ADDRESSES[String(chainId)]?.[name]
}
