// One pre-outcome Morpho cap transaction, one treated vault and four frozen controls.
// Dry by default. Live collection requires --run --max-steps N; --verify is offline.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { FACTORY_SHA, SUBMIT_SHA, readSources } from './morpho-v2-cap-lifecycle-census.mjs'
import { verify as verifyWatch } from './morpho-v2-cap-prospective-watch.mjs'

export const STUDY = 'morpho-v2-cap-prospective-fixed-exit-baseline-v1'
export const B = 26_061_710
export const B_HASH = '0x02c469f7e342ae291b85c187a30e13be262728afb14c761cf35ced8cd86ae981'
export const WATCH_B_SHA = '50f84b28cfa9b6e5fe1a724377d5ad9959968662852874cb77a8d3c9b5a2834b'
export const PROPOSAL_TX = '0x8bd1bf90702b593ce3a847c8d2a3899da3d6529a8303859cd38665006fd00175'
export const TREATED = '0xc207d3f66537d7f66456808379a0e560cf20da36'
export const CONTROLS = [
  '0x195b3a57dd0480534c84a5607a52a92304fa81f2',
  '0x3833c5f51c1af6435e34d2fbddb4ba94612f1a79',
  '0x0bd9bc3c61406b3851c9c09950235205ff3a2d5f',
  '0x49379379529ef1ff7c4adc5364be33ba8666df4e',
]
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const Q = 1_000_000_000_000n
export const CHUNK_BLOCKS = 1_000
export const MAX_STEPS = 4
export const MAX_RPC_PER_STEP = 256
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_SEGMENT_BYTES = 4 * 1024 * 1024
export const RESERVE_BYTES = 1_000_000_000
export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)').toLowerCase()
const ZERO = `0x${'0'.repeat(40)}`
const DEAD = `0x${'0'.repeat(36)}dead`
const HASH = /^0x[\da-f]{64}$/
const ADDRESS = /^0x[\da-f]{40}$/
const DECIMAL = /^(0|[1-9]\d*)$/
const HEX = /^0x(?:[\da-f]{2})*$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const RESULT_STATUSES = new Set([
  'missing-or-invalid-vault-code',
  'asset-identity-mismatch',
  'transfer-ledger-supply-mismatch',
  'holder-code-rpc-ambiguous',
  'no-positive-code-empty-eoa',
  'holder-ledger-balance-mismatch',
  'holder-claim-below-fixed-q',
  'baseline-revert',
  'withdraw-rpc-ambiguous',
  'historical-state-rpc-ambiguous',
  'baseline-success',
])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const unsigned = ({ segmentSha256, ...rest }) => rest
const seal = (segment) => ({
  ...unsigned(segment),
  segmentSha256: sha(JSON.stringify(unsigned(segment))),
})
const defaultRoot = resolve('data/research/venue-signals')
const defaultOut = resolve('data/research/venue-signals/morpho-v2-cap-prospective-baseline')
const defaultWatch = resolve('data/research/venue-signals/morpho-v2-cap-prospective-watch')

function quantity(value) {
  const n = Number(typeof value === 'string' ? BigInt(value) : value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid RPC quantity')
  return n
}
function block(value, expected) {
  const number = quantity(value?.number)
  if (
    !HASH.test(value?.hash?.toLowerCase() || '') ||
    (expected !== undefined && number !== expected)
  )
    throw new Error('Canonical block identity mismatch')
  return {
    number,
    hash: value.hash.toLowerCase(),
    parentHash: HASH.test(value.parentHash?.toLowerCase() || '')
      ? value.parentHash.toLowerCase()
      : null,
  }
}
const pinned = (path, expectedSha) => {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) throw new Error('Pinned source physical SHA mismatch')
  return JSON.parse(bytes)
}

export function loadPlan({ root = defaultRoot, watch = defaultWatch } = {}) {
  const factory = pinned(join(root, `${FACTORY_SHA}.json`), FACTORY_SHA)
  const submitPath = join(root, `${SUBMIT_SHA}.json`)
  const sources = readSources(join(root, `${FACTORY_SHA}.json`), submitPath)
  const watched = verifyWatch({ out: watch, sources, requireExisting: true })
  const baselineWatchBytes = readFileSync(join(watch, '000026060741-000026061710.json'))
  const baselineWatchSegment = JSON.parse(baselineWatchBytes)
  if (
    watched.throughBlock < B ||
    sha(baselineWatchBytes) !== WATCH_B_SHA ||
    baselineWatchSegment.to !== B ||
    baselineWatchSegment.toHash !== B_HASH
  )
    throw new Error('Frozen watcher baseline frontier mismatch')
  const creations = new Map(factory.events.map((event) => [event.vault.toLowerCase(), event]))
  const treated = creations.get(TREATED)
  if (treated?.block !== 25_938_780 || treated.asset?.toLowerCase() !== USDC)
    throw new Error('Frozen treated creation mismatch')
  const sorted = factory.events
    .filter(
      (event) =>
        event.vault.toLowerCase() !== TREATED &&
        event.asset?.toLowerCase() === USDC &&
        event.block <= B,
    )
    .sort(
      (a, b) =>
        Math.abs(a.block - treated.block) - Math.abs(b.block - treated.block) ||
        a.vault.toLowerCase().localeCompare(b.vault.toLowerCase()),
    )
    .slice(0, 4)
    .map((event) => event.vault.toLowerCase())
  if (JSON.stringify(sorted) !== JSON.stringify(CONTROLS))
    throw new Error('Frozen nearest-four control selection mismatch')
  const proposalName = '000026052741-000026053740.json'
  const proposalBytes = readFileSync(join(watch, proposalName))
  const proposal = JSON.parse(proposalBytes)
  const legs = proposal.events.filter(
    (event) =>
      event.kind === 'submit' &&
      event.raw.transactionHash === PROPOSAL_TX &&
      event.detail.vault === TREATED,
  )
  const capPairs = new Map()
  for (const leg of legs) {
    const { allocationId, kind, proposedCap } = leg.detail.cap
    const pair = capPairs.get(allocationId) || {}
    if (pair[kind]) throw new Error('Duplicate proposed cap leg')
    pair[kind] = proposedCap
    capPairs.set(allocationId, pair)
  }
  if (
    legs.length !== 4 ||
    !legs.every(
      (leg) => leg.raw.blockNumber === 26_053_355 && leg.detail.executableAt === '1790585111',
    ) ||
    capPairs.size !== 2 ||
    [...capPairs.values()].some(
      (pair) => pair.absolute !== '5000000000000' || pair.relative !== '1000000000000000000',
    )
  )
    throw new Error('Frozen one-transaction proposal mismatch')
  return {
    study: STUDY,
    factorySha256: FACTORY_SHA,
    submitSha256: SUBMIT_SHA,
    watcherFrontierSha256: WATCH_B_SHA,
    proposalSegmentSha256: sha(proposalBytes),
    baselineBlock: B,
    baselineHash: B_HASH,
    proposalTx: PROPOSAL_TX,
    qRaw: Q.toString(),
    vaults: [TREATED, ...CONTROLS].map((vault, index) => ({
      index,
      role: index ? 'control' : 'treated',
      vault,
      creationBlock: creations.get(vault).block,
      creationHash: creations.get(vault).blockHash.toLowerCase(),
      asset: USDC,
    })),
  }
}

function decodeTransfer(log, vault, from, to) {
  const topics = log?.topics || []
  const blockNumber = quantity(log?.blockNumber),
    logIndex = quantity(log?.logIndex)
  if (
    log.removed === true ||
    log.address?.toLowerCase() !== vault ||
    blockNumber < from ||
    blockNumber > to ||
    !HASH.test(log.blockHash?.toLowerCase() || '') ||
    !HASH.test(log.transactionHash?.toLowerCase() || '') ||
    topics.length !== 3 ||
    topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
    !/^0x0{24}[\da-f]{40}$/i.test(topics[1] || '') ||
    !/^0x0{24}[\da-f]{40}$/i.test(topics[2] || '') ||
    !HASH.test(log.data?.toLowerCase() || '')
  )
    throw new Error('Malformed Transfer log')
  return {
    block: blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    logIndex,
    txHash: log.transactionHash.toLowerCase(),
    from: `0x${topics[1].slice(26)}`.toLowerCase(),
    to: `0x${topics[2].slice(26)}`.toLowerCase(),
    value: BigInt(log.data).toString(),
  }
}

export function replay(logs) {
  const balances = new Map()
  let lastBlock = -1,
    lastIndex = -1
  for (const log of logs) {
    if (
      !Number.isSafeInteger(log.block) ||
      !Number.isSafeInteger(log.logIndex) ||
      log.block < lastBlock ||
      (log.block === lastBlock && log.logIndex <= lastIndex) ||
      !HASH.test(log.blockHash) ||
      !HASH.test(log.txHash) ||
      !ADDRESS.test(log.from) ||
      !ADDRESS.test(log.to) ||
      !DECIMAL.test(log.value)
    )
      throw new Error('Invalid or unordered Transfer ledger')
    lastBlock = log.block
    lastIndex = log.logIndex
    const value = BigInt(log.value)
    if (log.from === ZERO && log.to === ZERO) throw new Error('Zero-to-zero Transfer')
    if (log.from !== ZERO) {
      const next = (balances.get(log.from) || 0n) - value
      if (next < 0n) throw new Error('Transfer ledger underflow')
      balances.set(log.from, next)
    }
    if (log.to !== ZERO) balances.set(log.to, (balances.get(log.to) || 0n) + value)
  }
  return [...balances]
    .filter(([, n]) => n > 0n)
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
}

function names(path) {
  if (!existsSync(path)) return []
  const all = readdirSync(path)
  if (
    all.some((name) => !/^\d{2}-\d{6}-(?:transfer|baseline)\.json(?:\.[\da-f-]+\.tmp)?$/.test(name))
  )
    throw new Error('Unexpected baseline checkpoint file')
  return all.filter((name) => name.endsWith('.json')).sort()
}
function segmentName(index, sequence, kind) {
  return `${String(index).padStart(2, '0')}-${String(sequence).padStart(6, '0')}-${kind}.json`
}
function sourceMatches(saved, plan) {
  return (
    saved.study === STUDY &&
    saved.chainId === 1 &&
    saved.factorySha256 === plan.factorySha256 &&
    saved.submitSha256 === plan.submitSha256 &&
    saved.watcherFrontierSha256 === plan.watcherFrontierSha256 &&
    saved.proposalSegmentSha256 === plan.proposalSegmentSha256 &&
    saved.baselineBlock === B &&
    saved.baselineHash === B_HASH &&
    saved.proposalTx === PROPOSAL_TX &&
    saved.qRaw === Q.toString()
  )
}
export function verifyArtifacts({ out = defaultOut, plan = loadPlan() } = {}) {
  const files = names(out)
  const state = plan.vaults.map((vault) => ({
    vault,
    throughBlock: vault.creationBlock - 1,
    previousSha256: null,
    previousBlockHash: null,
    sequence: 0,
    logs: [],
    result: null,
  }))
  for (const name of files) {
    const bytes = readFileSync(join(out, name))
    if (bytes.length > MAX_SEGMENT_BYTES) throw new Error('Baseline segment size cap exceeded')
    const saved = JSON.parse(bytes),
      row = state[saved.index]
    if (
      !row ||
      !sourceMatches(saved, plan) ||
      saved.vault !== row.vault.vault ||
      saved.sequence !== row.sequence ||
      saved.previousSha256 !== row.previousSha256 ||
      saved.segmentSha256 !== sha(JSON.stringify(unsigned(saved))) ||
      name !== segmentName(saved.index, saved.sequence, saved.kind) ||
      row.result
    )
      throw new Error('Baseline segment identity, seal or continuity mismatch')
    if (saved.kind === 'transfer') {
      if (
        saved.from !== row.throughBlock + 1 ||
        saved.to < saved.from ||
        saved.to > Math.min(B, saved.from + CHUNK_BLOCKS - 1) ||
        !HASH.test(saved.fromHash) ||
        (saved.from === row.vault.creationBlock && saved.fromHash !== row.vault.creationHash) ||
        !HASH.test(saved.toHash) ||
        (saved.to === B && saved.toHash !== B_HASH) ||
        !HASH.test(saved.fromParentHash) ||
        (row.previousBlockHash && saved.fromParentHash !== row.previousBlockHash) ||
        !Array.isArray(saved.logs)
      )
        throw new Error('Transfer segment range mismatch')
      let last = row.logs.at(-1)
      for (const log of saved.logs) {
        if (
          log.block < saved.from ||
          log.block > saved.to ||
          (log.block === saved.from && log.blockHash !== saved.fromHash) ||
          (log.block === saved.to && log.blockHash !== saved.toHash) ||
          (last &&
            (log.block < last.block || (log.block === last.block && log.logIndex <= last.logIndex)))
        )
          throw new Error('Transfer segment log boundary mismatch')
        last = log
      }
      row.logs.push(...saved.logs)
      replay(row.logs)
      row.throughBlock = saved.to
      row.previousBlockHash = saved.toHash
    } else if (saved.kind === 'baseline') {
      if (
        row.throughBlock !== B ||
        saved.result?.vault !== row.vault.vault ||
        saved.result?.baselineBlock !== B ||
        saved.result?.baselineHash !== B_HASH ||
        saved.result?.qRaw !== Q.toString() ||
        !RESULT_STATUSES.has(saved.result?.status) ||
        (saved.result?.holder && !ADDRESS.test(saved.result.holder)) ||
        !DECIMAL.test(saved.result?.replayedSupply || '') ||
        saved.result?.replayedSupply !==
          replay(row.logs)
            .reduce((s, [, n]) => s + n, 0n)
            .toString()
      )
        throw new Error('Baseline result ledger mismatch')
      if (saved.result.holder) {
        const actualShares = replay(row.logs).find(
          ([address]) => address === saved.result.holder,
        )?.[1]
        if (
          !actualShares ||
          saved.result.holderShares !== actualShares.toString() ||
          (saved.result.balanceOf && saved.result.balanceOf !== saved.result.holderShares)
        )
          throw new Error('Baseline selected holder ledger mismatch')
      }
      if (!Array.isArray(saved.result.examinedHolders))
        throw new Error('Missing baseline holder examination')
      {
        const candidates = replay(row.logs).filter(([address]) => !isSentinel(address))
        if (
          !Array.isArray(saved.result.examinedHolders) ||
          saved.result.examinedHolders.length > candidates.length
        )
          throw new Error('Baseline holder examination mismatch')
        for (let i = 0; i < saved.result.examinedHolders.length; i++) {
          const attempted = saved.result.examinedHolders[i]
          if (
            attempted.holder !== candidates[i][0] ||
            attempted.shares !== candidates[i][1].toString() ||
            (attempted.codeHash !== null && !HASH.test(attempted.codeHash))
          )
            throw new Error('Baseline holder order or code mismatch')
          if (attempted.codeHash === null && i !== saved.result.examinedHolders.length - 1)
            throw new Error('Code-empty holder was skipped')
        }
        if (
          saved.result.holder &&
          (saved.result.examinedHolders.at(-1)?.holder !== saved.result.holder ||
            saved.result.examinedHolders.at(-1)?.codeHash !== null)
        )
          throw new Error('Selected holder is not first code-empty candidate')
      }
      if (
        saved.result.status === 'baseline-success' &&
        (!ADDRESS.test(saved.result.holder) ||
          !DECIMAL.test(saved.result.holderShares) ||
          !DECIMAL.test(saved.result.totalSupply) ||
          saved.result.totalSupply !== saved.result.replayedSupply ||
          !DECIMAL.test(saved.result.totalAssets) ||
          !DECIMAL.test(saved.result.balanceOf) ||
          saved.result.balanceOf !== saved.result.holderShares ||
          !DECIMAL.test(saved.result.previewRedeemable) ||
          BigInt(saved.result.previewRedeemable) < Q ||
          !DECIMAL.test(saved.result.withdrawShares) ||
          saved.result.asset !== USDC ||
          !HASH.test(saved.result.runtimeCodeHash) ||
          !ADDRESS.test(saved.result.liquidityAdapter))
      )
        throw new Error('Invalid successful baseline result')
      row.result = saved.result
    } else throw new Error('Unknown baseline segment kind')
    row.sequence++
    row.previousSha256 = sha(bytes)
  }
  const statusCounts = {}
  for (const row of state)
    if (row.result) statusCounts[row.result.status] = (statusCounts[row.result.status] || 0) + 1
  return {
    files: files.length,
    rows: state,
    baselineRowsCompleted: state.filter((x) => x.result).length,
    baselineSuccessCount: statusCounts['baseline-success'] || 0,
    statusCounts,
  }
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  const root = existsSync(dirname(out)) ? dirname(out) : defaultRoot
  const fs = stat(root)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Baseline disk reserve reached')
}
function append(out, segment, stat) {
  const bytes = JSON.stringify(seal(segment))
  if (Buffer.byteLength(bytes) > MAX_SEGMENT_BYTES)
    throw new Error('Baseline segment size cap reached')
  mkdirSync(out, { recursive: true })
  diskGuard(out, stat, Buffer.byteLength(bytes))
  const target = join(out, segmentName(segment.index, segment.sequence, segment.kind))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}
const isRevert = (error) =>
  [3, -32015].includes(error?.code ?? error?.cause?.code) ||
  /execution reverted|vm execution error/i.test(error?.message || '')
const isSentinel = (address) => address === ZERO || address === DEAD || BigInt(address) <= 0xffn
export async function collect({
  client,
  out = defaultOut,
  plan = loadPlan(),
  maxSteps = MAX_STEPS,
  stat = statfsSync,
} = {}) {
  if (!client || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS)
    throw new Error('Invalid bounded baseline collection request')
  let calls = 0,
    stepCalls = 0
  const request = async (method, params) => {
    diskGuard(out, stat)
    if (++stepCalls > MAX_RPC_PER_STEP) throw new Error('Per-step RPC cap reached')
    calls++
    const value = await client.request({ method, params })
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES)
      throw new Error('RPC response size cap reached')
    return value
  }
  const getBlock = async (number) =>
    block(await request('eth_getBlockByNumber', [toHex(number), false]), number)
  const finalized = block(await request('eth_getBlockByNumber', ['finalized', false]))
  if (finalized.number < B) throw new Error('Baseline block not finalized')
  if ((await getBlock(B)).hash !== B_HASH) throw new Error('Frozen B canonical hash mismatch')
  if (quantity(await request('eth_chainId', [])) !== 1) throw new Error('Wrong chain ID')
  let state = verifyArtifacts({ out, plan })
  for (let step = 0; step < maxSteps; step++) {
    const row = state.rows.find((entry) => !entry.result)
    if (!row) break
    stepCalls = 0
    const { vault, sequence, previousSha256 } = row
    const base = {
      ...plan,
      vaults: undefined,
      chainId: 1,
      index: vault.index,
      vault: vault.vault,
      sequence,
      previousSha256,
    }
    if (row.throughBlock < B) {
      const from = row.throughBlock + 1,
        to = Math.min(B, from + CHUNK_BLOCKS - 1)
      const first = await getBlock(from),
        last = await getBlock(to)
      if (from === vault.creationBlock && first.hash !== vault.creationHash)
        throw new Error('Frozen creation canonical hash mismatch')
      if (
        !first.parentHash ||
        !last.parentHash ||
        (row.previousBlockHash && first.parentHash !== row.previousBlockHash)
      )
        throw new Error('Transfer segment parent hash mismatch')
      const logsRaw = await request('eth_getLogs', [
        {
          address: vault.vault,
          fromBlock: toHex(from),
          toBlock: toHex(to),
          topics: [TRANSFER_TOPIC],
        },
      ])
      if (!Array.isArray(logsRaw)) throw new Error('Transfer RPC did not return an array')
      const logs = logsRaw
        .map((log) => decodeTransfer(log, vault.vault, from, to))
        .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
      const loggedBlockHashes = new Map()
      for (const log of logs) {
        const prior = loggedBlockHashes.get(log.block)
        if (prior && prior !== log.blockHash)
          throw new Error('Conflicting Transfer block hashes in one range')
        loggedBlockHashes.set(log.block, log.blockHash)
      }
      for (const [number, expectedHash] of loggedBlockHashes) {
        const canonical = number === from ? first : number === to ? last : await getBlock(number)
        if (canonical.hash !== expectedHash)
          throw new Error('Transfer log belongs to noncanonical block')
      }
      replay([...row.logs, ...logs])
      if (
        (await getBlock(from)).hash !== first.hash ||
        (await getBlock(to)).hash !== last.hash ||
        (await getBlock(B)).hash !== B_HASH
      )
        throw new Error('Canonical block changed during Transfer scan')
      append(
        out,
        {
          ...base,
          kind: 'transfer',
          from,
          to,
          fromHash: first.hash,
          fromParentHash: first.parentHash,
          toHash: last.hash,
          logs,
        },
        stat,
      )
    } else {
      const result = await probeBaseline({ request, getBlock, row })
      if ((await getBlock(B)).hash !== B_HASH)
        throw new Error('Canonical B changed during baseline probe')
      append(out, { ...base, kind: 'baseline', result }, stat)
    }
    state = verifyArtifacts({ out, plan })
  }
  return {
    baselineRowsCompleted: state.baselineRowsCompleted,
    baselineSuccessCount: state.baselineSuccessCount,
    statusCounts: state.statusCounts,
    steps: state.files,
    rpcCalls: calls,
    frontier: state.rows.map((row) => ({
      vault: row.vault.vault,
      throughBlock: row.throughBlock,
      status: row.result?.status || 'transfer-prefix-partial',
    })),
  }
}

export async function probeBaseline({ request, getBlock, row }) {
  const vault = row.vault.vault,
    hash = B_HASH
  const param = { blockHash: hash, requireCanonical: true }
  const result = {
    vault,
    baselineBlock: B,
    baselineHash: hash,
    qRaw: Q.toString(),
    replayedSupply: replay(row.logs)
      .reduce((s, [, n]) => s + n, 0n)
      .toString(),
    examinedHolders: [],
    status: 'unresolved',
  }
  const call = async (name, args = [], from = vault) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await request('eth_call', [
        {
          from,
          to: vault,
          data: encodeFunctionData({ abi: ABI, functionName: name, args }),
          gas: toHex(30_000_000),
        },
        param,
      ]),
    })
  try {
    const code = await request('eth_getCode', [vault, param])
    if (!HEX.test(code?.toLowerCase() || '') || code === '0x')
      return { ...result, status: 'missing-or-invalid-vault-code' }
    result.runtimeCodeHash = keccak256(code)
    const asset = (await call('asset')).toLowerCase()
    result.asset = asset
    if (asset !== USDC) return { ...result, status: 'asset-identity-mismatch' }
    result.liquidityAdapter = (await call('liquidityAdapter')).toLowerCase()
    const supply = await call('totalSupply')
    result.totalSupply = supply.toString()
    if (result.replayedSupply !== result.totalSupply)
      return { ...result, status: 'transfer-ledger-supply-mismatch' }
    result.totalAssets = (await call('totalAssets')).toString()
    for (const [address, shares] of replay(row.logs)) {
      if (isSentinel(address)) continue
      const holderCode = await request('eth_getCode', [address, param])
      if (!HEX.test(holderCode?.toLowerCase() || ''))
        return { ...result, status: 'holder-code-rpc-ambiguous' }
      result.examinedHolders.push({
        holder: address,
        shares: shares.toString(),
        codeHash: holderCode === '0x' ? null : keccak256(holderCode),
      })
      if (holderCode !== '0x') continue
      result.holder = address
      result.holderShares = shares.toString()
      break
    }
    if (!result.holder) return { ...result, status: 'no-positive-code-empty-eoa' }
    result.balanceOf = (await call('balanceOf', [result.holder])).toString()
    if (result.balanceOf !== result.holderShares)
      return { ...result, status: 'holder-ledger-balance-mismatch' }
    result.previewRedeemable = (
      await call('previewRedeem', [BigInt(result.holderShares)])
    ).toString()
    if (BigInt(result.previewRedeemable) < Q)
      return { ...result, status: 'holder-claim-below-fixed-q' }
    try {
      result.withdrawShares = (
        await call('withdraw', [Q, result.holder, result.holder], result.holder)
      ).toString()
      result.status = 'baseline-success'
    } catch (error) {
      if (/disk reserve|RPC cap|response size cap/i.test(error.message)) throw error
      result.status = isRevert(error) ? 'baseline-revert' : 'withdraw-rpc-ambiguous'
    }
    if ((await getBlock(B)).hash !== B_HASH) throw new Error('Canonical B changed during call')
    return result
  } catch (error) {
    if (/disk reserve|RPC cap|response size cap|Canonical B changed/i.test(error.message))
      throw error
    return { ...result, status: 'historical-state-rpc-ambiguous' }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (key) => {
    const i = args.indexOf(key)
    return i < 0 ? undefined : args[i + 1]
  }
  const root = resolve(option('--source-root') || defaultRoot)
  const watch = resolve(option('--watch') || defaultWatch)
  const out = resolve(option('--out') || defaultOut)
  const plan = loadPlan({ root, watch })
  if (args.includes('--verify')) {
    const state = verifyArtifacts({ out, plan })
    console.log(
      JSON.stringify({
        sourceVerified: true,
        checkpointFilesVerified: state.files,
        baselineRowsCompleted: state.baselineRowsCompleted,
        baselineSuccessCount: state.baselineSuccessCount,
        statusCounts: state.statusCounts,
      }),
    )
  } else if (args.includes('--run')) {
    const maxSteps = Number(option('--max-steps') || 1)
    const url = option('--rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
    console.log(JSON.stringify(await collect({ client: makeClient(url), out, plan, maxSteps })))
  } else {
    const state = verifyArtifacts({ out, plan })
    console.log(
      JSON.stringify({
        dry: true,
        plan,
        checkpoint: {
          files: state.files,
          baselineRowsCompleted: state.baselineRowsCompleted,
          baselineSuccessCount: state.baselineSuccessCount,
          statusCounts: state.statusCounts,
          frontier: state.rows.map((row) => ({
            vault: row.vault.vault,
            throughBlock: row.throughBlock,
            status: row.result?.status || 'unmeasured',
          })),
        },
      }),
    )
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    // Network/provider errors may contain RPC URLs or keys; print only our own bounded categories.
    const known =
      /^(Frozen|Pinned|Wrong chain|Baseline block|Canonical|Transfer|Baseline disk reserve|Per-step RPC cap|RPC response size cap|Invalid bounded|Unexpected baseline checkpoint|Baseline segment)/
    console.error(known.test(error.message) ? error.message : 'Baseline RPC or source failure')
    process.exitCode = 1
  })
