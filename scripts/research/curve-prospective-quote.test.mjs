import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  collect,
  readValidatedCheckpoints,
  routesFromParts,
  safeCliError,
  selectRpc,
  sourceIdentity,
  STUDY,
  STUDY_V2,
  verify,
} from './curve-prospective-quote.mjs'

const ABI = parseAbi([
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)',
  'function fee() view returns (uint256)',
  'function A() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function get_dy(int128,int128,uint256) view returns (uint256)',
])
const identity = sourceIdentity()
const HASH = `0x${'a'.repeat(64)}`
const DRIFT = `0x${'b'.repeat(64)}`
const at = {
  number: '0x18da4e0',
  hash: HASH,
  timestamp: `0x${Math.floor(Date.now() / 1000 - 600).toString(16)}`,
}
const disk = () => ({ bavail: 1_000_000, bsize: 4096 })
const temp = () => mkdtempSync(join(tmpdir(), 'curve-prospective-'))
function rpc({
  wrongCoin = false,
  drift = false,
  missingQuote = false,
  noHashPin = false,
  zeroQuotes = false,
  emptyCode = false,
  missingPoolState = false,
  finalizedHash = HASH,
} = {}) {
  let quoteCalls = 0
  const methods = []
  const client = {
    async request({ method, params }) {
      methods.push(method)
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return params[0] === 'finalized'
          ? { ...at, hash: finalizedHash }
          : { ...at, hash: drift ? DRIFT : finalizedHash }
      if (method === 'eth_getCode') {
        if (noHashPin && typeof params[1] === 'object') throw new Error('blockHash unsupported')
        return emptyCode ? '0x' : '0x6001600055'
      }
      assert.equal(method, 'eth_call')
      const [{ to, data }, pin] = params
      if (noHashPin && typeof pin === 'object') throw new Error('blockHash unsupported')
      const { functionName, args } = decodeFunctionData({ abi: ABI, data })
      const address = to.toLowerCase()
      let result
      if (functionName === 'asset') result = identity.crvUsd
      else if (functionName === 'totalAssets') result = 20_000_000n * 10n ** 18n
      else if (functionName === 'balances') {
        if (missingPoolState) return '0x'
        result = args[0] === 0n ? 25_000_000n * 10n ** 6n : 25_000_000n * 10n ** 18n
      } else if (functionName === 'fee') result = 4_000_000n
      else if (functionName === 'A') result = 200n
      else if (functionName === 'coins') {
        const i = identity.pools.findIndex((p) => p.address === address)
        result =
          args[0] === 0n
            ? wrongCoin && i === 0
              ? identity.crvUsd
              : identity.pools[i].coin0
            : identity.crvUsd
      } else if (functionName === 'decimals') result = address === identity.crvUsd ? 18 : 6
      else if (functionName === 'get_dy') {
        quoteCalls++
        if (missingQuote && quoteCalls === 7) return '0x'
        result = zeroQuotes ? 0n : args[2] / 10n ** 12n - 100n
      }
      return encodeFunctionResult({ abi: ABI, functionName, result })
    },
  }
  return { client, methods }
}

test('collects a sealed fixed-route grid at one finalized hash', async () => {
  const out = temp(),
    { client, methods } = rpc()
  const result = await collect({ client, out, stat: disk })
  assert.equal(result.pinMode, 'hash')
  assert.deepEqual(verify({ out }), { count: 1, latestBlock: parseInt(at.number, 16) })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(readValidatedCheckpoints({ out })[0].checkpoint.sha256, saved.sha256)
  assert.equal(saved.raw.parts[0].length, 8)
  assert.equal(saved.raw.parts[1].length, 8)
  assert.equal(saved.study, STUDY_V2)
  assert.deepEqual(saved.raw.poolStates[0].balancesRaw, [
    String(25_000_000n * 10n ** 6n),
    String(25_000_000n * 10n ** 18n),
  ])
  assert.equal(saved.raw.poolStates[1].feeRaw, '4000000')
  assert.equal(saved.raw.poolStates[1].ARaw, '200')
  assert.equal(saved.raw.codeIdentities.length, 6)
  assert.equal(saved.raw.gridLegs.length, 5)
  assert.equal(saved.raw.gridLegs[2].usdt.crvUsdInputRaw, String(500_000n * 10n ** 18n))
  assert.equal(saved.raw.gridLegs[2].usdc.outputRaw, saved.raw.parts[1][5])
  assert.match(saved.quoteCaveat, /not a scrvUSD holder withdrawal/)
  assert.deepEqual(
    saved.routes['1000000'].grid.map((row) => row.usdtShare),
    [0, 0.25, 0.5, 0.75, 1],
  )
  assert.equal(saved.routes['1000000'].bestQuote, 0.9999999999)
  assert.equal(methods.filter((m) => m === 'eth_call').length, 35)
  assert.equal(methods.filter((m) => m === 'eth_getCode').length, 6)
  const bytes = readFileSync(result.path, 'utf8')
  const replay = await collect({ client, out, stat: disk })
  assert.equal(replay.status, 'unchanged')
  assert.equal(replay.path, result.path)
  assert.equal(replay.bestQuote, result.bestQuote)
  assert.equal(readFileSync(result.path, 'utf8'), bytes)
  assert.equal(methods.filter((m) => m === 'eth_call').length, 35)
  assert.equal(methods.filter((m) => m === 'eth_getCode').length, 6)
  assert.equal(readdirSync(out).length, 1)
})

test('rejects conflicting same-height finalized hash without writing', async () => {
  const out = temp()
  await collect({ client: rpc().client, out, stat: disk })
  await assert.rejects(
    collect({ client: rpc({ finalizedHash: DRIFT }).client, out, stat: disk }),
    /not a new prospective/,
  )
  assert.equal(verify({ out }).count, 1)
})

test('rejects canonical drift on an otherwise exact saved replay', async () => {
  const out = temp()
  await collect({ client: rpc().client, out, stat: disk })
  const { client, methods } = rpc({ drift: true })
  await assert.rejects(collect({ client, out, stat: disk }), /hash drift/)
  assert.equal(methods.filter((m) => m === 'eth_call').length, 0)
  assert.equal(verify({ out }).count, 1)
})

test('serializes simultaneous same-hash collectors into one receipt and one unchanged replay', async () => {
  const out = temp()
  const first = rpc()
  const second = rpc()
  let enteredResolve,
    resumeResolve,
    held = false
  const entered = new Promise((resolve) => (enteredResolve = resolve))
  const resume = new Promise((resolve) => (resumeResolve = resolve))
  const heldClient = {
    async request(request) {
      if (!held && request.method === 'eth_call') {
        held = true
        enteredResolve()
        await resume
      }
      return first.client.request(request)
    },
  }
  const firstRun = collect({ client: heldClient, out, stat: disk })
  await entered
  const secondRun = collect({ client: second.client, out, stat: disk })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(second.methods, [])
  } finally {
    resumeResolve()
  }
  const results = await Promise.all([firstRun, secondRun])
  assert.deepEqual(
    results.map((result) => result.status),
    ['recorded', 'unchanged'],
  )
  assert.equal(second.methods.filter((method) => method === 'eth_call').length, 0)
  assert.equal(verify({ out }).count, 1)
  assert.equal(readdirSync(out).length, 1)
})

test('serializes simultaneous divergent same-height hashes and rejects the second', async () => {
  const out = temp()
  const first = rpc()
  const second = rpc({ finalizedHash: DRIFT })
  let enteredResolve,
    resumeResolve,
    held = false
  const entered = new Promise((resolve) => (enteredResolve = resolve))
  const resume = new Promise((resolve) => (resumeResolve = resolve))
  const heldClient = {
    async request(request) {
      if (!held && request.method === 'eth_call') {
        held = true
        enteredResolve()
        await resume
      }
      return first.client.request(request)
    },
  }
  const firstRun = collect({ client: heldClient, out, stat: disk })
  await entered
  const secondRun = collect({ client: second.client, out, stat: disk })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(second.methods, [])
  } finally {
    resumeResolve()
  }
  assert.equal((await firstRun).status, 'recorded')
  await assert.rejects(secondRun, /not a new prospective/)
  assert.equal(verify({ out }).count, 1)
})

test('leaves a crash-stale lock in place and fails closed before RPC', async () => {
  const out = temp()
  const path = join(out, '.collection.lock')
  mkdirSync(path)
  const { client, methods } = rpc()
  await assert.rejects(collect({ client, out, stat: disk, lockTimeoutMs: 0 }), /lock busy or stale/)
  assert.deepEqual(methods, [])
  assert.deepEqual(readdirSync(out), ['.collection.lock'])
})

test('rejects wrong onchain coin orientation before sealing', async () => {
  const out = temp()
  await assert.rejects(
    collect({ client: rpc({ wrongCoin: true }).client, out, stat: disk }),
    /orientation/,
  )
  assert.deepEqual(readdirSync(out), [])
})

test('rejects canonical hash drift before sealing', async () => {
  const out = temp()
  await assert.rejects(
    collect({ client: rpc({ drift: true }).client, out, stat: disk }),
    /hash drift/,
  )
  assert.deepEqual(readdirSync(out), [])
})

test('rejects incomplete quote before sealing', async () => {
  const out = temp()
  await assert.rejects(
    collect({ client: rpc({ missingQuote: true }).client, out, stat: disk }),
    /Incomplete pinned call/,
  )
  assert.deepEqual(readdirSync(out), [])
})

test('rejects missing same-block pool state or deployed-code identity before sealing', async () => {
  for (const option of [{ missingPoolState: true }, { emptyCode: true }]) {
    const out = temp()
    await assert.rejects(
      collect({ client: rpc(option).client, out, stat: disk }),
      /Incomplete pinned call|code identity/,
    )
    assert.deepEqual(readdirSync(out), [])
  }
})

test('offline reader keeps original sealed v1 checkpoints readable', async () => {
  const out = temp()
  const result = await collect({ client: rpc().client, out, stat: disk })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  saved.study = STUDY
  delete saved.quoteCaveat
  delete saved.raw.poolStates
  delete saved.raw.codeIdentities
  delete saved.raw.gridLegs
  delete saved.sha256
  saved.sha256 = createHash('sha256').update(JSON.stringify(saved)).digest('hex')
  writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
  assert.deepEqual(verify({ out }), { count: 1, latestBlock: parseInt(at.number, 16) })
  assert.equal(readValidatedCheckpoints({ out })[0].checkpoint.study, STUDY)
})

test('v2 reader rejects resealed pool-state, code-identity, and quote-leg shape drift', async () => {
  for (const change of [
    (saved) => {
      saved.raw.poolStates[0].balancesRaw = ['0']
    },
    (saved) => {
      saved.raw.codeIdentities[0].codeSha256 = 'not-a-sha'
    },
    (saved) => {
      saved.raw.gridLegs[0].usdc.outputRaw = '1'
    },
  ]) {
    const out = temp()
    const result = await collect({ client: rpc().client, out, stat: disk })
    const saved = JSON.parse(readFileSync(result.path, 'utf8'))
    change(saved)
    delete saved.sha256
    saved.sha256 = createHash('sha256').update(JSON.stringify(saved)).digest('hex')
    writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
    assert.throws(() => verify({ out }), /v2 pool state, code identity, or quote legs/)
  }
})

test('checks disk reserve before any RPC request', async () => {
  const out = temp(),
    { client, methods } = rpc()
  await assert.rejects(
    collect({ client, out, stat: () => ({ bavail: 1, bsize: 1 }) }),
    /disk reserve/,
  )
  assert.deepEqual(methods, [])
})

test('verifies a provider without EIP-1898 using number and canonical hash', async () => {
  const out = temp()
  const result = await collect({ client: rpc({ noHashPin: true }).client, out, stat: disk })
  assert.equal(result.pinMode, 'number-hash-checked')
  assert.match(result.pinCaveat, /EIP-1898 unsupported/)
  assert.equal(verify({ out }).count, 1)
})

test('selects first configured RPC host and rejects explicit host lists', () => {
  assert.equal(
    selectRpc(undefined, 'https://first.example/key,https://second.example/key'),
    'https://first.example/key',
  )
  assert.equal(
    selectRpc(
      'https://explicit.example/key',
      'https://first.example/key,https://second.example/key',
    ),
    'https://explicit.example/key',
  )
  assert.throws(
    () => selectRpc('https://first.example,https://second.example', ''),
    /Exactly one RPC host/,
  )
  assert.throws(
    () => selectRpc(undefined, ',https://second.example'),
    /Configured RPC host missing/,
  )
})

test('preserves all-zero and mixed-zero quote outcomes', () => {
  const zeros = routesFromParts([Array(8).fill('0'), Array(8).fill('0')])['1000000']
  assert.equal(zeros.bestOutputRaw, '0')
  assert.equal(zeros.bestQuote, 0)
  assert.deepEqual(
    zeros.grid.map((row) => row.outputRaw),
    Array(5).fill('0'),
  )

  const mixed = routesFromParts([Array(8).fill('0'), Array(8).fill('1000000')])['1000000']
  assert.equal(mixed.grid[4].outputRaw, '0')
  assert.equal(mixed.grid[0].outputRaw, '1000000')
  assert.equal(mixed.bestOutputRaw, '1000000')
})

test('collects and verifies an all-zero measured quote', async () => {
  const out = temp()
  const result = await collect({ client: rpc({ zeroQuotes: true }).client, out, stat: disk })
  assert.equal(result.bestQuote, 0)
  assert.equal(verify({ out }).count, 1)
})

test('CLI reports local disk, RPC, and verification reasons without provider text', async () => {
  const classify = (error) => JSON.parse(safeCliError(error)).reason
  const diskOut = temp()
  const { client, methods } = rpc()
  await assert.rejects(
    collect({ client, out: diskOut, stat: () => ({ bavail: 1, bsize: 1 }) }),
    (error) => classify(error) === 'disk_reserve',
  )
  assert.deepEqual(methods, [])

  const rpcOut = temp()
  const secret = 'https://rpc.example/private-token?key=secret'
  await assert.rejects(
    collect({
      client: {
        request: async () => {
          throw new Error(secret)
        },
      },
      out: rpcOut,
      stat: disk,
    }),
    (error) => {
      assert.equal(classify(error), 'rpc_failure')
      assert.doesNotMatch(safeCliError(error), /secret|private-token|rpc\.example/)
      return true
    },
  )

  const invalidOut = temp()
  writeFileSync(join(invalidOut, 'broken.json'), '{}')
  await assert.rejects(
    collect({ client, out: invalidOut, stat: disk }),
    (error) => classify(error) === 'verification_failed',
  )
  assert.deepEqual(methods, [])
  assert.equal(classify(new Error(secret)), 'collection_failed')
})

test('seal verification detects physical corruption and duplicate block identity', async () => {
  const out = temp()
  const result = await collect({ client: rpc().client, out, stat: disk })
  const bytes = readFileSync(result.path, 'utf8')
  const saved = JSON.parse(bytes)
  saved.raw.parts[0][0] = '1'
  writeFileSync(result.path, JSON.stringify(saved))
  assert.throws(() => verify({ out }), /SHA mismatch/)
  writeFileSync(result.path, bytes)
  writeFileSync(join(out, 'duplicate.json'), bytes)
  assert.throws(() => verify({ out }), /Duplicate block|filename mismatch/)
})

test('rejects configuration address and orientation drift', () => {
  const venues = [
    {
      name: 'scrvUSD',
      enabled: true,
      address: identity.vault,
      underlying: identity.crvUsd,
      decimals: 18,
      depthMarkets: identity.pools.map((p) => ({
        enabled: true,
        kind: 'curve-stableswap',
        address: p.address,
        token0: p.coin0,
        token1: p.coin1,
        exitFrom: p.coin1,
      })),
    },
  ]
  venues[0].depthMarkets[0].token0 = identity.crvUsd
  assert.throws(() => sourceIdentity(venues), /orientation/)
})
