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
  // On-chain Q-Racing game (membrane-solidity q-racing/script/Deploy.s.sol, anvil).
  // Filled by `pnpm sync-addresses` from q-racing/ui/deployment.json (the game contract
  // set) and q-racing/ui/dex.json (the anvil swap venue: USDC/WETH/router). The game
  // stands up its own mock CDT — `qgameCdt` is a SEPARATE key from the protocol `cdt`
  // above (they differ per deploy). This replaces the retired `qracing*` mint bridge.
  | 'qgamePocketGP'
  | 'qgamePetNFT'
  | 'qgameBytes'
  | 'qgamePetLens'
  | 'qgameStandings'
  | 'qgameDailyMaze'
  | 'qgameCdt'
  | 'qgameUsdc'
  | 'qgameWeth'
  | 'qgameRouter'

export type Address = `0x${string}`

const ADDRESSES = addressBook as Record<string, Partial<Record<ContractName, Address>>>

export function getContractAddress(chainId: number, name: ContractName): Address | undefined {
  return ADDRESSES[String(chainId)]?.[name]
}
