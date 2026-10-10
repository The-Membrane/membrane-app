// Reconcile a deterministic cap-lifecycle replay sample with historical VaultV2 storage.
// Dry: node scripts/research/morpho-v2-lifecycle-getter-check.mjs
// Live (read-only): node scripts/research/morpho-v2-lifecycle-getter-check.mjs --run true
// Offline: node scripts/research/morpho-v2-lifecycle-getter-check.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  FACTORY_SHA,
  PINNED_HEAD_HASH,
  SUBMIT_SHA,
  TO_BLOCK,
  eventKey,
  readSources,
  replay,
  validateCheckpoint,
} from './morpho-v2-cap-lifecycle-census.mjs'

export const STUDY = 'morpho-v2-lifecycle-getter-check-v1'
export const STAGE1_SHA = '28b4c9737df8e97f76f71ee5dc8c41d771bbd9bdcbcba01a113837ab29fa8ae9'
export const LIFECYCLE_SHA = 'c63d60150221712a7fd1d8279baf2c0e78a73ed9404a7197c172f6f3ae82be77'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 64 * 1024
export const CAP_SELECTORS = new Set(['0xf6f98fd5', '0x2438525b'])
const ABI = parseAbi(['function executableAt(bytes data) view returns (uint256)'])
const HASH = /^0x[\da-f]{64}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = (saved) => {
  const { checkpointSha256, ...rest } = saved
  return rest
}
export const seal = (saved) => ({
  ...unsigned(saved),
  checkpointSha256: sha(JSON.stringify(unsigned(saved))),
})

export function readInputs({ factoryPath, submitPath, stage1Path, lifecyclePath }) {
  const sources = readSources(factoryPath, submitPath)
  const stage1Bytes = readFileSync(stage1Path)
  const lifecycleBytes = readFileSync(lifecyclePath)
  if (sha(stage1Bytes) !== STAGE1_SHA || sha(lifecycleBytes) !== LIFECYCLE_SHA)
    throw new Error('Frozen Stage-1 or lifecycle source SHA mismatch')
  const stage1 = JSON.parse(stage1Bytes)
  const lifecycle = JSON.parse(lifecycleBytes)
  if (
    stage1.study !== 'morpho-v2-cap-submit-stage1-v1' ||
    stage1.status !== 'complete' ||
    stage1.chainId !== 1 ||
    stage1.factoryArtifactSha256 !== FACTORY_SHA ||
    stage1.coverage?.complete !== true ||
    stage1.summary?.independentEligibleCount !== 304 ||
    !Array.isArray(stage1.summary.independentEligibleProposalIndexes)
  )
    throw new Error('Frozen Stage-1 metadata mismatch')
  validateCheckpoint(lifecycle, sources, { complete: true })
  if (lifecycle.coverage.throughBlock !== TO_BLOCK) throw new Error('Lifecycle coverage mismatch')
  return { sources, stage1, lifecycle }
}

function stateAt(inputs, key, block) {
  const state = replay(inputs.sources, inputs.lifecycle, block).state.get(key)
  if (state?.ambiguous) throw new Error('Sample key has ambiguous lifecycle')
  return { pending: state?.pending === true, cycles: state?.cycles || 0 }
}

function row(event, block, label, state, expectedHash = null) {
  return {
    label,
    vault: event.vault.toLowerCase(),
    selector: event.selector.toLowerCase(),
    dataSha256: sha(Buffer.from(event.data.slice(2), 'hex')),
    sourceBlock: event.block,
    sourceTxHash: event.txHash.toLowerCase(),
    sourceLogIndex: event.logIndex,
    asOfBlock: block,
    expectedHash,
    expectedPending: state.pending,
    replayCycles: state.cycles,
    data: event.data.toLowerCase(),
  }
}

// The sample is an integrity check, not an outcome-selected warning cohort. Its first four
// independent proposals cover Accept, Revoke, and a repeated exact-calldata Submit cycle.
export function selectChecks(inputs) {
  const { stage1, lifecycle } = inputs
  const checks = []
  const firstFour = stage1.summary.independentEligibleProposalIndexes.slice(0, 4)
  if (firstFour.length !== 4) throw new Error('Insufficient frozen proposal indexes')
  const seen = new Set(),
    closureKinds = new Set()
  let reusedCycle = false
  for (const index of firstFour) {
    const proposal = stage1.proposals[index]
    if (
      !proposal ||
      !Number.isSafeInteger(proposal.block) ||
      !Array.isArray(proposal.rawEventIndexes)
    )
      throw new Error('Malformed sampled proposal')
    const event = proposal.rawEventIndexes
      .map((i) => stage1.rawEvents[i])
      .find((candidate) => CAP_SELECTORS.has(candidate?.selector?.toLowerCase()))
    if (
      !event ||
      event.block !== proposal.block ||
      event.vault.toLowerCase() !== proposal.vault.toLowerCase()
    )
      throw new Error('Sample cap leg mismatch')
    const key = eventKey(event)
    if (seen.has(key)) throw new Error('Duplicate sampled key')
    seen.add(key)
    const submit = inputs.sources.submits.find(
      (candidate) =>
        candidate.txHash.toLowerCase() === event.txHash.toLowerCase() &&
        candidate.logIndex === event.logIndex,
    )
    if (
      !submit ||
      eventKey(submit) !== key ||
      submit.blockHash.toLowerCase() !== event.blockHash.toLowerCase()
    )
      throw new Error('Sample is not linked to frozen raw Submit')
    const closure = lifecycle.events.find(
      (candidate) =>
        eventKey(candidate) === key &&
        (candidate.block > event.block ||
          (candidate.block === event.block && candidate.logIndex > event.logIndex)),
    )
    if (!closure) throw new Error('Sampled Submit has no first settlement')
    const intervening = inputs.sources.submits.some(
      (candidate) =>
        eventKey(candidate) === key &&
        (candidate.block > event.block ||
          (candidate.block === event.block && candidate.logIndex > event.logIndex)) &&
        (candidate.block < closure.block ||
          (candidate.block === closure.block && candidate.logIndex < closure.logIndex)),
    )
    if (intervening) throw new Error('Sampled cycle has intervening Submit')
    const before = stateAt(inputs, key, event.block - 1)
    const opened = stateAt(inputs, key, event.block)
    const closed = stateAt(inputs, key, closure.block)
    if (!opened.pending || closed.pending) throw new Error('Sampled open/settle replay mismatch')
    if (opened.cycles > 1) reusedCycle = true
    closureKinds.add(closure.kind)
    checks.push(row(event, event.block - 1, 'before-submit', before))
    checks.push(row(event, event.block, 'after-submit', opened, event.blockHash.toLowerCase()))
    checks.push(row(event, closure.block, `after-${closure.kind}`, closed, closure.blockHash))
  }
  if (!reusedCycle || !closureKinds.has('accept') || !closureKinds.has('revoke'))
    throw new Error('Frozen sample lost cycle or settlement coverage')

  const head = replay(inputs.sources, lifecycle, TO_BLOCK)
  const pendingHead = stage1.rawEvents
    .filter((event) => CAP_SELECTORS.has(event.selector.toLowerCase()))
    .filter((event) => {
      const state = head.state.get(eventKey(event))
      return state?.pending && !state.ambiguous
    })
    .sort((a, b) => eventKey(a).localeCompare(eventKey(b)) || a.block - b.block)[0]
  if (!pendingHead) throw new Error('No clean pending-at-head cap key')
  checks.push(
    row(
      pendingHead,
      TO_BLOCK,
      'pending-at-head',
      stateAt(inputs, eventKey(pendingHead), TO_BLOCK),
      PINNED_HEAD_HASH,
    ),
  )
  if (checks.length !== 13) throw new Error('Unexpected sampled getter count')
  return checks
}

function publicRow(check) {
  const { data, ...rest } = check
  return rest
}

function guardDisk(out, bytes, stat = statfsSync) {
  const disk = stat(dirname(out))
  if (Number(disk.bavail) * Number(disk.bsize) - bytes < RESERVE_BYTES)
    throw new Error('Getter reconciliation disk reserve reached')
}

function atomic(out, saved, stat) {
  const bytes = JSON.stringify(saved)
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES)
    throw new Error('Getter artifact size cap reached')
  mkdirSync(dirname(out), { recursive: true })
  guardDisk(out, Buffer.byteLength(bytes), stat)
  const temp = `${out}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, out)
}

export function verify(saved, inputs) {
  const expected = selectChecks(inputs)
  if (
    saved?.study !== STUDY ||
    saved.status !== 'complete' ||
    saved.chainId !== 1 ||
    saved.factorySha256 !== FACTORY_SHA ||
    saved.submitSha256 !== SUBMIT_SHA ||
    saved.stage1Sha256 !== STAGE1_SHA ||
    saved.lifecycleSha256 !== LIFECYCLE_SHA ||
    saved.pinnedHeadHash !== PINNED_HEAD_HASH ||
    !Array.isArray(saved.checks) ||
    saved.checks.length !== expected.length ||
    !/^[\da-f]{64}$/.test(saved.checkpointSha256 || '') ||
    sha(JSON.stringify(unsigned(saved))) !== saved.checkpointSha256
  )
    throw new Error('Getter checkpoint integrity mismatch')
  for (let i = 0; i < expected.length; i++) {
    const actual = saved.checks[i]
    const allowedKeys = new Set([
      ...Object.keys(publicRow(expected[i])),
      'blockHash',
      'executableAt',
      'actualPending',
    ])
    if (
      Object.keys(actual).some((key) => !allowedKeys.has(key)) ||
      Object.entries(publicRow(expected[i])).some(([key, value]) => actual[key] !== value) ||
      !HASH.test(actual.blockHash) ||
      !/^\d+$/.test(actual.executableAt) ||
      actual.actualPending !== (BigInt(actual.executableAt) !== 0n) ||
      actual.actualPending !== actual.expectedPending ||
      (actual.expectedHash && actual.blockHash !== actual.expectedHash)
    )
      throw new Error('Historical getter does not reconcile with lifecycle replay')
  }
  return saved
}

export async function collect({
  client,
  rpcRead = (method, params) => client.request({ method, params }),
  inputs,
  out,
  stat = statfsSync,
}) {
  if (existsSync(out)) return verify(JSON.parse(readFileSync(out, 'utf8')), inputs)
  const checks = selectChecks(inputs)
  guardDisk(out, 0, stat)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const rows = [],
    headers = new Map()
  for (const check of checks) {
    guardDisk(out, 0, stat)
    let hash = headers.get(check.asOfBlock)
    if (!hash) {
      const header = await client.getBlock({ blockNumber: BigInt(check.asOfBlock) })
      hash = header.hash?.toLowerCase()
      if (!HASH.test(hash) || (check.expectedHash && hash !== check.expectedHash))
        throw new Error('Historical header hash mismatch')
      headers.set(check.asOfBlock, hash)
    }
    const call = encodeFunctionData({ abi: ABI, functionName: 'executableAt', args: [check.data] })
    guardDisk(out, 0, stat)
    const result = await rpcRead('eth_call', [
      { to: check.vault, data: call },
      { blockHash: hash, requireCanonical: true },
    ])
    let executableAt
    try {
      executableAt = decodeFunctionResult({ abi: ABI, functionName: 'executableAt', data: result })
    } catch {
      throw new Error('Historical getter failed or EIP-1898 unsupported')
    }
    const actualPending = executableAt !== 0n
    if (actualPending !== check.expectedPending)
      throw new Error('Historical getter does not reconcile with lifecycle replay')
    rows.push({
      ...publicRow(check),
      blockHash: hash,
      executableAt: executableAt.toString(),
      actualPending,
    })
  }
  const saved = seal({
    study: STUDY,
    status: 'complete',
    chainId: 1,
    factorySha256: FACTORY_SHA,
    submitSha256: SUBMIT_SHA,
    stage1Sha256: STAGE1_SHA,
    lifecycleSha256: LIFECYCLE_SHA,
    pinnedHeadHash: PINNED_HEAD_HASH,
    checks: rows,
  })
  verify(saved, inputs)
  atomic(out, saved, stat)
  return saved
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith('--') ||
      args[i + 1] === undefined ||
      opts[args[i].slice(2)] !== undefined
    )
      throw new Error('Expected unique --key value arguments')
    opts[args[i].slice(2)] = args[i + 1]
  }
  if (
    Object.keys(opts).some(
      (key) =>
        !['factory', 'submit', 'stage1', 'lifecycle', 'out', 'run', 'verify', 'rpc'].includes(key),
    ) ||
    (opts.run && opts.run !== 'true') ||
    (opts.verify && opts.verify !== 'true') ||
    (opts.run && opts.verify)
  )
    throw new Error('Invalid getter-check CLI options')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    const paths = {
      factoryPath: resolve(opts.factory || `data/research/venue-signals/${FACTORY_SHA}.json`),
      submitPath: resolve(opts.submit || `data/research/venue-signals/${SUBMIT_SHA}.json`),
      stage1Path: resolve(opts.stage1 || `data/research/venue-signals/${STAGE1_SHA}.json`),
      lifecyclePath: resolve(
        opts.lifecycle || 'data/research/venue-signals/morpho-v2-cap-lifecycle-census.json',
      ),
    }
    const inputs = readInputs(paths)
    const out = resolve(
      opts.out || 'data/research/venue-signals/morpho-v2-lifecycle-getter-check.json',
    )
    if (opts.verify) {
      const bytes = readFileSync(out)
      const saved = verify(JSON.parse(bytes), inputs)
      process.stdout.write(
        JSON.stringify({ status: saved.status, checks: saved.checks.length, sha256: sha(bytes) }) +
          '\n',
      )
    } else if (!opts.run) {
      const checks = selectChecks(inputs)
      process.stdout.write(
        JSON.stringify({
          mode: 'dry',
          checks: checks.length,
          labels: checks.map((x) => x.label),
          reserveBytes: RESERVE_BYTES,
          runRequired: true,
        }) + '\n',
      )
    } else {
      const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!rpc) throw new Error('Missing RPC configuration')
      const saved = await collect({ client: makeClient(rpc), inputs, out })
      process.stdout.write(
        JSON.stringify({ status: saved.status, checks: saved.checks.length }) + '\n',
      )
    }
  } catch {
    // Error chains may contain a credential-bearing RPC URL. Never print them.
    process.stderr.write('Lifecycle getter check failed; no result was published.\n')
    process.exitCode = 1
  }
}
