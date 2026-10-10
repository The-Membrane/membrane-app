import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TOKEN } from './usde-debt-mint-baseline.mjs'
import {
  compareTransfers,
  configuredAlchemyUrl,
  normalizeTransfer,
  parseArgs,
  probeTransfers,
} from './alchemy-mint-capability.mjs'

const ZERO = `0x${'0'.repeat(40)}`
const OWNER = `0x${'1'.repeat(40)}`
const HASH = `0x${'2'.repeat(64)}`
const segment = {
  fromBlock: 100,
  toBlock: 100,
  logs: [
    { blockNumber: 100, transactionHash: HASH, owner: OWNER, valueRaw: '0' },
    { blockNumber: 100, transactionHash: HASH, owner: OWNER, valueRaw: '5' },
  ],
}
const transfer = (raw) => ({
  blockNum: '0x64',
  hash: HASH,
  from: ZERO,
  to: OWNER,
  category: 'erc20',
  rawContract: { address: TOKEN, value: raw },
})
const response = (transfers, pageKey) =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { transfers, pageKey },
    }),
    { status: 200 },
  )

test('CLI and configured URL reject path/key leakage', () => {
  assert.deepEqual(
    parseArgs([
      '--probe',
      '--segment',
      `${'0'.repeat(12)}-${'1'.repeat(12)}-${'a'.repeat(64)}.json`,
    ]),
    {
      segmentName: `${'0'.repeat(12)}-${'1'.repeat(12)}-${'a'.repeat(64)}.json`,
    },
  )
  assert.throws(() => parseArgs(['--probe', '--segment', '../secret']), /cli_invalid/)
  assert.equal(
    configuredAlchemyUrl('https://example.org/k,https://eth-mainnet.g.alchemy.com/v2/SECRET'),
    'https://eth-mainnet.g.alchemy.com/v2/SECRET',
  )
  assert.throws(
    () => configuredAlchemyUrl('https://alchemy.com.evil.test/key'),
    /alchemy_url_unavailable/,
  )
})

test('raw parser retains zero-value transfer and rejects wrong contract', () => {
  assert.equal(normalizeTransfer(transfer('0x0'), 100, 100), `100:${HASH}:${OWNER}:0`)
  assert.equal(normalizeTransfer(transfer('0x0000'), 100, 100), `100:${HASH}:${OWNER}:0`)
  assert.equal(
    normalizeTransfer({ ...transfer('0x0005'), blockNum: '0x064' }, 100, 100),
    `100:${HASH}:${OWNER}:5`,
  )
  assert.throws(
    () =>
      normalizeTransfer(
        { ...transfer('0x1'), rawContract: { address: ZERO, value: '0x1' } },
        100,
        100,
      ),
    /transfer_invalid/,
  )
})

test('multiset comparison catches missing zero and duplicate identities', () => {
  assert.deepEqual(compareTransfers(segment, [transfer('0x0'), transfer('0x5')]), {
    matched: 2,
    saved: 2,
    api: 2,
    missing: 0,
    extra: 0,
    match: true,
    ambiguous: false,
    comparisonScope: 'block_transaction_recipient_raw_amount_only',
    completenessClaim: false,
  })
  assert.deepEqual(compareTransfers(segment, [transfer('0x5'), transfer('0x5')]), {
    matched: 1,
    saved: 2,
    api: 2,
    missing: 1,
    extra: 1,
    match: false,
    ambiguous: true,
    comparisonScope: 'block_transaction_recipient_raw_amount_only',
    completenessClaim: false,
  })
  const sameTupleTwice = {
    ...segment,
    logs: [segment.logs[1], { ...segment.logs[1], logIndex: 999 }],
  }
  assert.equal(compareTransfers(sameTupleTwice, [transfer('0x5'), transfer('0x5')]).match, false)
})

test('requests exact filter and follows a finite page chain', async () => {
  const requests = []
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body).params[0])
    return requests.length === 1 ? response([transfer('0x0')], 'next') : response([transfer('0x5')])
  }
  const result = await probeTransfers(segment, {
    url: 'https://eth-mainnet.g.alchemy.com/v2/hidden',
    fetchImpl,
  })
  assert.equal(result.match, true)
  assert.equal(result.pages, 2)
  assert.equal(JSON.stringify(result).includes('pageKey'), false)
  assert.equal(JSON.stringify(result).includes('next'), false)
  assert.deepEqual(requests[0], {
    fromBlock: '0x64',
    toBlock: '0x64',
    fromAddress: ZERO,
    contractAddresses: [TOKEN],
    category: ['erc20'],
    excludeZeroValue: false,
    maxCount: '0x3e8',
  })
  assert.equal(requests[1].pageKey, 'next')
})

test('deadline terminates an injected fetch that ignores abort', async () => {
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => new Promise(() => {}),
      deadlineMs: 5,
    }),
    (cause) => cause.message === 'alchemy_mint_probe_deadline',
  )
  let calls = 0
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => {
        calls++
        await new Promise((resolve) => setTimeout(resolve, 18))
        return response([], 'another-page')
      },
      deadlineMs: 5,
    }),
    (cause) => cause.message === 'alchemy_mint_probe_deadline',
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(calls, 1)
})

test('repeat page key, endless pages, and provider errors fail closed and sanitized', async () => {
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => response([], 'same'),
    }),
    /alchemy_mint_probe_page_loop/,
  )
  let page = 0
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => response([], `page-${++page}`),
    }),
    /alchemy_mint_probe_page_cap/,
  )
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => {
        throw new Error('provider SECRET and full URL')
      },
    }),
    (cause) => cause.message === 'alchemy_mint_probe_request_failed',
  )
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => {
        throw new Error('alchemy_mint_probe_SECRET')
      },
    }),
    (cause) => cause.message === 'alchemy_mint_probe_request_failed',
  )
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'SECRET' } })),
    }),
    (cause) => cause.message === 'alchemy_mint_probe_response_invalid',
  )
  await assert.rejects(
    probeTransfers(segment, {
      url: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { transfers: [] } })),
    }),
    (cause) => cause.message === 'alchemy_mint_probe_response_invalid',
  )
})
