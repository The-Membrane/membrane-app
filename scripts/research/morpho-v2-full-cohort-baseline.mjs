// Outcome-blind treated baseline. Dry by default; --run true --max-anchors 32.
// This file reads the anchor block header only for source identity, never its state or a later exit outcome.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toEventSelector,
  toHex,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-full-cohort-treated-baseline-v1'
export const MANIFEST_SHA = '6c37829c74cf1897c6a86a409fddc1bdaf1e94b64169695df589f49214f1dbf5'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const LEGACY_FIRST20_SHA = '9b6755e9687c9303881bcbc71cafead0ae0904a42a27d1b89abb4a148b77dc66'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024
export const MAX_RAW_BYTES = 16 * 1024 * 1024
export const CHUNK_BLOCKS = 8_000
export const GAS = toHex(30_000_000)
export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[\da-f]{40}$/
const HASH = /^0x[\da-f]{64}$/
const SHA = /^[\da-f]{64}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export class TransferRpcError extends Error {}
export class TransferLedgerError extends Error {}
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})

export function verifySeal(value) {
  if (!value || !SHA.test(value.checkpointSha256 || '')) throw new Error('Missing seal')
  if (sha(JSON.stringify(unsigned(value))) !== value.checkpointSha256)
    throw new Error('Checkpoint seal mismatch')
  return value
}

export function guardDisk(path, proposedBytes = 0) {
  const root = existsSync(dirname(path)) ? dirname(path) : resolve('data/research/venue-signals')
  const stat = statfsSync(root)
  if (Number(stat.bavail) * Number(stat.bsize) - proposedBytes < RESERVE_BYTES)
    throw new Error('Disk reserve reached')
}

function save(path, object, cap) {
  const value = JSON.stringify(seal(object))
  const bytes = Buffer.byteLength(value)
  if (bytes > cap) throw new Error('Checkpoint output cap reached')
  guardDisk(path, bytes)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, value, { mode: 0o600 })
  renameSync(temp, path)
  return JSON.parse(value)
}

function pinned(path, expectedSha) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) throw new Error('Pinned source SHA mismatch')
  return JSON.parse(bytes)
}

export function selectAnchors(manifest, factory) {
  if (
    manifest.study !== 'morpho-v2-full-cohort-manifest-v1' ||
    manifest.status !== 'complete' ||
    manifest.chainId !== 1 ||
    manifest.summary?.anchors !== 304 ||
    manifest.factorySha256 !== FACTORY_SHA ||
    !Array.isArray(manifest.rows) ||
    manifest.rows.length !== 304 ||
    factory.study !== 'morpho-v2-factory-create-v1' ||
    factory.status !== 'complete' ||
    !Array.isArray(factory.events)
  )
    throw new Error('Frozen source metadata mismatch')
  const creations = new Map(factory.events.map((event) => [event.vault.toLowerCase(), event]))
  const seen = new Set()
  return manifest.rows.map((row, index) => {
    const vault = row.vault?.toLowerCase()
    const creation = creations.get(vault)
    if (
      !ADDRESS.test(vault || '') ||
      !HASH.test(row.anchorBlockHash || '') ||
      !HASH.test(row.anchorTxHash || '') ||
      !Number.isSafeInteger(row.anchorBlock) ||
      !Number.isSafeInteger(row.proposalIndex) ||
      !creation ||
      creation.block >= row.anchorBlock ||
      seen.has(row.proposalIndex) ||
      (index > 0 && row.anchorBlock < manifest.rows[index - 1].anchorBlock)
    )
      throw new Error('Frozen anchor identity or chronology mismatch')
    seen.add(row.proposalIndex)
    return {
      index,
      proposalIndex: row.proposalIndex,
      vault,
      anchorBlock: row.anchorBlock,
      anchorBlockHash: row.anchorBlockHash.toLowerCase(),
      creationBlock: creation.block,
      preBlock: row.anchorBlock - 1,
    }
  })
}

function decodeTransfer(log, anchor, start, end) {
  const topics = log.topics || []
  const block = Number(BigInt(log.blockNumber))
  const logIndex = Number(BigInt(log.logIndex))
  if (
    log.removed === true ||
    log.address?.toLowerCase() !== anchor.vault ||
    topics.length !== 3 ||
    topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
    !/^0x0{24}[\da-f]{40}$/i.test(topics[1] || '') ||
    !/^0x0{24}[\da-f]{40}$/i.test(topics[2] || '') ||
    !/^0x[\da-f]{64}$/i.test(log.data || '') ||
    !Number.isSafeInteger(block) ||
    block < start ||
    block > end ||
    !Number.isSafeInteger(logIndex) ||
    !HASH.test(log.blockHash?.toLowerCase() || '') ||
    !HASH.test(log.transactionHash?.toLowerCase() || '')
  )
    throw new Error('Malformed Transfer log')
  return {
    block,
    blockHash: log.blockHash.toLowerCase(),
    logIndex,
    txHash: log.transactionHash.toLowerCase(),
    from: `0x${topics[1].slice(26)}`.toLowerCase(),
    to: `0x${topics[2].slice(26)}`.toLowerCase(),
    value: BigInt(log.data).toString(),
  }
}

export function replayTransfers(logs) {
  const balances = new Map()
  let previousBlock = -1,
    previousIndex = -1
  for (const log of logs) {
    if (
      !Number.isSafeInteger(log.block) ||
      !Number.isSafeInteger(log.logIndex) ||
      log.block < previousBlock ||
      (log.block === previousBlock && log.logIndex <= previousIndex) ||
      !HASH.test(log.blockHash || '') ||
      !HASH.test(log.txHash || '') ||
      !ADDRESS.test(log.from || '') ||
      !ADDRESS.test(log.to || '') ||
      !/^\d+$/.test(log.value || '')
    )
      throw new Error('Invalid or unordered Transfer ledger')
    previousBlock = log.block
    previousIndex = log.logIndex
    const amount = BigInt(log.value)
    if (log.from === ZERO && log.to === ZERO) throw new Error('Zero-to-zero Transfer')
    if (log.from !== ZERO) {
      const next = (balances.get(log.from) || 0n) - amount
      if (next < 0n) throw new Error('Transfer ledger underflow')
      balances.set(log.from, next)
    }
    if (log.to !== ZERO) balances.set(log.to, (balances.get(log.to) || 0n) + amount)
  }
  return [...balances]
    .filter(([, shares]) => shares > 0n)
    .sort((a, b) =>
      a[1] === b[1] ? keccak256(a[0]).localeCompare(keccak256(b[0])) : a[1] > b[1] ? -1 : 1,
    )
}

export function baselineSize(assets, redeemable) {
  if (assets < 0n || redeemable < 0n) throw new Error('Negative baseline input')
  const a = assets / 1000n,
    b = redeemable / 10n
  return a < b ? a : b
}

export async function firstEoa(holders, readCode, batchSize = 8) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16)
    throw new Error('Invalid EOA batch size')
  for (let start = 0; start < holders.length; start += batchSize) {
    const batch = holders.slice(start, start + batchSize)
    const codes = await Promise.all(batch.map(([address]) => readCode(address)))
    for (let index = 0; index < batch.length; index++) {
      if (codes[index] === '0x') return batch[index]
    }
  }
  return null
}

export function validateRaw(raw, anchor, preBlockHash, allowPartial = false) {
  verifySeal(raw)
  if (
    raw.study !== 'morpho-v2-full-cohort-transfer-prefix-v1' ||
    raw.manifestSha256 !== MANIFEST_SHA ||
    raw.chainId !== 1 ||
    raw.vault !== anchor.vault ||
    raw.fromBlock !== anchor.creationBlock ||
    !Number.isSafeInteger(raw.throughBlock) ||
    raw.throughBlock > anchor.preBlock ||
    raw.throughBlock < anchor.creationBlock - 1 ||
    raw.preBlockHash !== preBlockHash ||
    !Array.isArray(raw.logs) ||
    (!allowPartial && raw.throughBlock !== anchor.preBlock)
  )
    throw new Error('Raw prefix metadata mismatch')
  if (raw.logs.some((log) => log.block > raw.throughBlock || log.block < anchor.creationBlock))
    throw new Error('Raw prefix coverage mismatch')
  replayTransfers(raw.logs)
  return raw
}

function legacyCache(anchor, legacy) {
  const result = legacy.results?.find(
    (item) => item.vault === anchor.vault && item.preBlock === anchor.preBlock,
  )
  if (!result) return null
  const path = result.rawLogPath
  if (result.proposalIndex !== anchor.proposalIndex || !path || !existsSync(path))
    throw new Error('Legacy cache anchor mismatch')
  const bytes = readFileSync(path)
  if (sha(bytes) !== result.rawLogSha256) throw new Error('Legacy cache physical SHA mismatch')
  const raw = JSON.parse(bytes)
  if (
    raw.study !== 'morpho-v2-pre-b-transfer-logs-v1' ||
    raw.status !== 'complete' ||
    raw.vault !== anchor.vault ||
    raw.proposalIndex !== anchor.proposalIndex ||
    raw.fromBlock !== anchor.creationBlock ||
    raw.throughBlock !== anchor.preBlock ||
    raw.nextBlock !== anchor.anchorBlock ||
    raw.logs.length !== result.rawLogCount ||
    !HASH.test(result.preBlockHash?.toLowerCase() || '')
  )
    throw new Error('Legacy cache metadata mismatch')
  replayTransfers(raw.logs)
  return {
    logs: raw.logs,
    expectedPreBlockHash: result.preBlockHash.toLowerCase(),
    sourceSha256: sha(bytes),
  }
}

function priorPrefix(rawDir, anchor, preBlockHash) {
  if (!existsSync(rawDir)) return null
  const pattern = new RegExp(`^${anchor.vault}-(\\d+)\\.json$`)
  const candidates = readdirSync(rawDir)
    .map((name) => ({ name, match: name.match(pattern) }))
    .filter(({ match }) => match && Number(match[1]) < anchor.preBlock)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
  for (const candidate of candidates) {
    const path = resolve(rawDir, candidate.name)
    const bytes = readFileSync(path)
    if (bytes.length > MAX_RAW_BYTES) throw new Error('Prior raw prefix cap exceeded')
    const raw = JSON.parse(bytes)
    // A partial earlier anchor must not be mistaken for a completed reusable prefix.
    if (raw.throughBlock !== Number(candidate.match[1])) continue
    // The earlier checkpoint has a different B-1 hash; validate its own metadata and seal.
    validateRaw(raw, { ...anchor, preBlock: raw.throughBlock }, raw.preBlockHash)
    if (!HASH.test(preBlockHash)) throw new Error('Invalid current pre-block hash')
    return {
      logs: raw.logs,
      throughBlock: raw.throughBlock,
      throughBlockHash: raw.preBlockHash,
      sourceSha256: sha(bytes),
    }
  }
  return null
}

async function rpc(client, path, method, params) {
  guardDisk(path)
  return client.request({ method, params })
}

async function header(client, path, block) {
  const value = await rpc(client, path, 'eth_getBlockByNumber', [toHex(block), false])
  if (
    !value ||
    Number(BigInt(value.number)) !== block ||
    !HASH.test(value.hash?.toLowerCase() || '')
  )
    throw new Error('Historical block header mismatch')
  return value.hash.toLowerCase()
}

export async function collectTransfers({ client, anchor, rawDir, preBlockHash, legacy }) {
  const rawPath = resolve(rawDir, `${anchor.vault}-${anchor.preBlock}.json`)
  if (existsSync(rawPath)) {
    const bytes = readFileSync(rawPath)
    if (bytes.length > MAX_RAW_BYTES) throw new Error('Raw prefix cap exceeded')
    const existing = validateRaw(JSON.parse(bytes), anchor, preBlockHash, true)
    if (existing.throughBlock === anchor.preBlock)
      return { raw: existing, rawPath, physicalSha256: sha(bytes) }
  }
  let raw = existsSync(rawPath) ? JSON.parse(readFileSync(rawPath)) : null
  if (!raw) {
    const old = legacy ? legacyCache(anchor, legacy) : null
    if (old) {
      if (old.expectedPreBlockHash !== preBlockHash) throw new Error('Legacy B-1 hash mismatch')
      raw = {
        study: 'morpho-v2-full-cohort-transfer-prefix-v1',
        manifestSha256: MANIFEST_SHA,
        chainId: 1,
        vault: anchor.vault,
        fromBlock: anchor.creationBlock,
        throughBlock: anchor.preBlock,
        preBlockHash,
        sourceSha256: old.sourceSha256,
        logs: old.logs,
      }
      const saved = save(rawPath, raw, MAX_RAW_BYTES)
      return { raw: saved, rawPath, physicalSha256: sha(readFileSync(rawPath)) }
    }
    const prefix = priorPrefix(rawDir, anchor, preBlockHash)
    if (prefix && (await header(client, rawPath, prefix.throughBlock)) !== prefix.throughBlockHash)
      throw new Error('Prior prefix block hash mismatch')
    raw = {
      study: 'morpho-v2-full-cohort-transfer-prefix-v1',
      manifestSha256: MANIFEST_SHA,
      chainId: 1,
      vault: anchor.vault,
      fromBlock: anchor.creationBlock,
      throughBlock: prefix?.throughBlock ?? anchor.creationBlock - 1,
      preBlockHash,
      sourceSha256: prefix?.sourceSha256 ?? null,
      logs: prefix?.logs ?? [],
    }
  }
  for (let start = raw.throughBlock + 1; start <= anchor.preBlock; ) {
    const end = Math.min(anchor.preBlock, start + CHUNK_BLOCKS - 1)
    let logs
    try {
      logs = await rpc(client, rawPath, 'eth_getLogs', [
        {
          address: anchor.vault,
          fromBlock: toHex(start),
          toBlock: toHex(end),
          topics: [TRANSFER_TOPIC],
        },
      ])
    } catch (error) {
      if (/Disk reserve/.test(error.message)) throw error
      throw new TransferRpcError('Transfer range RPC failed')
    }
    if (!Array.isArray(logs)) throw new TransferRpcError('Non-array Transfer result')
    let additions
    try {
      additions = logs
        .map((log) => decodeTransfer(log, anchor, start, end))
        .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
      replayTransfers([...raw.logs, ...additions])
    } catch {
      throw new TransferLedgerError('Transfer range ledger mismatch')
    }
    raw = save(
      rawPath,
      { ...raw, throughBlock: end, logs: [...raw.logs, ...additions] },
      MAX_RAW_BYTES,
    )
    start = end + 1
  }
  return { raw, rawPath, physicalSha256: sha(readFileSync(rawPath)) }
}

function isRevert(error) {
  const code = error?.code ?? error?.cause?.code
  return (
    code === 3 ||
    code === -32015 ||
    /execution reverted|vm execution error/i.test(error?.message || '')
  )
}

export async function probeAnchor({ client, anchor, rawDir, out, legacy }) {
  const preBlockHash = await header(client, out, anchor.preBlock)
  if ((await header(client, out, anchor.anchorBlock)) !== anchor.anchorBlockHash)
    throw new Error('Sealed anchor block hash mismatch')
  const result = {
    index: anchor.index,
    proposalIndex: anchor.proposalIndex,
    vault: anchor.vault,
    anchorBlock: anchor.anchorBlock,
    preBlock: anchor.preBlock,
    preBlockHash,
  }
  let collected
  try {
    collected = await collectTransfers({ client, anchor, rawDir, preBlockHash, legacy })
  } catch (error) {
    if (error instanceof TransferRpcError) return { ...result, status: 'transfer-rpc-ambiguous' }
    if (error instanceof TransferLedgerError)
      return { ...result, status: 'transfer-ledger-ambiguous' }
    throw error
  }
  const { raw, rawPath, physicalSha256 } = collected
  Object.assign(result, {
    rawPath,
    rawSha256: physicalSha256,
    transferLogCount: raw.logs.length,
    rawSourceSha256: raw.sourceSha256,
  })
  const holders = replayTransfers(raw.logs)
  const blockParam = { blockHash: preBlockHash, requireCanonical: true }
  const call = async (functionName, args = [], from = anchor.vault) => {
    const data = encodeFunctionData({ abi: ABI, functionName, args })
    const output = await rpc(client, out, 'eth_call', [
      { from, to: anchor.vault, data, gas: GAS },
      blockParam,
    ])
    return decodeFunctionResult({ abi: ABI, functionName, data: output })
  }
  try {
    const [code, totalSupply] = await Promise.all([
      rpc(client, out, 'eth_getCode', [anchor.vault, blockParam]),
      call('totalSupply'),
    ])
    if (!code || code === '0x') return { ...result, status: 'missing-vault-code' }
    result.runtimeCodeHash = keccak256(code)
    const summed = holders.reduce((sum, [, shares]) => sum + shares, 0n)
    result.totalSupply = totalSupply.toString()
    result.replayedSupply = summed.toString()
    if (summed !== totalSupply) return { ...result, status: 'holder-ledger-supply-mismatch' }
    const selected = await firstEoa(holders, (address) =>
      rpc(client, out, 'eth_getCode', [address, blockParam]),
    )
    if (!selected) return { ...result, status: 'no-positive-eoa-holder' }
    const [address, shares] = selected
    const onchainShares = await call('balanceOf', [address])
    if (onchainShares !== shares)
      return { ...result, holder: address, status: 'holder-ledger-balance-mismatch' }
    const [assets, redeemable] = await Promise.all([
      call('totalAssets'),
      call('previewRedeem', [shares]),
    ])
    const q = baselineSize(assets, redeemable)
    Object.assign(result, {
      holder: address,
      holderShares: shares.toString(),
      totalAssets: assets.toString(),
      previewRedeemable: redeemable.toString(),
      qAssets: q.toString(),
    })
    if (q === 0n) return { ...result, status: 'zero-baseline-size' }
    try {
      result.withdrawShares = (await call('withdraw', [q, address, address], address)).toString()
      if ((await header(client, out, anchor.preBlock)) !== preBlockHash)
        return { ...result, status: 'pre-block-reorg-ambiguous' }
      return { ...result, status: 'baseline-success' }
    } catch (error) {
      if (/Disk reserve/.test(error.message)) throw error
      return { ...result, status: isRevert(error) ? 'baseline-revert' : 'withdraw-rpc-ambiguous' }
    }
  } catch (error) {
    if (/Disk reserve/.test(error.message)) throw error
    return { ...result, status: 'historical-state-rpc-ambiguous' }
  }
}

export function verifyCheckpoint(saved, anchors) {
  verifySeal(saved)
  if (
    saved.study !== STUDY ||
    saved.chainId !== 1 ||
    saved.manifestSha256 !== MANIFEST_SHA ||
    saved.factorySha256 !== FACTORY_SHA ||
    !Array.isArray(saved.results) ||
    saved.results.length > anchors.length ||
    saved.status !== (saved.results.length === anchors.length ? 'complete' : 'partial')
  )
    throw new Error('Baseline checkpoint metadata mismatch')
  for (let i = 0; i < saved.results.length; i++) {
    const result = saved.results[i],
      anchor = anchors[i]
    if (
      result.index !== i ||
      result.proposalIndex !== anchor.proposalIndex ||
      result.vault !== anchor.vault ||
      result.anchorBlock !== anchor.anchorBlock ||
      result.preBlock !== anchor.preBlock ||
      !HASH.test(result.preBlockHash || '') ||
      !/^[a-z0-9-]+$/.test(result.status || '')
    )
      throw new Error('Baseline result frontier mismatch')
    if (result.rawPath) {
      const bytes = readFileSync(result.rawPath)
      if (sha(bytes) !== result.rawSha256 || bytes.length > MAX_RAW_BYTES)
        throw new Error('Baseline raw physical SHA mismatch')
      validateRaw(JSON.parse(bytes), anchor, result.preBlockHash)
    }
  }
  return saved
}

export async function run({
  client,
  manifestPath,
  factoryPath,
  out,
  rawDir,
  maxAnchors = 32,
  legacyPath,
}) {
  if (!Number.isInteger(maxAnchors) || maxAnchors < 1 || maxAnchors > 304)
    throw new Error('max-anchors must be 1..304')
  const manifest = pinned(manifestPath, MANIFEST_SHA)
  const factory = pinned(factoryPath, FACTORY_SHA)
  const anchors = selectAnchors(manifest, factory)
  const prefix = anchors.slice(0, maxAnchors)
  const legacy =
    legacyPath && existsSync(legacyPath) ? pinned(legacyPath, LEGACY_FIRST20_SHA) : null
  let saved = existsSync(out)
    ? verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), anchors)
    : seal({
        study: STUDY,
        chainId: 1,
        manifestSha256: MANIFEST_SHA,
        factorySha256: FACTORY_SHA,
        status: 'partial',
        results: [],
      })
  if (saved.results.length >= maxAnchors) return saved
  if (Number(BigInt(await rpc(client, out, 'eth_chainId', []))) !== 1)
    throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < maxAnchors; i++) {
    const result = await probeAnchor({ client, anchor: prefix[i], rawDir, out, legacy })
    if ((await header(client, out, prefix[i].anchorBlock)) !== prefix[i].anchorBlockHash)
      throw new Error('Sealed anchor block hash changed during baseline')
    // getLogs is a range query, not EIP-1898. Recheck the terminal B-1 header
    // for every status, including censored ones, before appending the row.
    try {
      if ((await header(client, out, prefix[i].preBlock)) !== result.preBlockHash)
        result.status = 'pre-block-reorg-ambiguous'
    } catch (error) {
      if (/Disk reserve/.test(error.message)) throw error
      result.status = 'pre-block-recheck-rpc-ambiguous'
    }
    saved = save(
      out,
      {
        ...saved,
        results: [...saved.results, result],
        status: i === anchors.length - 1 ? 'complete' : 'partial',
      },
      MAX_CHECKPOINT_BYTES,
    )
  }
  return saved
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value')
    opts[args[i].slice(2)] = args[i + 1]
  }
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    const mode = opts.run === 'true' ? 'run' : opts.verify === 'true' ? 'verify' : 'dry'
    if (opts.run && opts.verify) throw new Error('Conflicting modes')
    const base = 'data/research/venue-signals/'
    const manifestPath = resolve(opts.manifest || `${base}morpho-v2-full-cohort-manifest.json`)
    const factoryPath = resolve(opts.factory || `${base}${FACTORY_SHA}.json`)
    const out = resolve(opts.out || `${base}morpho-v2-full-cohort-baseline.json`)
    const rawDir = resolve(opts['raw-dir'] || `${base}morpho-v2-full-cohort-baseline-raw`)
    const legacyPath = resolve(opts.legacy || `${base}morpho-v2-exit-baseline-first20.json`)
    const maxAnchors = opts['max-anchors'] === undefined ? 32 : Number(opts['max-anchors'])
    if (!Number.isInteger(maxAnchors) || maxAnchors < 1 || maxAnchors > 304)
      throw new Error('max-anchors must be 1..304')
    if (mode === 'dry') {
      const anchors = selectAnchors(
        pinned(manifestPath, MANIFEST_SHA),
        pinned(factoryPath, FACTORY_SHA),
      )
      process.stdout.write(
        JSON.stringify({ mode, totalAnchors: anchors.length, nextBatch: maxAnchors }) + '\n',
      )
    } else if (mode === 'verify') {
      const anchors = selectAnchors(
        pinned(manifestPath, MANIFEST_SHA),
        pinned(factoryPath, FACTORY_SHA),
      )
      const saved = verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), anchors)
      process.stdout.write(
        JSON.stringify({ mode, completed: saved.results.length, sha256: sha(readFileSync(out)) }) +
          '\n',
      )
    } else {
      const rpcUrl = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpcUrl) throw new Error('Missing RPC')
      const saved = await run({
        client: makeClient(rpcUrl),
        manifestPath,
        factoryPath,
        out,
        rawDir,
        maxAnchors,
        legacyPath,
      })
      process.stdout.write(
        JSON.stringify({ mode, completed: saved.results.length, sha256: sha(readFileSync(out)) }) +
          '\n',
      )
    }
  } catch {
    // Never print provider errors: they can contain credential-bearing URLs.
    process.stderr.write('Full-cohort baseline stopped; source, RPC, or resource check failed.\n')
    process.exitCode = 1
  }
}
