import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
} from 'viem'
import { ABI as PANEL_ABI, MARKETS, POOL } from './aave-core-forward-panel.mjs'
import { CHUNK_BLOCKS, collect, MAX_BLOCKS, verify } from './aave-core-operation-collector.mjs'

const market = MARKETS.find((row) => row.name === 'USDT')
const A_HASH = `0x${'aa'.repeat(32)}`
const B_HASH = `0x${'bb'.repeat(32)}`
const TX = `0x${'11'.repeat(32)}`
const USER = `0x${'44'.repeat(20)}`
const ABI = [
  ...parseAbi([
    'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
    'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
    'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
    'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function balanceOf(address) view returns (uint256)',
    'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
    'function POOL() view returns (address)',
    'function decimals() view returns (uint8)',
  ]),
  ...PANEL_ABI.reserve,
]
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
const temp = () => mkdtempSync(join(tmpdir(), 'aave-operation-'))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function log(eventName, args, dataTypes, dataValues, index, address) {
  return {
    address,
    blockNumber: '0x65',
    blockHash: B_HASH,
    transactionHash: TX,
    transactionIndex: '0x0',
    logIndex: `0x${index.toString(16)}`,
    topics: encodeEventTopics({ abi: ABI, eventName, args }),
    data: encodeAbiParameters(parseAbiParameters(dataTypes), dataValues),
    removed: false,
  }
}

function sourceLogs() {
  return {
    pool: [
      log(
        'Supply',
        { reserve: market.base, onBehalfOf: USER, referralCode: 0 },
        'address,uint256,uint16',
        [USER, 100n, 0],
        0,
        POOL,
      ),
      log(
        'Borrow',
        { reserve: market.base, onBehalfOf: USER, referralCode: 0 },
        'address,uint256,uint8,uint256,uint16',
        [USER, 30n, 2, 0n, 0],
        2,
        POOL,
      ),
    ],
    inbound: [
      log('Transfer', { from: USER, to: market.aToken }, 'uint256', [100n], 1, market.base),
    ],
    outbound: [
      log('Transfer', { from: market.aToken, to: USER }, 'uint256', [30n], 3, market.base),
    ],
  }
}

function rpc({
  quiet = false,
  operationOnly = false,
  allFour = false,
  duplicatePool = false,
  wrongDirection = false,
  badEndpoint = false,
  drift = false,
  missingLogs = false,
  wrongCode = false,
  wrongReserve = false,
} = {}) {
  const calls = []
  const logs = sourceLogs()
  if (duplicatePool) logs.pool.push({ ...logs.pool[0] })
  if (allFour) {
    logs.pool.push(
      log(
        'Repay',
        { reserve: market.base, user: USER, repayer: USER },
        'uint256,bool',
        [20n, false],
        4,
        POOL,
      ),
    )
    logs.inbound.push(
      log('Transfer', { from: USER, to: market.aToken }, 'uint256', [20n], 5, market.base),
    )
    logs.pool.push(
      log('Withdraw', { reserve: market.base, user: USER, to: USER }, 'uint256', [10n], 6, POOL),
    )
    logs.outbound.push(
      log('Transfer', { from: market.aToken, to: USER }, 'uint256', [10n], 7, market.base),
    )
  }
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return { number: '0x65', hash: B_HASH, timestamp: '0x64' }
        const n = Number(BigInt(params[0]))
        return {
          number: params[0],
          hash:
            n === 100
              ? A_HASH
              : drift &&
                  calls.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === '0x65')
                    .length > 1
                ? A_HASH
                : B_HASH,
          timestamp: '0x64',
        }
      }
      if (method === 'eth_getCode') return wrongCode ? '0x' : '0x6001'
      if (method === 'eth_call') {
        const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data })
        let result
        if (functionName === 'UNDERLYING_ASSET_ADDRESS') result = market.base
        else if (functionName === 'POOL') result = POOL
        else if (functionName === 'decimals') result = 6
        else if (functionName === 'getReserveData')
          result = {
            configuration: { data: 1n },
            liquidityIndex: 10n ** 27n,
            currentLiquidityRate: 0n,
            variableBorrowIndex: 10n ** 27n,
            currentVariableBorrowRate: 0n,
            currentStableBorrowRate: 0n,
            lastUpdateTimestamp: 100n,
            id: 4,
            aTokenAddress: wrongReserve ? USER : market.aToken,
            stableDebtTokenAddress: USER,
            variableDebtTokenAddress: USER,
            interestRateStrategyAddress: USER,
            accruedToTreasury: 0n,
            unbacked: 0n,
            isolationModeTotalDebt: 0n,
          }
        else if (functionName === 'balanceOf') {
          result =
            params[1].blockHash === A_HASH
              ? 1000n
              : BigInt(
                  quiet ? 1000 : badEndpoint ? 1071 : operationOnly ? 1100 : allFour ? 1080 : 1070,
                )
        }
        return encodeFunctionResult({ abi: ABI, functionName, result })
      }
      if (method === 'eth_getLogs') {
        if (missingLogs) throw new Error('RPC log read failed')
        if (quiet) return []
        if (params[0].address.toLowerCase() === POOL.toLowerCase()) return logs.pool
        if (params[0].topics[1])
          return wrongDirection ? logs.inbound : operationOnly ? [] : logs.outbound
        return wrongDirection ? logs.outbound : logs.inbound
      }
      throw new Error('Unexpected RPC method')
    },
  }
  return { client, calls }
}

test('seals exact pinned mixed Pool/Transfer receipt and replays both chunk and endpoint math', async () => {
  const out = temp()
  const { client, calls } = rpc()
  const result = await collect({
    client,
    marketName: 'USDT',
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  assert.equal(result.endpointResidualRaw, '0')
  assert.equal(result.operationGrossReconciled, true)
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.operations.length, 2)
  assert.equal(saved.transfers.length, 2)
  assert.equal(saved.identities[0].reserveAToken, market.aToken.toLowerCase())
  assert.equal(saved.chunks.poolOperations[0].queries[0].logs.length, 2)
  assert.equal(saved.reconciliation.transactions[0].status, 'gross-matched-mixed')
  assert.deepEqual(verify({ out }), { count: 1 })
  assert.equal(calls.filter((row) => row.method === 'eth_getLogs').length, 3)
  assert.ok(
    calls.filter((row) => row.method === 'eth_call').every((row) => row.params[1].blockHash),
  )
})

test('seals explicit complete quiet chunks with unchanged endpoint cash', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ quiet: true }).client,
    marketName: 'USDT',
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reconciliation.emptyRange, true)
  assert.equal(saved.chunks.poolOperations[0].queries[0].logs.length, 0)
  assert.equal(saved.chunks.underlyingTransfers[0].queries[0].logs.length, 0)
  assert.equal(verify({ out }).count, 1)
})

test('decodes all four Aave Pool operation kinds without netting away mixed gross flow', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ allFour: true }).client,
    marketName: 'USDT',
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.deepEqual(
    saved.operations.map((row) => row.kind),
    ['Supply', 'Borrow', 'Repay', 'Withdraw'],
  )
  assert.equal(saved.reconciliation.totals.operationInRaw, '120')
  assert.equal(saved.reconciliation.totals.operationOutRaw, '40')
  assert.equal(saved.reconciliation.totals.transferNetRaw, '80')
  assert.equal(verify({ out }).count, 1)
})

test('retains unmatched Borrow amount when transfer/endpoint residual is zero', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ operationOnly: true }).client,
    marketName: 'USDT',
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reconciliation.operationGrossReconciled, false)
  assert.equal(saved.reconciliation.totals.endpointMinusTransfersRaw, '0')
  assert.equal(result.operationGrossReconciled, false)
})

test('rejects nonzero endpoint residual, RPC failure, missing code, and reorg without a receipt', async () => {
  for (const option of [
    { badEndpoint: true },
    { missingLogs: true },
    { wrongCode: true },
    { wrongReserve: true },
    { drift: true },
    { duplicatePool: true },
    { wrongDirection: true },
  ]) {
    const out = temp()
    await assert.rejects(
      collect({
        client: rpc(option).client,
        marketName: 'USDT',
        fromBlock: 100,
        toBlock: 101,
        out,
        stat,
      }),
    )
    assert.deepEqual(readdirSync(out), [])
  }
})

test('disk and block bounds fail before the first RPC', async () => {
  const out = temp()
  const { client, calls } = rpc()
  await assert.rejects(
    collect({
      client,
      marketName: 'USDT',
      fromBlock: 100,
      toBlock: 101,
      out,
      stat: () => ({ bavail: 1, bsize: 1 }),
    }),
    /Disk reserve/,
  )
  await assert.rejects(
    collect({
      client,
      marketName: 'USDT',
      fromBlock: 100,
      toBlock: 100 + MAX_BLOCKS + 1,
      out,
      stat,
    }),
    /unbounded/,
  )
  for (const chunkBlocks of [0, CHUNK_BLOCKS + 1]) {
    await assert.rejects(
      collect({ client, marketName: 'USDT', fromBlock: 100, toBlock: 101, chunkBlocks, out, stat }),
      /Invalid log chunk size/,
    )
  }
  assert.deepEqual(calls, [])
  assert.ok(CHUNK_BLOCKS < MAX_BLOCKS)
})

test('does not overwrite a sealed receipt and detects resealed raw/normalized inconsistency', async () => {
  const out = temp()
  const result = await collect({
    client: rpc().client,
    marketName: 'USDT',
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const original = readFileSync(result.path, 'utf8')
  await assert.rejects(
    collect({ client: rpc().client, marketName: 'USDT', fromBlock: 100, toBlock: 101, out, stat }),
  )
  assert.equal(readFileSync(result.path, 'utf8'), original)
  const saved = JSON.parse(original)
  saved.chunks.poolOperations[0].normalized[0].amountRaw = '101'
  delete saved.chunks.poolOperations[0].sha256
  saved.chunks.poolOperations[0].sha256 = sha(saved.chunks.poolOperations[0])
  delete saved.sha256
  saved.sha256 = sha(saved)
  writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
  assert.throws(() => verify({ out }), /Raw log projection mismatch/)
})
