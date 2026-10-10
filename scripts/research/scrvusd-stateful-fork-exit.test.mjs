import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi } from 'viem'
import {
  diskGuard,
  execute,
  loadSources,
  makePlan,
  RESERVE_BYTES,
  savePlan,
  STUDY,
  validatePlan,
} from './scrvusd-stateful-fork-exit.mjs'
import { sourceIdentity } from './curve-prospective-quote.mjs'

const hash = `0x${'a'.repeat(64)}`
const block = { number: 26_000_000, hash, timestamp: 1_800_000_000 }
const holder = `0x${'1'.repeat(40)}`
const targetAddress = `0x${'2'.repeat(40)}`
const vaultCode = `0x363d3d373d3d3d363d73${targetAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`
const sha = (v) => createHash('sha256').update(v).digest('hex')
const abi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function withdraw(uint256,address,address) returns (uint256)',
  'function coins(uint256) view returns (address)',
  'function get_dy(int128,int128,uint256) view returns (uint256)',
  'function exchange(int128,int128,uint256,uint256,address) returns (uint256)',
])
const config = sourceIdentity()
const codes = [vaultCode, '0x6000', '0x6001', '0x6002', '0x6003', '0x6004']
const addresses = [
  config.vault,
  config.crvUsd,
  config.pools[0].coin0,
  config.pools[1].coin0,
  ...config.pools.map((p) => p.address),
]
const row = {
  checkpoint: {
    source: config,
    block,
    raw: {
      codeIdentities: addresses.map((address, i) => ({
        address,
        codeSha256: sha(Buffer.from(codes[i].slice(2), 'hex')),
      })),
    },
  },
}
const target = {
  vaultRuntime: vaultCode,
  target: targetAddress,
  targetCode: '0x6005',
  targetCodeHash: keccak256('0x6005'),
}
const plan = () =>
  makePlan({
    holder,
    rawCrvUsd: '1000000000000000000',
    sharesBps: [0, 10000],
    minOutputBps: 9900,
    createdUtc: new Date((block.timestamp - 60) * 1000).toISOString(),
  })
const fakeStat = (bytes) => () => ({ bavail: bytes, bsize: 1 })
function fakeAdapter({
  badHash = false,
  revertWithdraw = false,
  stableCreditedDuringWithdraw = false,
  badReceiptTo = false,
  badReceiptBlockHash = false,
} = {}) {
  const calls = []
  let stopCount = 0
  let state
  let snapshot = null
  let nonce = 0
  let lastTx = null
  const localHash = `0x${'c'.repeat(64)}`
  const initial = () => ({
    shares: 2n * 10n ** 18n,
    crv: 0n,
    usdt: 0n,
    usdc: 0n,
    allowance: new Map(),
    head: block.number,
    eth: 0n,
  })
  state = initial()
  const copy = (s) => ({ ...s, allowance: new Map(s.allowance) })
  const adapter = {
    async start({ blockNumber }) {
      assert.equal(blockNumber, block.number)
      return {
        async request(method, params = []) {
          calls.push(method)
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_blockNumber') return `0x${state.head.toString(16)}`
          if (method === 'eth_getBlockByNumber')
            return {
              number: params[0],
              hash:
                BigInt(params[0]) === BigInt(block.number)
                  ? badHash
                    ? `0x${'b'.repeat(64)}`
                    : block.hash
                  : localHash,
              timestamp: `0x${block.timestamp.toString(16)}`,
            }
          if (method === 'eth_getCode') {
            if (params[0] === holder) return '0x'
            if (params[0] === targetAddress) return target.targetCode
            return codes[addresses.indexOf(params[0])]
          }
          if (method === 'evm_snapshot') {
            snapshot = copy(state)
            return `0x${++nonce}`
          }
          if (method === 'evm_revert') {
            state = copy(snapshot)
            return true
          }
          if (method === 'eth_getBalance') return `0x${state.eth.toString(16)}`
          if (method === 'anvil_setBalance') {
            state.eth = BigInt(params[1])
            return true
          }
          if (method.startsWith('anvil_')) return true
          if (method === 'eth_call') {
            const { functionName, args } = decodeFunctionData({ abi, data: params[0].data })
            let result
            if (functionName === 'asset') result = config.crvUsd
            if (functionName === 'coins')
              result = config.pools.find((p) => p.address === params[0].to)[
                Number(args[0]) ? 'coin1' : 'coin0'
              ]
            if (functionName === 'balanceOf')
              result =
                params[0].to === config.vault
                  ? state.shares
                  : params[0].to === config.crvUsd
                    ? state.crv
                    : params[0].to === config.pools[0].coin0
                      ? state.usdt
                      : state.usdc
            if (functionName === 'allowance')
              result = state.allowance.get(args[1].toLowerCase()) ?? 0n
            if (functionName === 'get_dy') result = args[2] / 10n ** 12n
            return encodeFunctionResult({ abi, functionName, result })
          }
          if (method === 'eth_sendTransaction') {
            const tx = params[0]
            lastTx = tx
            const { functionName, args } = decodeFunctionData({ abi, data: tx.data })
            if (functionName === 'withdraw' && !revertWithdraw) {
              state.shares -= 1n * 10n ** 18n
              state.crv += 1n * 10n ** 18n
              if (stableCreditedDuringWithdraw) state.usdc += 100n
            }
            if (functionName === 'approve') state.allowance.set(args[0].toLowerCase(), args[1])
            if (functionName === 'exchange') {
              assert(state.allowance.get(tx.to) >= args[2])
              state.crv -= args[2]
              if (tx.to === config.pools[0].address) state.usdt += args[2] / 10n ** 12n
              else state.usdc += args[2] / 10n ** 12n
            }
            state.head++
            return `0x${String(++nonce).padStart(64, '0')}`
          }
          if (method === 'eth_getTransactionReceipt')
            return {
              transactionHash: params[0],
              status: revertWithdraw ? '0x0' : '0x1',
              gasUsed: '0x5208',
              blockNumber: `0x${state.head.toString(16)}`,
              blockHash: badReceiptBlockHash ? `0x${'d'.repeat(64)}` : localHash,
              from: lastTx.from,
              to: badReceiptTo ? config.crvUsd : lastTx.to,
            }
          throw new Error(`Unexpected ${method}`)
        },
        async stop() {
          stopCount++
        },
      }
    },
  }
  return {
    adapter,
    calls,
    get stopCount() {
      return stopCount
    },
  }
}

test('plan is sealed and predeclared split set is bounded', () => {
  const p = plan()
  assert.equal(validatePlan(p), p)
  assert.throws(() => validatePlan({ ...p, sharesBps: [0, 0] }), /Invalid/)
  assert.throws(
    () =>
      makePlan({
        holder,
        rawCrvUsd: '1',
        sharesBps: [10001],
        minOutputBps: 9900,
        createdUtc: p.createdUtc,
      }),
    /Invalid/,
  )
})

test('2.5 GiB guard fails before fork adapter invocation', async () => {
  assert.throws(() => diskGuard(tmpdir(), fakeStat(RESERVE_BYTES - 1)), /fork_disk_reserve/)
  let started = false
  await assert.rejects(
    () =>
      execute({
        sources: { row, target, plan: plan(), refs: {} },
        adapter: {
          start: () => {
            started = true
          },
        },
        stat: fakeStat(RESERVE_BYTES - 1),
        out: tmpdir(),
      }),
    /fork_disk_reserve/,
  )
  assert.equal(started, false)
})

test('each split resets B and executes withdrawal, approval and one pool swap sequentially', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-test-'))
  try {
    const fake = fakeAdapter()
    const result = await execute({
      sources: { row, target, plan: plan(), refs: {} },
      adapter: fake.adapter,
      stat: fakeStat(RESERVE_BYTES + 1_000_000),
      out,
    })
    assert.equal(result.status, 'all_routes_executed', JSON.stringify(result.routes))
    assert.deepEqual(
      result.routes.map((r) => r.output),
      [
        { usdtRaw: '0', usdcRaw: '1000000', usdTotal: null, valuation: 'not_pinned' },
        { usdtRaw: '1000000', usdcRaw: '0', usdTotal: null, valuation: 'not_pinned' },
      ],
    )
    assert.deepEqual(
      result.routes.map((r) => r.transactions.map((tx) => tx.stage)),
      [
        ['withdraw', 'approve_usdc_pool', 'swap_usdc'],
        ['withdraw', 'approve_usdt_pool', 'swap_usdt'],
      ],
    )
    assert.equal(fake.calls.filter((v) => v === 'evm_revert').length, 2)
    assert.equal(fake.stopCount, 1)
    assert.equal(result.routes[0].gasOverride.artificialWeiRaw, '1000000000000000000')
    assert.equal(
      readFileSync(
        join(
          out,
          `${String(block.number).padStart(12, '0')}-${hash.slice(2)}-${result.plan.sha256}.json`,
        ),
        'utf8',
      ).endsWith('\n'),
      true,
    )
  } finally {
    rmSync(out, { recursive: true })
  }
})

test('wrong fork B/hash is sealed unavailable without a swap', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-test-'))
  try {
    const fake = fakeAdapter({ badHash: true })
    const result = await execute({
      sources: { row, target, plan: plan(), refs: {} },
      adapter: fake.adapter,
      stat: fakeStat(RESERVE_BYTES + 1_000_000),
      out,
    })
    assert.equal(result.status, 'partial_or_unavailable')
    assert.equal(result.failureStage, 'fork_verification_or_snapshot')
    assert.equal(result.routes.length, 0)
    assert.equal(fake.calls.includes('eth_sendTransaction'), false)
  } finally {
    rmSync(out, { recursive: true })
  }
})

test('fork startup failure is sealed unavailable without pretending execution', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-test-'))
  try {
    const result = await execute({
      sources: { row, target, plan: plan(), refs: {} },
      adapter: {
        start: async () => {
          throw new Error('provider details must not be copied')
        },
      },
      stat: fakeStat(RESERVE_BYTES + 1_000_000),
      out,
    })
    assert.equal(result.status, 'partial_or_unavailable')
    assert.equal(result.failureStage, 'fork_start')
    assert.equal(result.routes.length, 0)
    assert.equal(JSON.stringify(result).includes('provider details'), false)
  } finally {
    rmSync(out, { recursive: true })
  }
})

test('failed withdrawal has no claimed output or later route', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-test-'))
  try {
    const fake = fakeAdapter({ revertWithdraw: true })
    const result = await execute({
      sources: { row, target, plan: plan(), refs: {} },
      adapter: fake.adapter,
      stat: fakeStat(RESERVE_BYTES + 1_000_000),
      out,
    })
    assert.equal(result.routes.length, 1)
    assert.equal(result.routes[0].failedStage, 'withdraw')
    assert.equal(result.routes[0].output, null)
    assert.equal(result.routes[0].failure.receipt.status, '0x0')
  } finally {
    rmSync(out, { recursive: true })
  }
})

test('stablecoin credited during withdrawal is not misattributed to Curve swaps', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-test-'))
  try {
    const fake = fakeAdapter({ stableCreditedDuringWithdraw: true })
    const result = await execute({
      sources: { row, target, plan: plan(), refs: {} },
      adapter: fake.adapter,
      stat: fakeStat(RESERVE_BYTES + 1_000_000),
      out,
    })
    assert.equal(result.status, 'partial_or_unavailable')
    assert.equal(result.routes.length, 1)
    assert.equal(result.routes[0].failedStage, 'withdraw')
    assert.equal(result.routes[0].output, null)
    assert.equal(result.routes[0].afterWithdraw.usdcRaw, '100')
    assert.equal(result.routes[0].before.usdcRaw, '0')
    assert.equal(result.routes[0].transactions.length, 1)
    assert.equal(fake.calls.filter((method) => method === 'eth_sendTransaction').length, 1)
  } finally {
    rmSync(out, { recursive: true })
  }
})

test('wrong receipt destination or mined block hash cannot produce an output claim', async () => {
  for (const options of [{ badReceiptTo: true }, { badReceiptBlockHash: true }]) {
    const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-test-'))
    try {
      const fake = fakeAdapter(options)
      const result = await execute({
        sources: { row, target, plan: plan(), refs: {} },
        adapter: fake.adapter,
        stat: fakeStat(RESERVE_BYTES + 1_000_000),
        out,
      })
      assert.equal(result.status, 'partial_or_unavailable')
      assert.equal(result.routes[0].failedStage, 'withdraw')
      assert.equal(result.routes[0].output, null)
      assert.equal(fake.calls.filter((method) => method === 'eth_sendTransaction').length, 1)
    } finally {
      rmSync(out, { recursive: true })
    }
  }
})

test('physical quote SHA mismatch rejects before any source can be trusted', () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-source-test-'))
  try {
    const quotePath = join(out, 'quote.json')
    writeFileSync(quotePath, '{}\n')
    assert.throws(
      () =>
        loadSources({
          quotePath,
          quoteSha256: 'f'.repeat(64),
          targetPath: 'unused',
          targetSha256: 'f'.repeat(64),
          planPath: 'unused',
          planSha256: 'f'.repeat(64),
        }),
      /Physical source SHA mismatch/,
    )
  } finally {
    rmSync(out, { recursive: true })
  }
})

test('plan save is no-overwrite and physical-hash pinned', () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-fork-plan-test-'))
  try {
    const path = join(out, 'plan.json')
    const saved = savePlan({ plan: plan(), path, stat: fakeStat(RESERVE_BYTES + 1_000_000) })
    assert.equal(saved.physicalSha256, sha(readFileSync(path)))
    assert.throws(
      () => savePlan({ plan: plan(), path, stat: fakeStat(RESERVE_BYTES + 1_000_000) }),
      /EEXIST/,
    )
  } finally {
    rmSync(out, { recursive: true })
  }
})
