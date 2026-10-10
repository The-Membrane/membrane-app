import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import {
  CHUNK_BLOCKS,
  CONFIGURATOR,
  DEFAULT_OUT,
  INITIALIZATION_TX,
  MIN_FREE_BYTES,
  MAX_CHUNKS,
  MAX_PACE_MS,
  MAX_PREFLIGHT_CALLS,
  MAX_RPC_CALLS,
  START_BLOCK,
  START_HASH,
  TOKEN,
  USDE,
  appendSegment,
  assertDiskFloor,
  candidateOwners,
  classifyRpcFailure,
  collect,
  main,
  normalizeLog,
  parseArgs,
  selectRpcReaders,
  verify,
} from './usde-debt-mint-baseline.mjs'

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const RESERVE_INITIALIZED = parseAbiItem(
  'event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)',
)
const ZERO = `0x${'0'.repeat(40)}`
const OWNER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const ATOKEN = '0x4444444444444444444444444444444444444444'
const hex = (value) => `0x${BigInt(value).toString(16)}`
const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const NOW = Date.UTC(2026, 8, 27, 21, 0)
const head = START_BLOCK + 9
const now = () => new Date(NOW)
const folder = () => mkdtempSync(join(tmpdir(), 'usde-debt-mint-'))
const saved = (out) =>
  readdirSync(out)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(out, name), 'utf8')))

function block(number, options = {}) {
  const blockHash = number === START_BLOCK ? START_HASH : hash(number)
  return {
    number: hex(number),
    hash: options.changedBlock === number ? hash(number + 90_000) : blockHash,
    parentHash: number === START_BLOCK + 1 ? START_HASH : hash(number - 1),
    timestamp: hex(Math.floor(NOW / 1000) - 1200 - ((options.head ?? head) - number) * 12),
  }
}

function event(options = {}) {
  const number = options.block ?? START_BLOCK + 4
  const index = options.index ?? 0
  const from = options.from ?? ZERO
  const owner = options.owner ?? OWNER
  return {
    address: options.address ?? TOKEN,
    topics: encodeEventTopics({
      abi: [TRANSFER],
      eventName: 'Transfer',
      args: { from, to: owner },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [options.value ?? 10n]),
    blockNumber: hex(number),
    blockHash: number === START_BLOCK ? START_HASH : hash(number),
    transactionHash: hash(1_000_000 + number * 100 + index),
    logIndex: hex(index),
    removed: false,
  }
}

function initialization(options = {}) {
  return {
    address: CONFIGURATOR,
    topics: encodeEventTopics({
      abi: [RESERVE_INITIALIZED],
      eventName: 'ReserveInitialized',
      args: { asset: options.asset ?? USDE, aToken: ATOKEN },
    }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      [OTHER, options.token ?? TOKEN, OTHER],
    ),
    blockNumber: hex(START_BLOCK),
    blockHash: START_HASH,
    transactionHash: options.tx ?? INITIALIZATION_TX,
    logIndex: hex(options.index ?? 0),
    removed: false,
  }
}

function rpc(events = [], options = {}) {
  const finalized = options.head ?? head
  return async (method, params) => {
    if (method === 'eth_chainId') return options.wrongChain ? '0x89' : '0x1'
    if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'finalized' ? finalized : Number(BigInt(params[0]))
      return block(number, { head: finalized, changedBlock: options.changedBlock })
    }
    if (method === 'eth_getCode') {
      const number = Number(BigInt(params[1]))
      return number < START_BLOCK ? (options.earlyCode ?? '0x') : options.noCode ? '0x' : '0x6001'
    }
    if (method === 'eth_getLogs') {
      const filter = params[0]
      if (filter.address.toLowerCase() === CONFIGURATOR)
        return options.initializationLogs ?? [initialization(options)]
      assert.equal(filter.address.toLowerCase(), TOKEN)
      assert.equal(filter.topics.length, 2)
      assert.equal(filter.topics[1], `0x${'0'.repeat(64)}`)
      const from = Number(BigInt(filter.fromBlock))
      const to = Number(BigInt(filter.toBlock))
      if (options.forceSplit && to > from && (options.forceSingletonCap || to - from >= 9))
        return Array.from({ length: 250 }, (_, i) => ({ i }))
      if (options.forceSingletonCap && from === to)
        return Array.from({ length: 250 }, (_, i) => ({ i }))
      return events.filter((entry) => {
        const number = Number(BigInt(entry.blockNumber))
        return (
          number >= from &&
          number <= to &&
          entry.address.toLowerCase() === TOKEN &&
          entry.topics[1] === filter.topics[1]
        )
      })
    }
    throw new Error(`unexpected ${method}`)
  }
}

async function inFolder(fn) {
  const out = folder()
  try {
    await fn(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

test('quiet interval seals exact anchor, peer agreement, physical SHA and retrospective time', async () =>
  inFolder(async (out) => {
    const result = await collect({ rpcRead: rpc(), peerRpcRead: rpc(), out, now })
    assert.equal(result.appended, 1)
    assert.equal(result.throughBlock, head)
    assert.equal(result.hostCount, 2)
    assert.equal(verify({ out }).logCount, 0)
    const segment = saved(out)[0]
    assert.equal(segment.fromBlock, START_BLOCK)
    assert.equal(segment.fromHeader.hash, START_HASH)
    assert.equal(segment.rawLogCount, 0)
    assert.equal(segment.reserveInitialization.asset, USDE)
    assert.equal(segment.reserveInitialization.variableDebtToken, TOKEN)
    assert.equal(segment.reserveInitialization.transactionHash, INITIALIZATION_TX)
    assert.ok(segment.peerWitness.initializationSha256)
    assert.deepEqual(segment.candidateOwners, [])
    assert.equal(segment.firstObservedAt, now().toISOString())
    assert.ok(segment.retrospectiveLagSeconds >= 0)
    assert.equal(segment.coverage, 'two_rpc_readers_exact_agreement_not_provider_independence')
    assert.equal(segment.peerWitness.distinctHostnames, false)
    assert.match(readdirSync(out)[0], /^\d{12}-\d{12}-[a-f0-9]{64}\.json$/)
    assert.equal((await collect({ rpcRead: rpc(), out, now })).appended, 0)
  }))

test('positive zero-origin Transfer yields owner candidate; zero value is evidence only', async () =>
  inFolder(async (out) => {
    const logs = [event(), event({ index: 1, owner: OTHER, value: 0n })]
    const result = await collect({ rpcRead: rpc(logs), peerRpcRead: rpc(logs), out, now })
    assert.equal(result.logCount, 2)
    assert.deepEqual(saved(out)[0].candidateOwners, [OWNER])
    assert.equal(verify({ out }).logCount, 2)
    assert.deepEqual(candidateOwners(logs.map((raw) => normalizeLog(raw, START_BLOCK, head))), [
      OWNER,
    ])
    assert.throws(
      () => normalizeLog(event({ from: OTHER }), START_BLOCK, head),
      /log_identity_mismatch/,
    )
    assert.throws(
      () => normalizeLog(event({ address: OTHER }), START_BLOCK, head),
      /log_identity_mismatch/,
    )
    assert.throws(() => normalizeLog(event({ owner: ZERO }), START_BLOCK, head), /owner_invalid/)
  }))

test('wrong chain, deployment boundary, peer logs and peer headers fail closed', async () => {
  await inFolder(async (out) => {
    await assert.rejects(
      collect({ rpcRead: rpc([], { wrongChain: true }), out, now }),
      /wrong_chain/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc([], { earlyCode: '0x6001' }), out, now }),
      /anchor_code_mismatch/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc([], { noCode: true }), out, now }),
      /anchor_code_mismatch/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc([event()]), peerRpcRead: rpc(), out, now }),
      /peer_logs_mismatch/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc(), peerRpcRead: rpc([], { changedBlock: head }), out, now }),
      /peer_chain_mismatch|peer_boundary_mismatch/,
    )
  })
})

test('ReserveInitialized proof fails wrong asset, debt token, tx, missing or duplicate log', async () =>
  inFolder(async (out) => {
    for (const options of [
      { asset: OTHER },
      { token: OTHER },
      { tx: hash(999) },
      { initializationLogs: [] },
      { initializationLogs: [initialization(), initialization({ index: 1 })] },
    ]) {
      await assert.rejects(
        collect({ rpcRead: rpc([], options), out, now }),
        /initialization_(identity_mismatch|reserve_mismatch|log_missing_or_ambiguous)/,
      )
      assert.equal(verify({ out }).segmentCount, 0)
    }
    await assert.rejects(
      collect({ rpcRead: rpc(), peerRpcRead: rpc([], { index: 1 }), out, now }),
      /peer_initialization_mismatch/,
    )
  }))

test('range-limit splits without gaps and ambiguous singleton refuses to seal', async () => {
  await inFolder(async (out) => {
    const result = await collect({ rpcRead: rpc([], { forceSplit: true }), out, now, maxChunks: 2 })
    assert.equal(result.appended, 2)
    assert.equal(verify({ out }).throughBlock, head)
    assert.equal(saved(out).length, 2)
  })
  await inFolder(async (out) => {
    await assert.rejects(
      collect({
        rpcRead: rpc([], { forceSplit: true, forceSingletonCap: true }),
        out,
        now,
        maxChunks: 4,
      }),
      /ambiguous_singleton/,
    )
  })
})

test('disk floor, chunk/call bounds, immutable seals and private CLI path', async () =>
  inFolder(async (out) => {
    assert.throws(
      () => assertDiskFloor(out, () => ({ bavail: 1, bsize: MIN_FREE_BYTES - 1 })),
      /disk_reserve_reached/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc(), out, now, maxChunks: MAX_CHUNKS + 1 }),
      /invalid_max_chunks/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc(), out, now, initialRpcCalls: MAX_RPC_CALLS }),
      /rpc_call_cap/,
    )
    const result = await collect({ rpcRead: rpc(), out, now })
    assert.ok(result.rpcCalls <= MAX_RPC_CALLS)
    const segment = saved(out)[0]
    assert.throws(() => appendSegment(out, segment), /EEXIST/)
    const name = readdirSync(out)[0]
    writeFileSync(join(out, name), '{}')
    assert.throws(
      () => verify({ out }),
      /segment_invalid|segment_json_invalid|Cannot read properties/,
    )
    await assert.rejects(main(['--verify', '--out', out]), /output_path_not_private/)
    assert.ok(DEFAULT_OUT.includes('/data/research/venue-signals/'))
    assert.equal(CHUNK_BLOCKS, 5000)
    assert.equal(MAX_CHUNKS, 32)
    assert.equal(MAX_RPC_CALLS, 2048)
  }))

test('bounded catch-up freezes an exact finalized target and resumes without changing seals', async () =>
  inFolder(async (out) => {
    const target = START_BLOCK + 6
    const first = await collect({
      rpcRead: rpc(),
      peerRpcRead: rpc(),
      out,
      now,
      throughBlock: target,
      rangeBlocks: 3,
      maxChunks: 1,
    })
    assert.equal(first.throughBlock, START_BLOCK + 2)
    assert.equal(first.targetBlock, target)
    const firstName = readdirSync(out)[0]
    const second = await collect({
      rpcRead: rpc(),
      peerRpcRead: rpc(),
      out,
      now,
      throughBlock: target,
      rangeBlocks: 3,
      maxChunks: 32,
    })
    assert.equal(second.throughBlock, target)
    assert.equal(second.appended, 2)
    assert.equal(readdirSync(out)[0], firstName)
    assert.equal(verify({ out }).segmentCount, 3)
    await assert.rejects(
      collect({ rpcRead: rpc(), out, now, throughBlock: head + 1 }),
      /target_not_finalized/,
    )
    await assert.rejects(
      collect({ rpcRead: rpc(), out, now, throughBlock: START_BLOCK }),
      /target_behind_frontier/,
    )
    await assert.rejects(main(['--run', '--max-chunks', '33']), /cli_invalid/)
    await assert.rejects(main(['--run', '--through-block', '12']), /cli_invalid/)
  }))

test('pace CLI accepts bounded decimal milliseconds and defaults to zero', () => {
  assert.equal(parseArgs(['--run']).paceMs, 0)
  assert.equal(parseArgs(['--run', '--pace-ms', '0']).paceMs, 0)
  assert.equal(parseArgs(['--run', '--pace-ms', '5000']).paceMs, MAX_PACE_MS)
  for (const value of ['-1', '5001', '1.5', '1e3', 'Infinity', '', '01'])
    assert.throws(() => parseArgs(['--run', '--pace-ms', value]), /cli_invalid/)
  assert.throws(() => parseArgs(['--run', '--pace-ms']), /cli_invalid/)
})

test('pace runs only after a sealed chunk when more work remains', async () =>
  inFolder(async (out) => {
    const starts = []
    const reader = rpc()
    const tracked = async (method, params) => {
      if (method === 'eth_getLogs' && params[0].address.toLowerCase() === TOKEN)
        starts.push(Number(BigInt(params[0].fromBlock)))
      return reader(method, params)
    }
    const sleeps = []
    const result = await collect({
      rpcRead: tracked,
      out,
      now,
      maxChunks: 4,
      rangeBlocks: 3,
      paceMs: 25,
      sleep: async (ms) => {
        sleeps.push({ ms, throughBlock: verify({ out }).throughBlock, started: starts.length })
      },
    })
    assert.equal(result.appended, 4)
    assert.deepEqual(starts, [START_BLOCK, START_BLOCK + 3, START_BLOCK + 6, START_BLOCK + 9])
    assert.deepEqual(sleeps, [
      { ms: 25, throughBlock: START_BLOCK + 2, started: 1 },
      { ms: 25, throughBlock: START_BLOCK + 5, started: 2 },
      { ms: 25, throughBlock: START_BLOCK + 8, started: 3 },
    ])
  }))

test('zero pace and a one-chunk cap never invoke sleep', async () => {
  await inFolder(async (out) => {
    const sleep = async () => assert.fail('unexpected sleep')
    await collect({ rpcRead: rpc(), out, now, maxChunks: 2, rangeBlocks: 3, sleep })
  })
  await inFolder(async (out) => {
    const sleep = async () => assert.fail('unexpected sleep')
    const result = await collect({ rpcRead: rpc(), out, now, maxChunks: 1, paceMs: 25, sleep })
    assert.equal(result.appended, 1)
  })
  await inFolder(async (out) => {
    await assert.rejects(
      collect({ rpcRead: rpc(), out, now, paceMs: MAX_PACE_MS + 1 }),
      /invalid_pace_ms/,
    )
    assert.equal(readdirSync(out).length, 0)
  })
})

test('provider failure after a sealed chunk leaves a verifiable resumable frontier', async () =>
  inFolder(async (out) => {
    const reader = rpc()
    const interrupted = async (method, params) => {
      if (
        method === 'eth_getLogs' &&
        params[0].address.toLowerCase() === TOKEN &&
        Number(BigInt(params[0].fromBlock)) >= START_BLOCK + 3
      )
        throw new Error('rate_limit')
      return reader(method, params)
    }
    const sleeps = []
    await assert.rejects(
      collect({
        rpcRead: interrupted,
        out,
        now,
        throughBlock: START_BLOCK + 8,
        rangeBlocks: 3,
        maxChunks: MAX_CHUNKS,
        paceMs: 25,
        sleep: async (ms) => sleeps.push(ms),
      }),
      /rate_limit/,
    )
    assert.deepEqual(sleeps, [25])
    assert.equal(verify({ out }).throughBlock, START_BLOCK + 2)
    const original = readdirSync(out)[0]
    const resumed = await collect({
      rpcRead: rpc(),
      out,
      now,
      throughBlock: START_BLOCK + 8,
      rangeBlocks: 3,
      maxChunks: MAX_CHUNKS,
    })
    assert.equal(resumed.throughBlock, START_BLOCK + 8)
    assert.equal(readdirSync(out)[0], original)
    assert.equal(verify({ out }).segmentCount, 3)
  }))

test('HTTP 429 Too Many Requests stops a log range without recursive splitting', async () =>
  inFolder(async (out) => {
    const reader = rpc()
    let logCalls = 0
    const throttled = async (method, params) => {
      if (method === 'eth_getLogs' && params[0].address.toLowerCase() === TOKEN) {
        logCalls++
        throw new Error('HTTP 429 Too Many Requests')
      }
      return reader(method, params)
    }
    await assert.rejects(
      collect({
        rpcRead: throttled,
        out,
        now,
        throughBlock: head,
        rangeBlocks: 8,
        paceMs: 25,
        sleep: async () => assert.fail('unexpected sleep before a seal'),
      }),
      /HTTP 429 Too Many Requests/,
    )
    assert.equal(logCalls, 1)
    assert.equal(readdirSync(out).length, 0)
    assert.equal(classifyRpcFailure(new Error('HTTP 429 Too Many Requests')), 'rate_limit')
    assert.equal(
      classifyRpcFailure(new Error('query returned more than 10000 results')),
      'range_limit',
    )
    assert.equal(classifyRpcFailure(new Error('request timeout')), 'failed')
  }))

test('explicit provider block-range limit still splits and seals a contiguous frontier', async () =>
  inFolder(async (out) => {
    const reader = rpc()
    let rangeFailures = 0
    const limited = async (method, params) => {
      if (method === 'eth_getLogs' && params[0].address.toLowerCase() === TOKEN) {
        const from = Number(BigInt(params[0].fromBlock))
        const to = Number(BigInt(params[0].toBlock))
        if (to - from + 1 > 2) {
          rangeFailures++
          throw new Error('provider block range limit')
        }
      }
      return reader(method, params)
    }
    const result = await collect({
      rpcRead: limited,
      out,
      now,
      throughBlock: START_BLOCK + 3,
      rangeBlocks: 4,
      maxChunks: 4,
    })
    assert.equal(rangeFailures, 1)
    assert.equal(result.throughBlock, START_BLOCK + 3)
    assert.equal(verify({ out }).segmentCount, 2)
  }))

test('HTTP 429 during preflight does not probe narrower ranges or another reader', async () => {
  let logCalls = 0
  const factory = (url) => {
    const client = preflightFactory({ [url]: 1000 })(url)
    return {
      ...client,
      request: async (request) => {
        if (request.method === 'eth_getLogs') {
          logCalls++
          throw new Error('HTTP 429 Too Many Requests')
        }
        return client.request(request)
      },
    }
  }
  await assert.rejects(
    selectRpcReaders({ raw: 'https://one.example,https://two.example', factory }),
    /usde_debt_mint_rpc_rate_limit/,
  )
  assert.equal(logCalls, 1)
})

test('preflight does not shrink a range after an unrelated provider timeout', async () => {
  let logCalls = 0
  const factory = (url) => {
    const client = preflightFactory({ [url]: 1000 })(url)
    return {
      ...client,
      request: async (request) => {
        if (request.method === 'eth_getLogs') {
          logCalls++
          throw new Error('request timeout')
        }
        return client.request(request)
      },
    }
  }
  await assert.rejects(
    selectRpcReaders({ raw: 'https://one.example', factory }),
    /no_healthy_rpc_host/,
  )
  assert.equal(logCalls, 1)
})

function preflightFactory(limitByUrl) {
  return (url) => ({
    getChainId: async () => 1,
    getBlock: async ({ blockTag }) => block(blockTag ? head : START_BLOCK),
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') {
        if (url.includes('flaky')) throw new Error(`credential in ${url}`)
        return '0x1'
      }
      if (method !== 'eth_getLogs') throw new Error('unexpected preflight method')
      const filter = params[0]
      assert.equal(filter.address.toLowerCase(), TOKEN)
      assert.equal(filter.topics[1], `0x${'0'.repeat(64)}`)
      const count = Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n)
      if (count > limitByUrl[url]) throw new Error(`provider ${url} range limit`)
      return []
    },
  })
}

test('preflight prefers two distinct full-range readers over an earlier eight-block reader', async () => {
  const urls = [
    'https://slow.example/secret',
    'https://fast-a.example/secret',
    'https://fast-b.example/secret',
  ]
  const ranges = [8, 1000, 1000]
  const result = await selectRpcReaders({
    raw: urls.join(','),
    factory: preflightFactory(Object.fromEntries(urls.map((url, i) => [url, ranges[i]]))),
  })
  assert.deepEqual(
    result.readers.map((entry) => entry.anchorProbePassedBlocks),
    [1000, 1000],
  )
  assert.ok(result.preflightRpcCalls <= MAX_PREFLIGHT_CALLS)
})

test('preflight labels tested fallback ranges and retains only best per hostname', async () => {
  const urls = [
    'https://one.example/eight',
    'https://one.example/full',
    'https://two.example/four',
    'https://flaky.example/secret',
  ]
  const limits = Object.fromEntries(urls.map((url, i) => [url, [8, 1000, 4, 1000][i]]))
  const result = await selectRpcReaders({ raw: urls.join(','), factory: preflightFactory(limits) })
  assert.deepEqual(
    result.readers.map((entry) => entry.anchorProbePassedBlocks),
    [1000, 4],
  )
  assert.ok(result.preflightRpcCalls <= MAX_PREFLIGHT_CALLS)
  await inFolder(async (out) => {
    const reading = await collect({
      rpcRead: rpc(),
      out,
      now,
      rangeBlocks: 4,
      anchorProbePassedBlocksByReader: [4],
    })
    assert.equal(reading.rangeBlocks, 4)
    assert.deepEqual(reading.anchorProbePassedBlocksByReader, [4])
    assert.equal(saved(out)[0].toBlock, START_BLOCK + 3)
    assert.deepEqual(saved(out)[0].anchorProbePassedBlocksByReader, [4])
    assert.equal(verify({ out }).segmentCount, 1)
  })
  await assert.rejects(
    selectRpcReaders({
      raw: 'https://flaky.example/secret',
      factory: preflightFactory(limits),
    }),
    /no_healthy_rpc_host/,
  )
})

test('immutable v2 eight-block pilot remains verifiable but explicitly unprobed', async () =>
  inFolder(async (out) => {
    await collect({ rpcRead: rpc(), out, now, rangeBlocks: 8 })
    const originalName = readdirSync(out)[0]
    const old = saved(out)[0]
    unlinkSync(join(out, originalName))
    old.config.schemaVersion = 2
    old.config.chunkBlocks = 1000
    delete old.rangeBlocks
    delete old.anchorProbePassedBlocksByReader
    appendSegment(out, old)
    const oldState = verify({ out })
    assert.equal(oldState.throughBlock, START_BLOCK + 7)
    assert.equal(oldState.legacyUnprobedSegmentCount, 1)
    const resumed = await collect({
      rpcRead: rpc(),
      out,
      now,
      rangeBlocks: 1000,
      anchorProbePassedBlocksByReader: [1000],
    })
    assert.equal(resumed.throughBlock, head)
    assert.equal(resumed.legacyUnprobedSegmentCount, 1)
    assert.equal(saved(out).length, 2)
    assert.equal(saved(out)[1].config.schemaVersion, 4)
  }))

test('immutable v3 thousand-block seals remain verifiable before new v4 five-thousand-block seals', async () =>
  inFolder(async (out) => {
    await collect({ rpcRead: rpc(), out, now, rangeBlocks: 8 })
    const oldName = readdirSync(out)[0]
    const old = saved(out)[0]
    unlinkSync(join(out, oldName))
    old.config.schemaVersion = 3
    old.config.chunkBlocks = 1000
    appendSegment(out, old)
    const verifiedOldName = readdirSync(out)[0]
    assert.equal(verify({ out }).throughBlock, START_BLOCK + 7)
    const resumed = await collect({ rpcRead: rpc(), out, now, rangeBlocks: CHUNK_BLOCKS })
    assert.equal(resumed.throughBlock, head)
    assert.equal(readdirSync(out)[0], verifiedOldName)
    assert.equal(saved(out)[1].config.schemaVersion, 4)
    assert.equal(saved(out)[1].config.chunkBlocks, 5000)
    assert.equal(verify({ out }).segmentCount, 2)
  }))
