// Treated-only, first-20-distinct-vault fixed-q follow-through. Exploratory, no control claim.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { BASELINE_SHA, probeExit } from './morpho-v2-exit-outcome-pilot.mjs'

export const STUDY = 'morpho-v2-treated-exit-first20-v1'
export const HEAD = 26_052_740
const DAY = 86_400
const HASH = /^0x[\da-f]{64}$/i
const MIN_FREE_BYTES = 2.5 * 1024 ** 3
const MAX_CHECKPOINT_BYTES = 2 * 1024 ** 2
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned input SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function integer(value) {
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe integer')
  return number
}
function headerOf(block) {
  const header = { block: integer(block.number), hash: block.hash, timestamp: integer(block.timestamp) }
  if (!HASH.test(header.hash)) throw new Error('Invalid block header')
  return header
}

export function selectTreated20(stage1, baseline) {
  if (stage1.study !== 'morpho-v2-cap-submit-stage1-v1' || stage1.status !== 'complete' ||
      stage1.summary?.independentEligibleCount !== 304 || !stage1.coverage?.complete ||
      baseline.study !== 'morpho-v2-exit-baseline-pilot-v1' || baseline.status !== 'complete' ||
      baseline.maxVaults !== 20 || baseline.results?.length !== 20)
    throw new Error('Frozen Stage-1/baseline cohort mismatch')
  const independent = new Set(stage1.summary.independentEligibleProposalIndexes)
  const selected = baseline.results.map((row) => {
    const proposal = stage1.proposals[row.proposalIndex]
    if (!proposal || !independent.has(row.proposalIndex) || proposal.vault.toLowerCase() !== row.vault ||
        proposal.block !== row.block || !HASH.test(row.preBlockHash))
      throw new Error('Frozen proposal/baseline mismatch')
    const times = proposal.executableAts
      .filter((_, index) => proposal.classes[index] === 'eligible')
      .map(integer).sort((a, b) => a - b)
    if (!times.length) throw new Error('Missing eligible executable time')
    return {
      proposalIndex: row.proposalIndex, vault: row.vault, anchorBlock: row.block,
      anchorTimestamp: row.timestamp, preBlock: row.preBlock, preBlockHash: row.preBlockHash,
      holder: row.holder || null, qAssets: row.qAssets || null,
      baselineStatus: row.status, baselineRuntimeHash: row.runtimeCodeHash,
      executableAt: times[0], coInterventionTimes: times.slice(1),
    }
  })
  if (new Set(selected.map((row) => row.vault)).size !== 20 ||
      selected.filter((row) => row.baselineStatus === 'baseline-success').length !== 18 ||
      selected.filter((row) => row.baselineStatus === 'zero-baseline-size').length !== 2)
    throw new Error('First-20 denominator changed')
  for (const row of selected.filter((x) => x.baselineStatus === 'baseline-success'))
    if (!/^0x[\da-f]{40}$/i.test(row.holder) || !/^\d+$/.test(row.qAssets) || BigInt(row.qAssets) <= 0n)
      throw new Error('Invalid successful baseline')
  return selected
}

export function classifyFollowThrough(anchor, probes) {
  if (anchor.baselineStatus !== 'baseline-success') return 'baseline-excluded'
  // +7d is descriptive; it must not erase an otherwise evaluable +24h primary outcome.
  const primary = [probes.preExecutable, probes.plus24h]
  if (primary.some((p) => p?.status === 'head-censored')) return 'head-censored'
  if (primary.some((p) => !p || p.runtimeCodeHash !== anchor.baselineRuntimeHash)) return 'code-or-probe-censored'
  if (primary.some((p) => p.status === 'holder-attrition' || p.status === 'holder-code-changed'))
    return 'holder-censored'
  if (primary.some((p) => p.status !== 'success' && p.status !== 'evm-revert'))
    return 'non-liquidity-error-censored'
  return probes.plus24h.status === 'evm-revert' ? 'plus24h-revert' : 'plus24h-success'
}

export function verifyOffline({ out, stage1Path, baselinePath }) {
  const anchors = selectTreated20(pinned(stage1Path, STAGE1_SHA), pinned(baselinePath, BASELINE_SHA))
  const bytes = readFileSync(out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.stage1Sha256 !== STAGE1_SHA || saved.baselineSha256 !== BASELINE_SHA ||
      saved.headBlock !== HEAD || !Array.isArray(saved.results) || saved.results.length > 20 ||
      saved.status !== (saved.results.length === 20 ? 'complete' : 'partial'))
    throw new Error('Treated-exit checkpoint mismatch')
  for (let i = 0; i < saved.results.length; i++) {
    const row = saved.results[i]
    if (JSON.stringify(row.anchor) !== JSON.stringify(anchors[i]) ||
        row.verdict !== classifyFollowThrough(row.anchor, row.probes || {}))
      throw new Error('Treated-exit row mismatch')
    if (row.anchor.baselineStatus === 'baseline-success' &&
        !['preExecutable', 'plus24h', 'plus7d'].every((key) => row.probes?.[key]?.status))
      throw new Error('Treated-exit missing horizon')
  }
  return { checkpointSha256: sha(bytes), status: saved.status, completed: saved.results.length,
    verdicts: saved.results.reduce((counts, row) => (counts[row.verdict] = (counts[row.verdict] || 0) + 1, counts), {}) }
}

export async function run({ client, out, stage1Path, baselinePath, onProgress = () => {} }) {
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  const anchors = selectTreated20(stage1, pinned(baselinePath, BASELINE_SHA))
  if (existsSync(out)) verifyOffline({ out, stage1Path, baselinePath })
  let saved = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {
    study: STUDY, stage1Sha256: STAGE1_SHA, baselineSha256: BASELINE_SHA,
    headBlock: HEAD, status: 'partial', results: [],
  }
  if (saved.status === 'complete') return verifyOffline({ out, stage1Path, baselinePath })
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const headers = new Map()
  async function get(block) {
    if (!headers.has(block)) headers.set(block, headerOf(await client.getBlock({ blockNumber: BigInt(block) })))
    return headers.get(block)
  }
  const head = await get(HEAD)
  if (head.hash.toLowerCase() !== stage1.pinnedHeadHash.toLowerCase()) throw new Error('Pinned head hash mismatch')
  async function atOrAfter(target, first) {
    if (head.timestamp < target) return null
    let lo = first, hi = HEAD
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if ((await get(mid)).timestamp >= target) hi = mid
      else lo = mid + 1
    }
    const found = await get(lo)
    if (lo > first && (await get(lo - 1)).timestamp >= target) throw new Error('Timestamp search invariant failed')
    return found
  }
  for (let i = saved.results.length; i < anchors.length; i++) {
    const disk = statfsSync(dirname(out))
    if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES)
      throw new Error('Disk reserve reached; checkpoint retained')
    const anchor = anchors[i]
    const probes = {}
    if (anchor.baselineStatus === 'baseline-success') {
      const before = await atOrAfter(anchor.executableAt, anchor.anchorBlock)
      const targets = {
        preExecutable: before ? await get(before.block - 1) : null,
        plus24h: await atOrAfter(anchor.executableAt + DAY, anchor.anchorBlock),
        plus7d: await atOrAfter(anchor.executableAt + 7 * DAY, anchor.anchorBlock),
      }
      for (const [key, header] of Object.entries(targets)) {
        probes[key] = header
          ? await probeExit({ client, vault: anchor.vault, holder: anchor.holder, q: anchor.qAssets,
              header, executableAt: anchor.executableAt, stage1, anchorBlock: anchor.anchorBlock, control: false })
          : { status: 'head-censored' }
      }
    }
    const row = { anchor, probes, verdict: classifyFollowThrough(anchor, probes) }
    saved = { ...saved, results: [...saved.results, row], status: i === 19 ? 'complete' : 'partial' }
    if (Buffer.byteLength(JSON.stringify(saved)) > MAX_CHECKPOINT_BYTES)
      throw new Error('Checkpoint size cap reached')
    atomic(out, saved)
    onProgress({ completed: i + 1, verdict: row.verdict })
  }
  return verifyOffline({ out, stage1Path, baselinePath })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-treated-exit-first20.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
    baselinePath: resolve(`data/research/venue-signals/morpho-v2-exit-baseline-first20.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths,
      client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
      onProgress: (progress) => process.stdout.write(JSON.stringify(progress) + '\n'),
    })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Treated-exit follow-through stopped; checkpoint retained.\n')
    process.exitCode = 1
  }
}
