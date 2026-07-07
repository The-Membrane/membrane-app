/**
 * Sync deployed contract addresses from a Foundry broadcast into config/evm/addresses.json.
 *
 * Usage: pnpm sync-addresses [chainId]   (default 31337; set MEMBRANE_SOLIDITY_PATH to
 * override the sibling-repo default)
 *
 * Reads broadcast/DeployFullSystem.s.sol/<chainId>/run-latest.json, maps Foundry
 * contractName -> our ContractName keys, and writes config/evm/addresses.json which
 * config/evm/contracts.ts loads. CDT/MBRN are both `MembraneToken` deployments — they
 * are disambiguated by CREATE order (CDT first, MBRN second: DeployFullSystem.s.sol:203-204).
 */
import * as fs from 'fs'
import * as path from 'path'

const SOLIDITY_ROOT = process.env.MEMBRANE_SOLIDITY_PATH ?? path.resolve(__dirname, '../../membrane-solidity')
const CHAIN_ID = process.argv[2] ?? '31337'
const BROADCAST = path.join(SOLIDITY_ROOT, 'broadcast', 'DeployFullSystem.s.sol', CHAIN_ID, 'run-latest.json')
const DEST = path.resolve(__dirname, '../config/evm/addresses.json')

/** Foundry contractName -> address-book key (MembraneToken handled by order below) */
const NAME_MAP: Record<string, string> = {
  Cdp: 'cdp',
  LtvDisco: 'ltvDisco',
  LiquidationEngine: 'liquidationEngine',
  LiqQueue: 'liqQueue',
  Transmuter: 'transmuter',
  Acquisition: 'acquisition',
  Staking: 'staking',
  Governance: 'governance',
  RevenueDistributor: 'revenueDistributor',
  Oracle: 'oracle',
  TwalOracle: 'twalOracle',
  PointsSystem: 'pointsSystem',
  SystemDiscounts: 'systemDiscounts',
  Auction: 'auction',
  Vesting: 'vesting',
  Collateral: 'collateral',
  FrontendLens: 'frontendLens',
  CdpRouter: 'cdpRouter',
}

function main() {
  if (!fs.existsSync(BROADCAST)) {
    console.error(`Broadcast not found: ${BROADCAST}`)
    console.error('Run the deploy first: forge script script/DeployFullSystem.s.sol --rpc-url <url> --broadcast')
    process.exit(1)
  }

  const run = JSON.parse(fs.readFileSync(BROADCAST, 'utf8'))
  const addresses: Record<string, string> = {}
  const membraneTokens: string[] = []

  for (const tx of run.transactions ?? []) {
    if (tx.transactionType !== 'CREATE' || !tx.contractAddress) continue
    if (tx.contractName === 'MembraneToken') {
      membraneTokens.push(tx.contractAddress)
      continue
    }
    const key = NAME_MAP[tx.contractName]
    if (key) addresses[key] = tx.contractAddress
  }

  // CDT deployed before MBRN (DeployFullSystem.s.sol:203-204)
  if (membraneTokens[0]) addresses.cdt = membraneTokens[0]
  if (membraneTokens[1]) addresses.mbrn = membraneTokens[1]

  const existing = fs.existsSync(DEST) ? JSON.parse(fs.readFileSync(DEST, 'utf8')) : {}
  existing[CHAIN_ID] = addresses
  fs.writeFileSync(DEST, JSON.stringify(existing, null, 2) + '\n')

  console.log(`Wrote ${Object.keys(addresses).length} addresses for chain ${CHAIN_ID} to config/evm/addresses.json:`)
  console.log(Object.entries(addresses).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
}

main()
