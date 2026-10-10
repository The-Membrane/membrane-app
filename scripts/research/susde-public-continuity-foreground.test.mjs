import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foregroundTick, pacedInfuraClients } from './susde-public-continuity-foreground.mjs'

const urls = ['https://rpc.ankr.com/eth', 'https://mainnet.infura.io/v3/test']

test('serializes Infura calls and retries only the transient RPC failure', async () => {
  const calls = []
  let infuraAttempts = 0
  const peers = pacedInfuraClients(urls, {
    delay: async () => {},
    clients: (selected) =>
      selected.map((provider) => ({
        provider,
        async request(method) {
          calls.push(`${new URL(provider).hostname}:${method}`)
          if (provider.includes('infura') && ++infuraAttempts === 1)
            throw Error('public_rpc_unavailable')
          return method
        },
      })),
  })
  const [first, second] = await Promise.all([
    peers[1].request('eth_getLogs', []),
    peers[1].request('eth_getBlockByNumber', []),
  ])
  assert.equal(first, 'eth_getLogs')
  assert.equal(second, 'eth_getBlockByNumber')
  assert.deepEqual(calls, [
    'mainnet.infura.io:eth_getLogs',
    'mainnet.infura.io:eth_getLogs',
    'mainnet.infura.io:eth_getBlockByNumber',
  ])
})

test('one foreground tick passes a fixed two-host pair to the bounded recorder', async () => {
  const result = await foregroundTick(8, {
    urls,
    delay: async () => {},
    clients: (selected) => selected.map((provider) => ({ provider, request: async () => '0x1' })),
    tick: async ({ issueSequence, clients }) => {
      assert.equal(issueSequence, 8)
      assert.deepEqual(
        clients().map((peer) => new URL(peer.provider).hostname),
        ['rpc.ankr.com', 'mainnet.infura.io'],
      )
      return { status: 'advanced', appended: 1, windows: 1, coveredThroughBlock: '20' }
    },
  })
  assert.equal(result.appended, 1)
  assert.equal(result.complete, false)
})
