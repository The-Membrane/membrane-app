// Read-only, resumable Ethereum Vault V2 factory creation census.
// node scripts/research/morpho-v2-factory-census.mjs --out data/research/venue-signals/morpho-v2-factory-census.json
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const FACTORY = '0xA1D94F746dEfa1928926b84fB2596c06926C0405'
export const SKY_VAULT = '0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11'
export const FROM_BLOCK = 23_375_073
export const TO_BLOCK = 26_052_740
export const CHUNK_BLOCKS = 10_000
export const EVENT = parseAbiItem(
  'event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)',
)
export const TOPIC0 = '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e'
export const STUDY = 'morpho-v2-factory-create-v1'
const address = (value) => /^0x[0-9a-fA-F]{40}$/.test(value || '')
const hash = (value) => /^0x[0-9a-fA-F]{64}$/.test(value || '')

export function ranges(from = FROM_BLOCK, to = TO_BLOCK, size = CHUNK_BLOCKS) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from > to ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > CHUNK_BLOCKS
  )
    throw new Error('Invalid bounded scan range')
  const output = []
  for (let first = from; first <= to; first += size)
    output.push({ fromBlock: first, toBlock: Math.min(to, first + size - 1) })
  return output
}

export function decodeCreation(log, timestamp) {
  if (log.address?.toLowerCase() !== FACTORY.toLowerCase())
    throw new Error('Factory address mismatch')
  if (log.topics?.[0]?.toLowerCase() !== TOPIC0) throw new Error('Unexpected event topic')
  const block = Number(log.blockNumber)
  const logIndex = Number(log.logIndex)
  const transactionIndex = Number(log.transactionIndex)
  if (
    ![block, logIndex, transactionIndex, timestamp].every(Number.isSafeInteger) ||
    !hash(log.transactionHash) ||
    !hash(log.blockHash)
  )
    throw new Error('Malformed log coordinate, hash or timestamp')
  const { args } = decodeEventLog({
    abi: [EVENT],
    data: log.data,
    topics: log.topics,
    strict: true,
  })
  if (![args.owner, args.asset, args.newVaultV2].every(address) || !hash(args.salt))
    throw new Error('Malformed factory event arguments')
  return {
    block,
    blockHash: log.blockHash,
    transactionIndex,
    txHash: log.transactionHash,
    logIndex,
    timestamp,
    owner: args.owner,
    asset: args.asset,
    vault: args.newVaultV2,
    salt: args.salt,
  }
}

export function summarize(events) {
  const unique = new Set(events.map((event) => event.vault.toLowerCase()))
  return {
    eventCount: events.length,
    uniqueVaultCount: unique.size,
    duplicateVaultCount: events.length - unique.size,
    containsSkyVault: unique.has(SKY_VAULT.toLowerCase()),
  }
}

function assertCompleteSummary(saved) {
  const actual = summarize(saved.events)
  if (
    actual.duplicateVaultCount ||
    !actual.containsSkyVault ||
    JSON.stringify(saved.summary) !== JSON.stringify(actual)
  )
    throw new Error('Complete checkpoint failed unique-vault, known-vault or summary verification')
}

export function validateCheckpoint(saved, expected) {
  if (
    saved?.study !== STUDY ||
    saved.factory?.toLowerCase() !== FACTORY.toLowerCase() ||
    saved.topic0 !== TOPIC0 ||
    saved.from !== expected.from ||
    saved.to !== expected.to ||
    saved.chunkBlocks !== expected.chunkBlocks ||
    !['partial', 'complete'].includes(saved.status) ||
    !Number.isSafeInteger(saved.nextChunk) ||
    saved.nextChunk < 0 ||
    saved.nextChunk > expected.ranges.length ||
    !Array.isArray(saved.events) ||
    (saved.endBlockHash !== undefined && !hash(saved.endBlockHash)) ||
    (saved.status === 'complete' && saved.nextChunk !== expected.ranges.length)
  )
    throw new Error('Checkpoint does not match this factory census')
  const lastCovered = saved.nextChunk
    ? expected.ranges[saved.nextChunk - 1].toBlock
    : expected.from - 1
  const seen = new Set()
  let previousBlock = -1,
    previousIndex = -1
  for (const event of saved.events) {
    if (
      !Number.isSafeInteger(event.block) ||
      event.block < expected.from ||
      event.block > lastCovered ||
      !Number.isSafeInteger(event.logIndex) ||
      event.logIndex < 0 ||
      !Number.isSafeInteger(event.transactionIndex) ||
      event.transactionIndex < 0 ||
      !Number.isSafeInteger(event.timestamp) ||
      !hash(event.txHash) ||
      !hash(event.blockHash) ||
      !hash(event.salt) ||
      ![event.owner, event.asset, event.vault].every(address) ||
      event.block < previousBlock ||
      (event.block === previousBlock && event.logIndex <= previousIndex)
    )
      throw new Error('Malformed, unordered or out-of-coverage checkpoint event')
    const key = `${event.txHash.toLowerCase()}:${event.logIndex}`
    if (seen.has(key)) throw new Error('Duplicate checkpoint event')
    seen.add(key)
    previousBlock = event.block
    previousIndex = event.logIndex
  }
  if (
    saved.coverage?.throughBlock !== lastCovered ||
    saved.coverage?.chunksComplete !== saved.nextChunk ||
    saved.coverage?.chunksExpected !== expected.ranges.length
  )
    throw new Error('Checkpoint coverage mismatch')
  if (saved.status === 'complete') assertCompleteSummary(saved)
  return saved
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}

async function retryRead(operation, retries, pause) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= retries)
        throw new Error(`RPC read failed after ${attempt + 1} attempts`, { cause: error })
      await pause(Math.min(10_000, 500 * 2 ** attempt))
    }
  }
}

async function verifyChainAndEndBlock(client, to, retries, pause, expectedHash) {
  const chainId = await retryRead(() => client.getChainId(), retries, pause)
  if (chainId !== 1) throw new Error('Factory census requires Ethereum mainnet chain ID 1')
  const header = await retryRead(() => client.getBlock({ blockNumber: BigInt(to) }), retries, pause)
  if (!hash(header?.hash) || !Number.isSafeInteger(Number(header.timestamp)))
    throw new Error('Malformed pinned end-block header')
  if (expectedHash && header.hash.toLowerCase() !== expectedHash.toLowerCase())
    throw new Error('Pinned end-block hash changed; checkpoint cannot safely resume')
  return { hash: header.hash, timestamp: Number(header.timestamp) }
}

export async function collect({
  client,
  out,
  from = FROM_BLOCK,
  to = TO_BLOCK,
  chunkBlocks = CHUNK_BLOCKS,
  maxChunks = Infinity,
  retries = 3,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  onProgress = () => {},
}) {
  if (toEventSelector(EVENT).toLowerCase() !== TOPIC0) throw new Error('Factory ABI topic mismatch')
  const chunkRanges = ranges(from, to, chunkBlocks)
  const expected = { from, to, chunkBlocks, ranges: chunkRanges }
  const existing = existsSync(out)
  let result = existing
    ? validateCheckpoint(JSON.parse(readFileSync(out, 'utf8')), expected)
    : {
        study: STUDY,
        source:
          'https://github.com/morpho-org/vault-v2/blob/main/src/interfaces/IVaultV2Factory.sol',
        factory: FACTORY,
        topic0: TOPIC0,
        from,
        to,
        chunkBlocks,
        status: 'partial',
        nextChunk: 0,
        events: [],
        coverage: {
          fromBlock: from,
          throughBlock: from - 1,
          chunksComplete: 0,
          chunksExpected: chunkRanges.length,
        },
      }
  const pin = await verifyChainAndEndBlock(client, to, retries, pause, result.endBlockHash)
  if (!existing) {
    result = { ...result, endBlockHash: pin.hash, endBlockTimestamp: pin.timestamp }
    writeAtomic(out, result)
  }
  if (result.status === 'complete') {
    // The original imported SHA blob predates block pinning. Keep it immutable;
    // identify the weaker runtime-only provenance in the returned object.
    // A block hash detects chain/provider drift, not silently omitted logs.
    await verifyChainAndEndBlock(client, to, retries, pause, result.endBlockHash || pin.hash)
    return result.endBlockHash
      ? result
      : { ...result, pinProvenance: 'legacy-runtime-only', runtimeEndBlockHash: pin.hash }
  }
  if (!result.endBlockHash) throw new Error('Partial legacy checkpoint lacks an end-block pin')
  const timestamps = new Map()
  const stopAt = Math.min(chunkRanges.length, result.nextChunk + maxChunks)
  for (let i = result.nextChunk; i < stopAt; i++) {
    const range = chunkRanges[i]
    const logs = await retryRead(
      () =>
        client.getLogs({
          address: FACTORY,
          event: EVENT,
          fromBlock: BigInt(range.fromBlock),
          toBlock: BigInt(range.toBlock),
        }),
      retries,
      pause,
    )
    const additions = []
    for (const log of logs) {
      const block = Number(log.blockNumber)
      if (block < range.fromBlock || block > range.toBlock)
        throw new Error('Out-of-range factory log')
      if (!timestamps.has(block)) {
        const header = await retryRead(
          () => client.getBlock({ blockNumber: BigInt(block) }),
          retries,
          pause,
        )
        if (header.hash?.toLowerCase() !== log.blockHash?.toLowerCase())
          throw new Error('Log/header block hash mismatch; chain may have reorganized')
        timestamps.set(block, Number(header.timestamp))
      }
      additions.push(decodeCreation(log, timestamps.get(block)))
    }
    additions.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    result = {
      ...result,
      nextChunk: i + 1,
      events: [...result.events, ...additions],
      coverage: {
        fromBlock: from,
        throughBlock: range.toBlock,
        chunksComplete: i + 1,
        chunksExpected: chunkRanges.length,
      },
    }
    validateCheckpoint(result, expected)
    writeAtomic(out, result)
    onProgress(result)
  }
  if (result.nextChunk === chunkRanges.length) {
    const summary = summarize(result.events)
    if (summary.duplicateVaultCount || !summary.containsSkyVault)
      throw new Error('Complete scan failed unique-vault or known-vault verification')
    result = { ...result, status: 'complete', summary }
    await verifyChainAndEndBlock(client, to, retries, pause, result.endBlockHash)
    writeAtomic(out, result)
  }
  return result
}

function options(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value arguments')
    parsed[args[i].slice(2)] = args[i + 1]
  }
  return parsed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc')
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-factory-census.json')
  try {
    const result = await collect({
      client: makeClient(rpc),
      out,
      maxChunks: opts['max-chunks'] === undefined ? Infinity : Number(opts['max-chunks']),
      onProgress: (state) =>
        process.stdout.write(
          `chunks ${state.nextChunk}/${state.coverage.chunksExpected}, events ${state.events.length}\n`,
        ),
    })
    const bytes = readFileSync(out)
    process.stdout.write(
      JSON.stringify({
        path: out,
        status: result.status,
        coverage: result.coverage,
        summary: result.summary || null,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }) + '\n',
    )
  } catch (error) {
    // Provider errors may embed credential-bearing RPC URLs; never print their messages or causes.
    process.stderr.write(
      `Factory census stopped; checkpoint remains at ${out}. ${error.message.startsWith('RPC read failed') ? 'RPC read failed.' : 'Validation failed.'}\n`,
    )
    process.exitCode = 1
  }
}
