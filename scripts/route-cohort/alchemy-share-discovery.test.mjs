import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main as capabilityMain } from './alchemy-share-capability.mjs'
import {
  append,
  assertOutputSeparated,
  capabilityBinding,
  candidates,
  checkDisk,
  collect,
  fetchWindow,
  main,
  sourceAnchor,
  verify,
  WINDOW_BLOCKS,
} from './alchemy-share-discovery.mjs'
import { TOKENS, TRANSFER_TOPIC, collect as collectSource } from './share-transfer-source.mjs'

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
const sourceRpc = async (method, params) => {
  if (method === 'eth_chainId') return '0x1'
  if (method === 'eth_getBlockByNumber')
    return header(params[0] === 'finalized' ? 10 : Number(BigInt(params[0])))
  if (method === 'eth_getCode') return Number(BigInt(params[1].blockHash)) === 9 ? '0x' : '0x6001'
  if (method === 'eth_getLogs') return [log]
  throw Error('unexpected source method')
}
const api = (index = 0, override = {}) => ({
  category: 'erc20',
  blockNum: '0xb',
  hash: hash(102),
  from: address(3),
  to: address(4),
  rawContract: { address: TOKENS.sGHO, value: '0x2' },
  uniqueId: `${hash(102)}:log:${index}`,
  ...override,
})
const page = (transfers, pageKey) => ({ jsonrpc: '2.0', result: { transfers, pageKey } })
const generousDisk = () => ({ bavail: 2_000_000_000, bsize: 1 })

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'alchemy-share-discovery-'))
  const source = join(root, 'source')
  const receipt = join(root, 'capability')
  const out = join(root, 'journal')
  try {
    await collectSource({
      out: source,
      config,
      rpcRead: sourceRpc,
      peerRpcRead: sourceRpc,
      stat: generousDisk,
      now: () => new Date(11_000),
    })
    const segment = readdirSync(source)[0]
    await capabilityMain(
      [
        '--run',
        '--source',
        source,
        '--segment',
        segment,
        '--token',
        'sGHO',
        '--deployment-block',
        '10',
        '--out',
        receipt,
      ],
      {
        env: { get: () => undefined },
        rpcUrls: 'https://eth-mainnet.g.alchemy.com/v2/test',
        stat: generousDisk,
        rpcRead: async () => ({
          jsonrpc: '2.0',
          result: {
            transfers: [
              {
                ...api(0, {
                  blockNum: '0xa',
                  hash: hash(101),
                  to: address(1),
                  from: address(0),
                  uniqueId: `${hash(101)}:log:0`,
                }),
              },
            ],
          },
        }),
      },
    )
    const anchor = sourceAnchor({ source, config, frontierBlock: 10, frontierHash: hash(10) })
    const capability = await capabilityBinding({
      token: 'sGHO',
      deploymentBlock: 10,
      capabilitySource: source,
      capabilitySegment: segment,
      capabilityStartBlock: 10,
      capabilityReceipt: receipt,
    })
    const args = [
      '--source',
      source,
      '--token',
      'sGHO',
      '--deployment-block',
      '10',
      '--start-block',
      '10',
      '--frontier-block',
      '10',
      '--frontier-hash',
      hash(10),
      '--capability-source',
      source,
      '--capability-segment',
      segment,
      '--capability-start-block',
      '10',
      '--capability-receipt',
      receipt,
      '--out',
      out,
    ]
    return await fn({ root, source, segment, receipt, out, anchor, capability, args })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('dry default binds a token-specific exact-log capability and makes no request', async () =>
  fixture(async ({ args, out, anchor, capability, source, segment, receipt }) => {
    const empty = verify({ out, anchor, capability })
    assert.equal(empty.segmentCount, 0)
    assert.equal(empty.windowQualification, null)
    const result = await main(args)
    assert.equal(result.status, 'dry_run')
    assert.equal(result.requestMade, false)
    assert.equal(result.windowBlocks, 1_000)
    assert.equal(result.windowQualification, 'experimental_page_key_exhausted_only')
    assert.equal(result.capability.receiptSha256, capability.receiptSha256)
    const wider = await main([...args, '--window-blocks', '50000'])
    assert.equal(wider.windowBlocks, 50_000)
    assert.equal(wider.requestMade, false)
    await assert.rejects(
      capabilityBinding({
        token: 'sUSDe',
        deploymentBlock: 10,
        capabilitySource: source,
        capabilitySegment: segment,
        capabilityStartBlock: 10,
        capabilityReceipt: receipt,
      }),
    )
  }))

test('unfiltered two-page scan preserves repeated tuple with distinct log indexes', async () => {
  const calls = []
  const result = await fetchWindow({
    fromBlock: 11,
    toBlock: 1010,
    tokenAddress: TOKENS.sGHO,
    read: async (_method, [params]) => {
      calls.push(params)
      return calls.length === 1 ? page([api(0)], 'next') : page([api(1)])
    },
  })
  assert.equal(result.pages, 2)
  assert.equal(result.rows.length, 2)
  assert.deepEqual(
    result.rows.map((row) => row.logIndex),
    [0, 1],
  )
  assert.deepEqual(candidates(result.rows), [address(4)])
  assert.equal(calls[1].pageKey, 'next')
  assert.equal('fromAddress' in calls[0], false)
  assert.equal('toAddress' in calls[0], false)
  assert.deepEqual(calls[0].contractAddresses, [TOKENS.sGHO])
})

test('duplicate identity, missing index and unfinished pagination fail closed', async () => {
  const common = { fromBlock: 11, toBlock: 1010, tokenAddress: TOKENS.sGHO }
  await assert.rejects(
    fetchWindow({ ...common, read: async () => page([api(), api()]) }),
    /duplicate_log_identity/,
  )
  await assert.rejects(
    fetchWindow({ ...common, read: async () => page([api(), api(0, { blockNum: '0xc' })]) }),
    /duplicate_transaction_log/,
  )
  await assert.rejects(
    fetchWindow({ ...common, read: async () => page([api(0, { uniqueId: undefined })]) }),
    /transfer_identity_invalid/,
  )
  await assert.rejects(
    fetchWindow({ ...common, read: async () => page([], 'more') }),
    /page_key_invalid|pagination_incomplete/,
  )
  let densePages = 0
  await assert.rejects(
    fetchWindow({ ...common, read: async () => page([], `next-${++densePages}`) }),
    /pagination_incomplete/,
  )
  assert.equal(densePages, 4)
})

test('one finalized window seals; offline replay catches source and artifact tamper', async () =>
  fixture(async ({ out, anchor, capability, source, args }) => {
    const calls = []
    const result = await collect({
      out,
      anchor,
      capability,
      stat: generousDisk,
      rpcRead: async (method, params) => {
        calls.push(method)
        if (method === 'eth_getBlockByNumber')
          return header(params[0] === 'finalized' ? 1010 : Number(BigInt(params[0])))
        if (method === 'alchemy_getAssetTransfers') return page([api(0), api(1)])
        throw Error('unexpected')
      },
      capturedAt: () => new Date(12_000).toISOString(),
    })
    assert.equal(result.throughBlock, 1010)
    assert.equal(result.transferCount, 2)
    assert.equal(result.interiorAncestry, 'not_independently_proven')
    assert.equal(result.windowQualification, 'experimental_page_key_exhausted_only')
    assert.deepEqual(result.candidateRecipients, [address(4)])
    assert.ok(calls.includes('alchemy_getAssetTransfers'))
    assert.equal((await main(['--verify', ...args])).transferCount, 2)
    const name = readdirSync(out)[0]
    const original = readFileSync(join(out, name))
    assert.equal(JSON.parse(original).interiorAncestry, 'not_independently_proven')
    assert.throws(() => append(out, JSON.parse(original), generousDisk), /EEXIST/)
    assert.deepEqual(readFileSync(join(out, name)), original)
    writeFileSync(join(out, name), `${readFileSync(join(out, name), 'utf8')} `)
    assert.throws(() => verify({ out, anchor, capability }), /seal_hash_invalid/)
    const sourceName = readdirSync(source)[0]
    writeFileSync(join(source, sourceName), `${readFileSync(join(source, sourceName), 'utf8')} `)
    await assert.rejects(main(args), /share_source_hash_mismatch/)
  }))

test('frontier and capability receipt tamper cannot authorize journal', async () =>
  fixture(async ({ source, receipt, args }) => {
    assert.throws(
      () => sourceAnchor({ source, config, frontierBlock: 10, frontierHash: hash(99) }),
      /frontier_hash_mismatch/,
    )
    const name = readdirSync(receipt)[0]
    writeFileSync(join(receipt, name), `${readFileSync(join(receipt, name), 'utf8')} `)
    await assert.rejects(main(args), /alchemy_share_receipt_invalid/)
  }))

test('disk floor and exclusive lock fail before API request', async () =>
  fixture(async ({ out, anchor, capability }) => {
    assert.throws(() => checkDisk(out, () => ({ bavail: 10, bsize: 1 })), /disk_reserve_reached/)
    await assert.rejects(
      collect({
        out,
        anchor,
        capability,
        stat: () => ({ bavail: 10, bsize: 1 }),
        rpcRead: async () => {
          throw Error('must not request')
        },
      }),
      /disk_reserve_reached/,
    )
    const { mkdirSync, openSync, closeSync } = await import('node:fs')
    mkdirSync(out)
    const fd = openSync(join(out, '.alchemy-share-discovery.lock'), 'wx')
    closeSync(fd)
    await assert.rejects(
      collect({
        out,
        anchor,
        capability,
        stat: generousDisk,
        rpcRead: async () => {
          throw Error('must not request')
        },
      }),
      /lock_held/,
    )
  }))

test('direct collector rejects forged capability binding before request', async () =>
  fixture(async ({ out, anchor, capability }) => {
    let calls = 0
    await assert.rejects(
      collect({
        out,
        anchor,
        capability: { ...capability, receiptSha256: '0'.repeat(64) },
        stat: generousDisk,
        rpcRead: async () => {
          calls++
          return null
        },
      }),
      /proof_binding_changed/,
    )
    assert.equal(calls, 0)
  }))

test('output nested under source or receipt, including symlink parents, fails before mkdir or RPC', async () =>
  fixture(async ({ root, source, receipt, args }) => {
    const aliasedSource = join(root, 'source-alias')
    symlinkSync(source, aliasedSource, 'dir')
    const separateCapabilitySource = join(root, 'other-capability-source')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(separateCapabilitySource)
    assert.throws(
      () =>
        assertOutputSeparated(join(separateCapabilitySource, 'nested'), [
          source,
          separateCapabilitySource,
          receipt,
        ]),
      /out_inside_source_or_receipt/,
    )
    let calls = 0
    const rpcRead = async () => {
      calls++
      throw Error('must not request')
    }
    for (const out of [
      source,
      join(source, 'nested'),
      join(receipt, 'nested'),
      join(aliasedSource, 'nested'),
    ]) {
      const passed = [...args]
      passed[passed.indexOf('--out') + 1] = out
      await assert.rejects(
        main(['--run', ...passed, '--max-chunks', '1'], { rpcRead, stat: generousDisk }),
        /out_inside_source_or_receipt/,
      )
      if (out.endsWith('nested')) assert.equal(existsSync(out), false)
    }
    assert.equal(calls, 0)
  }))

test('offline replay rejects the same transaction/log index reported at two blocks', async () =>
  fixture(async ({ root, anchor, capability }) => {
    const out = join(root, 'bad-journal')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(out)
    append(
      out,
      {
        schemaVersion: 1,
        anchor,
        capability,
        fromBlock: 11,
        toBlock: 1010,
        fromHash: hash(11),
        fromParentHash: hash(10),
        toHash: hash(1010),
        finalizedHead: 1010,
        finalizedHeadHash: hash(1010),
        capturedAt: new Date(12_000).toISOString(),
        pages: 1,
        rows: [
          {
            blockNumber: 11,
            transactionHash: hash(102),
            logIndex: 0,
            sender: address(3),
            recipient: address(4),
            valueRaw: '2',
          },
          {
            blockNumber: 12,
            transactionHash: hash(102),
            logIndex: 0,
            sender: address(3),
            recipient: address(4),
            valueRaw: '2',
          },
        ],
        candidateRecipients: [address(4)],
        logCompleteness: 'not_independently_proven',
        interiorAncestry: 'not_independently_proven',
        currentHolderCertificate: false,
        routeTvlClaim: false,
      },
      generousDisk,
    )
    assert.throws(() => verify({ out, anchor, capability }), /duplicate_transaction_log/)
  }))

test('live collector refuses an anchor behind the current two-host source tip', async () =>
  fixture(async ({ source, out, anchor, capability }) => {
    const nextRpc = async (method, params) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return header(params[0] === 'finalized' ? 11 : Number(BigInt(params[0])))
      if (method === 'eth_getCode')
        return Number(BigInt(params[1].blockHash)) === 9 ? '0x' : '0x6001'
      if (method === 'eth_getLogs') return []
      throw Error('unexpected source method')
    }
    await collectSource({
      out: source,
      config,
      rpcRead: nextRpc,
      peerRpcRead: nextRpc,
      stat: generousDisk,
      windowBlocks: 1,
    })
    let calls = 0
    await assert.rejects(
      collect({
        out,
        anchor,
        capability,
        stat: generousDisk,
        rpcRead: async () => {
          calls++
          return null
        },
      }),
      /source_tip_advanced/,
    )
    assert.equal(calls, 0)
    assert.equal(existsSync(out), false)
  }))

test('boundary header change after API paging fails before sealing', async () =>
  fixture(async ({ out, anchor, capability }) => {
    let firstBlockReads = 0
    await assert.rejects(
      collect({
        out,
        anchor,
        capability,
        stat: generousDisk,
        rpcRead: async (method, params) => {
          if (method === 'eth_getBlockByNumber') {
            if (params[0] === 'finalized') return header(1010)
            const n = Number(BigInt(params[0]))
            if (n === 11 && ++firstBlockReads === 2) return { ...header(11), hash: hash(999) }
            return header(n)
          }
          if (method === 'alchemy_getAssetTransfers') return page([])
          throw Error('unexpected')
        },
      }),
      /boundary_changed/,
    )
    assert.deepEqual(readdirSync(out), [])
  }))

test('a sealed schema-v1 1000-block prefix replays unchanged before a schema-v2 5000-block continuation', async () =>
  fixture(async ({ out, anchor, capability, args }) => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(out)
    const old = {
      schemaVersion: 1,
      anchor,
      capability,
      fromBlock: 11,
      toBlock: 1010,
      fromHash: hash(11),
      fromParentHash: hash(10),
      toHash: hash(1010),
      finalizedHead: 1010,
      finalizedHeadHash: hash(1010),
      capturedAt: new Date(12_000).toISOString(),
      pages: 1,
      rows: [],
      candidateRecipients: [],
      logCompleteness: 'not_independently_proven',
      currentHolderCertificate: false,
      routeTvlClaim: false,
    }
    const oldName = append(out, old, generousDisk)
    const oldBytes = readFileSync(join(out, oldName))
    const state = await collect({
      out,
      anchor,
      capability,
      windowBlocks: 5_000,
      stat: generousDisk,
      rpcRead: async (method, params) => {
        if (method === 'eth_getBlockByNumber')
          return header(params[0] === 'finalized' ? 6010 : Number(BigInt(params[0])))
        if (method === 'alchemy_getAssetTransfers') return page([])
        throw Error('unexpected')
      },
    })
    assert.equal(state.throughBlock, 6010)
    assert.equal(state.segmentCount, 2)
    assert.equal(state.interiorAncestry, 'not_independently_proven')
    assert.deepEqual(readFileSync(join(out, oldName)), oldBytes)
    assert.equal('interiorAncestry' in JSON.parse(oldBytes), false)
    const newName = readdirSync(out).find((name) => name !== oldName)
    const next = JSON.parse(readFileSync(join(out, newName)))
    assert.equal(next.schemaVersion, 2)
    assert.equal(next.windowBlocks, 5_000)
    assert.equal(next.windowQualification, 'experimental_page_key_exhausted_only')
    assert.equal(next.fromBlock, 1011)
    assert.equal(next.toBlock, 6010)
    let rpcCalls = 0
    const replay = await main(['--verify', ...args], {
      rpcRead: async () => {
        rpcCalls++
        throw Error('must not request')
      },
      env: {
        get: () => {
          throw Error('must not read env')
        },
      },
    })
    assert.equal(replay.throughBlock, 6010)
    assert.equal(rpcCalls, 0)
    assert.throws(() => append(out, old, generousDisk), /EEXIST/)
    assert.deepEqual(readFileSync(join(out, oldName)), oldBytes)
  }))

test('only declared experimental windows are accepted and semantic window tamper fails replay', async () =>
  fixture(async ({ root, anchor, capability, args }) => {
    assert.deepEqual(WINDOW_BLOCKS, [1_000, 5_000, 10_000, 50_000])
    let calls = 0
    await assert.rejects(
      collect({
        out: join(root, 'unbounded'),
        anchor,
        capability,
        windowBlocks: 100_000,
        stat: generousDisk,
        rpcRead: async () => {
          calls++
          return null
        },
      }),
      /input_invalid/,
    )
    assert.equal(calls, 0)
    await assert.rejects(main([...args, '--window-blocks', '4999']), /window_blocks_invalid/)
    const out = join(root, 'window-tamper')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(out)
    const badWindow = {
      schemaVersion: 2,
      windowBlocks: 5_000,
      windowQualification: 'experimental_page_key_exhausted_only',
      anchor,
      capability,
      fromBlock: 11,
      toBlock: 1010,
      fromHash: hash(11),
      fromParentHash: hash(10),
      toHash: hash(1010),
      finalizedHead: 1010,
      finalizedHeadHash: hash(1010),
      capturedAt: new Date(12_000).toISOString(),
      pages: 1,
      rows: [],
      candidateRecipients: [],
      logCompleteness: 'not_independently_proven',
      interiorAncestry: 'not_independently_proven',
      currentHolderCertificate: false,
      routeTvlClaim: false,
    }
    append(out, badWindow, generousDisk)
    assert.throws(() => verify({ out, anchor, capability }), /seal_invalid/)
    const missingAncestry = { ...badWindow, windowBlocks: 1_000 }
    delete missingAncestry.interiorAncestry
    const v2Out = join(root, 'v2-missing-ancestry')
    mkdirSync(v2Out)
    append(v2Out, missingAncestry, generousDisk)
    assert.throws(() => verify({ out: v2Out, anchor, capability }), /seal_invalid/)
  }))
