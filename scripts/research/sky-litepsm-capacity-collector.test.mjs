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
import { CHUNK_BLOCKS, collect, MAX_BLOCKS, verify } from './sky-litepsm-capacity-collector.mjs'

const PSM = '0xf6e72db5454dd049d0788e411b06cfaf16853042'
const POCKET = '0x37305b1cd40574e4c5ce33f8e8306be057fd7341'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USER = `0x${'44'.repeat(20)}`
const TX = `0x${'11'.repeat(32)}`
const A_HASH = `0x${'aa'.repeat(32)}`
const B_HASH = `0x${'bb'.repeat(32)}`
const C_HASH = `0x${'cc'.repeat(32)}`
const D_HASH = `0x${'dd'.repeat(32)}`
const E_HASH = `0x${'ee'.repeat(32)}`
const WHAT = `0x${'cc'.repeat(32)}`
const ABI = parseAbi([
  'event BuyGem(address indexed owner, uint256 value, uint256 fee)',
  'event SellGem(address indexed owner, uint256 value, uint256 fee)',
  'event File(bytes32 indexed what, uint256 data)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function pocket() view returns (address)',
  'function gem() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
])
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
const temp = () => mkdtempSync(join(tmpdir(), 'sky-pocket-collector-'))
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

function sourceLogs({ self = false } = {}) {
  const buy = log('BuyGem', { owner: USER }, 'uint256,uint256', [100n, 0n], 0, PSM)
  const out = log('Transfer', { from: POCKET, to: USER }, 'uint256', [100n], 1, USDC)
  const sell = log('SellGem', { owner: USER }, 'uint256,uint256', [30n, 0n], 2, PSM)
  const incoming = log('Transfer', { from: USER, to: POCKET }, 'uint256', [30n], 3, USDC)
  const file = log('File', { what: WHAT }, 'uint256', [7n], 4, PSM)
  const selfTransfer = log('Transfer', { from: POCKET, to: POCKET }, 'uint256', [9n], 5, USDC)
  return { buy, out, sell, incoming, file, selfTransfer: self ? selfTransfer : undefined }
}

function rpc({
  quiet = false,
  self = false,
  badEndpoint = false,
  wrongIdentity = false,
  drift = false,
  duplicate = false,
  omittedBuy = false,
  nullCoordinate = false,
  interior = false,
} = {}) {
  const calls = []
  const logs = sourceLogs({ self })
  if (interior) for (const row of Object.values(logs)) if (row) row.blockNumber = '0x66'
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized')
          return {
            number: interior ? '0x67' : '0x65',
            hash: interior ? C_HASH : B_HASH,
            timestamp: '0x64',
          }
        const n = Number(BigInt(params[0]))
        return {
          number: params[0],
          hash: interior
            ? n === 100
              ? A_HASH
              : n === 101
                ? D_HASH
                : n === 102
                  ? B_HASH
                  : C_HASH
            : n === 100
              ? A_HASH
              : drift &&
                  calls.filter(
                    (call) => call.method === 'eth_getBlockByNumber' && call.params[0] === '0x65',
                  ).length > 1
                ? A_HASH
                : B_HASH,
          timestamp: '0x64',
        }
      }
      if (method === 'eth_getCode') return '0x6001'
      if (method === 'eth_call') {
        const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data })
        const result =
          functionName === 'pocket'
            ? wrongIdentity
              ? USER
              : POCKET
            : functionName === 'gem'
              ? USDC
              : params[1].blockHash === A_HASH
                ? 1000n
                : quiet
                  ? 1000n
                  : badEndpoint
                    ? 931n
                    : 930n
        return encodeFunctionResult({ abi: ABI, functionName, result })
      }
      if (method === 'eth_getLogs') {
        if (quiet) return []
        const { address, topics } = params[0]
        let result
        if (address.toLowerCase() === PSM) {
          const selected = [logs.buy, logs.sell, logs.file].find(
            (row) => row.topics[0].toLowerCase() === topics[0].toLowerCase(),
          )
          result = selected && !(omittedBuy && selected === logs.buy) ? [selected] : []
        } else if (topics[1]) {
          result = [logs.out, ...(self ? [logs.selfTransfer] : [])]
        } else {
          result = [logs.incoming, ...(self ? [logs.selfTransfer] : [])]
        }
        if (nullCoordinate && address.toLowerCase() === PSM && result.length)
          result = [{ ...result[0], transactionIndex: null }]
        return duplicate && address.toLowerCase() === PSM && result.length
          ? [...result, result[0]]
          : result
      }
      throw new Error('Unexpected Sky RPC method')
    },
  }
  return { client, calls }
}

test('seals five exact streams, pinned identities, quiet-range coverage and Pocket residual', async () => {
  const out = temp()
  const { client, calls } = rpc()
  const result = await collect({ client, fromBlock: 100, toBlock: 101, out, stat })
  assert.equal(result.endpointResidualRaw, '0')
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.deepEqual(Object.keys(saved.chunks), [
    'buyGem',
    'sellGem',
    'fileUint',
    'usdcTransfersOut',
    'usdcTransfersIn',
  ])
  assert.equal(saved.reconciliation.transactions[0].buyOutRelation, 'mixed_no_simple_equality')
  assert.equal(saved.identities[0].psmPocket, POCKET)
  assert.equal(saved.logs.fileUint[0].what, WHAT)
  assert.deepEqual(verify({ out }), { count: 1 })
  assert.equal(calls.filter((call) => call.method === 'eth_getLogs').length, 5)
  assert.ok(
    calls.filter((call) => call.method === 'eth_call').every((call) => call.params[1].blockHash),
  )
})

test('retains an explicit five-stream quiet chunk and unchanged balance', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ quiet: true }).client,
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reconciliation.transactions.length, 0)
  assert.equal(saved.reconciliation.endpointMinusTransfersRaw, '0')
  assert.ok(Object.values(saved.chunks).every((chunks) => chunks[0].query.logs.length === 0))
  assert.equal(verify({ out }).count, 1)
})

test('counts the exact Pocket self-transfer once despite two directional query copies', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ self: true }).client,
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reconciliation.transactions[0].pocketSelfRaw, '9')
  assert.equal(saved.reconciliation.pocketNetTransfersRaw, '-70')
  assert.equal(verify({ out }).count, 1)
})

test('fails closed before writing for wrong identity, duplicate log, bad residual or chain drift', async () => {
  for (const variation of [
    { wrongIdentity: true },
    { duplicate: true },
    { badEndpoint: true },
    { drift: true },
    { nullCoordinate: true },
  ]) {
    const out = temp()
    await assert.rejects(
      collect({ client: rpc(variation).client, fromBlock: 100, toBlock: 101, out, stat }),
    )
    assert.deepEqual(readdirSync(out), [])
  }
})

test('bounded interval and disk reserve are enforced before any RPC read', async () => {
  const { client, calls } = rpc()
  await assert.rejects(
    collect({ client, fromBlock: 100, toBlock: 100 + MAX_BLOCKS + 1, out: temp(), stat }),
    /unbounded/,
  )
  await assert.rejects(
    collect({
      client,
      fromBlock: 100,
      toBlock: 101,
      out: temp(),
      stat: () => ({ bavail: 1, bsize: 1 }),
    }),
    /Disk reserve/,
  )
  assert.equal(calls.length, 0)
  assert.equal(CHUNK_BLOCKS, 64)
})

test('immutable window and offline raw-projection replay reject duplicate or resealed tampering', async () => {
  const out = temp()
  const { client } = rpc()
  const result = await collect({ client, fromBlock: 100, toBlock: 101, out, stat })
  await assert.rejects(collect({ client, fromBlock: 100, toBlock: 101, out, stat }))
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  saved.chunks.buyGem[0].normalized[0].valueRaw = '101'
  saved.chunks.buyGem[0].sha256 = sha(
    Object.fromEntries(Object.entries(saved.chunks.buyGem[0]).filter(([key]) => key !== 'sha256')),
  )
  saved.sha256 = sha(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'sha256')))
  writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
  assert.throws(() => verify({ out }), /projection mismatch/)
})

test('does not call a zero residual proof of BuyGem log completeness', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ omittedBuy: true }).client,
    fromBlock: 100,
    toBlock: 101,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reconciliation.endpointMinusTransfersRaw, '0')
  assert.equal(saved.reconciliation.transactions[0].buyOutRelation, 'no_buy_gem')
  assert.match(saved.caveat, /not independent log completeness/)
  assert.equal(verify({ out }).count, 1)
})

test('offline replay rejects a resealed interior log/header inconsistency', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ interior: true }).client,
    fromBlock: 100,
    toBlock: 103,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.canonicalBlocks.find((row) => row.blockNumber === 102).blockHash, B_HASH)
  assert.equal(verify({ out }).count, 1)
  saved.canonicalBlocks.find((row) => row.blockNumber === 102).blockHash = E_HASH
  saved.sha256 = sha(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'sha256')))
  writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
  assert.throws(() => verify({ out }), /raw log\/header hash mismatch/)
})

test('offline replay rejects a resealed quiet chunk boundary/header inconsistency', async () => {
  const out = temp()
  const result = await collect({
    client: rpc({ quiet: true, interior: true }).client,
    fromBlock: 100,
    toBlock: 103,
    out,
    stat,
  })
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(verify({ out }).count, 1)
  saved.chunks.buyGem[0].firstHash = E_HASH
  saved.chunks.buyGem[0].sha256 = sha(
    Object.fromEntries(Object.entries(saved.chunks.buyGem[0]).filter(([key]) => key !== 'sha256')),
  )
  saved.sha256 = sha(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'sha256')))
  writeFileSync(result.path, `${JSON.stringify(saved)}\n`)
  assert.throws(() => verify({ out }), /chunk boundary\/header hash mismatch/)
})
