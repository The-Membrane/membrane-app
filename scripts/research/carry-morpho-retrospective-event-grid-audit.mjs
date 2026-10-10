// Link sealed historical holder pairs to sources frozen from Deposit events.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  OUT as PAIR_DIR,
  classifyRetrospectivePair,
  validateRecord,
} from './carry-morpho-retrospective-holder-pairs.mjs'
import { readVerifiedEventGrid } from './carry-morpho-retrospective-event-grid.mjs'

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function auditEventGrid(
  grid,
  records,
  { validate = validateRecord, classify = classifyRetrospectivePair } = {},
) {
  const cells = new Map(grid.cells.map((cell) => [`${cell.routeIndex}/${cell.sourceBlock}`, cell]))
  const seen = new Set()
  const transitions = {}
  const censorReasons = {}
  let captured = 0
  let depositHolderSelected = 0
  let depositTxTransferSeen = 0
  for (const record of records) {
    validate(record)
    const key = `${record.routeIndex}/${record.sourceBlock}`
    const cell = cells.get(key)
    if (!cell) continue
    if (seen.has(key)) throw Error('morpho_event_grid_duplicate_pair')
    seen.add(key)
    if (
      record.destination !== record.candidate.destination ||
      record.fromBlock !== cell.fromBlock ||
      record.toBlock !== cell.toBlock ||
      record.source.primary.targetParentHash !== cell.eventBlockHash ||
      record.source.secondary.targetParentHash !== cell.eventBlockHash
    )
      throw Error('morpho_event_grid_pair_mismatch')
    captured++
    if (
      record.holder &&
      sha(`${record.destination}:${record.holder}`) === cell.depositHolderCommitment
    )
      depositHolderSelected++
    if (
      record.candidate.screenedCandidates.some(
        (row) => row.sourceLog.transactionHash === cell.depositTxHash,
      )
    )
      depositTxTransferSeen++
    const transition = classify(record)
    transitions[transition] = (transitions[transition] ?? 0) + 1
    if (transition === 'censored') {
      const reason =
        record.sourceAssay?.status === 'censored'
          ? record.sourceAssay.reason
          : record.futureAssay?.reason
      if (!/^[a-z0-9_]{1,80}$/.test(reason ?? '')) throw Error('morpho_event_grid_censor_invalid')
      censorReasons[reason] = (censorReasons[reason] ?? 0) + 1
    }
  }
  return {
    study: 'carry_morpho_retrospective_event_grid_audit_v1',
    gridSha256: grid.sha256,
    plannedVaults: new Set(grid.cells.map((cell) => cell.routeIndex)).size,
    plannedCells: grid.cells.length,
    capturedCells: captured,
    remainingCells: grid.cells.length - captured,
    depositHolderSelected,
    depositTxTransferSeen,
    transitions,
    censorReasons,
    forecastValidated: false,
  }
}

export async function readEventGridAudit() {
  const grid = await readVerifiedEventGrid()
  const records = []
  for (const file of (await readdir(PAIR_DIR)).sort()) {
    if (!/^\d{2}-\d{12}\.json$/.test(file)) throw Error('morpho_event_grid_pair_file_invalid')
    const bytes = await readFile(join(PAIR_DIR, file), 'utf8')
    if (Buffer.byteLength(bytes) > 512 * 1024) throw Error('morpho_event_grid_pair_file_invalid')
    const record = JSON.parse(bytes)
    if (bytes !== `${JSON.stringify(record)}\n`) throw Error('morpho_event_grid_pair_file_invalid')
    records.push(record)
  }
  return auditEventGrid(grid, records)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  readEventGridAudit()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? 'morpho_event_grid_audit_failed').split(' ')[0])
      process.exitCode = 1
    })
