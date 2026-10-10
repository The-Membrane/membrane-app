import assert from 'node:assert/strict'
import test from 'node:test'

import { toEventSelector } from 'viem'

import { SILO, USDE } from './susde-public-pending-exit-common.mjs'
import { candidateMatches, discoverAndAttest } from './susde-public-discover-deliveries.mjs'

const holder = '0x1111111111111111111111111111111111111111'
const word = (address) => `0x${address.slice(2).padStart(64, '0')}`
const issue = {
  sequence: 1,
  holder,
  pendingAssetsRaw: '123',
  anchor: { blockNumber: '100' },
}
const log = {
  address: USDE,
  topics: [toEventSelector('Transfer(address,address,uint256)'), word(SILO), word(holder)],
  data: `0x${123n.toString(16).padStart(64, '0')}`,
  blockNumber: '0x65',
  blockHash: `0x${'a'.repeat(64)}`,
  transactionHash: `0x${'b'.repeat(64)}`,
  removed: false,
}

test('candidate requires exact holder, amount and a block after the frozen issue', () => {
  assert.deepEqual(candidateMatches(log, [issue]), [issue])
  assert.deepEqual(
    candidateMatches({ ...log, data: `0x${124n.toString(16).padStart(64, '0')}` }, [issue]),
    [],
  )
  assert.deepEqual(candidateMatches({ ...log, blockNumber: '0x64' }, [issue]), [])
})

test('one bounded scan passes a candidate to the independent attester once', async () => {
  let attestations = 0
  let scans = 0
  const header = { number: '0x65', hash: `0x${'c'.repeat(64)}` }
  const clients = () => [
    {
      url: 'https://rpc.ankr.com/eth',
      request: async (method) => {
        if (method === 'eth_getBlockByNumber') return header
        assert.equal(method, 'eth_getLogs')
        scans++
        return [log]
      },
    },
    { url: 'https://eth-mainnet.g.alchemy.com/v2/example', request: async () => header },
  ]
  const result = await discoverAndAttest({
    urls: ['https://rpc.ankr.com/eth', 'https://eth-mainnet.g.alchemy.com/v2/example'],
    clients,
    loadIssues: async () => [issue],
    loadDeliveries: async () => [],
    attest: async ({ issueSequence, transactionHash }) => {
      assert.equal(issueSequence, 1)
      assert.equal(transactionHash, log.transactionHash)
      attestations++
      return { status: 'attested' }
    },
  })
  assert.equal(scans, 1)
  assert.equal(attestations, 1)
  assert.equal(result.newlyAttested, 1)
  assert.equal(result.uniqueCandidates, 1)
})
