// Append-only local invocation receipts. These expose failures and duplicate
// scheduler slots without treating a failed attempt as a forecast outcome.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { runPublicDirectScoreSweep } from '../record-carry-local-compound-holder-scores.mjs'
import {
  configuredPublicRpcUrls,
  issuePublicDirectExit,
  publicRpcClients,
  verifyPublicDirectIssues,
} from './carry-local-compound-holder-issue.mjs'
import { verifyPublicDirectScores } from './carry-local-compound-holder-score.mjs'

export const OUT = resolve('data/research/venue-signals/carry-local-compound-holder-attempts')
const STUDY = 'carry_local_compound_holder_attempt_v1'
const SLOT_MS = 15 * 60_000
const HASH = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const name = (sequence) => `${String(sequence).padStart(8, '0')}.json`
const withoutSeal = ({ sha256: _seal, ...body }) => body

export async function verifyCompoundAttempts(out = OUT) {
  let names
  try {
    names = (await readdir(out)).filter((item) => item.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const filename of names) {
    if (filename !== name(rows.length + 1)) throw Error('compound_attempt_sequence_gap')
    const bytes = await readFile(join(out, filename))
    if (bytes.length > 8_192) throw Error('compound_attempt_size_invalid')
    const row = JSON.parse(bytes.toString('utf8'))
    const prior = rows.at(-1)
    if (
      `${JSON.stringify(row)}\n` !== bytes.toString('utf8') ||
      row.study !== STUDY ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (prior?.sha256 ?? null) ||
      (prior && !HASH.test(row.previousSha256)) ||
      row.sha256 !== sha(JSON.stringify(withoutSeal(row))) ||
      !['issue', 'score'].includes(row.mode) ||
      !['issued', 'scored_sweep', 'duplicate_slot', 'failed'].includes(row.status) ||
      (row.status === 'issued' &&
        (!Number.isSafeInteger(row.issueSequence) ||
          row.issueSequence < 1 ||
          !HASH.test(row.issueSha256 ?? '') ||
          row.scoreSummary !== null)) ||
      (row.status !== 'issued' && (row.issueSequence !== null || row.issueSha256 !== null)) ||
      (row.status === 'scored_sweep' &&
        (!row.scoreSummary ||
          !Number.isSafeInteger(row.scoreSummary.due) ||
          !Number.isSafeInteger(row.scoreSummary.attempted) ||
          !Number.isSafeInteger(row.scoreSummary.scored) ||
          !Number.isSafeInteger(row.scoreSummary.retries))) ||
      (row.status !== 'scored_sweep' && row.scoreSummary !== null) ||
      !Number.isSafeInteger(row.slot) ||
      row.slot !== Math.floor(Date.parse(row.startedAtUtc) / SLOT_MS) ||
      !Number.isFinite(Date.parse(row.finishedAtUtc)) ||
      Date.parse(row.finishedAtUtc) < Date.parse(row.startedAtUtc) ||
      (prior && Date.parse(row.startedAtUtc) < Date.parse(prior.startedAtUtc))
    )
      throw Error('compound_attempt_invalid')
    rows.push(row)
  }
  return rows
}

export function auditCompoundAttemptLinkage(issues, attempts) {
  const bySequence = new Map(issues.map((issue) => [issue.sequence, issue]))
  const linked = new Set()
  const invalidAttemptSequences = []
  for (const attempt of attempts) {
    if (attempt.status !== 'issued') continue
    const issue = bySequence.get(attempt.issueSequence)
    if (
      !issue ||
      linked.has(issue.sequence) ||
      issue.sha256 !== attempt.issueSha256 ||
      issue.slot !== attempt.slot ||
      Date.parse(issue.issuedAtUtc) < Date.parse(attempt.startedAtUtc) ||
      Date.parse(issue.issuedAtUtc) > Date.parse(attempt.finishedAtUtc)
    ) {
      invalidAttemptSequences.push(attempt.sequence)
    } else {
      linked.add(issue.sequence)
    }
  }
  return {
    linkedIssues: linked.size,
    orphanIssueSequences: issues
      .filter((issue) => !linked.has(issue.sequence))
      .map((issue) => issue.sequence),
    invalidAttemptSequences,
  }
}

export async function appendCompoundAttempt(entry, out = OUT, stat = statfsSync) {
  await mkdir(out, { recursive: true })
  const prior = await verifyCompoundAttempts(out)
  const payload = {
    study: STUDY,
    sequence: prior.length + 1,
    previousSha256: prior.at(-1)?.sha256 ?? null,
    ...entry,
  }
  const sealed = { ...payload, sha256: sha(JSON.stringify(payload)) }
  const serialized = `${JSON.stringify(sealed)}\n`
  if (Buffer.byteLength(serialized) > 8_192) throw Error('compound_attempt_size_invalid')
  const disk = stat(out)
  if (Number(disk.bavail) * Number(disk.bsize) < 1_073_741_824 + Buffer.byteLength(serialized))
    throw Error('compound_attempt_disk_reserve')
  const temporary = join(out, `.attempt-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(serialized)
      await file.sync()
    } finally {
      await file.close()
    }
    await link(temporary, join(out, name(sealed.sequence)))
    const directory = await open(out, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return sealed
}

export async function runCompoundTick(mode, now = () => new Date()) {
  if (!['issue', 'score'].includes(mode)) throw Error('compound_tick_usage')
  const startedAtUtc = now().toISOString()
  const slot = Math.floor(Date.parse(startedAtUtc) / SLOT_MS)
  let status = 'failed'
  let result = null
  try {
    const issues = await verifyPublicDirectIssues()
    if (mode === 'issue' && issues.some((issue) => issue.slot === slot)) {
      status = 'duplicate_slot'
    } else {
      const urls = configuredPublicRpcUrls(readEnv())
      if (mode === 'issue') {
        result = await issuePublicDirectExit({
          marketKey: 'compoundV3Usdc',
          clients: publicRpcClients(urls),
          expectedSlot: slot,
        })
        status = 'issued'
      } else {
        const scores = await verifyPublicDirectScores()
        result = await runPublicDirectScoreSweep({ issues, scores, urls })
        status = 'scored_sweep'
      }
    }
  } catch {
    // Vendor errors may contain a credential or holder. Record only the failure.
  }
  const receipt = await appendCompoundAttempt({
    mode,
    slot,
    startedAtUtc,
    finishedAtUtc: now().toISOString(),
    status,
    issueSequence: status === 'issued' ? result.sequence : null,
    issueSha256: status === 'issued' ? result.sha256 : null,
    scoreSummary: status === 'scored_sweep' ? result : null,
  })
  return { status, sequence: receipt.sequence }
}

async function cli() {
  const mode = process.argv[2]
  if (mode === '--verify') {
    const rows = await verifyCompoundAttempts()
    const linkage = auditCompoundAttemptLinkage(await verifyPublicDirectIssues(), rows)
    if (linkage.invalidAttemptSequences.length) throw Error('compound_attempt_issue_link_invalid')
    process.stdout.write(
      `${JSON.stringify({ status: 'verified_local_chain', attempts: rows.length, ...linkage })}\n`,
    )
    return
  }
  const result = await runCompoundTick(mode)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status === 'failed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    process.stderr.write('local_compound_holder_attempt_failed\n')
    process.exitCode = 1
  })
}
