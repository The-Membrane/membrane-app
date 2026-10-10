import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKENS, TRANSFER_TOPIC, collect } from './share-transfer-source.mjs'
import {
  compareTransfers,
  loadNonzeroSegment,
  main,
  probe,
  requestParams,
} from './alchemy-share-capability.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const topic = (a) => `0x${a.slice(2).padStart(64, '0')}`
const config = {
  chainId: 1,
  token: 'sGHO',
  address: TOKENS.sGHO,
  deploymentBlock: 10,
  startBlock: 10,
}
const header = (n) => ({
  number: `0x${n.toString(16)}`,
  hash: hash(n),
  parentHash: hash(n - 1),
  timestamp: `0x${n.toString(16)}`,
})
const log = {
  address: TOKENS.sGHO,
  topics: [TRANSFER_TOPIC, topic(address(0)), topic(address(1))],
  data: hash(2),
  blockNumber: '0xa',
  blockHash: hash(10),
  transactionHash: hash(101),
  logIndex: '0x0',
}
const rpc = async (method, params) => {
  if (method === 'eth_chainId') return '0x1'
  if (method === 'eth_getBlockByNumber')
    return header(params[0] === 'finalized' ? 10 : Number(BigInt(params[0])))
  if (method === 'eth_getCode') return Number(BigInt(params[1].blockHash)) === 9 ? '0x' : '0x6001'
  if (method === 'eth_getLogs') return [log]
  throw Error('unexpected method')
}
const api = (overrides = {}) => ({
  category: 'erc20',
  blockNum: '0xa',
  hash: hash(101),
  to: address(1),
  rawContract: { address: TOKENS.sGHO, value: '0x2' },
  ...overrides,
})
const page = (transfers, pageKey) => ({ jsonrpc: '2.0', id: 1, result: { transfers, pageKey } })

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'alchemy-share-test-'))
  const out = join(root, 'source')
  try {
    await collect({
      out,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
      now: () => new Date(11_000),
    })
    const name = readdirSync(out)[0]
    return await fn({
      out,
      target: join(root, 'receipt'),
      name,
      segment: loadNonzeroSegment({ source: out, name, config }),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('dry run verifies physical source and uses contract-only unfiltered query', async () =>
  fixture(async ({ out, name }) => {
    const result = await main([
      '--source',
      out,
      '--segment',
      name,
      '--token',
      'sGHO',
      '--deployment-block',
      '10',
    ])
    assert.equal(result.status, 'dry_run')
    assert.equal(result.canonicalCount, 1)
    assert.deepEqual(result.request.contractAddresses, [TOKENS.sGHO])
    assert.deepEqual(result.request.category, ['erc20'])
    assert.equal(result.request.excludeZeroValue, false)
    assert.equal('fromAddress' in result.request, false)
    assert.equal('toAddress' in result.request, false)
  }))

test('complete two-page multiset match does not claim holder coverage', async () =>
  fixture(async ({ segment }) => {
    const calls = []
    const result = await probe({
      segment,
      rpcRead: async (params) => {
        calls.push(params)
        return calls.length === 1 ? page([], 'next') : page([api()], '')
      },
    })
    assert.equal(result.status, 'matched')
    assert.equal(result.pages, 2)
    assert.equal(result.claim, 'one_sealed_segment_comparison_only')
    assert.equal(calls[1].pageKey, 'next')
    assert.deepEqual(requestParams(segment), calls[0])
  }))

test('incomplete pagination, repeated key and raw-value omission fail closed', async () =>
  fixture(async ({ segment }) => {
    await assert.rejects(
      probe({ segment, maxPages: 1, rpcRead: async () => page([], 'more') }),
      /alchemy_share_pagination_incomplete/,
    )
    await assert.rejects(
      probe({ segment, rpcRead: async () => page([], 'again') }),
      /alchemy_share_page_key_repeated/,
    )
    await assert.rejects(
      probe({
        segment,
        rpcRead: async () => page([api({ rawContract: { address: TOKENS.sGHO, value: null } })]),
      }),
      /alchemy_share_raw_value_unavailable/,
    )
  }))

test('wrong contract or missing API event is mismatch/failure', async () =>
  fixture(async ({ segment }) => {
    assert.equal(compareTransfers(segment, []).status, 'mismatch')
    assert.throws(
      () =>
        compareTransfers(segment, [api({ rawContract: { address: address(9), value: '0x2' } })]),
      /alchemy_share_transfer_invalid/,
    )
  }))

test('duplicate tuples without log indices remain ambiguous, not exact identity', async () =>
  fixture(async ({ segment }) => {
    const repeated = { ...segment, logs: [segment.logs[0], { ...segment.logs[0], logIndex: 1 }] }
    const ambiguous = compareTransfers(repeated, [api(), api()])
    assert.equal(ambiguous.status, 'ambiguous')
    assert.equal(ambiguous.exactLogIdentity, false)
    const exact = compareTransfers(repeated, [
      api({ uniqueId: `${hash(101)}:log:0` }),
      api({ uniqueId: `${hash(101)}:log:1` }),
    ])
    assert.equal(exact.status, 'matched')
    assert.equal(exact.exactLogIdentity, true)
    const partial = compareTransfers(repeated, [api({ uniqueId: `${hash(101)}:log:0` }), api()])
    assert.equal(partial.status, 'ambiguous')
    assert.equal(partial.knownLogIndexes, 1)
    const contradicted = compareTransfers(repeated, [
      api({ uniqueId: `${hash(101)}:log:2` }),
      api(),
    ])
    assert.equal(contradicted.status, 'mismatch')
    for (const uniqueId of [
      `garbage:log:0`,
      `${hash(102)}:log:0`,
      `${hash(101)}:log:9007199254740992`,
    ])
      assert.throws(
        () => compareTransfers(repeated, [api({ uniqueId }), api()]),
        /alchemy_share_transfer_id_invalid/,
      )
  }))

test('unverified segment cannot be used as a capability witness', async () =>
  fixture(async ({ out, name }) => {
    assert.throws(
      () => loadNonzeroSegment({ source: out, name: 'bad.json', config }),
      /alchemy_share_segment_name_invalid/,
    )
    assert.throws(
      () => loadNonzeroSegment({ source: out, name, config: { ...config, token: 'sUSDe' } }),
      /share_source_config_invalid|share_source_segment_invalid/,
    )
  }))

test('verified zero-log segment stops before any API request', async () => {
  const out = mkdtempSync(join(tmpdir(), 'alchemy-share-zero-'))
  try {
    const quiet = async (method, params) => (method === 'eth_getLogs' ? [] : rpc(method, params))
    await collect({
      out,
      config,
      rpcRead: quiet,
      peerRpcRead: quiet,
      stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
      now: () => new Date(11_000),
    })
    const name = readdirSync(out)[0]
    await assert.rejects(
      main(
        [
          '--run',
          '--source',
          out,
          '--segment',
          name,
          '--token',
          'sGHO',
          '--deployment-block',
          '10',
        ],
        {
          fetcher: async () => {
            throw Error('must not query')
          },
        },
      ),
      /alchemy_share_segment_zero_logs/,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('run path sends contract-only request and never reports endpoint credentials', async () =>
  fixture(async ({ out, name }) => {
    const secret = 'DO_NOT_PRINT_KEY'
    let request
    const result = await main(
      ['--run', '--source', out, '--segment', name, '--token', 'sGHO', '--deployment-block', '10'],
      {
        rpcUrls: `https://eth-mainnet.g.alchemy.com/v2/${secret}`,
        fetcher: async (_url, options) => {
          request = JSON.parse(options.body)
          return new Response(JSON.stringify(page([api()])), { status: 200 })
        },
      },
    )
    assert.equal(result.status, 'matched')
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(request.method, 'alchemy_getAssetTransfers')
    assert.deepEqual(request.params[0].contractAddresses, [TOKENS.sGHO])
    assert.equal('fromAddress' in request.params[0], false)
    assert.equal('toAddress' in request.params[0], false)
  }))

test('sealed capability receipt replays offline with exact normalized rows and source', async () =>
  fixture(async ({ out, name, target }) => {
    const args = [
      '--source',
      out,
      '--segment',
      name,
      '--token',
      'sGHO',
      '--deployment-block',
      '10',
      '--out',
      target,
    ]
    const receipt = await main(['--run', ...args], {
      rpcUrls: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      rpcRead: async () => page([api({ uniqueId: `${hash(101)}:log:0` })]),
      stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
      captureNow: () => new Date('2026-09-28T12:00:00Z'),
    })
    assert.equal(receipt.result.status, 'matched')
    const bytes = readFileSync(join(target, receipt.name), 'utf8')
    assert.equal(bytes.includes('SECRET'), false)
    assert.equal(bytes.includes('eth-mainnet.g.alchemy.com'), false)
    const saved = JSON.parse(bytes)
    assert.equal(saved.normalizedRows.length, 1)
    assert.equal(saved.normalizedRows[0].valueRaw, '2')
    assert.equal(saved.source.segment, name)
    const verified = await main(['--verify', ...args], {
      rpcRead: async () => {
        throw Error('must not query')
      },
    })
    assert.equal(verified.status, 'verified')
    assert.equal(verified.result.status, 'matched')
    await assert.rejects(
      main(['--run', ...args], {
        rpcUrls: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
        rpcRead: async () => {
          throw Error('must not query duplicate')
        },
        stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
      }),
      /alchemy_share_target_exists_or_unavailable/,
    )
  }))

test('receipt refuses low disk before network', async () =>
  fixture(async ({ out, name, target }) => {
    await assert.rejects(
      main(
        [
          '--run',
          '--source',
          out,
          '--segment',
          name,
          '--token',
          'sGHO',
          '--deployment-block',
          '10',
          '--out',
          target,
        ],
        {
          stat: () => ({ bavail: 999_999_999, bsize: 1 }),
          rpcRead: async () => {
            throw Error('must not query low disk')
          },
        },
      ),
      /alchemy_share_disk_reserve_reached/,
    )
  }))

test('receipt target inside sealed source is rejected before network', async () =>
  fixture(async ({ out, name }) => {
    await assert.rejects(
      main(
        [
          '--run',
          '--source',
          out,
          '--segment',
          name,
          '--token',
          'sGHO',
          '--deployment-block',
          '10',
          '--out',
          join(out, 'receipt'),
        ],
        {
          stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
          rpcRead: async () => {
            throw Error('must not query nested target')
          },
        },
      ),
      /alchemy_share_out_inside_source/,
    )
    assert.equal(readdirSync(out).length, 1)
  }))

test('modified receipt and modified source fail offline replay', async () =>
  fixture(async ({ out, name, target }) => {
    const args = [
      '--source',
      out,
      '--segment',
      name,
      '--token',
      'sGHO',
      '--deployment-block',
      '10',
      '--out',
      target,
    ]
    const sealed = await main(['--run', ...args], {
      rpcUrls: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      rpcRead: async () => page([api()]),
      stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
    })
    const receiptPath = join(target, sealed.name)
    const original = readFileSync(receiptPath)
    writeFileSync(receiptPath, Buffer.concat([original, Buffer.from(' ')]))
    await assert.rejects(main(['--verify', ...args]), /alchemy_share_receipt_invalid/)
    writeFileSync(receiptPath, original)
    const sourcePath = join(out, name)
    writeFileSync(sourcePath, Buffer.concat([readFileSync(sourcePath), Buffer.from(' ')]))
    await assert.rejects(main(['--verify', ...args]), /share_source_hash_mismatch/)
  }))

test('hash-valid replay receipt cannot lie about comparison result', async () =>
  fixture(async ({ out, name, target }) => {
    const args = [
      '--source',
      out,
      '--segment',
      name,
      '--token',
      'sGHO',
      '--deployment-block',
      '10',
      '--out',
      target,
    ]
    const sealed = await main(['--run', ...args], {
      rpcUrls: 'https://eth-mainnet.g.alchemy.com/v2/SECRET',
      rpcRead: async () => page([api()]),
      stat: () => ({ bavail: 2_000_000_000, bsize: 1 }),
    })
    const path = join(target, sealed.name)
    const changed = JSON.parse(readFileSync(path, 'utf8'))
    changed.result.status = 'mismatch'
    const bytes = Buffer.from(JSON.stringify(changed))
    const { createHash } = await import('node:crypto')
    const renamed = `${createHash('sha256').update(bytes).digest('hex')}.json`
    rmSync(path)
    writeFileSync(join(target, renamed), bytes)
    await assert.rejects(main(['--verify', ...args]), /alchemy_share_receipt_replay_mismatch/)
  }))
