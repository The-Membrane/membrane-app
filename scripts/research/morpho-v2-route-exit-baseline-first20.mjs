// Frozen PRE-OUTCOME route-switch feasibility pilot. Never query block B state.
// node scripts/research/morpho-v2-route-exit-baseline-first20.mjs --max-vaults 20
// node scripts/research/morpho-v2-route-exit-baseline-first20.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { replayTransfers, baselineSize, TRANSFER_TOPIC } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-route-exit-baseline-first20-v1'
export const HEADERS_SHA = '66595ce99bb86c86ddf38c8063c8f178bfbc4497043d61dab68762ab14deb4f6'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_RAW_BYTES = 20 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const CHUNK_BLOCKS = 8_000
const HASH = /^0x[\da-f]{64}$/i
const ADDRESS = /^0x[\da-f]{40}$/i
const ZERO = '0x0000000000000000000000000000000000000000'
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function asset() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unseal = ({ checkpointSha256, ...rest }) => rest
export const seal = (value) => ({ ...unseal(value), checkpointSha256: sha(JSON.stringify(unseal(value))) })

function pinned(path, expected, name) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error(`${name} SHA mismatch`)
  return JSON.parse(bytes)
}
function writeBounded(path, value, maxBytes) {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(value)
  const size = Buffer.byteLength(bytes)
  if (size > maxBytes) throw new Error('Checkpoint size cap reached')
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - size < RESERVE_BYTES)
    throw new Error('Checkpoint disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}
function int(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}
export function selectFirst20(headers, factory, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid pilot denominator')
  if (headers?.study !== 'morpho-v2-route-address-headers-v1' ||
      headers.status !== 'complete' || headers.chainId !== 1 ||
      headers.routeArtifactSha256 !== '45a7182cc2c5d38616ea066522789840559242e5758958f49a228e718fbcd786' ||
      headers.changes?.length !== 275 || !Array.isArray(headers.headers) ||
      factory?.study !== 'morpho-v2-factory-create-v1' || factory.status !== 'complete' ||
      !Array.isArray(factory.events) || factory.events.length !== 757)
    throw new Error('Incomplete frozen route/factory cohort')
  const creations = new Map(factory.events.map((x) => [x.vault.toLowerCase(), x]))
  const seen = new Set(), selected = []
  const ordered = [...headers.changes].sort((a, b) =>
    a.block - b.block || a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex || a.vault.localeCompare(b.vault))
  for (const change of ordered) {
    if (!ADDRESS.test(change.vault) || !ADDRESS.test(change.fromAdapter) ||
        !ADDRESS.test(change.toAdapter) || change.fromAdapter === change.toAdapter ||
        !Number.isSafeInteger(change.block) || change.block <= 0 ||
        !Number.isSafeInteger(change.transactionIndex) || !Number.isSafeInteger(change.logIndex) ||
        !HASH.test(change.blockHash) || !HASH.test(change.txHash))
      throw new Error('Invalid route-address transition')
    const vault = change.vault.toLowerCase()
    if (change.fromAdapter.toLowerCase() === ZERO || change.toAdapter.toLowerCase() === ZERO)
      continue
    if (seen.has(vault)) continue
    const creation = creations.get(vault)
    if (!creation || !Number.isSafeInteger(creation.block) || creation.block >= change.block ||
        !ADDRESS.test(creation.asset)) throw new Error('Missing pre-route vault creation')
    seen.add(vault)
    selected.push({ ...change, vault, fromAdapter: change.fromAdapter.toLowerCase(),
      toAdapter: change.toAdapter.toLowerCase(), creationBlock: creation.block,
      creationAsset: creation.asset.toLowerCase() })
    if (selected.length === limit) break
  }
  if (selected.length !== limit) throw new Error('Fewer than frozen pilot denominator')
  return selected
}

function decodeTransfer(log, anchor, start, end) {
  if (log.address?.toLowerCase() !== anchor.vault || log.topics?.length !== 3 ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase() ||
      !/^0x0{24}[\da-f]{40}$/i.test(log.topics[1]) ||
      !/^0x0{24}[\da-f]{40}$/i.test(log.topics[2]) ||
      !HASH.test(log.data) || log.removed === true)
    throw new Error('Malformed Transfer RPC log')
  const block = int(log.blockNumber), logIndex = int(log.logIndex)
  if (block < start || block > end || !HASH.test(log.blockHash) ||
      !HASH.test(log.transactionHash)) throw new Error('Out-of-range Transfer RPC log')
  return { block, blockHash: log.blockHash.toLowerCase(), logIndex,
    txHash: log.transactionHash.toLowerCase(),
    from: `0x${log.topics[1].slice(26)}`.toLowerCase(),
    to: `0x${log.topics[2].slice(26)}`.toLowerCase(),
    value: BigInt(log.data).toString() }
}
function rawExpected(anchor) {
  return { study: 'morpho-v2-route-pre-b-transfer-logs-v1', chainId: 1,
    headersSha256: HEADERS_SHA, factorySha256: FACTORY_SHA,
    vault: anchor.vault, routeBlock: anchor.block, routeTxHash: anchor.txHash,
    fromBlock: anchor.creationBlock, throughBlock: anchor.block - 1,
    chunkBlocks: CHUNK_BLOCKS }
}
export function validateRaw(raw, anchor) {
  const expected = rawExpected(anchor)
  for (const [key, value] of Object.entries(expected))
    if (raw?.[key] !== value) throw new Error('Raw-log metadata mismatch')
  if (!Array.isArray(raw.logs) || !Number.isSafeInteger(raw.nextBlock) ||
      raw.nextBlock < expected.fromBlock || raw.nextBlock > expected.throughBlock + 1 ||
      raw.status !== (raw.nextBlock === expected.throughBlock + 1 ? 'complete' : 'partial') ||
      !/^[\da-f]{64}$/.test(raw.checkpointSha256 || '') ||
      sha(JSON.stringify(unseal(raw))) !== raw.checkpointSha256 ||
      raw.logs.some((x) => x.block < expected.fromBlock || x.block >= raw.nextBlock))
    throw new Error('Raw-log checkpoint integrity/coverage mismatch')
  replayTransfers(raw.logs)
  return raw
}
export async function collectLedger({ client, anchor, path, onProgress = () => {} }) {
  const expected = rawExpected(anchor)
  let raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) :
    seal({ ...expected, nextBlock: expected.fromBlock, logs: [], status: 'partial' })
  validateRaw(raw, anchor)
  if (!existsSync(path)) writeBounded(path, raw, MAX_RAW_BYTES)
  while (raw.nextBlock <= expected.throughBlock) {
    const end = Math.min(expected.throughBlock, raw.nextBlock + CHUNK_BLOCKS - 1)
    const logs = await client.request({ method: 'eth_getLogs', params: [{
      address: anchor.vault, fromBlock: toHex(raw.nextBlock), toBlock: toHex(end),
      topics: [TRANSFER_TOPIC],
    }] })
    const additions = logs.map((x) => decodeTransfer(x, anchor, raw.nextBlock, end))
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    raw = seal({ ...unseal(raw), nextBlock: end + 1,
      logs: [...raw.logs, ...additions],
      status: end === expected.throughBlock ? 'complete' : 'partial' })
    validateRaw(raw, anchor)
    writeBounded(path, raw, MAX_RAW_BYTES)
    onProgress({ vault: anchor.vault, nextBlock: raw.nextBlock, throughBlock: raw.throughBlock })
  }
  return raw
}

async function baseline({ client, anchor, raw, rawPath }) {
  const at = BigInt(anchor.block - 1)
  const result = { vault: anchor.vault, block: anchor.block, txHash: anchor.txHash,
    preBlock: Number(at), rawLogPath: rawPath, rawLogSha256: sha(readFileSync(rawPath)),
    rawLogCount: raw.logs.length }
  try {
    const header = await client.getBlock({ blockNumber: at })
    result.preBlockHash = header.hash?.toLowerCase()
    if (int(header.number) !== Number(at) || !HASH.test(result.preBlockHash))
      return { ...result, status: 'invalid-pre-block-header' }
    const code = await client.getCode({ address: anchor.vault, blockNumber: at })
    result.runtimeCodeHash = code && code !== '0x' ? keccak256(code) : null
    if (!result.runtimeCodeHash) return { ...result, status: 'missing-vault-code' }
    const read = (functionName, args = []) => client.readContract({
      address: anchor.vault, abi: ABI, functionName, args, blockNumber: at,
    })
    result.route = (await read('liquidityAdapter')).toLowerCase()
    result.asset = (await read('asset')).toLowerCase()
    if (result.route !== anchor.fromAdapter) return { ...result, status: 'old-route-mismatch' }
    if (result.asset !== anchor.creationAsset) return { ...result, status: 'creation-asset-mismatch' }
    const holders = replayTransfers(raw.logs)
    const totalSupply = await read('totalSupply')
    const replayedSupply = holders.reduce((sum, [, balance]) => sum + balance, 0n)
    result.totalSupply = totalSupply.toString()
    result.replayedSupply = replayedSupply.toString()
    if (totalSupply !== replayedSupply) return { ...result, status: 'holder-ledger-supply-mismatch' }
    for (const [holder, shares] of holders) {
      const holderCode = await client.getCode({ address: holder, blockNumber: at })
      if (holderCode && holderCode !== '0x') continue
      result.holder = holder
      result.holderShares = shares.toString()
      const actual = await read('balanceOf', [holder])
      if (actual !== shares) return { ...result, actualShares: actual.toString(),
        status: 'holder-ledger-balance-mismatch' }
      const totalAssets = await read('totalAssets')
      const claim = await read('previewRedeem', [shares])
      const q = baselineSize(totalAssets, claim)
      result.totalAssets = totalAssets.toString()
      result.previewRedeemableAssets = claim.toString()
      result.qAssets = q.toString()
      if (q === 0n) return { ...result, status: 'zero-baseline-size' }
      const data = encodeFunctionData({ abi: ABI, functionName: 'withdraw',
        args: [q, holder, holder] })
      try {
        const output = await client.request({ method: 'eth_call', params: [
          { from: holder, to: anchor.vault, data, gas: toHex(20_000_000) }, toHex(at),
        ] })
        result.withdrawShares = decodeFunctionResult({ abi: ABI,
          functionName: 'withdraw', data: output }).toString()
        return { ...result, status: 'baseline-success' }
      } catch (error) {
        return { ...result, status: /revert|execution reverted/i.test(String(error?.message || ''))
          ? 'baseline-evm-revert' : 'baseline-rpc-error' }
      }
    }
    return { ...result, status: 'no-positive-eoa-holder' }
  } catch {
    return { ...result, status: 'pre-outcome-read-error' }
  }
}

function expectedOutput(anchors) {
  return { study: STUDY, chainId: 1, headersSha256: HEADERS_SHA,
    factorySha256: FACTORY_SHA, frozenDenominator: anchors.length, anchors }
}
export function validateOutput(saved, anchors, rawDir) {
  const expected = expectedOutput(anchors)
  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(saved?.[key]) !== JSON.stringify(value))
      throw new Error('Output metadata/selection mismatch')
  if (!Array.isArray(saved.results) || saved.results.length > anchors.length ||
      saved.status !== (saved.results.length === anchors.length ? 'complete' : 'partial') ||
      !/^[\da-f]{64}$/.test(saved.checkpointSha256 || '') ||
      sha(JSON.stringify(unseal(saved))) !== saved.checkpointSha256)
    throw new Error('Output checkpoint integrity mismatch')
  for (let i = 0; i < saved.results.length; i++) {
    const row = saved.results[i], anchor = anchors[i]
    const path = resolve(rawDir, `${anchor.vault}-${anchor.block}-pre-b-route-transfers.json`)
    if (row.vault !== anchor.vault || row.block !== anchor.block ||
        row.preBlock !== anchor.block - 1 || row.rawLogPath !== path || !existsSync(path))
      throw new Error('Output result/anchor mismatch')
    const bytes = readFileSync(path)
    if (sha(bytes) !== row.rawLogSha256) throw new Error('Completed raw ledger SHA mismatch')
    const raw = validateRaw(JSON.parse(bytes), anchor)
    if (raw.status !== 'complete' || raw.logs.length !== row.rawLogCount)
      throw new Error('Completed raw ledger coverage mismatch')
  }
  return saved
}
export async function run({ client, headersPath, factoryPath, out, rawDir,
  maxVaults = 20, onProgress = () => {} }) {
  const headers = pinned(headersPath, HEADERS_SHA, 'Route headers')
  const factory = pinned(factoryPath, FACTORY_SHA, 'Factory')
  const anchors = selectFirst20(headers, factory, maxVaults)
  const expected = expectedOutput(anchors)
  let saved = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) :
    seal({ ...expected, status: 'partial', results: [] })
  validateOutput(saved, anchors, rawDir)
  if (!existsSync(out)) writeBounded(out, saved, MAX_OUTPUT_BYTES)
  if (saved.status === 'complete') return saved
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < anchors.length; i++) {
    const anchor = anchors[i]
    const rawPath = resolve(rawDir, `${anchor.vault}-${anchor.block}-pre-b-route-transfers.json`)
    const raw = await collectLedger({ client, anchor, path: rawPath, onProgress })
    const result = await baseline({ client, anchor, raw, rawPath })
    saved = seal({ ...unseal(saved), results: [...saved.results, result],
      status: i + 1 === anchors.length ? 'complete' : 'partial' })
    validateOutput(saved, anchors, rawDir)
    writeBounded(out, saved, MAX_OUTPUT_BYTES)
    onProgress({ completed: saved.results.length, denominator: anchors.length,
      vault: anchor.vault, result: result.status })
  }
  return saved
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
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-route-exit-baseline-first20.json')
  try {
    const headersPath = resolve(opts.headers || 'data/research/venue-signals/morpho-v2-route-address-headers.json')
    const factoryPath = resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`)
    const rawDir = resolve(opts['raw-dir'] || 'data/research/venue-signals/morpho-v2-route-exit-baseline-raw')
    const maxVaults = opts['max-vaults'] === undefined ? 20 : Number(opts['max-vaults'])
    const headers = pinned(headersPath, HEADERS_SHA, 'Route headers')
    const factory = pinned(factoryPath, FACTORY_SHA, 'Factory')
    const anchors = selectFirst20(headers, factory, maxVaults)
    const saved = opts.verify === 'true'
      ? validateOutput(JSON.parse(readFileSync(out, 'utf8')), anchors, rawDir)
      : await run({ client: makeClient(opts.rpc || process.env.RECORDER_RPC_URL ||
          readEnv().get('RECORDER_RPC_URL')), headersPath, factoryPath, out, rawDir,
        maxVaults, onProgress: (x) => process.stdout.write(JSON.stringify(x) + '\n') })
    process.stdout.write(JSON.stringify({ path: out, status: saved.status,
      completed: saved.results.length, denominator: anchors.length,
      sha256: sha(readFileSync(out)) }) + '\n')
  } catch (error) {
    // Never print provider exceptions: they may contain credential-bearing RPC URLs.
    process.stderr.write(`Route pre-outcome baseline stopped; checkpoint remains at ${out}. ` +
      (error.message === 'Wrong chain ID' ? 'Wrong chain ID.' : 'Validation/RPC/resource guard failed.') + '\n')
    process.exitCode = 1
  }
}
