// Frozen source cohort selected from pre-existing, two-host verified Deposit logs.
// Selection uses only event identity and block position, never later exit outcomes.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAbiItem, toEventHash } from 'viem'

import { loadMorphoFlowSubjects } from '../record-carry-morpho-v2-flows.mjs'
import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'
import { CAMPAIGN_ROOT, ROOT, verifyArchive } from './record-carry-morpho-v2-block-archive.mjs'

export const OUT = resolve(
  'data/research/venue-signals/carry-morpho-retrospective-event-grid-v1.json',
)
export const EPOCH_BLOCKS = 512
const DEPOSIT = toEventHash(
  parseAbiItem(
    'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
).toLowerCase()
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code) => {
  throw Error(`morpho_event_grid_${code}`)
}

export function selectEventCells(events, startBlock, routeByVault) {
  const selected = new Map()
  for (const event of events) {
    if (event.topics?.[0] !== DEPOSIT) continue
    const routeIndex = routeByVault.get(event.address)
    if (routeIndex === undefined) fail('unknown_vault')
    const eventBlock = Number(event.blockNumber)
    if (!Number.isSafeInteger(eventBlock) || eventBlock < startBlock) fail('event_block')
    const epoch = Math.floor((eventBlock - startBlock) / EPOCH_BLOCKS)
    const key = `${routeIndex}:${epoch}`
    if (selected.has(key)) continue
    selected.set(key, {
      routeIndex,
      epoch,
      eventBlock,
      eventBlockHash: event.blockHash,
      depositTxHash: event.transactionHash,
      depositLogIndex: event.logIndex,
      depositHolderCommitment: sha(`${event.address}:${`0x${event.topics[2].slice(-40)}`}`),
      sourceBlock: eventBlock + 1,
      fromBlock: eventBlock,
      toBlock: eventBlock,
    })
  }
  return [...selected.values()].sort((a, b) => a.routeIndex - b.routeIndex || a.epoch - b.epoch)
}

export async function buildEventGrid(bundlesLimit = null) {
  const subjects = await loadMorphoFlowSubjects()
  const manifestFile = JSON.parse(
    readFileSync(resolve('lib/carry/morpho-v2-asset-identities.json')),
  )
  const manifest = new Map(
    manifestFile.entries.map((r) => [r.vault.toLowerCase(), BigInt(r.creation.blockNumber)]),
  )
  const pilot = verifyArchive(subjects, manifest, ROOT, { requireComplete: true })
  const pilotTip = JSON.parse(
    readFileSync(join(ROOT, `${String(pilot.bundles).padStart(12, '0')}.json`)),
  )
  const archive = verifyArchive(subjects, manifest, CAMPAIGN_ROOT, {
    requireComplete: false,
    campaign: true,
    predecessorSha256: pilotTip.sha256,
  })
  const bundles = bundlesLimit ?? archive.bundles
  if (!Number.isSafeInteger(bundles) || bundles < 1 || bundles > archive.bundles)
    fail('bundle_limit')
  const frozenTip = JSON.parse(
    readFileSync(join(CAMPAIGN_ROOT, `${String(bundles).padStart(12, '0')}.json`)),
  )
  const enrollment = JSON.parse(readFileSync(join(CAMPAIGN_ROOT, 'enrollment.json')))
  const routeByVault = new Map(BOARD_ROUTES.map((route, index) => [route.destination, index]))
  if (routeByVault.size !== 49 || subjects.length !== 49) fail('route_count')
  const events = []
  for (let sequence = 1; sequence <= bundles; sequence++) {
    const bundle = JSON.parse(
      readFileSync(join(CAMPAIGN_ROOT, `${String(sequence).padStart(12, '0')}.json`)),
    )
    for (const slice of bundle.slices) events.push(...slice.witnesses[0].raw)
  }
  const body = {
    schema: 'carry_morpho_retrospective_event_grid_v1',
    chainId: 1,
    selectionRule: 'first_deposit_per_vault_per_512_block_epoch_from_verified_archive',
    epochBlocks: EPOCH_BLOCKS,
    archiveStartBlock: Number(enrollment.startBlock) + 1,
    archiveTipSha256: frozenTip.sha256,
    archiveBundles: bundles,
    archiveEvents: events.length,
    cells: selectEventCells(events, Number(enrollment.startBlock) + 1, routeByVault),
    forecastValidated: false,
  }
  return { ...body, sha256: sha(body) }
}

export async function readVerifiedEventGrid() {
  const frozen = JSON.parse(readFileSync(OUT))
  const { sha256, ...body } = frozen
  if (sha(body) !== sha256) fail('seal')
  const rebuilt = await buildEventGrid(frozen.archiveBundles)
  if (sha(rebuilt) !== sha(frozen)) fail('grid_drift')
  return frozen
}

async function main() {
  const [action] = process.argv.slice(2)
  if (!['--freeze', '--verify'].includes(action) || process.argv.length !== 3) fail('usage')
  if (action === '--freeze') {
    const rebuilt = await buildEventGrid()
    writeFileSync(OUT, `${JSON.stringify(rebuilt)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(
      JSON.stringify({
        cells: rebuilt.cells.length,
        vaults: new Set(rebuilt.cells.map((c) => c.routeIndex)).size,
        sha256: rebuilt.sha256,
        forecastValidated: false,
      }),
    )
  } else {
    const rebuilt = await readVerifiedEventGrid()
    console.log(
      JSON.stringify({
        cells: rebuilt.cells.length,
        vaults: new Set(rebuilt.cells.map((c) => c.routeIndex)).size,
        sha256: rebuilt.sha256,
        forecastValidated: false,
      }),
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
