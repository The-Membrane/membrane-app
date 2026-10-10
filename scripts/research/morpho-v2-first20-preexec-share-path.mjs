// Reconstruct adapter child-share headroom during the 72h cap-proposal window.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbi, parseAbiItem, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { BASELINE_SHA } from './morpho-v2-exit-outcome-pilot.mjs'

export const STUDY = 'morpho-v2-first20-preexec-share-path-v1'
export const PREEXEC_SHA = 'dd2b1635049084e882e919fcdf7c5412d9973cd8e9d02f76a8a5dd28867db8c5'
const CHILD = '0xb0f05e4de970a1aaf77f8c2f823953a367504ba9'
const ADAPTER = '0xf55d73af1dcec32fbee3775ad5baafd476f1674b'
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function previewWithdraw(uint256) view returns (uint256)'])
const TRANSFER = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const TOPIC = toEventSelector(TRANSFER)
const indexed = (address) => `0x${address.slice(2).padStart(64, '0')}`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned study input SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function sources(paths) {
  const baseline = pinned(paths.baselinePath, BASELINE_SHA).results[15]
  const preexec = pinned(paths.preexecPath, PREEXEC_SHA).results[15]
  const stage1 = pinned(paths.stage1Path, STAGE1_SHA)
  const proposal = stage1.proposals[baseline.proposalIndex]
  if (baseline.vault !== preexec.vault || preexec.onset !== 'pre-executable-onset' ||
      proposal.vault.toLowerCase() !== baseline.vault || proposal.block !== baseline.block ||
      preexec.block <= baseline.preBlock)
    throw new Error('Frozen incident anchors mismatch')
  return { baseline, preexec, proposal }
}

export function verifyOffline(paths) {
  const { baseline, preexec } = sources(paths)
  const bytes = readFileSync(paths.out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.status !== 'complete' || saved.baselineSha256 !== BASELINE_SHA ||
      saved.preexecSha256 !== PREEXEC_SHA || saved.stage1Sha256 !== STAGE1_SHA ||
      saved.vault !== baseline.vault || saved.qAssets !== preexec.qAssets ||
      saved.child !== CHILD || saved.adapter !== ADAPTER ||
      saved.samples?.[0]?.block !== baseline.preBlock || saved.samples?.at(-1)?.block !== preexec.block ||
      !Array.isArray(saved.transfers)) throw new Error('Share-path checkpoint mismatch')
  for (const sample of saved.samples)
    if (!/^\d+$/.test(sample.adapterShares) || !/^\d+$/.test(sample.requiredShares) ||
        sample.sufficient !== (BigInt(sample.adapterShares) >= BigInt(sample.requiredShares)))
      throw new Error('Share-path sample mismatch')
  for (const event of saved.transfers)
    if (event.block < baseline.preBlock || event.block > preexec.block ||
        event.from !== ADAPTER && event.to !== ADAPTER)
      throw new Error('Share-path Transfer mismatch')
  return { checkpointSha256: sha(bytes), vault: saved.vault, qAssets: saved.qAssets,
    proposalTimestamp: saved.proposalTimestamp, executableAt: saved.executableAt,
    samples: saved.samples, transfers: saved.transfers }
}

export async function run({ client, ...paths }) {
  if (existsSync(paths.out)) return verifyOffline(paths)
  const { baseline, preexec, proposal } = sources(paths)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const q = BigInt(preexec.qAssets)
  const raw = []
  for (let start = baseline.preBlock; start <= preexec.block; start += 8_000) {
    const end = Math.min(preexec.block, start + 7_999)
    const [outbound, inbound] = await Promise.all([
      client.request({ method: 'eth_getLogs', params: [{ address: CHILD, fromBlock: toHex(start), toBlock: toHex(end), topics: [TOPIC, indexed(ADAPTER)] }] }),
      client.request({ method: 'eth_getLogs', params: [{ address: CHILD, fromBlock: toHex(start), toBlock: toHex(end), topics: [TOPIC, null, indexed(ADAPTER)] }] }),
    ])
    raw.push(...outbound, ...inbound)
  }
  const unique = new Map()
  for (const log of raw) {
    const decoded = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics, strict: true })
    const event = { block: Number(log.blockNumber), blockHash: log.blockHash,
      txHash: log.transactionHash, logIndex: Number(log.logIndex),
      from: decoded.args.from.toLowerCase(), to: decoded.args.to.toLowerCase(), value: decoded.args.value.toString() }
    unique.set(`${event.txHash}:${event.logIndex}`, event)
  }
  const transfers = [...unique.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const blocks = [...new Set([baseline.preBlock, ...transfers.map((event) => event.block), preexec.block])].sort((a, b) => a - b)
  const samples = []
  for (const block of blocks) {
    const blockNumber = BigInt(block)
    const [header, shares, required] = await Promise.all([
      client.getBlock({ blockNumber }),
      client.readContract({ address: CHILD, abi: ABI, functionName: 'balanceOf', args: [ADAPTER], blockNumber }),
      client.readContract({ address: CHILD, abi: ABI, functionName: 'previewWithdraw', args: [q], blockNumber }),
    ])
    const expectedHash = block === baseline.preBlock ? baseline.preBlockHash :
      block === preexec.block ? preexec.probe.hash : transfers.find((event) => event.block === block)?.blockHash
    if (header.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('Historical block hash mismatch')
    samples.push({ block, blockHash: header.hash, timestamp: Number(header.timestamp),
      adapterShares: shares.toString(), requiredShares: required.toString(), sufficient: shares >= required })
  }
  const value = { study: STUDY, status: 'complete', baselineSha256: BASELINE_SHA,
    preexecSha256: PREEXEC_SHA, stage1Sha256: STAGE1_SHA, vault: baseline.vault,
    child: CHILD, adapter: ADAPTER, qAssets: preexec.qAssets,
    proposalTimestamp: proposal.timestamp, executableAt: Number(proposal.executableAts[0]),
    samples, transfers }
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) throw new Error('Share-path cache size cap reached')
  atomic(paths.out, value)
  return verifyOffline(paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-first20-preexec-share-path.json'),
    baselinePath: resolve('data/research/venue-signals/morpho-v2-exit-baseline-first20.json'),
    preexecPath: resolve('data/research/venue-signals/morpho-v2-size-preexec-first20.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Pre-executable share path stopped; no result was published.\n')
    process.exitCode = 1
  }
}
