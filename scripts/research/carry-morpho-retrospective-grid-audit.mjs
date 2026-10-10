// Reconcile sealed retrospective pairs against the predeclared source grid.
// A handpicked demonstration is never included in the grid denominator.
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  OUT as PAIR_DIR,
  classifyRetrospectivePair,
  validateRecord,
} from './carry-morpho-retrospective-holder-pairs.mjs'
import { readVerifiedGrid } from './carry-morpho-retrospective-grid.mjs'

export function auditGrid(
  grid,
  records,
  { validate = validateRecord, classify = classifyRetrospectivePair } = {},
) {
  const byKey = new Map(grid.cells.map((cell) => [`${cell.routeIndex}/${cell.sourceBlock}`, cell]))
  const seen = new Set()
  const byRoute = new Map()
  let handpicked = 0
  for (const record of records) {
    validate(record)
    const key = `${record.routeIndex}/${record.sourceBlock}`
    if (seen.has(key)) throw Error('morpho_grid_duplicate_pair')
    seen.add(key)
    const cell = byKey.get(key)
    if (!cell) {
      handpicked++
      continue
    }
    const anchor = grid.anchors[cell.anchorIndex]
    if (
      record.routeKey !== cell.routeKey ||
      record.destination !== cell.destination ||
      record.asset !== cell.asset ||
      record.fromBlock !== cell.fromBlock ||
      record.toBlock !== cell.toBlock ||
      record.source.primary.targetHash !== anchor.sourceHash ||
      record.source.primary.targetBlockAt !== anchor.sourceAt
    )
      throw Error('morpho_grid_pair_mismatch')
    const route = byRoute.get(record.routeIndex) ?? {
      captured: 0,
      transitions: {},
      censorReasons: {},
    }
    route.captured++
    const transition = classify(record)
    route.transitions[transition] = (route.transitions[transition] ?? 0) + 1
    if (transition === 'censored') {
      const reason =
        record.sourceAssay?.status === 'censored'
          ? record.sourceAssay.reason
          : record.futureAssay?.reason
      if (!/^[a-z0-9_]{1,80}$/.test(reason ?? '')) throw Error('morpho_grid_censor_invalid')
      route.censorReasons[reason] = (route.censorReasons[reason] ?? 0) + 1
    }
    byRoute.set(record.routeIndex, route)
  }
  const captured = [...byRoute.values()].reduce((total, row) => total + row.captured, 0)
  const aggregate = (field) =>
    [...byRoute.values()].reduce((totals, row) => {
      for (const [key, count] of Object.entries(row[field]))
        totals[key] = (totals[key] ?? 0) + count
      return totals
    }, {})
  return {
    study: 'carry_morpho_retrospective_grid_audit_v1',
    gridSha256: grid.sha256,
    plannedRoutes: new Set(grid.cells.map((cell) => cell.routeIndex)).size,
    plannedCells: grid.cells.length,
    capturedGridCells: captured,
    uncapturedGridCells: grid.cells.length - captured,
    handpickedDemonstrations: handpicked,
    transitions: aggregate('transitions'),
    censorReasons: aggregate('censorReasons'),
    byRoute: [...byRoute]
      .sort((a, b) => a[0] - b[0])
      .map(([routeIndex, row]) => ({
        routeIndex,
        ...row,
      })),
    forecastValidated: false,
  }
}

export async function readAudit({ pairDir = PAIR_DIR } = {}) {
  const grid = await readVerifiedGrid()
  let files
  try {
    files = (await readdir(pairDir)).sort()
  } catch (error) {
    if (error.code === 'ENOENT') files = []
    else throw error
  }
  const records = []
  for (const file of files) {
    if (!/^\d{2}-\d{12}\.json$/.test(file)) throw Error('morpho_grid_pair_file_invalid')
    const bytes = await readFile(join(pairDir, file), 'utf8')
    if (Buffer.byteLength(bytes) > 512 * 1024) throw Error('morpho_grid_pair_file_invalid')
    const record = JSON.parse(bytes)
    if (bytes !== `${JSON.stringify(record)}\n`) throw Error('morpho_grid_pair_file_invalid')
    records.push(record)
  }
  return auditGrid(grid, records)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  readAudit()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? 'morpho_grid_audit_failed').split(' ')[0])
      process.exitCode = 1
    })
