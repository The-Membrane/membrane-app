import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbiItem,
} from 'viem'

import { SUSDE } from './usde-susde-receipts.mjs'
import {
  CONFIGURATOR,
  INITIALIZATION_TX,
  START_BLOCK,
  START_HASH,
  TOKEN,
  USDE,
  collect,
} from './usde-debt-mint-baseline.mjs'
import { MULTICALL3, PAGE_SIZE, collectPage, loadIndex, reconcile } from './usde-debt-census.mjs'

const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const ZERO = `0x${'0'.repeat(40)}`
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const INITIALIZED = parseAbiItem(
  'event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)',
)
const ABI = {
  aggregate3: parseAbiItem(
    'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  ),
  scaledBalanceOf: parseAbiItem('function scaledBalanceOf(address) view returns (uint256)'),
  scaledTotalSupply: parseAbiItem('function scaledTotalSupply() view returns (uint256)'),
  balanceOf: parseAbiItem('function balanceOf(address) view returns (uint256)'),
  convertToAssets: parseAbiItem('function convertToAssets(uint256) view returns (uint256)'),
  totalAssets: parseAbiItem('function totalAssets() view returns (uint256)'),
  asset: parseAbiItem('function asset() view returns (address)'),
  decimals: parseAbiItem('function decimals() view returns (uint8)'),
  POOL: parseAbiItem('function POOL() view returns (address)'),
  UNDERLYING_ASSET_ADDRESS: parseAbiItem(
    'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  ),
}
const hex = (value) => `0x${BigInt(value).toString(16)}`
const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const B = START_BLOCK + 9
const NOW = Date.UTC(2026, 8, 27, 21)
const owner = (i) =>
  `0x${BigInt(i + 1)
    .toString(16)
    .padStart(40, '0')}`

function block(n) {
  return {
    number: hex(n),
    hash: n === START_BLOCK ? START_HASH : hash(n),
    parentHash: n === START_BLOCK + 1 ? START_HASH : hash(n - 1),
    timestamp: hex(Math.floor(NOW / 1000) - 1200 - (B - n) * 12),
  }
}

function sourceRpc(count) {
  const init = {
    address: CONFIGURATOR,
    topics: encodeEventTopics({
      abi: [INITIALIZED],
      eventName: 'ReserveInitialized',
      args: { asset: USDE, aToken: owner(100) },
    }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      [owner(101), TOKEN, owner(102)],
    ),
    blockNumber: hex(START_BLOCK),
    blockHash: START_HASH,
    transactionHash: INITIALIZATION_TX,
    logIndex: '0x0',
    removed: false,
  }
  const events = Array.from({ length: count }, (_, i) => ({
    address: TOKEN,
    topics: encodeEventTopics({
      abi: [TRANSFER],
      eventName: 'Transfer',
      args: { from: ZERO, to: owner(i) },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [1n]),
    blockNumber: hex(START_BLOCK + 4),
    blockHash: hash(START_BLOCK + 4),
    transactionHash: hash(10_000 + i),
    logIndex: hex(i),
    removed: false,
  }))
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber')
      return block(params[0] === 'finalized' ? B : Number(BigInt(params[0])))
    if (method === 'eth_getCode') return Number(BigInt(params[1])) < START_BLOCK ? '0x' : '0x6001'
    if (method === 'eth_getLogs') {
      const filter = params[0]
      if (filter.address.toLowerCase() === CONFIGURATOR) return [init]
      return events.filter(
        (event) =>
          Number(BigInt(event.blockNumber)) >= Number(BigInt(filter.fromBlock)) &&
          Number(BigInt(event.blockNumber)) <= Number(BigInt(filter.toBlock)),
      )
    }
    throw new Error(`unexpected ${method}`)
  }
}

function censusRpc(count, options = {}) {
  const signatures = Object.fromEntries(
    Object.entries(ABI)
      .filter(([name]) => name !== 'aggregate3')
      .map(([name, abi]) => [
        encodeFunctionData({
          abi: [abi],
          functionName: name,
          args: ['scaledBalanceOf', 'balanceOf'].includes(name)
            ? [owner(0)]
            : name === 'convertToAssets'
              ? [1n]
              : [],
        }).slice(0, 10),
        name,
      ]),
  )
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber')
      return block(params[0] === 'finalized' ? B : Number(BigInt(params[0])))
    if (method === 'eth_getCode')
      return params[0].toLowerCase() === MULTICALL3 && !options.noMulticall ? '0x6001' : '0x'
    if (method === 'eth_call') {
      const { to, data } = params[0]
      if (to.toLowerCase() === POOL) {
        assert.equal(data, `0x35ea6a75${USDE.slice(2).padStart(64, '0')}`)
        const debtToken = options.wrongReserveToken ? owner(200) : TOKEN
        return `0x${Array.from({ length: 11 }, (_, i) => (i === 10 ? debtToken.slice(2).padStart(64, '0') : '0'.repeat(64))).join('')}`
      }
      assert.equal(to.toLowerCase(), MULTICALL3)
      const calls = decodeFunctionData({ abi: [ABI.aggregate3], data }).args[0]
      const results = calls.map((call) => {
        assert.equal(call.allowFailure, false)
        const name = signatures[call.callData.slice(0, 10)]
        assert.ok(name)
        let result
        if (name === 'UNDERLYING_ASSET_ADDRESS' || name === 'asset') result = USDE
        else if (name === 'POOL') result = POOL
        else if (name === 'decimals') result = 18
        else if (name === 'scaledTotalSupply')
          result = BigInt(options.wrongSupply ? count + 1 : count)
        else if (name === 'totalAssets') result = 1_000_000n
        else if (name === 'scaledBalanceOf') result = 1n
        else if (name === 'balanceOf') result = call.target.toLowerCase() === TOKEN ? 2n : 1n
        else if (name === 'convertToAssets') result = 3n
        return {
          success: !options.failedSubcall,
          returnData: encodeFunctionResult({ abi: [ABI[name]], functionName: name, result }),
        }
      })
      return encodeFunctionResult({
        abi: [ABI.aggregate3],
        functionName: 'aggregate3',
        result: results,
      })
    }
    throw new Error(`unexpected ${method}`)
  }
}

async function fixture(count, fn) {
  const temp = mkdtempSync(join(tmpdir(), 'usde-debt-census-'))
  const sourceDir = join(temp, 'source')
  const out = join(temp, 'pages')
  try {
    await collect({ rpcRead: sourceRpc(count), out: sourceDir, now: () => new Date(NOW) })
    await fn({ sourceDir, out })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

test('partial mint index cannot start any same-block census page', async () =>
  fixture(1, async ({ sourceDir, out }) => {
    assert.throws(() => loadIndex({ sourceDir, block: B - 1 }), /index_not_complete_to_block/)
    await assert.rejects(
      collectPage({ sourceDir, out, block: B - 1, page: 0, rpcRead: censusRpc(1) }),
      /index_not_complete_to_block/,
    )
    assert.equal(existsSync(out), false)
  }))

test('all pages reconcile only when every indexed scaled balance equals scaled supply', async () =>
  fixture(PAGE_SIZE + 1, async ({ sourceDir, out }) => {
    const index = loadIndex({ sourceDir, block: B })
    assert.equal(index.candidateCount, PAGE_SIZE + 1)
    assert.equal(index.pageCount, 2)
    const rpcRead = censusRpc(PAGE_SIZE + 1)
    const first = await collectPage({
      sourceDir,
      out,
      block: B,
      page: 0,
      rpcRead,
      now: () => new Date(NOW),
    })
    assert.equal(first.candidateCount, PAGE_SIZE + 1)
    assert.ok(first.rpcCalls <= 9)
    assert.throws(() => reconcile({ sourceDir, out, block: B }), /pages_incomplete/)
    await assert.rejects(
      collectPage({ sourceDir, out, block: B, page: 0, rpcRead }),
      /page_already_sealed/,
    )
    await collectPage({ sourceDir, out, block: B, page: 1, rpcRead, now: () => new Date(NOW) })
    const result = reconcile({ sourceDir, out, block: B })
    assert.equal(result.status, 'reconciled_same_block')
    assert.equal(result.scaledDebtRaw, String(PAGE_SIZE + 1))
    assert.equal(result.debtRaw, String(2 * (PAGE_SIZE + 1)))
    assert.equal(result.matchedRaw, String(2 * (PAGE_SIZE + 1)))
    assert.equal(result.candidateCount, PAGE_SIZE + 1)
    assert.equal(result.overlapCount, PAGE_SIZE + 1)
  }))

test('mismatched token supply blocks aggregate publication', async () =>
  fixture(1, async ({ sourceDir, out }) => {
    await collectPage({
      sourceDir,
      out,
      block: B,
      page: 0,
      rpcRead: censusRpc(1, { wrongSupply: true }),
      now: () => new Date(NOW),
    })
    assert.throws(() => reconcile({ sourceDir, out, block: B }), /scaled_supply_mismatch/)
  }))

test('unavailable Multicall3 or one failed subcall cannot seal a page', async () =>
  fixture(1, async ({ sourceDir, out }) => {
    await assert.rejects(
      collectPage({
        sourceDir,
        out,
        block: B,
        page: 0,
        rpcRead: censusRpc(1, { noMulticall: true }),
      }),
      /multicall_unavailable_at_block/,
    )
    await assert.rejects(
      collectPage({
        sourceDir,
        out,
        block: B,
        page: 0,
        rpcRead: censusRpc(1, { failedSubcall: true }),
      }),
      /batch_incomplete/,
    )
    assert.equal(existsSync(out), false)
  }))

test('a replaced reserve debt-token address blocks historical-owner reuse', async () =>
  fixture(1, async ({ sourceDir, out }) => {
    await assert.rejects(
      collectPage({
        sourceDir,
        out,
        block: B,
        page: 0,
        rpcRead: censusRpc(1, { wrongReserveToken: true }),
      }),
      /reserve_debt_token_mismatch/,
    )
    assert.equal(existsSync(out), false)
  }))
