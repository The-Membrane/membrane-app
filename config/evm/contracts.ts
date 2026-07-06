/**
 * EVM contract address book, keyed by chainId. Replaces the bech32 address tables in
 * config/contracts.json / config/defaults.ts under the EVM-only migration.
 *
 * Anvil addresses are filled from the broadcast output of DeployFullSystem.s.sol
 * (deterministic given a fresh anvil + fixed deployer nonce ordering). Until a deploy
 * has been run, entries are undefined and services return null (never throw) —
 * matching the existing service-layer contract.
 */

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

export type Address = `0x${string}`

const ADDRESSES: Record<number, Partial<Record<ContractName, Address>>> = {
  // anvil — populate from membrane-solidity broadcast/DeployFullSystem.s.sol/31337/run-latest.json
  31337: {},
}

export function getContractAddress(chainId: number, name: ContractName): Address | undefined {
  return ADDRESSES[chainId]?.[name]
}
