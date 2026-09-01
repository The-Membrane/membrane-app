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

/**
 * Supplementary broadcasts merged on top of DeployFullSystem, in order.
 *
 * DeployFullSystem does NOT deploy every contract the frontend reads. `CdpRouter`
 * is periphery with its own script (membrane-solidity script/DeployLocalRouter.s.sol);
 * without merging that broadcast the `cdpRouter` key is silently absent and the
 * entire Mint flow (deposit-and-borrow, repay-and-withdraw) is dead — see
 * services/chain/router.ts and components/Mint/hooks/useMint.ts.
 *
 * Missing files are skipped, so this stays a no-op on chains where the extra
 * script was never run.
 */
const EXTRA_BROADCASTS = ['DeployLocalRouter.s.sol']

/**
 * Q-Racing mint bridge lives in its OWN deploy script (membrane-solidity
 * script/DeployQRacingMint.s.sol) with its own mock CDT/USDC/WETH + V2 router. Its
 * contract names are collected SEPARATELY (see collectQracing below) so its mock
 * `MembraneToken` CDT never collides with the protocol CDT/MBRN ordering in the main
 * collect(). Missing broadcast => the qracing.* keys keep their zero placeholders.
 *
 * To sync after a fresh anvil deploy:
 *   1. MINT_SIGNER=$(MINT_SIGNER_KEY=0x... node scripts/print-mint-signer-address.mjs)
 *   2. MINT_SIGNER=$MINT_SIGNER forge script script/DeployQRacingMint.s.sol --rpc-url ... --broadcast
 *   3. pnpm sync-addresses            (this script picks up both broadcasts)
 * Or paste the deploy's logged addresses straight into config/evm/addresses.json.
 */
const QRACING_BROADCAST = 'DeployQRacingMint.s.sol'
const QRACING_NAME_MAP: Record<string, string> = {
  MintClaim: 'qracingMintClaim',
  ByteToken: 'qracingByteToken',
  PetNFT: 'qracingPetNFT',
  MembraneToken: 'qracingCdt', // the mock CDT stood up by the qracing deploy
  MockERC20: 'qracingUsdc',
  WETH9: 'qracingWeth',
  MinimalV2Router02: 'qracingRouter',
}

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

  const addresses: Record<string, string> = {}
  const membraneTokens: string[] = []

  const collect = (file: string) => {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const tx of run.transactions ?? []) {
      if (tx.transactionType !== 'CREATE' || !tx.contractAddress) continue
      if (tx.contractName === 'MembraneToken') {
        membraneTokens.push(tx.contractAddress)
        continue
      }
      const key = NAME_MAP[tx.contractName]
      if (key) addresses[key] = tx.contractAddress
    }
  }

  collect(BROADCAST)

  for (const script of EXTRA_BROADCASTS) {
    const extra = path.join(SOLIDITY_ROOT, 'broadcast', script, CHAIN_ID, 'run-latest.json')
    if (!fs.existsSync(extra)) {
      console.warn(`  (skipped: no broadcast for ${script} on chain ${CHAIN_ID})`)
      continue
    }
    collect(extra)
  }

  // CDT deployed before MBRN (DeployFullSystem.s.sol:203-204)
  if (membraneTokens[0]) addresses.cdt = membraneTokens[0]
  if (membraneTokens[1]) addresses.mbrn = membraneTokens[1]

  const existing = fs.existsSync(DEST) ? JSON.parse(fs.readFileSync(DEST, 'utf8')) : {}

  // Carry forward any existing qracing.* placeholders/values, then overlay a fresh
  // DeployQRacingMint broadcast on top (kept separate so its mock CDT can't clobber cdt/mbrn).
  const prev = (existing[CHAIN_ID] ?? {}) as Record<string, string>
  for (const [k, v] of Object.entries(prev)) {
    if (k.startsWith('qracing')) addresses[k] = v
  }
  const qracingFile = path.join(SOLIDITY_ROOT, 'broadcast', QRACING_BROADCAST, CHAIN_ID, 'run-latest.json')
  if (fs.existsSync(qracingFile)) {
    const run = JSON.parse(fs.readFileSync(qracingFile, 'utf8'))
    for (const tx of run.transactions ?? []) {
      if (tx.transactionType !== 'CREATE' || !tx.contractAddress) continue
      const key = QRACING_NAME_MAP[tx.contractName]
      if (key) addresses[key] = tx.contractAddress
    }
  } else {
    console.warn(`  (skipped: no broadcast for ${QRACING_BROADCAST} on chain ${CHAIN_ID})`)
  }

  existing[CHAIN_ID] = addresses
  fs.writeFileSync(DEST, JSON.stringify(existing, null, 2) + '\n')

  console.log(`Wrote ${Object.keys(addresses).length} addresses for chain ${CHAIN_ID} to config/evm/addresses.json:`)
  console.log(Object.entries(addresses).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
}

main()
