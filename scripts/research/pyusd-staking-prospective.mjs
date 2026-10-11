// Private local prospective PRIME → wYLDS callable-stage assay.
// This does not observe requestRedeem, admin completion, USDC or PYUSD payout.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  PRIME,
  ROUTE,
  assayHastraHolder,
  attestHastraIdentity,
  collectSnapshot,
} from './pyusd-staking-economic-exit.mjs'

export const STUDY = 'pyusd_staking_prime_prospective_v1'
export const ROOT = resolve('data/research/venue-signals/pyusd-staking-prime-prospective-v1')
export const HORIZONS = Object.freeze([1, 4, 24, 48, 168])
const DEADLINE_HOURS = 2
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const kinds = new Set(['issues', 'scores', 'attempts'])
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const hex = (value) => `0x${BigInt(value).toString(16)}`
const parsedClock = (clock) => {
  const ms = Date.parse(clock)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== clock)
    throw Error('pyusd_prospective_clock_invalid')
  return ms
}
const hourAt = (from, hours) => new Date(parsedClock(from) + hours * 3_600_000).toISOString()
const header = (block) => {
  if (
    !HASH.test(block?.hash ?? '') ||
    !HASH.test(block?.parentHash ?? '') ||
    !block?.number ||
    !block?.timestamp
  )
    throw Error('pyusd_prospective_header_invalid')
  return {
    number: BigInt(block.number).toString(),
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
    timestamp: Number(BigInt(block.timestamp)),
  }
}
const providerPair = (row) =>
  Array.isArray(row) &&
  row.length === 2 &&
  row.every((x) => typeof x === 'string' && /^https?:\/\/[^/]+$/.test(x)) &&
  row[0] !== row[1]

function validateRow(kind, row, previous) {
  if (
    !kinds.has(kind) ||
    row?.study !== STUDY ||
    row.kind !== kind ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    row.previousSha256 !== (previous?.sha256 ?? null) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('pyusd_prospective_row_invalid')
  const { sha256, ...body } = row
  if (sha256 !== sha(JSON.stringify(body))) throw Error('pyusd_prospective_chain_invalid')
  if (kind === 'issues') {
    if (
      row.routeKey !== ROUTE ||
      row.destination !== PRIME ||
      !ADDRESS.test(row.holder ?? '') ||
      !DECIMAL.test(row.qRaw ?? '') ||
      BigInt(row.qRaw) < 1n ||
      row.baseline?.routeKey !== ROUTE ||
      row.baseline?.destination !== PRIME ||
      row.baseline.assay?.holder !== row.holder ||
      row.baseline.assay?.qRaw !== row.qRaw ||
      row.baseline.assay?.pyusdPayout !== 'not_attested' ||
      row.baseline.pyusdConversion !== 'not_attested' ||
      row.baseline.finalPayout !== 'unassessed' ||
      !HASH.test(row.baseline.blockHash ?? '') ||
      !DECIMAL.test(row.baseline.blockNumber ?? '') ||
      !providerPair(row.baseline.origins) ||
      !same(
        row.targets,
        HORIZONS.map((horizonHours) => ({
          horizonHours,
          targetAtUtc: hourAt(row.issuedAtUtc, horizonHours),
          deadlineAtUtc: hourAt(row.issuedAtUtc, horizonHours + DEADLINE_HOURS),
        })),
      ) ||
      row.payoutAssessment !== 'first_stage_only_usdc_pyusd_unassessed'
    )
      throw Error('pyusd_prospective_issue_invalid')
    if (
      row.baseline.blockTimestamp * 1000 > parsedClock(row.issuedAtUtc) + 120_000 ||
      parsedClock(row.issuedAtUtc) - row.baseline.blockTimestamp * 1000 > 7_200_000
    )
      throw Error('pyusd_prospective_issue_clock_invalid')
  } else if (kind === 'scores') {
    if (
      !Number.isSafeInteger(row.issueSequence) ||
      row.issueSequence < 1 ||
      !SHA.test(row.issueSha256 ?? '') ||
      !HORIZONS.includes(row.horizonHours) ||
      !['measured', 'missed_window'].includes(row.status) ||
      row.payoutAssessment !== 'first_stage_only_usdc_pyusd_unassessed'
    )
      throw Error('pyusd_prospective_score_invalid')
    const at = parsedClock(row.scoredAtUtc)
    const targetAt = parsedClock(row.targetAtUtc)
    const deadline = parsedClock(row.deadlineAtUtc)
    if (deadline - targetAt !== DEADLINE_HOURS * 3_600_000 || at < targetAt)
      throw Error('pyusd_prospective_score_clock_invalid')
    if (row.status === 'measured') {
      if (
        at > deadline ||
        !row.target ||
        !row.measurement ||
        !DECIMAL.test(row.target.number ?? '') ||
        !HASH.test(row.target.hash ?? '') ||
        row.target.timestamp * 1000 < targetAt ||
        row.target.timestamp * 1000 > deadline ||
        row.target.timestamp * 1000 > at ||
        row.measurement.assay?.pyusdPayout !== 'not_attested' ||
        row.measurement.pyusdConversion !== 'not_attested' ||
        row.measurement.finalPayout !== 'unassessed' ||
        !providerPair(row.measurement.origins) ||
        row.deadlineWitness !== null
      )
        throw Error('pyusd_prospective_measured_invalid')
    } else if (
      at <= deadline ||
      row.target !== null ||
      row.measurement !== null ||
      !providerPair(row.deadlineWitness?.origins) ||
      !Array.isArray(row.deadlineWitness?.heads) ||
      row.deadlineWitness.heads.length !== 2 ||
      row.deadlineWitness.heads.some(
        (head) =>
          !DECIMAL.test(head?.number ?? '') ||
          !HASH.test(head?.hash ?? '') ||
          !HASH.test(head?.parentHash ?? '') ||
          !Number.isSafeInteger(head?.timestamp) ||
          head.timestamp * 1000 < deadline ||
          head.timestamp * 1000 > at,
      ) ||
      !Array.isArray(row.deadlineWitness?.commonHeaders) ||
      row.deadlineWitness.commonHeaders.length !== 2 ||
      !same(row.deadlineWitness.commonHeaders[0], row.deadlineWitness.commonHeaders[1]) ||
      row.deadlineWitness.commonHeaders.some(
        (header) => !Number.isSafeInteger(header?.timestamp) || header.timestamp * 1000 > at,
      ) ||
      !DECIMAL.test(row.deadlineWitness.commonHeaders[0]?.number ?? '') ||
      !HASH.test(row.deadlineWitness.commonHeaders[0]?.hash ?? '') ||
      !HASH.test(row.deadlineWitness.commonHeaders[0]?.parentHash ?? '') ||
      !Number.isSafeInteger(row.deadlineWitness.commonHeaders[0]?.timestamp) ||
      row.deadlineWitness.commonHeaders[0].timestamp * 1000 < deadline ||
      BigInt(row.deadlineWitness.commonHeaders[0].number) !==
        row.deadlineWitness.heads.reduce(
          (lowest, head) => (BigInt(head.number) < lowest ? BigInt(head.number) : lowest),
          BigInt(row.deadlineWitness.heads[0].number),
        ) ||
      row.deadlineWitness.heads.some(
        (head) =>
          head.number === row.deadlineWitness.commonHeaders[0].number &&
          !same(head, row.deadlineWitness.commonHeaders[0]),
      )
    )
      throw Error('pyusd_prospective_censor_invalid')
  } else if (kind === 'attempts') {
    if (
      !['issue', 'score'].includes(row.action) ||
      !['sealed', 'retry', 'no_due', 'no_fresh_holder'].includes(row.status) ||
      (row.reason !== null && !/^pyusd_[a-z0-9_]+$/.test(row.reason ?? '')) ||
      !Number.isSafeInteger(parsedClock(row.atUtc))
    )
      throw Error('pyusd_prospective_attempt_invalid')
  }
}

function validateScoreBinding(row, issues) {
  const issueRow = issues[row.issueSequence - 1]
  const plan = issueRow?.targets.find((target) => target.horizonHours === row.horizonHours)
  if (
    !issueRow ||
    !plan ||
    row.issueSha256 !== issueRow.sha256 ||
    row.targetAtUtc !== plan.targetAtUtc ||
    row.deadlineAtUtc !== plan.deadlineAtUtc ||
    (row.measurement &&
      (row.measurement.assay?.holder !== issueRow.holder ||
        row.measurement.assay?.qRaw !== issueRow.qRaw ||
        row.measurement.routeKey !== ROUTE ||
        row.measurement.destination !== PRIME ||
        row.measurement.blockHash !== row.target.hash ||
        row.measurement.blockNumber !== row.target.number ||
        row.measurement.blockTimestamp !== row.target.timestamp))
  )
    throw Error('pyusd_prospective_score_binding_invalid')
}

async function assertLocalRoot(root) {
  try {
    if (!(await lstat(root)).isDirectory()) throw Error('pyusd_prospective_root_invalid')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function readRows(kind, root = ROOT) {
  if (!kinds.has(kind)) throw Error('pyusd_prospective_kind_invalid')
  await assertLocalRoot(root)
  const directory = join(root, kind)
  let names
  try {
    if (!(await lstat(directory)).isDirectory()) throw Error('pyusd_prospective_root_invalid')
    names = await readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  if (names.some((name) => !/^\d{8}\.json$/.test(name))) throw Error('pyusd_prospective_stray_file')
  const issues = kind === 'scores' ? await readRows('issues', root) : null
  const rows = []
  const scoredKeys = new Set()
  for (const name of names.sort()) {
    if (name !== `${String(rows.length + 1).padStart(8, '0')}.json`)
      throw Error('pyusd_prospective_gap')
    const fd = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const st = await fd.stat()
      if (!st.isFile() || st.size < 1 || st.size > 90_000)
        throw Error('pyusd_prospective_file_size')
      bytes = await fd.readFile()
      if ((await fd.stat()).size !== st.size) throw Error('pyusd_prospective_file_changed')
    } finally {
      await fd.close()
    }
    const row = JSON.parse(bytes.toString('utf8'))
    if (bytes.toString('utf8') !== `${JSON.stringify(row)}\n` || row.sequence !== rows.length + 1)
      throw Error('pyusd_prospective_file_invalid')
    validateRow(kind, row, rows.at(-1))
    if (kind === 'scores') {
      validateScoreBinding(row, issues)
      const key = `${row.issueSequence}:${row.horizonHours}`
      if (scoredKeys.has(key)) throw Error('pyusd_prospective_score_duplicate')
      scoredKeys.add(key)
    }
    if (kind === 'issues' && rows.some((prior) => prior.holder === row.holder))
      throw Error('pyusd_prospective_holder_reused')
    rows.push(row)
  }
  return rows
}

export async function appendRow(kind, body, root = ROOT) {
  if (!kinds.has(kind)) throw Error('pyusd_prospective_kind_invalid')
  await mkdir(root, { recursive: true })
  await assertLocalRoot(root)
  const directory = join(root, kind)
  await mkdir(directory, { recursive: true })
  if (!(await lstat(directory)).isDirectory()) throw Error('pyusd_prospective_root_invalid')
  const rows = await readRows(kind, root)
  const doc = {
    ...body,
    study: STUDY,
    kind,
    sequence: rows.length + 1,
    previousSha256: rows.at(-1)?.sha256 ?? null,
  }
  const row = { ...doc, sha256: sha(JSON.stringify(doc)) }
  validateRow(kind, row, rows.at(-1))
  if (kind === 'scores') {
    validateScoreBinding(row, await readRows('issues', root))
    if (
      rows.some(
        (prior) =>
          prior.issueSequence === row.issueSequence && prior.horizonHours === row.horizonHours,
      )
    )
      throw Error('pyusd_prospective_score_duplicate')
  }
  if (kind === 'issues' && rows.some((prior) => prior.holder === row.holder))
    throw Error('pyusd_prospective_holder_reused')
  const data = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(data) > 90_000) throw Error('pyusd_prospective_file_size')
  const disk = statfsSync(directory)
  if (Number(disk.bavail) * Number(disk.bsize) < 1_073_741_824 + Buffer.byteLength(data))
    throw Error('pyusd_prospective_disk_reserve')
  const temp = join(directory, `.pyusd-prospective-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(data)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await link(temp, join(directory, `${String(row.sequence).padStart(8, '0')}.json`))
    const dir = await open(directory, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
  return row
}

function orderedPairs(urls) {
  const rank = (url) => {
    const host = new URL(url).hostname
    return host === 'rpc.ankr.com'
      ? 0
      : host === 'lb.drpc.live'
        ? 1
        : host.includes('alchemy.com')
          ? 2
          : host.includes('quiknode.pro')
            ? 3
            : host.includes('infura.io')
              ? 4
              : 5
  }
  const ordered = [...urls].sort((a, b) => rank(a) - rank(b))
  const pairs = []
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) {
      try {
        pairs.push(publicRpcClients([ordered[i], ordered[j]]))
      } catch {
        /* independent pair */
      }
      if (pairs.length >= 8) return pairs
    }
  return pairs
}

async function chainHeader(origin, tag) {
  if ((await origin.request('eth_chainId', [])) !== '0x1')
    throw Error('pyusd_prospective_chain_invalid')
  return header(await origin.request('eth_getBlockByNumber', [tag, false]))
}

async function finalizedDeadlineWitness(origins, deadlineAtUtc) {
  const heads = await Promise.all(origins.map((origin) => chainHeader(origin, 'finalized')))
  const commonNumber = heads.reduce(
    (lowest, head) => (BigInt(head.number) < lowest ? BigInt(head.number) : lowest),
    BigInt(heads[0].number),
  )
  const commonHeaders = await Promise.all(
    origins.map((origin) => chainHeader(origin, hex(commonNumber))),
  )
  if (
    !same(commonHeaders[0], commonHeaders[1]) ||
    commonHeaders[0].timestamp * 1000 < parsedClock(deadlineAtUtc) ||
    heads.some(
      (head) =>
        (head.number === commonHeaders[0].number && !same(head, commonHeaders[0])) ||
        head.timestamp * 1000 < parsedClock(deadlineAtUtc),
    )
  )
    throw Error('pyusd_prospective_deadline_disagreement')
  return { origins: origins.map((origin) => origin.provider), heads, commonHeaders }
}

export async function firstFinalizedTarget([first, second], baselineBlock, targetAtUtc) {
  const targetSeconds = Math.ceil(parsedClock(targetAtUtc) / 1000)
  const [headA, headB] = await Promise.all([
    chainHeader(first, 'finalized'),
    chainHeader(second, 'finalized'),
  ])
  if (headA.timestamp < targetSeconds || headB.timestamp < targetSeconds) return null
  let low = BigInt(baselineBlock) + 1n
  let high = BigInt(headA.number)
  if (high < low) return null
  while (low < high) {
    const mid = (low + high) / 2n
    const block = await chainHeader(first, hex(mid))
    if (block.timestamp >= targetSeconds) high = mid
    else low = mid + 1n
  }
  const [targetA, targetB, previousA, previousB] = await Promise.all([
    chainHeader(first, hex(low)),
    chainHeader(second, hex(low)),
    chainHeader(first, hex(low - 1n)),
    chainHeader(second, hex(low - 1n)),
  ])
  if (
    !same(targetA, targetB) ||
    !same(previousA, previousB) ||
    BigInt(headB.number) < low ||
    targetA.timestamp < targetSeconds ||
    previousA.timestamp >= targetSeconds ||
    targetA.parentHash !== previousA.hash ||
    BigInt(targetA.number) !== BigInt(previousA.number) + 1n
  )
    throw Error('pyusd_prospective_target_disagreement')
  return { target: targetA, previous: previousA, finalizedHeads: [headA, headB] }
}

async function measureAt([first, second], target, holder, qRaw) {
  const hash = target.hash
  const [idA, idB] = await Promise.all([
    attestHastraIdentity(first, hash),
    attestHastraIdentity(second, hash),
  ])
  if (!same(idA, idB)) throw Error('pyusd_prospective_identity_disagreement')
  const [assayA, assayB] = await Promise.all([
    assayHastraHolder(first, hash, holder, BigInt(qRaw)),
    assayHastraHolder(second, hash, holder, BigInt(qRaw)),
  ])
  if (!same(assayA, assayB)) throw Error('pyusd_prospective_assay_disagreement')
  return {
    chainId: 1,
    routeKey: ROUTE,
    destination: PRIME,
    blockNumber: target.number,
    blockHash: hash,
    blockTimestamp: target.timestamp,
    origins: [first.provider, second.provider],
    identity: idA,
    assay: assayA,
    finalPayout: 'unassessed',
    pyusdConversion: 'not_attested',
  }
}

const reasonFor = (error) => {
  const raw = error instanceof Error ? error.message : ''
  return /^pyusd_[a-z0-9_]+$/.test(raw) ? raw : 'pyusd_prospective_rpc_retry'
}

async function recordSealedAttempt(append, action, now, root) {
  try {
    await append(
      'attempts',
      { action, status: 'sealed', reason: null, atUtc: now().toISOString() },
      root,
    )
    return 'sealed'
  } catch {
    return 'failed'
  }
}

export async function issue(
  now = () => new Date(),
  root = ROOT,
  pairs = null,
  append = appendRow,
  capture = collectSnapshot,
) {
  const issues = await readRows('issues', root)
  const used = new Set(issues.map((row) => row.holder))
  const originPairs = pairs ?? orderedPairs(configuredPublicRpcUrls(readEnv()))
  let lastError
  for (const origins of originPairs) {
    let row
    try {
      const baseline = await capture(origins, null, null, used)
      const issuedAtUtc = now().toISOString()
      const holder = baseline.assay.holder
      if (used.has(holder)) throw Error('pyusd_prospective_duplicate_holder')
      row = await append(
        'issues',
        {
          routeKey: ROUTE,
          destination: PRIME,
          holder,
          qRaw: baseline.assay.qRaw,
          issuedAtUtc,
          baseline,
          targets: HORIZONS.map((horizonHours) => ({
            horizonHours,
            targetAtUtc: hourAt(issuedAtUtc, horizonHours),
            deadlineAtUtc: hourAt(issuedAtUtc, horizonHours + DEADLINE_HOURS),
          })),
          payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
        },
        root,
      )
    } catch (error) {
      lastError = error
      // A post-link fsync failure can leave a valid immutable issue behind.
      const published = (await readRows('issues', root)).find(
        (candidate) => candidate.sequence > issues.length,
      )
      if (published) {
        return {
          status: 'sealed',
          issue: published,
          attemptLogStatus: await recordSealedAttempt(append, 'issue', now, root),
        }
      }
      continue
    }
    return {
      status: 'sealed',
      issue: row,
      attemptLogStatus: await recordSealedAttempt(append, 'issue', now, root),
    }
  }
  const reason = reasonFor(lastError)
  const status = reason === 'pyusd_economic_no_holder_discovered' ? 'no_fresh_holder' : 'retry'
  await append('attempts', { action: 'issue', status, reason, atUtc: now().toISOString() }, root)
  return { status, reason }
}

export function dueTarget(issues, scores, nowUtc) {
  const nowMs = parsedClock(nowUtc)
  const scored = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  const due = issues
    .flatMap((issueRow) => issueRow.targets.map((plan) => ({ issueRow, plan })))
    .filter(
      ({ issueRow, plan }) =>
        nowMs >= parsedClock(plan.targetAtUtc) &&
        !scored.has(`${issueRow.sequence}:${plan.horizonHours}`),
    )
    .sort((a, b) => parsedClock(a.plan.targetAtUtc) - parsedClock(b.plan.targetAtUtc))
  return due.find(({ plan }) => nowMs <= parsedClock(plan.deadlineAtUtc)) ?? due[0] ?? null
}

export async function score(now = () => new Date(), root = ROOT, pairs = null, append = appendRow) {
  const [issues, scores] = await Promise.all([readRows('issues', root), readRows('scores', root)])
  const scoredKeys = new Set()
  for (const prior of scores) {
    const issueRow = issues[prior.issueSequence - 1]
    const plan = issueRow?.targets.find((x) => x.horizonHours === prior.horizonHours)
    const key = `${prior.issueSequence}:${prior.horizonHours}`
    if (
      !issueRow ||
      prior.issueSha256 !== issueRow.sha256 ||
      !plan ||
      prior.targetAtUtc !== plan.targetAtUtc ||
      prior.deadlineAtUtc !== plan.deadlineAtUtc ||
      scoredKeys.has(key)
    )
      throw Error('pyusd_prospective_score_binding_invalid')
    scoredKeys.add(key)
  }
  const scoredAtUtc = now().toISOString()
  const due = dueTarget(issues, scores, scoredAtUtc)
  if (!due) {
    await append(
      'attempts',
      { action: 'score', status: 'no_due', reason: null, atUtc: scoredAtUtc },
      root,
    )
    return { status: 'no_due' }
  }
  const { issueRow, plan } = due
  const originPairs = pairs ?? orderedPairs(configuredPublicRpcUrls(readEnv()))
  let lastError
  for (const origins of originPairs) {
    let row
    try {
      const late = parsedClock(scoredAtUtc) > parsedClock(plan.deadlineAtUtc)
      let target = null
      let measurement = null
      let deadlineWitness = null
      let status
      if (late) {
        deadlineWitness = await finalizedDeadlineWitness(origins, plan.deadlineAtUtc)
        status = 'missed_window'
      } else {
        const selected = await firstFinalizedTarget(
          origins,
          issueRow.baseline.blockNumber,
          plan.targetAtUtc,
        )
        if (!selected) throw Error('pyusd_prospective_target_not_finalized')
        if (selected.target.timestamp * 1000 > parsedClock(plan.deadlineAtUtc))
          throw Error('pyusd_prospective_target_after_deadline')
        target = selected.target
        measurement = await measureAt(origins, target, issueRow.holder, issueRow.qRaw)
        status = 'measured'
      }
      const capturedAtUtc = now().toISOString()
      if (status === 'measured' && parsedClock(capturedAtUtc) > parsedClock(plan.deadlineAtUtc))
        throw Error('pyusd_prospective_capture_window_elapsed')
      row = await append(
        'scores',
        {
          issueSequence: issueRow.sequence,
          issueSha256: issueRow.sha256,
          horizonHours: plan.horizonHours,
          targetAtUtc: plan.targetAtUtc,
          deadlineAtUtc: plan.deadlineAtUtc,
          scoredAtUtc: capturedAtUtc,
          status,
          target,
          measurement,
          deadlineWitness,
          payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
        },
        root,
      )
    } catch (error) {
      lastError = error
      // Never retry another provider after a score may have been published.
      const published = (await readRows('scores', root)).find(
        (candidate) =>
          candidate.issueSequence === issueRow.sequence &&
          candidate.horizonHours === plan.horizonHours,
      )
      if (published) {
        return {
          status: 'sealed',
          score: published,
          attemptLogStatus: await recordSealedAttempt(append, 'score', now, root),
        }
      }
      continue
    }
    return {
      status: 'sealed',
      score: row,
      attemptLogStatus: await recordSealedAttempt(append, 'score', now, root),
    }
  }
  const reason = reasonFor(lastError)
  await append(
    'attempts',
    { action: 'score', status: 'retry', reason, atUtc: now().toISOString() },
    root,
  )
  return { status: 'retry', reason }
}

export async function verifyEvidence(root = ROOT) {
  const [issues, scores, attempts] = await Promise.all([
    readRows('issues', root),
    readRows('scores', root),
    readRows('attempts', root),
  ])
  const keys = new Set()
  for (const row of scores) {
    const issueRow = issues[row.issueSequence - 1]
    const plan = issueRow?.targets.find((x) => x.horizonHours === row.horizonHours)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (
      !issueRow ||
      row.issueSha256 !== issueRow.sha256 ||
      !plan ||
      row.targetAtUtc !== plan.targetAtUtc ||
      row.deadlineAtUtc !== plan.deadlineAtUtc ||
      (row.measurement &&
        (row.measurement.assay.holder !== issueRow.holder ||
          row.measurement.assay.qRaw !== issueRow.qRaw ||
          row.measurement.blockHash !== row.target.hash ||
          row.measurement.blockNumber !== row.target.number)) ||
      keys.has(key)
    )
      throw Error('pyusd_prospective_score_binding_invalid')
    keys.add(key)
  }
  if (new Set(issues.map((row) => row.holder)).size !== issues.length)
    throw Error('pyusd_prospective_holder_reused')
  return { issues, scores, attempts }
}

export async function verify(root = ROOT) {
  const { issues, scores, attempts } = await verifyEvidence(root)
  return {
    study: STUDY,
    issues: issues.length,
    scores: scores.length,
    measuredScores: scores.filter((row) => row.status === 'measured').length,
    missedScores: scores.filter((row) => row.status === 'missed_window').length,
    attempts: attempts.length,
    distinctHolderEpisodes: issues.length,
    forecastCalibrated: false,
    tips: {
      issues: issues.at(-1)?.sha256 ?? null,
      scores: scores.at(-1)?.sha256 ?? null,
      attempts: attempts.at(-1)?.sha256 ?? null,
    },
  }
}

export function cliResultExitCode(mode, result) {
  if (result.status === 'retry' || result.attemptLogStatus === 'failed') return 1
  if (!mode.endsWith('-campaign')) return 0
  const row = mode === '--issue-campaign' ? result.issue : result.score
  return result.status === 'sealed' && Number.isSafeInteger(row?.sequence) && row.sequence > 0
    ? 0
    : 1
}

export function summarizeProspective(issues, scores, nowUtc = new Date().toISOString()) {
  const clock = parsedClock(nowUtc)
  const byKey = new Map(
    scores.map((scoreRow) => [`${scoreRow.issueSequence}:${scoreRow.horizonHours}`, scoreRow]),
  )
  return {
    status: 'available',
    routeKey: ROUTE,
    destination: PRIME,
    scope: 'prime_to_wylds_callable_only',
    finalPayoutAssessment: 'usdc_and_pyusd_unassessed',
    calibratedForecast: false,
    distinctHolderEpisodes: issues.length,
    scoreCount: scores.length,
    cells: HORIZONS.map((horizonHours) => {
      const cell = {
        horizonHours,
        issued: issues.length,
        baselineCallable: 0,
        baselineImpaired: 0,
        measured: 0,
        callable: 0,
        nonCallable: 0,
        missedWindow: 0,
        pending: 0,
        outcomeMissing: 0,
      }
      for (const issueRow of issues) {
        if (issueRow.baseline.assay.stage === 'prime_to_wylds_callable') cell.baselineCallable++
        else cell.baselineImpaired++
        const plan = issueRow.targets.find((entry) => entry.horizonHours === horizonHours)
        const scoreRow = byKey.get(`${issueRow.sequence}:${horizonHours}`)
        if (scoreRow?.status === 'measured') {
          cell.measured++
          if (scoreRow.measurement.assay.stage === 'prime_to_wylds_callable') cell.callable++
          else cell.nonCallable++
        } else if (scoreRow?.status === 'missed_window') cell.missedWindow++
        else if (clock <= parsedClock(plan.deadlineAtUtc)) cell.pending++
        else cell.outcomeMissing++
      }
      return cell
    }),
  }
}

async function main() {
  const mode = process.argv[2]
  if (
    !['--issue', '--score', '--issue-campaign', '--score-campaign', '--verify'].includes(mode) ||
    process.argv.length !== 3
  )
    throw Error(
      'usage: node pyusd-staking-prospective.mjs --issue|--score|--issue-campaign|--score-campaign|--verify',
    )
  const result =
    mode === '--verify'
      ? await verify()
      : mode.startsWith('--issue')
        ? await issue()
        : await score()
  if (mode === '--verify') console.log(JSON.stringify(result))
  else {
    console.log(
      JSON.stringify({
        status: result.status,
        reason: result.reason ?? null,
        attemptLogStatus: result.attemptLogStatus ?? null,
        sequence: result.issue?.sequence ?? result.score?.sequence ?? null,
      }),
    )
    process.exitCode = cliResultExitCode(mode, result)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
