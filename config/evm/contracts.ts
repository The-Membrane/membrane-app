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
  // Q-Racing mint bridge (membrane-solidity script/DeployQRacingMint.s.sol, anvil).
  // These live in the SAME per-chain address book; `pnpm sync-addresses` fills them from
  // the DeployQRacingMint broadcast when present, else they stay zero placeholders. The
  // qracing deploy stands up its own mock CDT/USDC/WETH + V2 router, so `qracingCdt` is a
  // separate key from the protocol `cdt` above (they may differ per deploy).
  | 'qracingMintClaim'
  | 'qracingByteToken'
  | 'qracingPetNFT'
  | 'qracingCdt'
  | 'qracingUsdc'
  | 'qracingWeth'
  | 'qracingRouter'

export type Address = `0x${string}`

const ADDRESSES = addressBook as Record<string, Partial<Record<ContractName, Address>>>

export function getContractAddress(chainId: number, name: ContractName): Address | undefined {
  return ADDRESSES[String(chainId)]?.[name]
}
