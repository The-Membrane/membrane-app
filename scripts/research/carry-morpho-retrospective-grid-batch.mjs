// Small, serial, foreground batches from the sealed Morpho retrospective grid.
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import {
  configuredPublicRpcUrls,
  publicRpcClients,
  slicedCandidateRequest,
} from './carry-public-direct-exit-issue.mjs'
import { readAudit } from './carry-morpho-retrospective-grid-audit.mjs'
import { readVerifiedGrid } from './carry-morpho-retrospective-grid.mjs'
import {
  OUT as PAIR_DIR,
  capturePilot,
  save,
  selectRpcUrls,
} from './carry-morpho-retrospective-holder-pairs.mjs'

const DECIMAL = /^(0|[1-9]\d*)$/
const fileFor = (routeIndex, sourceBlock) =>
  join(
    PAIR_DIR,
    `${String(routeIndex).padStart(2, '0')}-${String(sourceBlock).padStart(12, '0')}.json`,
  )

export function selectBatch(grid, { anchorIndex, routeStart, routeCount }) {
  if (
    !Number.isSafeInteger(anchorIndex) ||
    anchorIndex < 0 ||
    anchorIndex >= grid.anchors.length ||
    !Number.isSafeInteger(routeStart) ||
    routeStart < 0 ||
    !Number.isSafeInteger(routeCount) ||
    routeCount < 1 ||
    routeCount > 6 ||
    routeStart + routeCount > new Set(grid.cells.map((cell) => cell.routeIndex)).size
  )
    throw Error('morpho_grid_batch_selection_invalid')
  const cells = grid.cells.filter(
    (cell) =>
      cell.anchorIndex === anchorIndex &&
      cell.routeIndex >= routeStart &&
      cell.routeIndex < routeStart + routeCount,
  )
  if (cells.length !== routeCount) throw Error('morpho_grid_batch_selection_invalid')
  return cells
}

export async function captureBatch({
  grid,
  cells,
  urls,
  capture = capturePilot,
  persist = save,
  exists = async (path) => {
    try {
      await access(path)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  },
}) {
  const counts = { selected: cells.length, captured: 0, skippedExisting: 0, censored: 0 }
  for (const cell of cells) {
    if (await exists(fileFor(cell.routeIndex, cell.sourceBlock))) {
      counts.skippedExisting++
      continue
    }
    const [primary, secondary] = publicRpcClients(urls).map((client) => ({
      ...client,
      request: slicedCandidateRequest(client),
    }))
    const record = await capture({ ...cell, primary, secondary })
    if (record.source.primary.targetHash !== grid.anchors[cell.anchorIndex].sourceHash)
      throw Error('morpho_grid_batch_source_mismatch')
    await persist(record)
    counts.captured++
    if (record.sourceAssay.status === 'censored' || record.futureAssay.status === 'censored')
      counts.censored++
  }
  return counts
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args.some((value) => !DECIMAL.test(value)))
    throw Error('usage: ANCHOR_INDEX ROUTE_START ROUTE_COUNT')
  const grid = await readVerifiedGrid()
  await readAudit()
  const cells = selectBatch(grid, {
    anchorIndex: Number(args[0]),
    routeStart: Number(args[1]),
    routeCount: Number(args[2]),
  })
  const urls = selectRpcUrls(
    configuredPublicRpcUrls(readEnv('.env.local')),
    process.env.CARRY_MORPHO_RETROSPECTIVE_ORIGINS,
  )
  const result = await captureBatch({ grid, cells, urls })
  const audit = await readAudit()
  return { ...result, totalCapturedGridCells: audit.capturedGridCells, forecastValidated: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? 'morpho_grid_batch_failed').split(' ')[0])
      process.exitCode = 1
    })
