import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import { MARKETS } from './aave-core-forward-panel.mjs'
import {
  BLOCK,
  COMETS,
  OUTPUT_ROOT,
  SOURCE_SHA256,
  captureConfig,
  captureWindow,
  collect,
  parseCliArgs,
  plan,
  readSnapshot,
  run,
  saveSnapshot,
  spreadBps,
} from './aave-compound-peer-rate.mjs'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const seal = (x) => hash(JSON.stringify(x))
const H = `0x${'12'.repeat(32)}`
const A = `0x${'34'.repeat(20)}`
const ABI = [
  {
    type: 'function',
    name: 'baseToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getUtilization',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getSupplyRate',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'isWithdrawPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
]

function fixture(aaveFlags = { active: true, paused: false, frozen: false }, block = BLOCK) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-rate-'))
  const sourcePath = join(dir, 'aave.json')
  const out = join(dir, 'peer.json')
  const payload = {
    study: 'aave-core-anchor-features-v1',
    chainId: 1,
    rows: [
      {
        block,
        blockHash: H,
        blockTimestamp: 1000,
        observedAtMs: 1_001_000,
        markets: MARKETS.map((market) => ({
          name: market.name,
          underlying: market.base,
          liquidityRateRay: '10000000000000000000000000',
          flags: aaveFlags,
        })),
      },
    ],
  }
  writeFileSync(sourcePath, JSON.stringify({ payload, sha256: seal(payload) }))
  return { dir, sourcePath, out, expectedSourceSha256: hash(readFileSync(sourcePath)) }
}

function mock({
  block = BLOCK,
  chain = 1,
  blockHash = H,
  wrongBase = false,
  rateFailure = false,
  paused = false,
  missingImplementation = false,
  proxyFailureMarket = null,
  implementationFailureMarket = null,
  baseFailureMarket = null,
} = {}) {
  const calls = []
  return {
    calls,
    async getChainId() {
      calls.push('chain')
      return chain
    },
    async getBlock({ blockNumber }) {
      assert.equal(blockNumber, BigInt(block))
      calls.push('block')
      return { number: BigInt(block), hash: blockHash, timestamp: 1000n }
    },
    async request({ method, params }) {
      calls.push(method)
      assert.deepEqual(params.at(-1), { blockHash: H, requireCanonical: true })
      if (method === 'eth_getCode') {
        if (
          proxyFailureMarket !== null &&
          params[0].toLowerCase() === COMETS[proxyFailureMarket].address.toLowerCase()
        )
          throw new Error('proxy RPC unavailable')
        return '0x6000'
      }
      if (method === 'eth_getStorageAt') {
        if (
          implementationFailureMarket !== null &&
          params[0].toLowerCase() === COMETS[implementationFailureMarket].address.toLowerCase()
        )
          throw new Error('slot RPC unavailable')
        assert.match(params[1], /^0x[0-9a-f]{64}$/)
        return missingImplementation ? `0x${'00'.repeat(32)}` : `0x${'00'.repeat(12)}${A.slice(2)}`
      }
      if (method !== 'eth_call') throw new Error('Unexpected RPC')
      const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data })
      const index = COMETS.findIndex((c) => c.address.toLowerCase() === params[0].to.toLowerCase())
      assert.ok(index >= 0)
      let result
      if (functionName === 'baseToken') {
        if (baseFailureMarket === index) throw new Error('base RPC unavailable')
        result = wrongBase ? A : COMETS[index].base
      }
      if (functionName === 'getUtilization') result = 800_000_000_000_000_000n
      if (functionName === 'getSupplyRate') {
        assert.equal(args[0], 800_000_000_000_000_000n)
        if (rateFailure) throw new Error('https://credentialed-rpc.example/SECRET')
        result = 1_000_000_000n
      }
      if (functionName === 'isWithdrawPaused') result = paused
      return encodeFunctionResult({ abi: ABI, functionName, result })
    },
  }
}

test('dry plan never needs RPC or source file', () => {
  assert.equal(plan().status, 'dry-only')
  assert.equal(parseCliArgs([]).config.block, BLOCK)
})

test('daily CLI requires four explicit sealed inputs and matching scoped paths', () => {
  const sourcePath = join(OUTPUT_ROOT, 'aave-core-anchor-features-2026-09-27.json')
  const out = join(OUTPUT_ROOT, 'aave-compound-peer-rate-2026-09-27.json')
  const sha = 'a'.repeat(64)
  const args = [
    '--run',
    '--source',
    sourcePath,
    '--source-sha256',
    sha,
    '--block',
    '26060000',
    '--out',
    out,
  ]
  const parsed = parseCliArgs(args)
  assert.equal(parsed.run, true)
  assert.deepEqual(parsed.config, { sourcePath, expectedSourceSha256: sha, block: 26_060_000, out })
  assert.equal(parseCliArgs(args.slice(1)).run, false)
  assert.equal(plan(parsed.config).status, 'dry-only')
  assert.throws(() => parseCliArgs(args.slice(0, -2)), /requires source/)
  assert.throws(() => parseCliArgs([...args, '--block', '2']), /Invalid peer-rate arguments/)
  assert.throws(() => parseCliArgs([...args.slice(0, 4), 'not-a-sha', ...args.slice(5)]), /SHA-256/)
  assert.throws(
    () => captureConfig({ ...parsed.config, out: join(OUTPUT_ROOT, '..', 'outside.json') }),
    /outside/,
  )
  assert.throws(
    () =>
      captureConfig({
        ...parsed.config,
        out: join(OUTPUT_ROOT, 'aave-compound-peer-rate-2026-09-28.json'),
      }),
    /same frozen calendar date/,
  )
  assert.throws(
    () =>
      captureConfig({
        sourcePath: join(OUTPUT_ROOT, 'aave-core-anchor-features-2026-09-26.json'),
        expectedSourceSha256: sha,
        block: BLOCK,
        out: join(OUTPUT_ROOT, 'aave-compound-peer-rate-2026-09-26.json'),
      }),
    /Sep 26 frozen/,
  )
  assert.throws(
    () =>
      captureConfig({
        sourcePath: join(OUTPUT_ROOT, 'aave-core-anchor-features-2026-09-31.json'),
        expectedSourceSha256: sha,
        block: 26_060_000,
        out: join(OUTPUT_ROOT, 'aave-compound-peer-rate-2026-09-31.json'),
      }),
    /same frozen calendar date/,
  )
})

test('day-two sealed source uses its own block without changing day-one defaults', async () => {
  const block = BLOCK + 500
  const f = fixture(undefined, block)
  try {
    const client = mock({ block })
    const saved = await collect({ ...f, block, client, checkDisk: () => {}, now: () => 1_002_000 })
    assert.equal(saved.payload.block, block)
    assert.equal(saved.payload.blockHash, H)
    assert.equal(saved.payload.sourcePhysicalSha256, f.expectedSourceSha256)
    assert.ok(saved.payload.markets.every((r) => r.stratum === 'ge50bp'))
    saveSnapshot(f.out, saved, () => {})
    assert.equal(
      readSnapshot(f.out, { block, expectedSourceSha256: f.expectedSourceSha256 }).sha256,
      saved.sha256,
    )
    assert.throws(() => readSnapshot(f.out), /identity mismatch/)
    await assert.rejects(
      collect({
        ...f,
        block,
        client,
        expectedSourceSha256: SOURCE_SHA256,
        checkDisk: () => {},
        now: () => 1_002_000,
      }),
      /physical SHA/,
    )
    await assert.rejects(
      collect({ ...f, block: BLOCK, client, checkDisk: () => {}, now: () => 1_002_000 }),
      /anchor or market identity/,
    )
    assert.equal(plan().block, BLOCK)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('named calendar day starts 06:00–06:30 UTC and finishes by 07:00 UTC', async () => {
  const date = '2026-09-27'
  const at = (time) => Date.parse(`${date}T${time}Z`)
  assert.doesNotThrow(() => captureWindow(date, at('06:00:00.000'), at('07:00:00.000')))
  assert.doesNotThrow(() => captureWindow(date, at('06:30:00.000'), at('06:30:00.000')))
  assert.throws(() => captureWindow(date, at('05:59:59.999')), /start window/)
  assert.throws(() => captureWindow(date, at('06:30:00.001')), /start window/)
  assert.throws(() => captureWindow(date, at('06:30:00.000'), at('07:00:00.001')), /finish window/)
  const f = fixture()
  try {
    const client = mock()
    await assert.rejects(
      collect({
        ...f,
        client,
        captureDate: date,
        checkDisk: () => {},
        now: () => at('07:01:00.000'),
      }),
      /start window/,
    )
    assert.equal(client.calls.length, 0)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('exact rational spread and prespecified stratum boundaries', () => {
  const annual = 31_536_000n * 10n ** 9n
  assert.deepEqual(spreadBps(0n, 0n), { numerator: '0', denominator: '1', stratum: 'le0bp' })
  assert.equal(spreadBps(1_000_000_000n, annual * 10n ** 9n).stratum, 'le0bp')
  const at50 = spreadBps(1_000_000_000n, annual * 10n ** 9n - 5n * 10n ** 24n)
  assert.equal(at50.stratum, 'ge50bp')
  assert.equal(BigInt(at50.numerator), 50n * BigInt(at50.denominator))
  assert.equal(spreadBps(1_000_000_000n, annual * 10n ** 9n - 1n).stratum, 'gt0lt50bp')
  assert.throws(() => spreadBps(-1n, 0n), /Invalid raw/)
})

test('same-hash calls, implementation identity and complete positive rows', async () => {
  const f = fixture()
  try {
    const client = mock()
    const saved = await collect({
      ...f,
      client,
      checkDisk: () => {},
      now: (() => {
        let value = 1_002_000
        return () => value++
      })(),
    })
    assert.equal(saved.sha256, seal(saved.payload))
    assert.equal(saved.payload.sourcePhysicalSha256, f.expectedSourceSha256)
    assert.equal(saved.payload.markets.length, 2)
    assert.equal(saved.payload.markets[0].implementation.address, A)
    assert.equal(saved.payload.markets[0].compoundSupplyRatePerSecondRaw, '1000000000')
    assert.equal(saved.payload.markets[0].stratum, 'ge50bp')
    assert.ok(client.calls.includes('eth_getStorageAt'))
    assert.ok(client.calls.includes('eth_call'))
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('wrong source, chain, block, or base fail closed', async () => {
  const f = fixture()
  try {
    const options = { ...f, checkDisk: () => {}, now: () => 1_002_000 }
    const noRpc = mock()
    await assert.rejects(
      collect({ ...options, client: noRpc, expectedSourceSha256: SOURCE_SHA256 }),
      /physical SHA/,
    )
    assert.equal(noRpc.calls.length, 0)
    await assert.rejects(collect({ ...options, client: mock({ chain: 10 }) }), /Ethereum mainnet/)
    await assert.rejects(collect({ ...options, client: mock({ blockHash: A }) }), /block mismatch/)
    await assert.rejects(
      collect({ ...options, client: mock({ wrongBase: true }) }),
      /base mismatch/,
    )
    writeFileSync(f.sourcePath, `${readFileSync(f.sourcePath, 'utf8')} `)
    await assert.rejects(collect({ ...options, client: mock() }), /physical SHA/)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('paused and failed reads stay in ledger without alert stratum', async () => {
  const f = fixture()
  try {
    const options = { ...f, checkDisk: () => {}, now: () => 1_002_000 }
    const paused = await collect({ ...options, client: mock({ paused: true }) })
    assert.ok(paused.payload.markets.every((r) => r.stratum === 'paused' && r.withdrawPaused))
    const failed = await collect({
      ...options,
      client: mock({ rateFailure: true, missingImplementation: true }),
    })
    assert.ok(
      failed.payload.markets.every(
        (r) =>
          r.stratum === 'missing' &&
          r.failures.includes('supply-rate-read') &&
          r.implementation.address === null,
      ),
    )
    assert.ok(!JSON.stringify(failed).includes('SECRET'))
    const unresolved = await collect({
      ...options,
      client: mock({ missingImplementation: true }),
    })
    assert.ok(
      unresolved.payload.markets.every(
        (r) => r.stratum === 'implementation-unresolved' && r.implementation.address === null,
      ),
    )
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('one-market code, implementation, and base read failures retain other market', async () => {
  const f = fixture()
  try {
    const options = { ...f, checkDisk: () => {}, now: () => 1_002_000 }
    for (const [failure, reason] of [
      [{ proxyFailureMarket: 0 }, 'proxy-code-read'],
      [{ implementationFailureMarket: 0 }, 'implementation-read'],
      [{ baseFailureMarket: 0 }, 'baseToken-read'],
    ]) {
      const saved = await collect({ ...options, client: mock(failure) })
      assert.equal(saved.payload.markets.length, 2)
      assert.equal(saved.payload.markets[0].stratum, 'missing')
      assert.deepEqual(saved.payload.markets[0].failures, [reason])
      assert.equal(saved.payload.markets[1].stratum, 'ge50bp')
    }
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('disk-guard failure inside a rate read is globally fatal', async () => {
  const f = fixture()
  try {
    let checks = 0
    await assert.rejects(
      collect({
        ...f,
        client: mock(),
        now: () => 1_002_000,
        checkDisk: () => {
          if (++checks === 8) throw new Error('Disk reserve below 1 GiB')
        },
      }),
      /Disk guard/,
    )
    assert.equal(checks, 8)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('Aave inactive, paused, or frozen prevents a positive-spread opportunity label', async () => {
  for (const aaveFlags of [
    { active: false, paused: false, frozen: false },
    { active: true, paused: true, frozen: false },
    { active: true, paused: false, frozen: true },
  ]) {
    const f = fixture(aaveFlags)
    try {
      const saved = await collect({
        ...f,
        client: mock(),
        checkDisk: () => {},
        now: () => 1_002_000,
      })
      assert.ok(
        saved.payload.markets.every(
          (r) =>
            r.stratum === 'aave-ineligible' &&
            Number(r.spreadBps?.numerator) > 0 &&
            r.aaveFlags.active === aaveFlags.active &&
            r.aaveFlags.paused === aaveFlags.paused &&
            r.aaveFlags.frozen === aaveFlags.frozen,
        ),
      )
    } finally {
      rmSync(f.dir, { recursive: true })
    }
  }
})

test('disk, oversized duration and existing output refuse writes', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      collect({
        ...f,
        client: mock(),
        checkDisk: () => {
          throw new Error('Disk reserve below 1 GiB')
        },
        now: () => 1_002_000,
      }),
      /Disk guard/,
    )
    let clock = 1_002_000
    await assert.rejects(
      collect({ ...f, client: mock(), checkDisk: () => {}, now: () => (clock += 11 * 60 * 1000) }),
      /clock bounds/,
    )
    writeFileSync(f.out, 'existing')
    await assert.rejects(
      run({ ...f, client: mock(), checkDisk: () => {}, now: () => 1_002_000 }),
      /overwrite/,
    )
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('atomic save and SHA reread detect tampering', () => {
  const f = fixture()
  try {
    const payload = {
      study: 'aave-compound-peer-rate-v1',
      chainId: 1,
      block: BLOCK,
      blockHash: H,
      sourcePhysicalSha256: SOURCE_SHA256,
      markets: COMETS.map((c) => ({ market: c.name, comet: c.address, base: c.base })),
    }
    saveSnapshot(f.out, { payload, sha256: seal(payload) }, () => {})
    assert.equal(readSnapshot(f.out).sha256, seal(payload))
    assert.throws(
      () => saveSnapshot(f.out, { payload, sha256: seal(payload) }, () => {}),
      /overwrite/,
    )
    writeFileSync(f.out, `${readFileSync(f.out, 'utf8')} `)
    assert.equal(readSnapshot(f.out).sha256, seal(payload))
    writeFileSync(
      f.out,
      JSON.stringify({ payload: { ...payload, block: BLOCK + 1 }, sha256: seal(payload) }),
    )
    assert.throws(() => readSnapshot(f.out), /SHA mismatch/)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})
