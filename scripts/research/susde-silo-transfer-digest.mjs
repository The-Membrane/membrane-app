// Canonical content hash shared by the raw-log and Alchemy-indexed silo probes.
// This is a row-set comparison key, not a proof that either source is complete.
import { createHash } from 'node:crypto'

export const TRANSFER_DIGEST_SCHEMA = 'susde_silo_transfer_union_sha256_v1'
export const TRANSFER_DIGEST_INTERPRETATION =
  'Matching digests for the same chain, route, and A/B window show cross-source row-set agreement, not gross completeness or a holder forecast.'
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const UINT256_MAX = (1n << 256n) - 1n

function canonicalRow(row) {
  if (
    !row ||
    !Number.isSafeInteger(row.blockNumber) ||
    row.blockNumber < 0 ||
    !Number.isSafeInteger(row.logIndex) ||
    row.logIndex < 0 ||
    typeof row.transactionHash !== 'string' ||
    !HASH.test(row.transactionHash) ||
    typeof row.from !== 'string' ||
    !ADDRESS.test(row.from) ||
    typeof row.to !== 'string' ||
    !ADDRESS.test(row.to) ||
    typeof row.valueRaw !== 'string' ||
    !DECIMAL.test(row.valueRaw) ||
    BigInt(row.valueRaw) > UINT256_MAX
  )
    throw Error('susde_silo_digest_row_invalid')
  return [
    row.blockNumber,
    row.transactionHash.toLowerCase(),
    row.logIndex,
    row.from.toLowerCase(),
    row.to.toLowerCase(),
    row.valueRaw,
  ]
}

/** Hash the full union after mirrored self-transfers have been de-duplicated. */
export function digestTransferUnion(rows) {
  if (!Array.isArray(rows) || rows.length > 16_384) throw Error('susde_silo_digest_rows_invalid')
  const canonical = rows.map(canonicalRow)
  const blockLogs = new Set()
  const transactionLogs = new Set()
  for (const row of canonical) {
    const blockLog = `${row[0]}:${row[2]}`
    const transactionLog = `${row[1]}:${row[2]}`
    if (blockLogs.has(blockLog) || transactionLogs.has(transactionLog))
      throw Error('susde_silo_digest_duplicate')
    blockLogs.add(blockLog)
    transactionLogs.add(transactionLog)
  }
  canonical.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1].localeCompare(b[1]))
  const payload = JSON.stringify([TRANSFER_DIGEST_SCHEMA, canonical])
  return {
    schema: TRANSFER_DIGEST_SCHEMA,
    sha256: createHash('sha256').update(payload).digest('hex'),
    rowCount: canonical.length,
  }
}
