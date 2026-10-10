// Deterministic no-lookahead Morpho source grid from sealed daily cash anchors.
// This is a capture plan, not a set of holder outcomes or a forecast.
import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readLocalCarryCashObservations } from '../lib/localCarryCashStore.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'

export const OUT = resolve('data/research/venue-signals/carry-morpho-retrospective-grid-v1.json')
export const STUDY = 'carry_morpho_retrospective_grid_v1'
const SHA = /^[0-9a-f]{64}$/
const HASH = /^0x[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bodyOf = ({ sha256: _sha256, ...body }) => body

export function buildGrid({ manifest, observations, routes = BOARD_ROUTES }) {
  if (!Array.isArray(manifest?.subjects) || manifest.subjects.length !== 67)
    throw Error('morpho_grid_manifest_invalid')
  const subjects = new Set(
    manifest.subjects.map((row) => `${row.route_key}\0${row.destination}\0${row.asset}`),
  )
  if (
    !Array.isArray(routes) ||
    routes.length !== BOARD_ROUTES.length ||
    routes.some(
      (route, index) =>
        route !== BOARD_ROUTES[index] ||
        !subjects.has(`${route.routeKey}\0${route.destination}\0${route.asset}`),
    )
  )
    throw Error('morpho_grid_routes_invalid')
  const daily = observations
    .filter(
      (row) => row.collectionMode === 'retrospective' && row.anchorAt.endsWith('T00:00:00.000Z'),
    )
    .sort((a, b) => a.anchorAt.localeCompare(b.anchorAt))
    .slice(-120)
  if (daily.length !== 120 || new Set(daily.map((row) => row.anchorAt)).size !== 120)
    throw Error('morpho_grid_daily_anchors_invalid')
  for (let i = 1; i < daily.length; i++) {
    if (Date.parse(daily[i].anchorAt) - Date.parse(daily[i - 1].anchorAt) !== 86_400_000)
      throw Error('morpho_grid_daily_anchors_invalid')
  }
  const anchors = daily
    .filter((_, index) => index % 10 === 0)
    .map((row) => {
      const sourceBlock = Number(row.source?.block)
      if (
        !Number.isSafeInteger(sourceBlock) ||
        sourceBlock <= 64 ||
        !HASH.test(row.source?.blockHash ?? '') ||
        !SHA.test(row.receiptSha256 ?? '') ||
        row.source.blockAt > row.anchorAt
      )
        throw Error('morpho_grid_anchor_invalid')
      return {
        anchorAt: row.anchorAt,
        sourceBlock,
        sourceHash: row.source.blockHash,
        sourceAt: row.source.blockAt,
        sourceReceiptSha256: row.receiptSha256,
      }
    })
  const body = {
    study: STUDY,
    manifestSha256: manifest.sha256,
    policy: 'last_120_daily_anchors_every_tenth_from_oldest_preceding_64_blocks',
    lookbackBlocks: 64,
    historicalBacktestOnly: true,
    forecastValidated: false,
    anchors,
    cells: routes.flatMap((route, routeIndex) =>
      anchors.map((anchor, anchorIndex) => ({
        routeIndex,
        routeKey: route.routeKey,
        destination: route.destination,
        asset: route.asset,
        anchorIndex,
        sourceBlock: anchor.sourceBlock,
        fromBlock: anchor.sourceBlock - 64,
        toBlock: anchor.sourceBlock - 1,
      })),
    ),
  }
  return { ...body, sha256: sha(body) }
}

export function validateGrid(grid, expected) {
  if (!grid || !SHA.test(grid.sha256 ?? '') || sha(bodyOf(grid)) !== grid.sha256)
    throw Error('morpho_grid_seal_invalid')
  if (JSON.stringify(grid) !== JSON.stringify(expected)) throw Error('morpho_grid_archive_mismatch')
  return grid
}

export async function readVerifiedGrid() {
  const manifest = await buildSubjectManifest()
  const grid = buildGrid({ manifest, observations: readLocalCarryCashObservations(manifest) })
  const onDisk = await readFile(OUT, 'utf8')
  if (onDisk !== `${JSON.stringify(grid)}\n`) throw Error('morpho_grid_physical_mismatch')
  return validateGrid(JSON.parse(onDisk), grid)
}

export async function main(mode = '--verify') {
  if (!['--create', '--verify'].includes(mode)) throw Error('usage: --create|--verify')
  const manifest = await buildSubjectManifest()
  const grid = buildGrid({ manifest, observations: readLocalCarryCashObservations(manifest) })
  if (mode === '--create') {
    await mkdir(resolve('data/research/venue-signals'), { recursive: true })
    const bytes = `${JSON.stringify(grid)}\n`
    const disk = statfsSync(resolve('data/research/venue-signals'))
    if (Number(disk.bavail) * Number(disk.bsize) < 1_073_741_824 + Buffer.byteLength(bytes))
      throw Error('morpho_grid_disk_reserve')
    const temporary = `${OUT}.tmp-${process.pid}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, OUT)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  await readVerifiedGrid()
  return {
    anchors: grid.anchors.length,
    routes: BOARD_ROUTES.length,
    cells: grid.cells.length,
    sha256: grid.sha256,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? 'morpho_grid_failed').split(' ')[0])
      process.exitCode = 1
    })
