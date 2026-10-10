import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeFunctionResult, toEventSelector } from 'viem'
import { POOL } from './aave-stable-expansion.mjs'
import {
  MARKET,
  A,
  B,
  Q,
  decodeTransfer,
  digest,
  loadCheckpoint,
  run,
  selectHolder,
  validateCheckpoint,
} from './aave-lusd-asof-holder.mjs'

const HASH = (n) => `0x${n.toString(16).padStart(64, '0')}`
const EOA1 = `0x${'1'.repeat(40)}`
const EOA2 = `0x${'2'.repeat(40)}`
const EOA3 = `0x${'3'.repeat(40)}`
const word = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`
const BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]
const RESERVE_ABI = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
          ...[
            'liquidityIndex',
            'currentLiquidityRate',
            'variableBorrowIndex',
            'currentVariableBorrowRate',
            'currentStableBorrowRate',
          ].map((name) => ({ name, type: 'uint128' })),
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          ...[
            'stableDebtTokenAddress',
            'variableDebtTokenAddress',
            'interestRateStrategyAddress',
          ].map((name) => ({ name, type: 'address' })),
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
]
const reserveData = encodeFunctionResult({
  abi: RESERVE_ABI,
  functionName: 'getReserveData',
  result: {
    configuration: { data: 18n << 48n },
    liquidityIndex: 0n,
    currentLiquidityRate: 0n,
    variableBorrowIndex: 0n,
    currentVariableBorrowRate: 0n,
    currentStableBorrowRate: 0n,
    lastUpdateTimestamp: 0,
    id: 0,
    aTokenAddress: MARKET.aToken,
    stableDebtTokenAddress: EOA3,
    variableDebtTokenAddress: EOA3,
    interestRateStrategyAddress: EOA3,
    accruedToTreasury: 0n,
    unbacked: 0n,
    isolationModeTotalDebt: 0n,
  },
})
const withTemp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'aave-lusd-asof-'))
  try {
    await fn(join(dir, 'holder.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const log = (block, index, from, to) => ({
  address: MARKET.aToken,
  topics: [toEventSelector('Transfer(address,address,uint256)'), word(from), word(to)],
  data: HASH(1),
  removed: false,
  blockNumber: BigInt(block),
  blockHash: HASH(block),
  transactionHash: HASH(block * 10 + index),
  logIndex: BigInt(index),
})
function mock({
  deployment = A - 1,
  logs = [log(A - 1, 0, EOA1, EOA2)],
  balances = { [EOA1]: Q, [EOA2]: Q + 1n },
  failCode = false,
  wrongHeaderBlock = null,
} = {}) {
  const calls = []
  let logsRequested = false
  const client = {
    getBlock: async ({ blockNumber }) => {
      calls.push({ method: 'getBlock', block: Number(blockNumber) })
      return {
        number: blockNumber,
        hash: HASH(
          logsRequested && Number(blockNumber) === wrongHeaderBlock
            ? Number(blockNumber) + 1
            : Number(blockNumber),
        ),
      }
    },
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getLogs') {
        logsRequested = true
        return logs.filter(
          (item) =>
            Number(item.blockNumber) >= Number(BigInt(params[0].fromBlock)) &&
            Number(item.blockNumber) <= Number(BigInt(params[0].toBlock)),
        )
      }
      if (method === 'eth_getCode') {
        if (params[0].toLowerCase() === MARKET.aToken.toLowerCase())
          return Number(BigInt(params[1].blockHash)) >= deployment ? '0x6000' : '0x'
        if (failCode) throw new Error('https://secret.example/rpc?key=topsecret')
        return '0x'
      }
      if (method === 'eth_call') {
        if (params[0].to.toLowerCase() === POOL.toLowerCase()) return reserveData
        const address = `0x${params[0].data.slice(-40)}`.toLowerCase()
        return encodeFunctionResult({
          abi: BALANCE_ABI,
          functionName: 'balanceOf',
          result: balances[address] ?? 0n,
        })
      }
      throw new Error(`Unexpected ${method}`)
    },
  }
  return { client, calls }
}

test('RLUSD CLI uses its own preregistered identity', () => {
  const script = fileURLToPath(new URL('./aave-lusd-asof-holder.mjs', import.meta.url))
  const plan = spawnSync(process.execPath, [script, '--plan', '--market', 'RLUSD'], {
    encoding: 'utf8',
  })
  assert.equal(plan.status, 0, plan.stderr)
  const parsed = JSON.parse(plan.stdout)
  assert.equal(parsed.study, 'aave-rlusd-asof-holder-preoutcome-v1')
  assert.equal(parsed.asofBlock, 25_638_206)
  assert.equal(parsed.onsetBlock, 25_640_006)
  assert.equal(parsed.qRaw, (1_000_000n * 10n ** 18n).toString())
  assert.equal(parsed.aToken, '0xfa82580c16a31d0c1bc632a36f82e83efef3eec0')
})

test('USDC fallback CLI uses 6-decimal fixed million and distinct anchor', () => {
  const script = fileURLToPath(new URL('./aave-lusd-asof-holder.mjs', import.meta.url))
  const plan = spawnSync(process.execPath, [script, '--plan', '--market', 'USDC'], {
    encoding: 'utf8',
  })
  assert.equal(plan.status, 0, plan.stderr)
  const parsed = JSON.parse(plan.stdout)
  assert.equal(parsed.study, 'aave-usdc-asof-holder-preoutcome-v1')
  assert.equal(parsed.asofBlock, 24_911_006)
  assert.equal(parsed.onsetBlock, 24_912_806)
  assert.equal(parsed.qRaw, '1000000000000')
  assert.equal(parsed.aToken, '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c')
})

test('frozen LUSD identity, Transfer topic and deterministic holder tie-break', () => {
  assert.equal(A, B - 1800)
  assert.equal(MARKET.name, 'LUSD')
  assert.equal(MARKET.decimals, 18)
  const decoded = decodeTransfer(log(A, 0, EOA1, EOA2), A, A)
  assert.equal(decoded.from, EOA1)
  assert.equal(decoded.to, EOA2)
  assert.equal(
    selectHolder([
      { address: EOA2, status: 'ok', balanceRaw: Q.toString(), eoa: true },
      { address: EOA1, status: 'ok', balanceRaw: Q.toString(), eoa: true },
      { address: EOA3, status: 'ok', balanceRaw: (Q + 1n).toString(), eoa: false },
    ]).address,
    EOA1,
  )
})

test('bounded code search verifies boundary, scans all logs, pins A reads and freezes', async () => {
  await withTemp(async (out) => {
    const { client, calls } = mock()
    const first = await run({ out, client, maxCodeSteps: 2, checkDisk: () => {} })
    assert.equal(first.status, 'logs-pending')
    assert.equal(loadCheckpoint(out).deploymentBlock, null)
    const second = await run({
      out,
      client,
      maxCodeSteps: 50,
      maxNewChunks: 1,
      maxCandidates: 1,
      checkDisk: () => {},
    })
    assert.equal(second.status, 'reads-pending')
    assert.equal(second.logCount, 1)
    const final = await run({ out, client, maxCandidates: 2, checkDisk: () => {} })
    assert.equal(final.status, 'holder')
    assert.equal(final.holder.address, EOA2)
    const saved = loadCheckpoint(out)
    assert.equal(saved.status, 'frozen')
    assert.equal(saved.deploymentBlock, A - 1)
    assert.equal(saved.search.absentBelow, A - 2)
    assert.equal(saved.nextBlock, A + 1)
    assert.equal(saved.chunks[0].from, A - 1)
    assert.equal(saved.chunks[0].to, A)
    assert.ok(
      calls
        .filter(
          (item) =>
            item.method === 'eth_call' &&
            item.params[0].to.toLowerCase() === MARKET.aToken.toLowerCase(),
        )
        .every((item) => item.params[1].blockHash === HASH(A) && item.params[1].requireCanonical),
    )
    assert.ok(!calls.some((item) => item.block >= B))
    assert.ok(
      !calls.some(
        (item) => item.method === 'eth_call' && item.params[0].data.startsWith('0x69328dec'),
      ),
    )
  })
})

test('provider failure is sanitized and retryable before a successful freeze', async () => {
  await withTemp(async (out) => {
    const { client } = mock({ failCode: true })
    const result = await run({
      out,
      client,
      maxCodeSteps: 50,
      maxNewChunks: 1,
      maxCandidates: 2,
      checkDisk: () => {},
    })
    assert.equal(result.status, 'read-failure')
    assert.equal(result.holder, null)
    assert.equal(result.readFailures, 2)
    assert.doesNotMatch(readFileSync(out, 'utf8'), /secret\.example|topsecret/)
    assert.equal(loadCheckpoint(out).status, 'partial')
    const recovered = await run({
      out,
      client: mock().client,
      maxCandidates: 2,
      checkDisk: () => {},
    })
    assert.equal(recovered.status, 'holder')
    assert.equal(recovered.holder.address, EOA2)
    assert.equal(loadCheckpoint(out).status, 'frozen')
  })
})

test('rejects an interior Transfer with a noncanonical block hash', async () => {
  await withTemp(async (out) => {
    const { client } = mock({
      deployment: A - 4,
      logs: [log(A - 2, 0, EOA1, EOA2)],
      wrongHeaderBlock: A - 2,
    })
    await assert.rejects(
      run({ out, client, maxCodeSteps: 50, maxNewChunks: 1, checkDisk: () => {} }),
      /Transfer log canonical block hash mismatch/,
    )
    const saved = loadCheckpoint(out)
    assert.equal(saved.chunks.length, 0)
    assert.equal(saved.nextBlock, A - 4)
  })
})

test('offline validation rejects changed checksum, gaps, oversized chunk and missing reads', async () => {
  await withTemp(async (out) => {
    const { client } = mock()
    await run({
      out,
      client,
      maxCodeSteps: 50,
      maxNewChunks: 1,
      maxCandidates: 2,
      checkDisk: () => {},
    })
    const sealed = JSON.parse(readFileSync(out, 'utf8'))
    sealed.payload.chunks[0].to = A - 1
    sealed.sha256 = digest(sealed.payload)
    assert.throws(() => validateCheckpoint(sealed), /Invalid stored Transfer/)
    sealed.payload.chunks[0].to = A
    sealed.payload.reads.pop()
    sealed.sha256 = digest(sealed.payload)
    assert.throws(() => validateCheckpoint(sealed), /Frozen selection incomplete/)
    writeFileSync(out, JSON.stringify({ ...sealed, sha256: 'bad' }))
    assert.throws(() => loadCheckpoint(out), /SHA mismatch/)
  })
})

test('resource guards halt before a scan or read', async () => {
  await withTemp(async (out) => {
    const { client, calls } = mock()
    await assert.rejects(run({ out, client, maxCodeSteps: 501 }), /0\.\.500/)
    assert.equal(calls.length, 0)
    await assert.rejects(
      run({
        out,
        client,
        maxCodeSteps: 1,
        checkDisk: () => {
          throw new Error('Disk reserve below 2.5 GiB')
        },
      }),
      /Disk reserve/,
    )
    assert.equal(calls.filter((item) => item.method === 'eth_getLogs').length, 0)
  })
})

test('default disk guard supports an output path with missing parent directories', async () => {
  await withTemp(async (out) => {
    const nested = join(dirname(out), 'new', 'nested', 'holder.json')
    const { client } = mock()
    const result = await run({ out: nested, client, maxCodeSteps: 1 })
    assert.equal(result.status, 'logs-pending')
    assert.equal(loadCheckpoint(nested).search.probes.length, 1)
  })
})
