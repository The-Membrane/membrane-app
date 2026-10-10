import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { auditEventGrid } from './carry-morpho-retrospective-event-grid-audit.mjs'

const hash = `0x${'a'.repeat(64)}`
const vault = `0x${'b'.repeat(40)}`
const holder = `0x${'c'.repeat(40)}`
const transaction = `0x${'d'.repeat(64)}`
const commitment = createHash('sha256')
  .update(JSON.stringify(`${vault}:${holder}`))
  .digest('hex')
const cell = {
  routeIndex: 2,
  sourceBlock: 101,
  fromBlock: 100,
  toBlock: 100,
  eventBlockHash: hash,
  depositTxHash: transaction,
  depositHolderCommitment: commitment,
}
const record = {
  routeIndex: 2,
  sourceBlock: 101,
  destination: vault,
  fromBlock: 100,
  toBlock: 100,
  source: {
    primary: { targetParentHash: hash },
    secondary: { targetParentHash: hash },
  },
  candidate: {
    destination: vault,
    screenedCandidates: [{ sourceLog: { transactionHash: transaction } }],
  },
  holder,
}
const options = { validate: () => {}, classify: () => 'simulated_continuity' }

test('counts only a sealed-plan source with matching archive parent and holder', () => {
  const result = auditEventGrid({ sha256: 'plan', cells: [cell] }, [record], options)
  assert.equal(result.capturedCells, 1)
  assert.equal(result.depositHolderSelected, 1)
  assert.equal(result.depositTxTransferSeen, 1)
  assert.deepEqual(result.transitions, { simulated_continuity: 1 })
  assert.equal(result.forecastValidated, false)
})

test('rejects an outcome measured from a different event block', () => {
  const changed = {
    ...record,
    source: { ...record.source, primary: { targetParentHash: `0x${'e'.repeat(64)}` } },
  }
  assert.throws(
    () => auditEventGrid({ sha256: 'plan', cells: [cell] }, [changed], options),
    /pair_mismatch/,
  )
})
