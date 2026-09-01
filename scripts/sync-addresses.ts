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
 * The on-chain Q-Racing game lives in its OWN Foundry project (membrane-solidity
 * q-racing/) and its deploy (q-racing/script/Deploy.s.sol) writes a plain
 * address map to q-racing/ui/deployment.json rather than a broadcast we map by
 * contractName. The anvil swap venue (USDC/WETH/router) is stood up separately and
 * its addresses land in q-racing/ui/dex.json. Both are read directly here — no
 * `MembraneToken`-by-order disambiguation needed, and the game's mock CDT (`qgameCdt`)
 * is its own key, distinct from the protocol `cdt`/`mbrn`. Missing files => the
 * qgame.* keys keep whatever they had. Replaces the retired `qracing*` mint bridge.
 *
 * To sync after a fresh anvil deploy of the game:
 *   1. (in q-racing/) forge script script/Deploy.s.sol --rpc-url ... --broadcast   # writes ui/deployment.json
 *   2. deploy the swap venue (MinimalV2Dex) and write its addresses to ui/dex.json
 *   3. pnpm sync-addresses            (this script reads both JSON files)
 */
const QGAME_ROOT = path.join(SOLIDITY_ROOT, 'q-racing', 'ui')
/** q-racing/ui/deployment.json key -> address-book key */
const QGAME_DEPLOYMENT_MAP: Record<string, string> = {
  game: 'qgamePocketGP',
  petNFT: 'qgamePetNFT',
  token: 'qgameBytes',
  petLens: 'qgamePetLens',
  standings: 'qgameStandings',
  dailyMaze: 'qgameDailyMaze',
  cdt: 'qgameCdt',
}
/** q-racing/ui/dex.json key -> address-book key (the anvil swap venue) */
const QGAME_DEX_MAP: Record<string, string> = {
  usdc: 'qgameUsdc',
  weth: 'qgameWeth',
  router: 'qgameRouter',
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

  // Carry forward any existing qgame.* values, then overlay fresh q-racing deploy
  // artifacts on top (kept separate so the game's mock CDT can't clobber cdt/mbrn).
  const prev = (existing[CHAIN_ID] ?? {}) as Record<string, string>
  for (const [k, v] of Object.entries(prev)) {
    if (k.startsWith('qgame')) addresses[k] = v
  }
  const overlayJson = (file: string, map: Record<string, string>, label: string) => {
    if (!fs.existsSync(file)) {
      console.warn(`  (skipped: no ${label} at ${file})`)
      return
    }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    for (const [srcKey, destKey] of Object.entries(map)) {
      if (doc[srcKey]) addresses[destKey] = doc[srcKey]
    }
  }
  // Only overlay the game set on the game's own chain (anvil). deployment.json carries
  // no chainId, so gate on CHAIN_ID to avoid stamping anvil addresses onto other chains.
  if (CHAIN_ID === '31337') {
    overlayJson(path.join(QGAME_ROOT, 'deployment.json'), QGAME_DEPLOYMENT_MAP, 'q-racing/ui/deployment.json')
    overlayJson(path.join(QGAME_ROOT, 'dex.json'), QGAME_DEX_MAP, 'q-racing/ui/dex.json')
  }

  existing[CHAIN_ID] = addresses
  fs.writeFileSync(DEST, JSON.stringify(existing, null, 2) + '\n')

  console.log(`Wrote ${Object.keys(addresses).length} addresses for chain ${CHAIN_ID} to config/evm/addresses.json:`)
  console.log(Object.entries(addresses).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
}

main()
