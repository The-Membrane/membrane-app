import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DIRECT_FLOW_MARKETS,
  freshUsdeFlowStart,
  freezeDirectFlowTarget,
  MAX_SEGMENTS_PER_MARKET_TICK,
  recordDirectSupplierFlowTick,
  safeDirectFlowErrorCode,
} from './record-carry-direct-supplier-flow.mjs'

const script = fileURLToPath(new URL('./record-carry-direct-supplier-flow.mjs', import.meta.url))
const tick = fileURLToPath(new URL('./carry-direct-supplier-flow-tick.sh', import.meta.url))
const plist = fileURLToPath(
  new URL('./launchd/com.membrane.carry-direct-supplier-flows.plist', import.meta.url),
)
const nowMs = 1_800_000_000_000
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const origins = 'https://one.example/private-one,https://two.example/private-two'

function rpcFactory({
  atMs = nowMs,
  heads = [26090000, 26090002, 26090001, 26090003],
  badHash = false,
  badHashIndices = new Set(),
  broken = new Set(),
  wrongChain = new Set(),
  malformedHead = new Set(),
  malformedTarget = new Set(),
  factoryThrows = new Set(),
  calls = [],
} = {}) {
  return (url) => {
    const index = url.includes('one.example')
      ? 0
      : url.includes('two.example')
        ? 1
        : url.includes('three.example')
          ? 2
          : 3
    if (factoryThrows.has(index)) throw new Error(`https://private-${index}.example/factory-secret`)
    return {
      async request({ method, params }) {
        calls.push({ index, method, params })
        if (broken.has(index)) throw new Error(`https://private-${index}.example/secret`)
        if (method === 'eth_chainId') return wrongChain.has(index) ? '0xa' : '0x1'
        if (method === 'eth_getBlockByNumber') {
          if (params[0] === 'finalized' && malformedHead.has(index)) return { number: 'bad' }
          if (params[0] !== 'finalized' && malformedTarget.has(index)) return { number: 'bad' }
          const n = params[0] === 'finalized' ? heads[index] : Number(BigInt(params[0]))
          return {
            number: `0x${n.toString(16)}`,
            hash: hash(
              params[0] !== 'finalized' && (badHashIndices.has(index) || (badHash && index === 1))
                ? n + 1
                : n,
            ),
            parentHash: hash(n - 1),
            timestamp: `0x${Math.floor((atMs - 600_000 - (26090000 - n) * 12_000) / 1000).toString(
              16,
            )}`,
          }
        }
        throw new Error('unexpected_method')
      },
    }
  }
}

test('freezes strictly below both finalized heads and corroborates one exact target', async () => {
  const calls = []
  const result = await freezeDirectFlowTarget({
    rpcUrls: origins,
    clientFactory: rpcFactory({ calls }),
    nowMs,
  })
  assert.equal(result.targetBlock, 26089999)
  assert.equal(result.originCount, 2)
  assert.equal(result.rpcUrls, origins)
  assert.deepEqual(
    calls
      .filter((call) => call.method === 'eth_getBlockByNumber' && call.params[0] !== 'finalized')
      .map((call) => call.params[0]),
    Array(2).fill(`0x${result.targetBlock.toString(16)}`),
  )
  assert.ok(calls.every((call) => !['eth_call', 'eth_getLogs'].includes(call.method)))
})

test('Aave USDe first native tick seals its own fresh finalized start and resumes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-usde-frontier-'))
  const first = {
    targetBlock: 26089999,
    targetHash: hash(26089999),
    targetAtMs: nowMs - 600_000,
  }
  try {
    const start = freshUsdeFlowStart({ outDir: dir, frozen: first, nowMs })
    assert.deepEqual(start, { fromBlock: first.targetBlock, firstBlockHash: first.targetHash })
    assert.notEqual(
      start.fromBlock,
      DIRECT_FLOW_MARKETS.find((x) => x.marketKey === 'aaveV3Usdc').fromBlock,
    )
    const saved = JSON.parse(readFileSync(join(dir, 'start-aaveV3Usde.json'), 'utf8'))
    assert.equal(saved.firstFinalizedTargetHash, first.targetHash)
    assert.equal(saved.fromBlock, first.targetBlock)
    assert.deepEqual(
      freshUsdeFlowStart({
        outDir: dir,
        frozen: { ...first, targetBlock: first.targetBlock + 100 },
        nowMs: nowMs + 20 * 60_000,
      }),
      start,
    )
    assert.throws(
      () =>
        freshUsdeFlowStart({
          outDir: dir,
          frozen: { ...first, targetBlock: first.targetBlock - 1 },
          nowMs,
        }),
      /invalid_direct_usde_anchor/,
    )
    saved.fromBlock = DIRECT_FLOW_MARKETS.find((x) => x.marketKey === 'aaveV3Usdc').fromBlock
    rmSync(join(dir, 'start-aaveV3Usde.json'))
    writeFileSync(join(dir, 'start-aaveV3Usde.json'), JSON.stringify(saved))
    assert.throws(
      () => freshUsdeFlowStart({ outDir: dir, frozen: first, nowMs }),
      /invalid_direct_usde_anchor/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Aave USDe refuses an unanchored prior segment or stale bootstrap target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-usde-orphan-'))
  const first = { targetBlock: 26089999, targetHash: hash(26089999), targetAtMs: nowMs - 600_000 }
  try {
    writeFileSync(join(dir, 'aaveV3Usde-100-163.json'), '{}')
    assert.throws(
      () => freshUsdeFlowStart({ outDir: dir, frozen: first, nowMs }),
      /direct_usde_unanchored_segments/,
    )
    rmSync(join(dir, 'aaveV3Usde-100-163.json'))
    assert.throws(
      () =>
        freshUsdeFlowStart({
          outDir: dir,
          frozen: { ...first, targetAtMs: nowMs - 3 * 60 * 60_000 },
          nowMs,
        }),
      /invalid_direct_usde_frontier/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses one healthy origin and a disputed finalized target', async () => {
  await assert.rejects(
    freezeDirectFlowTarget({
      rpcUrls: origins,
      clientFactory: rpcFactory({ broken: new Set([1]) }),
      nowMs,
    }),
    /two_healthy_direct_rpc_origins_required/,
  )
  await assert.rejects(
    freezeDirectFlowTarget({
      rpcUrls: origins,
      clientFactory: rpcFactory({ badHash: true }),
      nowMs,
    }),
    /direct_finalized_target_disagreement/,
  )
})

test('one unusable third origin cannot block two healthy exact-hash origins', async () => {
  const three = `${origins},https://three.example/private-three`
  for (const option of [
    { broken: new Set([2]) },
    { wrongChain: new Set([2]) },
    { malformedHead: new Set([2]) },
    { malformedTarget: new Set([2]) },
    { factoryThrows: new Set([2]) },
  ]) {
    const result = await freezeDirectFlowTarget({
      rpcUrls: three,
      clientFactory: rpcFactory(option),
      nowMs,
    })
    assert.equal(result.targetBlock, 26089999)
    assert.equal(result.originCount, 2)
    assert.equal(result.rpcUrls, origins)
  }
  const oneDissent = await freezeDirectFlowTarget({
    rpcUrls: three,
    clientFactory: rpcFactory({ badHash: true }),
    nowMs,
  })
  assert.equal(oneDissent.originCount, 2)
  assert.equal(
    oneDissent.rpcUrls,
    'https://one.example/private-one,https://three.example/private-three',
  )
})

test('competing exact-hash pairs remain ambiguous', async () => {
  await assert.rejects(
    freezeDirectFlowTarget({
      rpcUrls: `${origins},https://three.example/private-three,https://four.example/private-four`,
      clientFactory: rpcFactory({ badHashIndices: new Set([2, 3]) }),
      nowMs,
    }),
    /direct_finalized_target_disagreement/,
  )
})

test('rejects stale finalized evidence before calling backfill', async () => {
  const stale = rpcFactory({ heads: [26090000, 26090002] })
  await assert.rejects(
    freezeDirectFlowTarget({
      rpcUrls: origins,
      nowMs: nowMs + 3 * 60 * 60 * 1000,
      clientFactory: stale,
    }),
    /two_healthy_direct_rpc_origins_required/,
  )
})

test('uses the sealed prefix start and bounded resume for each market independently', async () => {
  const calls = []
  const result = await recordDirectSupplierFlowTick({
    rpcUrls: origins,
    clientFactory: rpcFactory(),
    nowMs,
    freshStart: ({ frozen }) => ({
      fromBlock: frozen.targetBlock,
      firstBlockHash: frozen.targetHash,
    }),
    backfill: async (options) => {
      calls.push(options)
      const fresh = options.marketKey === 'aaveV3Usde'
      return {
        marketKey: options.marketKey,
        status: fresh ? 'complete' : 'budget_reached',
        throughBlock: fresh ? options.toBlock : options.fromBlock + 511,
        newSegments: fresh ? 1 : 8,
        resumedSegments: 100,
      }
    },
  })
  assert.equal(result.targetBlock, 26089999)
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ['complete', 'budget_reached', 'budget_reached', 'budget_reached'],
  )
  assert.deepEqual(
    calls.map(({ marketKey, fromBlock, toBlock, maxSegments }) => ({
      marketKey,
      fromBlock,
      toBlock,
      maxSegments,
    })),
    DIRECT_FLOW_MARKETS.map((market) => ({
      ...market,
      fromBlock: market.marketKey === 'aaveV3Usde' ? result.targetBlock : market.fromBlock,
      toBlock: result.targetBlock,
      maxSegments: MAX_SEGMENTS_PER_MARKET_TICK,
    })),
  )
  assert.ok(calls.every((call) => call.rpcUrls === origins))
  assert.equal(calls[0].marketKey, 'aaveV3Usde')
  assert.equal(calls[0].expectedFirstBlockHash, hash(result.targetBlock))
})

test('supplemental cap bounds each market before capture and rejects invalid caps', async () => {
  const calls = []
  const result = await recordDirectSupplierFlowTick({
    rpcUrls: origins,
    clientFactory: rpcFactory(),
    nowMs,
    maxSegmentsPerMarket: 2,
    freshStart: ({ frozen }) => ({
      fromBlock: frozen.targetBlock,
      firstBlockHash: frozen.targetHash,
    }),
    backfill: async (options) => {
      calls.push(options)
      return {
        marketKey: options.marketKey,
        status: 'budget_reached',
        throughBlock: options.fromBlock,
        newSegments: 2,
      }
    },
  })
  assert.equal(calls.length, DIRECT_FLOW_MARKETS.length)
  assert.ok(calls.every((call) => call.maxSegments === 2))
  assert.ok(result.results.every((entry) => entry.status === 'budget_reached'))
  await assert.rejects(
    recordDirectSupplierFlowTick({
      rpcUrls: origins,
      clientFactory: () => {
        throw Error('RPC should not start')
      },
      maxSegmentsPerMarket: 9,
    }),
    /invalid_direct_tick_options/,
  )
})

test('hourly withdrawal slots give every market the first turn without dropping failures', async () => {
  const marketKeys = DIRECT_FLOW_MARKETS.map((market) => market.marketKey)
  for (let slot = 0; slot < marketKeys.length; slot++) {
    const tickMs = nowMs + slot * 60 * 60_000
    const calls = []
    const result = await recordDirectSupplierFlowTick({
      rpcUrls: origins,
      clientFactory: rpcFactory({ atMs: tickMs }),
      nowMs: tickMs,
      freshStart: ({ frozen }) => ({
        fromBlock: frozen.targetBlock,
        firstBlockHash: frozen.targetHash,
      }),
      backfill: async (options) => {
        calls.push(options.marketKey)
        if (options.marketKey === 'sparkLendUsdt') throw Error('unavailable')
        return {
          marketKey: options.marketKey,
          status: 'complete',
          throughBlock: options.toBlock,
          newSegments: 1,
        }
      },
    })
    const expected = [...marketKeys.slice(slot), ...marketKeys.slice(0, slot)]
    assert.deepEqual(calls, expected)
    assert.deepEqual(
      result.results.map((row) => row.marketKey),
      expected,
    )
    assert.deepEqual(new Set(calls), new Set(marketKeys))
    assert.equal(result.results.find((row) => row.marketKey === 'sparkLendUsdt').status, 'failed')
  }
})

test('a failed Spark tick cannot discard Aave progress, and vice versa', async () => {
  const calls = []
  const result = await recordDirectSupplierFlowTick({
    rpcUrls: origins,
    clientFactory: rpcFactory(),
    nowMs,
    freshStart: ({ frozen }) => ({
      fromBlock: frozen.targetBlock,
      firstBlockHash: frozen.targetHash,
    }),
    backfill: async (options) => {
      calls.push(options.marketKey)
      if (options.marketKey === 'sparkLendUsdt')
        throw new Error('https://rpc.example/secret-holder-0xabc')
      return {
        marketKey: options.marketKey,
        status: 'complete',
        throughBlock: options.toBlock,
        newSegments: 1,
      }
    },
  })
  assert.deepEqual(calls, ['aaveV3Usde', 'aaveV3Usdc', 'sparkLendUsdt', 'compoundV3Usdc'])
  assert.deepEqual(result.results, [
    { marketKey: 'aaveV3Usde', status: 'complete', throughBlock: 26089999, newSegments: 1 },
    { marketKey: 'aaveV3Usdc', status: 'complete', throughBlock: 26089999, newSegments: 1 },
    {
      marketKey: 'sparkLendUsdt',
      status: 'failed',
      phase: 'backfill',
      errorCode: 'direct_unknown_failure',
      sourceClass: 'none',
      retryable: false,
    },
    { marketKey: 'compoundV3Usdc', status: 'complete', throughBlock: 26089999, newSegments: 1 },
  ])
  assert.doesNotMatch(JSON.stringify(result), /secret-holder|private-one|private-two/)

  const reverse = await recordDirectSupplierFlowTick({
    rpcUrls: origins,
    clientFactory: rpcFactory(),
    nowMs,
    freshStart: ({ frozen }) => ({
      fromBlock: frozen.targetBlock,
      firstBlockHash: frozen.targetHash,
    }),
    backfill: async (options) => {
      if (options.marketKey === 'aaveV3Usdc') throw new Error('secret-rpc-url')
      return {
        marketKey: options.marketKey,
        status: 'complete',
        throughBlock: options.toBlock,
        newSegments: 1,
      }
    },
  })
  assert.deepEqual(
    reverse.results.map((entry) => entry.status),
    ['complete', 'failed', 'complete', 'complete'],
  )
})

test('CLI and shell never print RPC credentials or holder text', () => {
  const invalidCap = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DIRECT_FLOW_MAX_SEGMENTS_PER_MARKET_TICK: 'unbounded',
      RECORDER_RPC_URLS: 'https://one.example/private-holder',
    },
  })
  assert.equal(invalidCap.status, 1)
  assert.equal(invalidCap.stderr, 'direct_supplier_flow_tick_failed\n')
  const cli = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, RECORDER_RPC_URLS: 'https://one.example/private-holder' },
  })
  assert.equal(cli.status, 1)
  assert.equal(cli.stderr, 'direct_supplier_flow_tick_failed\n')
  assert.doesNotMatch(cli.stdout + cli.stderr, /private-holder/)
  const diagnostic = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RECORDER_RPC_URLS: 'https://one.example/private-holder',
      DIRECT_FLOW_DIAGNOSTIC: '1',
    },
  })
  assert.equal(diagnostic.status, 1)
  assert.equal(
    diagnostic.stderr,
    'direct_supplier_flow_tick_failed:two_distinct_direct_rpc_origins_required\n',
  )
  assert.equal(
    safeDirectFlowErrorCode(new Error('https://one.example/private-holder')),
    'direct_unknown_failure',
  )
  assert.equal(safeDirectFlowErrorCode(new Error('direct_disk_reserve')), 'direct_disk_reserve')

  const dir = mkdtempSync(join(tmpdir(), 'direct-supplier-tick-'))
  try {
    const fakeNode = join(dir, 'node')
    const fakeTimeout = join(dir, 'timeout')
    writeFileSync(
      fakeNode,
      '#!/bin/sh\necho secret-holder-and-url\necho secret-holder-and-url >&2\necho direct_supplier_flow_market:aaveV3Usdc:failed:backfill:0:0:direct_source_disagreement:http_429:0\necho direct_supplier_flow_market:compoundV3Usdc:failed:backfill:0:0:direct_disk_reserve:none:0\necho direct_supplier_flow_market:aaveV3Usdc:failed:backfill:0:0:privatekey:none:0\nexit 7\n',
      { mode: 0o755 },
    )
    writeFileSync(fakeTimeout, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 })
    const run = spawnSync('/bin/sh', [tick], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: dir,
        DIRECT_FLOW_NODE_BIN: fakeNode,
        DIRECT_FLOW_TIMEOUT_BIN: fakeTimeout,
      },
    })
    assert.equal(run.status, 1)
    assert.equal(run.stderr, 'direct-supplier-flow:tick-failed\n')
    assert.equal(
      run.stdout,
      'direct_supplier_flow_market:aaveV3Usdc:failed:backfill:0:0:direct_source_disagreement:http_429:0\ndirect_supplier_flow_market:compoundV3Usdc:failed:backfill:0:0:direct_disk_reserve:none:0\n',
    )
    assert.doesNotMatch(run.stdout + run.stderr, /secret-holder-and-url/)
    assert.doesNotMatch(run.stdout + run.stderr, /privatekey/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shell lock rejects an overlapping process without running its child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-supplier-lock-'))
  const marker = join(dir, 'first-running')
  const fakeNode = join(dir, 'node')
  const fakeTimeout = join(dir, 'timeout')
  writeFileSync(fakeNode, `#!/bin/sh\ntouch '${marker}'\nsleep 1\n`, { mode: 0o755 })
  writeFileSync(fakeTimeout, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 })
  const env = {
    ...process.env,
    TMPDIR: dir,
    DIRECT_FLOW_NODE_BIN: fakeNode,
    DIRECT_FLOW_TIMEOUT_BIN: fakeTimeout,
  }
  try {
    const first = spawn('/bin/sh', [tick], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((done) => setTimeout(done, 10))
    assert.equal(existsSync(marker), true)
    const second = spawnSync('/bin/sh', [tick], { env, encoding: 'utf8' })
    assert.equal(second.status, 1)
    assert.equal(second.stderr, 'direct-supplier-flow:lock-unavailable\n')
    const supplemental = spawnSync('/bin/sh', [tick], {
      env: { ...env, DIRECT_FLOW_SUPPLEMENTAL: '1' },
      encoding: 'utf8',
    })
    assert.equal(supplemental.status, 75)
    assert.equal(supplemental.stderr, 'direct-supplier-flow:lock-unavailable\n')
    const firstExit = await new Promise((done) => first.once('exit', done))
    assert.equal(firstExit, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shell and offset launchd job are valid, bounded, and not activated by load', () => {
  assert.equal(spawnSync('/bin/sh', ['-n', tick]).status, 0)
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0)
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
    encoding: 'utf8',
  })
  assert.equal(parsed.status, 0)
  const job = JSON.parse(parsed.stdout)
  assert.equal(job.Label, 'com.membrane.carry-direct-supplier-flows')
  assert.equal(job.StartCalendarInterval.Minute, 4)
  assert.equal(job.RunAtLoad, false)
  assert.deepEqual(job.ProgramArguments, [
    '/opt/homebrew/bin/timeout',
    '-k',
    '5s',
    '270s',
    '/bin/sh',
    tick,
  ])
  assert.match(readFileSync(tick, 'utf8'), /flock\(fd, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/)
  assert.match(readFileSync(tick, 'utf8'), /-k 5s 240s/)
})
