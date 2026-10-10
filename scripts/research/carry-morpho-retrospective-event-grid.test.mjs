import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAbiItem, toEventHash } from 'viem'

import { selectEventCells } from './carry-morpho-retrospective-event-grid.mjs'

const topic = toEventHash(
  parseAbiItem(
    'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
).toLowerCase()
const vault = `0x${'a'.repeat(40)}`
const holder = `0x${'b'.repeat(40)}`
const event = (block, logIndex = 0) => ({
  address: vault,
  blockNumber: String(block),
  blockHash: `0x${'c'.repeat(64)}`,
  transactionHash: `0x${String(block).padStart(64, '0')}`,
  logIndex,
  topics: [topic, `0x${'0'.repeat(64)}`, `0x${holder.slice(2).padStart(64, '0')}`],
})

test('freezes first deposit per vault and 512 block epoch before outcomes', () => {
  const cells = selectEventCells(
    [event(100), event(101), event(612), event(613)],
    100,
    new Map([[vault, 7]]),
  )
  assert.deepEqual(
    cells.map(({ routeIndex, epoch, eventBlock, sourceBlock }) => ({
      routeIndex,
      epoch,
      eventBlock,
      sourceBlock,
    })),
    [
      { routeIndex: 7, epoch: 0, eventBlock: 100, sourceBlock: 101 },
      { routeIndex: 7, epoch: 1, eventBlock: 612, sourceBlock: 613 },
    ],
  )
  assert.equal(cells[0].fromBlock, 100)
  assert.equal(cells[0].toBlock, 100)
  assert.equal(cells[0].depositTxHash, event(100).transactionHash)
})

test('rejects an unrecognized deposit vault', () => {
  assert.throws(() => selectEventCells([event(100)], 100, new Map()), /unknown_vault/)
})
