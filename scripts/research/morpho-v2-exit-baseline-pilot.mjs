// Pre-outcome only. Default to a bounded two-vault pilot; --max-vaults 20 scales it.
// node scripts/research/morpho-v2-exit-baseline-pilot.mjs --max-vaults 2
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

export const STUDY = 'morpho-v2-exit-baseline-pilot-v1'
export const STAGE1_SHA = '28b4c9737df8e97f76f71ee5dc8c41d771bbd9bdcbcba01a113837ab29fa8ae9'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')
export const CHUNK_BLOCKS = 8_000
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[0-9a-f]{40}$/i
const HASH = /^0x[0-9a-f]{64}$/i
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function pinned(path, expectedSha) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) throw new Error('Pinned input SHA mismatch')
  return JSON.parse(bytes)
}
function checkedNumber(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}
export function selectFirstDistinct(stage1, factory, limit = 2) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('max-vaults must be 1..20')
  if (
    stage1.study !== 'morpho-v2-cap-submit-stage1-v1' ||
    stage1.status !== 'complete' ||
    stage1.chainId !== 1 ||
    stage1.factoryArtifactSha256 !== FACTORY_SHA ||
    !stage1.coverage?.complete ||
    stage1.summary?.independentEligibleCount < 20 ||
    !Array.isArray(stage1.summary.independentEligibleProposalIndexes)
  )
    throw new Error('Stage-1 input is not the frozen complete cohort')
  if (
    factory.study !== 'morpho-v2-factory-create-v1' ||
    factory.status !== 'complete' ||
    (factory.chainId !== undefined && factory.chainId !== 1) ||
    !Array.isArray(factory.events)
  )
    throw new Error('Factory input is not the frozen complete cohort')
  const creations = new Map(factory.events.map((x) => [x.vault.toLowerCase(), x]))
  const selected = [],
    seen = new Set()
  for (const index of stage1.summary.independentEligibleProposalIndexes) {
    const p = stage1.proposals[index]
    if (!p || p.qualifyingLegCount < 1 || !ADDRESS.test(p.vault) || !Number.isSafeInteger(p.block))
      throw new Error('Invalid independent proposal index')
    const key = p.vault.toLowerCase()
    if (seen.has(key)) continue
    const creation = creations.get(key)
    if (!creation || creation.block >= p.block)
      throw new Error('Missing pre-anchor factory creation')
    seen.add(key)
    selected.push({
      proposalIndex: index,
      vault: key,
      block: p.block,
      txHash: p.txHash,
      timestamp: p.timestamp,
      creationBlock: creation.block,
      creationTxHash: creation.txHash,
    })
    if (selected.length === limit) break
  }
  if (selected.length !== limit) throw new Error('Insufficient distinct independent vaults')
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].block < selected[i - 1].block)
      throw new Error('Independent index order changed')
  }
  return selected
}

export function replayTransfers(rawLogs) {
  const balances = new Map()
  let previousBlock = -1,
    previousIndex = -1
  for (const log of rawLogs) {
    if (
      !Number.isSafeInteger(log.block) ||
      !Number.isSafeInteger(log.logIndex) ||
      log.block < previousBlock ||
      (log.block === previousBlock && log.logIndex <= previousIndex) ||
      !HASH.test(log.blockHash) ||
      !HASH.test(log.txHash) ||
      !ADDRESS.test(log.from) ||
      !ADDRESS.test(log.to) ||
      !/^\d+$/.test(log.value)
    )
      throw new Error('Invalid or unordered Transfer log')
    previousBlock = log.block
    previousIndex = log.logIndex
    const value = BigInt(log.value),
      from = log.from.toLowerCase(),
      to = log.to.toLowerCase()
    if (from === ZERO && to === ZERO) throw new Error('Zero-to-zero Transfer')
    if (from !== ZERO) {
      const after = (balances.get(from) || 0n) - value
      if (after < 0n) throw new Error('Transfer ledger underflow')
      balances.set(from, after)
    }
    if (to !== ZERO) balances.set(to, (balances.get(to) || 0n) + value)
  }
  return [...balances]
    .filter(([, shares]) => shares > 0n)
    .sort((a, b) =>
      a[1] === b[1] ? keccak256(a[0]).localeCompare(keccak256(b[0])) : a[1] > b[1] ? -1 : 1,
    )
}

export function baselineSize(totalAssets, previewRedeemable) {
  if (totalAssets < 0n || previewRedeemable < 0n) throw new Error('Negative vault amount')
  const vaultTenthPercent = totalAssets / 1000n
  const holderTenth = previewRedeemable / 10n
  return vaultTenthPercent < holderTenth ? vaultTenthPercent : holderTenth
}

function decodeTransfer(log, vault, fromBlock, throughBlock) {
  if (
    log.address?.toLowerCase() !== vault ||
    log.topics?.length !== 3 ||
    log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase() ||
    !/^0x[0-9a-f]{24}[0-9a-f]{40}$/i.test(log.topics[1]) ||
    !/^0x[0-9a-f]{24}[0-9a-f]{40}$/i.test(log.topics[2]) ||
    !/^0x[0-9a-f]{64}$/i.test(log.data) ||
    log.removed === true
  )
    throw new Error('Malformed Transfer RPC log')
  const block = checkedNumber(log.blockNumber),
    logIndex = checkedNumber(log.logIndex)
  if (
    block < fromBlock ||
    block > throughBlock ||
    !HASH.test(log.blockHash) ||
    !HASH.test(log.transactionHash)
  )
    throw new Error('Out-of-range Transfer RPC log')
  return {
    block,
    blockHash: log.blockHash,
    logIndex,
    txHash: log.transactionHash,
    from: `0x${log.topics[1].slice(26)}`.toLowerCase(),
    to: `0x${log.topics[2].slice(26)}`.toLowerCase(),
    value: BigInt(log.data).toString(),
  }
}

async function retry(operation, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= retries) throw new Error('RPC read failed', { cause: error })
      await new Promise((done) => setTimeout(done, Math.min(8000, 500 * 2 ** attempt)))
    }
  }
}

export async function collectHolderLogs({
  client,
  anchor,
  rawPath,
  chunkBlocks = CHUNK_BLOCKS,
  onProgress = () => {},
}) {
  if (!Number.isInteger(chunkBlocks) || chunkBlocks < 1 || chunkBlocks > CHUNK_BLOCKS)
    throw new Error('Invalid chunk size')
  const throughBlock = anchor.block - 1
  const expected = {
    study: 'morpho-v2-pre-b-transfer-logs-v1',
    chainId: 1,
    stage1ArtifactSha256: STAGE1_SHA,
    vault: anchor.vault,
    proposalIndex: anchor.proposalIndex,
    fromBlock: anchor.creationBlock,
    throughBlock,
    chunkBlocks,
  }
  let saved = existsSync(rawPath)
    ? JSON.parse(readFileSync(rawPath, 'utf8'))
    : { ...expected, nextBlock: anchor.creationBlock, logs: [], status: 'partial' }
  for (const [key, value] of Object.entries(expected)) {
    if (saved[key] !== value) throw new Error('Transfer checkpoint metadata mismatch')
  }
  if (
    !Array.isArray(saved.logs) ||
    !Number.isSafeInteger(saved.nextBlock) ||
    saved.nextBlock < expected.fromBlock ||
    saved.nextBlock > throughBlock + 1 ||
    saved.status !== (saved.nextBlock === throughBlock + 1 ? 'complete' : 'partial')
  )
    throw new Error('Transfer checkpoint coverage mismatch')
  replayTransfers(saved.logs)
  if (saved.logs.some((x) => x.block >= saved.nextBlock))
    throw new Error('Transfer checkpoint frontier mismatch')
  while (saved.nextBlock <= throughBlock) {
    const end = Math.min(throughBlock, saved.nextBlock + chunkBlocks - 1)
    const logs = await retry(() =>
      client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: anchor.vault,
            fromBlock: toHex(saved.nextBlock),
            toBlock: toHex(end),
            topics: [TRANSFER_TOPIC],
          },
        ],
      }),
    )
    const additions = logs
      .map((x) => decodeTransfer(x, anchor.vault, saved.nextBlock, end))
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    replayTransfers([...saved.logs, ...additions])
    saved = {
      ...saved,
      nextBlock: end + 1,
      logs: [...saved.logs, ...additions],
      status: end === throughBlock ? 'complete' : 'partial',
    }
    atomic(rawPath, saved)
    onProgress(saved)
  }
  return saved
}

export async function probeAnchor({ client, anchor, rawPath, onProgress }) {
  const at = BigInt(anchor.block - 1)
  const raw = await collectHolderLogs({ client, anchor, rawPath, onProgress })
  const holders = replayTransfers(raw.logs)
  const header = await retry(() => client.getBlock({ blockNumber: at }))
  const code = await retry(() => client.getCode({ address: anchor.vault, blockNumber: at }))
  const result = {
    ...anchor,
    preBlock: Number(at),
    preBlockHash: header.hash,
    rawLogPath: rawPath,
    rawLogCount: raw.logs.length,
    rawLogSha256: sha(readFileSync(rawPath)),
    holderCount: holders.length,
    runtimeCodeHash: code && code !== '0x' ? keccak256(code) : null,
    runtimeBytes: code && code !== '0x' ? (code.length - 2) / 2 : 0,
  }
  if (!HASH.test(header.hash) || !result.runtimeCodeHash)
    return { ...result, status: 'missing-history-or-code' }
  const read = (functionName, args = []) =>
    retry(() =>
      client.readContract({
        address: anchor.vault,
        abi: ABI,
        functionName,
        args,
        blockNumber: at,
      }),
    )
  try {
    const supply = await read('totalSupply')
    const summed = holders.reduce((sum, [, balance]) => sum + balance, 0n)
    result.totalSupply = supply.toString()
    result.replayedSupply = summed.toString()
    if (supply !== summed) return { ...result, status: 'holder-ledger-supply-mismatch' }
    for (const [address, shares] of holders) {
      const holderCode = await retry(() => client.getCode({ address, blockNumber: at }))
      if (holderCode && holderCode !== '0x') continue
      const onchainShares = await read('balanceOf', [address])
      if (onchainShares !== shares)
        return {
          ...result,
          status: 'holder-ledger-balance-mismatch',
          holder: address,
          replayedShares: shares.toString(),
          onchainShares: onchainShares.toString(),
        }
      const totalAssets = await read('totalAssets')
      const redeemableAssets = await read('previewRedeem', [shares])
      const q = baselineSize(totalAssets, redeemableAssets)
      Object.assign(result, {
        holder: address,
        holderShares: shares.toString(),
        totalAssets: totalAssets.toString(),
        previewRedeemableAssets: redeemableAssets.toString(),
        qAssets: q.toString(),
        holderCode: '0x',
        abiCallsVerified: true,
      })
      if (q === 0n) return { ...result, status: 'zero-baseline-size' }
      const data = encodeFunctionData({
        abi: ABI,
        functionName: 'withdraw',
        args: [q, address, address],
      })
      try {
        const output = await retry(() =>
          client.request({
            method: 'eth_call',
            params: [{ from: address, to: anchor.vault, data }, toHex(at)],
          }),
        )
        result.withdrawShares = decodeFunctionResult({
          abi: ABI,
          functionName: 'withdraw',
          data: output,
        }).toString()
        return { ...result, status: 'baseline-success', withdrawOutput: output }
      } catch {
        return {
          ...result,
          status: 'baseline-revert-or-rpc-error',
          note: 'Revert, gate, adapter, gas and RPC errors are not classified as illiquidity',
        }
      }
    }
    return { ...result, status: 'no-positive-eoa-holder' }
  } catch {
    return { ...result, status: 'historical-state-read-error' }
  }
}

export function validateCachedResults(saved, anchors, rawDir) {
  if (
    !Array.isArray(saved.results) ||
    saved.results.length > anchors.length ||
    saved.status !== (saved.results.length === anchors.length ? 'complete' : 'partial')
  )
    throw new Error('Invalid pilot frontier')
  saved.results.forEach((result, index) => {
    const anchor = anchors[index]
    const rawPath = resolve(rawDir, `${anchor.vault}-${anchor.block}-pre-b-transfers.json`)
    if (
      result.vault !== anchor.vault ||
      result.proposalIndex !== anchor.proposalIndex ||
      result.preBlock !== anchor.block - 1 ||
      result.rawLogPath !== rawPath ||
      !existsSync(rawPath)
    )
      throw new Error('Cached result/anchor mismatch')
    const bytes = readFileSync(rawPath)
    if (sha(bytes) !== result.rawLogSha256) throw new Error('Cached raw-log SHA mismatch')
    const raw = JSON.parse(bytes)
    if (
      raw.status !== 'complete' ||
      raw.study !== 'morpho-v2-pre-b-transfer-logs-v1' ||
      raw.stage1ArtifactSha256 !== STAGE1_SHA ||
      raw.vault !== anchor.vault ||
      raw.proposalIndex !== anchor.proposalIndex ||
      raw.fromBlock !== anchor.creationBlock ||
      raw.throughBlock !== anchor.block - 1 ||
      raw.nextBlock !== anchor.block ||
      !Array.isArray(raw.logs) ||
      raw.logs.length !== result.rawLogCount
    )
      throw new Error('Cached raw-log metadata mismatch')
    replayTransfers(raw.logs)
  })
}

export async function run({
  client,
  stage1Path,
  factoryPath,
  out,
  rawDir,
  maxVaults = 2,
  onProgress = () => {},
}) {
  const stage1 = pinned(stage1Path, STAGE1_SHA),
    factory = pinned(factoryPath, FACTORY_SHA)
  const anchors = selectFirstDistinct(stage1, factory, maxVaults)
  const expected = {
    study: STUDY,
    chainId: 1,
    stage1ArtifactSha256: STAGE1_SHA,
    factoryArtifactSha256: FACTORY_SHA,
    selection: 'first-independent-eligible-per-first-distinct-vault',
    maxVaults,
    anchors,
  }
  let saved = existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8'))
    : { ...expected, status: 'partial', results: [] }
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(value))
      throw new Error('Pilot checkpoint metadata mismatch')
  }
  validateCachedResults(saved, anchors, rawDir)
  if (saved.status === 'complete') return saved
  if ((await retry(() => client.getChainId())) !== 1) throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < anchors.length; i++) {
    const anchor = anchors[i]
    const rawPath = resolve(rawDir, `${anchor.vault}-${anchor.block}-pre-b-transfers.json`)
    const result = await probeAnchor({
      client,
      anchor,
      rawPath,
      onProgress: (x) =>
        onProgress({
          vault: anchor.vault,
          nextBlock: x.nextBlock,
          throughBlock: x.throughBlock,
        }),
    })
    saved = {
      ...saved,
      results: [...saved.results, result],
      status: i + 1 === anchors.length ? 'complete' : 'partial',
    }
    atomic(out, saved)
    onProgress({ vault: anchor.vault, result: result.status, completed: saved.results.length })
  }
  return saved
}

function options(args) {
  const out = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value arguments')
    out[args[i].slice(2)] = args[i + 1]
  }
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const rpc = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('RECORDER_RPC_URL is required')
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-exit-baseline-pilot.json')
  try {
    const saved = await run({
      client: makeClient(rpc),
      stage1Path: resolve(opts.stage1 || `data/research/venue-signals/${STAGE1_SHA}.json`),
      factoryPath: resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`),
      out,
      rawDir: resolve(opts['raw-dir'] || 'data/research/venue-signals/morpho-v2-exit-baseline-raw'),
      maxVaults: opts['max-vaults'] === undefined ? 2 : Number(opts['max-vaults']),
      onProgress: (x) => process.stdout.write(JSON.stringify(x) + '\n'),
    })
    process.stdout.write(
      JSON.stringify({
        path: out,
        sha256: sha(readFileSync(out)),
        status: saved.status,
        results: saved.results.map((x) => ({
          vault: x.vault,
          preBlock: x.preBlock,
          status: x.status,
          rawLogCount: x.rawLogCount,
          qAssets: x.qAssets || null,
        })),
      }) + '\n',
    )
  } catch (error) {
    // RPC causes may include credential-bearing URLs; never print them.
    process.stderr.write(
      `Exit baseline stopped; checkpoint remains at ${out}. ` +
        `${error.message === 'RPC read failed' ? 'RPC read failed.' : 'Validation failed.'}\n`,
    )
    process.exitCode = 1
  }
}
