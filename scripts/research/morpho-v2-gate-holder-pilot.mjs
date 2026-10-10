// Five-candidate, pre-Submit-only Morpho V2 receive-assets gate feasibility pilot.
// Never reads Accept, future gate state, or future withdrawal outcomes.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  toHex,
} from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { replayTransfers } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-gate-holder-pilot-v1'
export const GATE_CENSUS_SHA = '640896b7a8c3df26cec02a524a089de0da0a33cba36146f4802ccda08b757f62'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const RAW_STUDY = 'morpho-v2-gate-holder-pre-b-transfers-v1'
export const CHUNK_BLOCKS = 8_000
// This five-vault pilot is capped at 10 MiB of raw data; keep >2.5 GiB headroom.
export const MIN_FREE_BYTES = 2.5 * 1024 ** 3
export const MAX_RAW_BYTES = 10 * 1024 ** 2
const ZERO = `0x${'0'.repeat(40)}`
const HASH = /^0x[\da-f]{64}$/i
const ADDRESS = /^0x[\da-f]{40}$/i
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const TRANSFER_TOPIC = toEventSelector(TRANSFER)
const VAULT_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])
const GATE_ABI = parseAbi(['function canReceiveAssets(address account) view returns (bool)'])

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const logsSha = (logs) => sha(Buffer.from(JSON.stringify(logs)))
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned input SHA mismatch')
  return JSON.parse(bytes)
}
function checkedNumber(value) {
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe RPC integer')
  return number
}
export function freeBytes(path) {
  const state = statfsSync(path)
  return Number(state.bavail) * Number(state.bsize)
}
function guardDisk(path, minimum = MIN_FREE_BYTES) {
  if (freeBytes(path) < minimum) throw new Error('Disk free space below pilot reserve; checkpoint preserved')
}
function guardRawSize(rawPath, next, maximum = MAX_RAW_BYTES) {
  const directory = dirname(rawPath)
  const existing = readdirSync(directory)
    .filter((name) => name.endsWith('-pre-b-transfers.json'))
    .reduce((sum, name) => sum + statSync(resolve(directory, name)).size, 0)
  const oldSize = existsSync(rawPath) ? statSync(rawPath).size : 0
  if (existing - oldSize + Buffer.byteLength(JSON.stringify(next)) > maximum)
    throw new Error('Gate-holder raw cache would exceed 10 MiB; checkpoint preserved')
}

export function selectFive(census, factory) {
  if (
    census.study !== 'morpho-v2-gate-submit-census-v1' ||
    census.status !== 'complete' ||
    census.chainId !== 1 ||
    census.factoryArtifactSha256 !== FACTORY_SHA ||
    census.summary?.classes?.candidate !== 5 ||
    !Array.isArray(census.rawEvents) ||
    !Array.isArray(census.classifications) ||
    census.rawEvents.length !== census.classifications.length ||
    factory.study !== 'morpho-v2-factory-create-v1' ||
    factory.status !== 'complete' ||
    factory.events?.length !== 757
  )
    throw new Error('Frozen gate/factory cohort mismatch')
  const created = new Map(factory.events.map((x) => [x.vault.toLowerCase(), x]))
  const selected = census.rawEvents.flatMap((event, index) => {
    const classification = census.classifications[index]
    if (classification.class !== 'candidate') return []
    const creation = created.get(event.vault.toLowerCase())
    if (
      !creation ||
      creation.block >= event.block ||
      classification.kind !== 'receive-assets' ||
      classification.leadSeconds !== 259_200 ||
      classification.preState?.gateAtSubmit !== ZERO ||
      !ADDRESS.test(classification.proposedGate) ||
      classification.proposedGate === ZERO
    )
      throw new Error('Frozen gate candidate changed')
    return [{
      index,
      vault: event.vault.toLowerCase(),
      block: event.block,
      blockHash: event.blockHash,
      txHash: event.txHash,
      logIndex: event.logIndex,
      creationBlock: creation.block,
      proposedGate: classification.proposedGate,
    }]
  })
  if (selected.length !== 5 || new Set(selected.map((x) => x.vault)).size !== 5)
    throw new Error('Expected exactly five distinct gate candidates')
  return selected
}

function decodeTransfer(log, anchor, first, last) {
  if (
    log.address?.toLowerCase() !== anchor.vault ||
    log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase() ||
    log.removed === true
  )
    throw new Error('Unexpected Transfer log')
  const block = checkedNumber(log.blockNumber),
    logIndex = checkedNumber(log.logIndex)
  if (
    block < first ||
    block > last ||
    !HASH.test(log.blockHash) ||
    !HASH.test(log.transactionHash)
  )
    throw new Error('Malformed Transfer coordinates')
  const { args } = decodeEventLog({ abi: [TRANSFER], topics: log.topics, data: log.data, strict: true })
  return {
    block,
    blockHash: log.blockHash,
    logIndex,
    txHash: log.transactionHash,
    from: args.from.toLowerCase(),
    to: args.to.toLowerCase(),
    value: args.value.toString(),
  }
}

async function retry(operation, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= retries) throw new Error('RPC read failed', { cause: error })
      await new Promise((done) => setTimeout(done, 500 * 2 ** attempt))
    }
  }
}

export async function collectTransfers({ client, anchor, rawPath, minFreeBytes = MIN_FREE_BYTES, onProgress = () => {} }) {
  mkdirSync(dirname(rawPath), { recursive: true })
  const throughBlock = anchor.block - 1
  const expected = {
    study: RAW_STUDY,
    chainId: 1,
    gateCensusSha256: GATE_CENSUS_SHA,
    vault: anchor.vault,
    proposalIndex: anchor.index,
    fromBlock: anchor.creationBlock,
    throughBlock,
    chunkBlocks: CHUNK_BLOCKS,
  }
  let saved = existsSync(rawPath)
    ? JSON.parse(readFileSync(rawPath, 'utf8'))
    : { ...expected, nextBlock: anchor.creationBlock, logs: [], logsSha256: logsSha([]), status: 'partial' }
  for (const [key, value] of Object.entries(expected))
    if (saved[key] !== value) throw new Error('Transfer checkpoint metadata mismatch')
  if (
    !Number.isSafeInteger(saved.nextBlock) ||
    saved.nextBlock < expected.fromBlock ||
    saved.nextBlock > throughBlock + 1 ||
    !Array.isArray(saved.logs) ||
    saved.status !== (saved.nextBlock === throughBlock + 1 ? 'complete' : 'partial') ||
    saved.logs.some((x) => x.block >= saved.nextBlock)
  )
    throw new Error('Transfer checkpoint frontier mismatch')
  if (!Array.isArray(saved.logs) || !/^[\da-f]{64}$/i.test(saved.logsSha256 || '') || saved.logsSha256 !== logsSha(saved.logs))
    throw new Error('Transfer checkpoint raw SHA mismatch')
  replayTransfers(saved.logs)
  while (saved.nextBlock <= throughBlock) {
    guardDisk(dirname(rawPath), minFreeBytes)
    const end = Math.min(throughBlock, saved.nextBlock + CHUNK_BLOCKS - 1)
    const logs = await retry(() => client.request({
      method: 'eth_getLogs',
      params: [{
        address: anchor.vault,
        fromBlock: toHex(saved.nextBlock),
        toBlock: toHex(end),
        topics: [TRANSFER_TOPIC],
      }],
    }))
    const additions = logs
      .map((log) => decodeTransfer(log, anchor, saved.nextBlock, end))
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    replayTransfers([...saved.logs, ...additions])
    const next = {
      ...saved,
      nextBlock: end + 1,
      logs: [...saved.logs, ...additions],
      status: end === throughBlock ? 'complete' : 'partial',
    }
    next.logsSha256 = logsSha(next.logs)
    guardRawSize(rawPath, next)
    saved = next
    atomic(rawPath, saved)
    onProgress({ vault: anchor.vault, nextBlock: saved.nextBlock, throughBlock })
  }
  return saved
}

export function classifyGateError(error) {
  const names = [], messages = []
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    names.push(String(current.name || ''))
    messages.push(String(current.shortMessage || current.details || current.message || ''))
  }
  const name = names.join(' '), message = messages.join(' ').toLowerCase()
  if (/ContractFunctionRevertedError|CallExecutionError/.test(name) && /revert/.test(message))
    return 'revert'
  if (/execution reverted|reverted with reason|vm execution error.*revert/.test(message))
    return 'revert'
  return 'rpc-error'
}

export async function probeGate({ client, gate, account, preBlock, caller, gas = 20_000_000n }) {
  const data = encodeFunctionData({ abi: GATE_ABI, functionName: 'canReceiveAssets', args: [account] })
  try {
    const output = await client.request({
      method: 'eth_call',
      params: [{ to: gate, data, gas: toHex(gas), ...(caller ? { from: caller } : {}) }, toHex(preBlock)],
    })
    try {
      const value = decodeFunctionResult({ abi: GATE_ABI, functionName: 'canReceiveAssets', data: output })
      return { status: value ? 'true' : 'false', output }
    } catch {
      return { status: 'malformed-return', output }
    }
  } catch (error) {
    return { status: classifyGateError(error) }
  }
}

export async function probeAnchor({ client, anchor, rawPath, minFreeBytes = MIN_FREE_BYTES, onProgress = () => {} }) {
  const raw = await collectTransfers({ client, anchor, rawPath, minFreeBytes, onProgress })
  const holders = replayTransfers(raw.logs)
  const preBlock = anchor.block - 1
  const [header, vaultCode, gateCode, supply] = await Promise.all([
    retry(() => client.getBlock({ blockNumber: BigInt(preBlock) })),
    retry(() => client.getCode({ address: anchor.vault, blockNumber: BigInt(preBlock) })),
    retry(() => client.getCode({ address: anchor.proposedGate, blockNumber: BigInt(preBlock) })),
    retry(() => client.readContract({ address: anchor.vault, abi: VAULT_ABI, functionName: 'totalSupply', blockNumber: BigInt(preBlock) })),
  ])
  const replayedSupply = holders.reduce((sum, [, amount]) => sum + amount, 0n)
  const base = {
    ...anchor,
    preBlock,
    preBlockHash: header.hash,
    rawPath,
    rawSha256: sha(readFileSync(rawPath)),
    rawLogCount: raw.logs.length,
    holderCount: holders.length,
    totalSupply: supply.toString(),
    replayedSupply: replayedSupply.toString(),
    vaultCodeHash: vaultCode && vaultCode !== '0x' ? keccak256(vaultCode) : null,
    gateCodeHash: gateCode && gateCode !== '0x' ? keccak256(gateCode) : null,
  }
  if (!HASH.test(header.hash) || !base.vaultCodeHash || !base.gateCodeHash)
    return { ...base, status: 'missing-code-or-header' }
  if (supply !== replayedSupply) return { ...base, status: 'holder-ledger-supply-mismatch' }
  for (const [account, shares] of holders) {
    const code = await retry(() => client.getCode({ address: account, blockNumber: BigInt(preBlock) }))
    if (code && code !== '0x') continue
    const balance = await retry(() => client.readContract({
      address: anchor.vault,
      abi: VAULT_ABI,
      functionName: 'balanceOf',
      args: [account],
      blockNumber: BigInt(preBlock),
    }))
    if (balance !== shares)
      return { ...base, status: 'holder-ledger-balance-mismatch', account, replayedShares: shares.toString(), onchainShares: balance.toString() }
    const holderGate = await probeGate({ client, gate: anchor.proposedGate, account, preBlock })
    const vaultGate = await probeGate({ client, gate: anchor.proposedGate, account: anchor.vault, preBlock })
    return {
      ...base,
      status: 'probed',
      holder: account,
      holderShares: shares.toString(),
      holderCode: '0x',
      holderGate,
      vaultGate,
    }
  }
  return { ...base, status: 'no-positive-eoa-holder' }
}

export function verifyResultPrefix(saved, anchors, rawDir) {
  if (!Array.isArray(saved.results) || saved.results.length > anchors.length)
    throw new Error('Pilot result frontier mismatch')
  for (let i = 0; i < saved.results.length; i++) {
    const result = saved.results[i], anchor = anchors[i]
    const rawPath = resolve(rawDir, `${anchor.vault}-${anchor.block}-pre-b-transfers.json`)
    if (result.vault !== anchor.vault || result.preBlock !== anchor.block - 1 || result.rawPath !== rawPath)
      throw new Error('Pilot result/anchor mismatch')
    const bytes = readFileSync(rawPath)
    if (sha(bytes) !== result.rawSha256) throw new Error('Pilot raw SHA mismatch')
    const raw = JSON.parse(bytes)
    if (
      raw.study !== RAW_STUDY ||
      raw.gateCensusSha256 !== GATE_CENSUS_SHA ||
      raw.status !== 'complete' ||
      raw.vault !== anchor.vault ||
      raw.nextBlock !== anchor.block ||
      raw.logsSha256 !== logsSha(raw.logs) ||
      raw.logs?.length !== result.rawLogCount
    )
      throw new Error('Pilot raw metadata mismatch')
    const holders = replayTransfers(raw.logs)
    if (holders.reduce((sum, [, amount]) => sum + amount, 0n).toString() !== result.replayedSupply)
      throw new Error('Pilot raw replay mismatch')
  }
}

export function verifyOffline({ out, rawDir, censusPath, factoryPath }) {
  const census = pinned(censusPath, GATE_CENSUS_SHA)
  const factory = pinned(factoryPath, FACTORY_SHA)
  const anchors = selectFive(census, factory)
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (
    saved.study !== STUDY ||
    saved.gateCensusSha256 !== GATE_CENSUS_SHA ||
    saved.factorySha256 !== FACTORY_SHA ||
    saved.status !== 'complete' ||
    JSON.stringify(saved.anchors) !== JSON.stringify(anchors) ||
    saved.results?.length !== 5
  )
    throw new Error('Pilot checkpoint mismatch')
  verifyResultPrefix(saved, anchors, rawDir)
  return { checkpointSha256: sha(readFileSync(out)), results: saved.results.map((result) => ({ vault: result.vault, status: result.status, holderGate: result.holderGate?.status || null, vaultGate: result.vaultGate?.status || null, rawLogCount: result.rawLogCount })) }
}

export async function run({ client, out, rawDir, censusPath, factoryPath, minFreeBytes = MIN_FREE_BYTES, onProgress = () => {} }) {
  const census = pinned(censusPath, GATE_CENSUS_SHA)
  const factory = pinned(factoryPath, FACTORY_SHA)
  const anchors = selectFive(census, factory)
  const expected = { study: STUDY, gateCensusSha256: GATE_CENSUS_SHA, factorySha256: FACTORY_SHA, anchors }
  let saved = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { ...expected, status: 'partial', results: [] }
  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(saved[key]) !== JSON.stringify(value)) throw new Error('Pilot checkpoint metadata mismatch')
  if (!Array.isArray(saved.results) || saved.results.length > 5 || saved.status !== (saved.results.length === 5 ? 'complete' : 'partial'))
    throw new Error('Pilot frontier mismatch')
  verifyResultPrefix(saved, anchors, rawDir)
  if (saved.status === 'complete') return saved
  if ((await retry(() => client.getChainId())) !== 1) throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < 5; i++) {
    guardDisk(dirname(out), minFreeBytes)
    const anchor = anchors[i]
    const rawPath = resolve(rawDir, `${anchor.vault}-${anchor.block}-pre-b-transfers.json`)
    const result = await probeAnchor({ client, anchor, rawPath, minFreeBytes, onProgress })
    saved = { ...saved, results: [...saved.results, result], status: i === 4 ? 'complete' : 'partial' }
    atomic(out, saved)
    onProgress({ vault: anchor.vault, completed: saved.results.length, status: result.status, holderGate: result.holderGate?.status || null })
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
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-gate-holder-pilot.json')
  const rawDir = resolve(opts['raw-dir'] || 'data/research/venue-signals/morpho-v2-gate-holder-raw')
  const censusPath = resolve(opts.census || `data/research/venue-signals/morpho-v2-gate-submit-census.json`)
  const factoryPath = resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`)
  try {
    if (opts.verify === 'offline') {
      process.stdout.write(JSON.stringify(verifyOffline({ out, rawDir, censusPath, factoryPath })) + '\n')
    } else {
      const rpc = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpc) throw new Error('RECORDER_RPC_URL missing')
      const saved = await run({ client: makeClient(rpc), out, rawDir, censusPath, factoryPath, onProgress: (progress) => process.stdout.write(JSON.stringify(progress) + '\n') })
      process.stdout.write(JSON.stringify({ status: saved.status, completed: saved.results.length }) + '\n')
    }
  } catch (error) {
    // RPC error causes may contain credential-bearing URLs. Never print them.
    process.stderr.write(`Gate holder pilot stopped; checkpoint remains at ${out}. ${error.message === 'RPC read failed' ? 'RPC read failed.' : error.message.startsWith('Disk free') ? 'Disk guard reached.' : 'Validation failed.'}\n`)
    process.exitCode = 1
  }
}
