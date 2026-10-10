// Opt-in, bounded capture near pending NOW targets. Observations only; no alert.
import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from '@neondatabase/serverless'
import {
  collect,
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as ISSUE_OUT,
  readRow,
  verify as verifyIssues,
} from './scrvusd-exit-forecast-issue.mjs'
import { OUT as SCORE_OUT } from './scrvusd-exit-forecast-score.mjs'
import { BOUND_ISSUE_OUT, BOUND_SCORE_OUT } from './scrvusd-bound-paths.mjs'
import { verifyBoundIssueWithPgV2 } from './scrvusd-bound-issue-verifier.mjs'
import { readSources } from './scrvusd-holder-duration.mjs'
import { OUT as HOLDER_OUT, observe, readPlan } from './scrvusd-fixed-holder-exit.mjs'
import {
  OUT as ATTEST_OUT,
  capture as captureAttestation,
  readVerifiedAtCheckpoint,
  save as saveAttestation,
  verify as verifyAttestations,
} from './scrvusd-target-code-attestation.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'scrvusd-target-window-capture-pass-v1'
export const EARLY_SECONDS = 1800
export const LATE_SECONDS = 5400
export const MAX_SELECTED_BLOCKS = 8
const LOCK = resolve('data/research/venue-signals/.scrvusd-target-window-pass.lock')
const names = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
const ms = (value) => Date.parse(value)

export function activePendingIssues({ v1 = [], v2 = [], nowUtc }) {
  const now = ms(nowUtc)
  if (!Number.isFinite(now)) throw new Error('Invalid pass time')
  return [
    ...v1.map((row) => ({ ...row, lane: 'v1' })),
    ...v2.map((row) => ({ ...row, lane: 'v2' })),
  ]
    .filter(({ issue }) => {
      const target = ms(issue.targetUtc)
      const deadline = ms(issue.outcomeProtocol?.checkpointSelection?.captureDeadlineUtc)
      return (
        Number.isFinite(target) &&
        deadline === target + LATE_SECONDS * 1000 &&
        now >= target - EARLY_SECONDS * 1000 &&
        now <= deadline
      )
    })
    .sort((a, b) => ms(a.issue.targetUtc) - ms(b.issue.targetUtc))
}

export function scoreSelectedQuote(issue, checkpoints) {
  const target = ms(issue.targetUtc)
  const issued = ms(issue.issuedAtUtc)
  const deadline = ms(issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
  const window = issue.outcomeProtocol.checkpointSelection.windowSeconds * 1000
  return (
    checkpoints
      .filter((row) => {
        const block = row.checkpoint.block
        const time = block.timestamp * 1000
        return (
          time > issued &&
          Math.abs(time - target) <= window &&
          ms(row.checkpoint.captureEndUtc) <= deadline
        )
      })
      .sort(
        (a, b) =>
          Math.abs(a.checkpoint.block.timestamp * 1000 - target) -
            Math.abs(b.checkpoint.block.timestamp * 1000 - target) ||
          a.checkpoint.block.number - b.checkpoint.block.number ||
          a.checkpoint.block.hash.localeCompare(b.checkpoint.block.hash),
      )[0] ?? null
  )
}

function sameBlock(a, b) {
  return a?.number === b?.number && a?.hash === b?.hash
}

export function selectedPair(issue, quote, holderRows) {
  if (!quote) return { status: 'missing_quote_checkpoint' }
  const deadline = ms(issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
  const holder = holderRows.find(
    (row) =>
      sameBlock(row.issue.checkpoint.block, quote.checkpoint.block) &&
      ms(row.issue.captureEndUtc) <= deadline,
  )
  if (!holder) return { status: 'missing_holder_observation', block: quote.checkpoint.block.number }
  if (holder.issue.holder !== issue.holder || holder.issue.rawCrvUsd !== issue.qAssetsRaw)
    throw new Error('Score-selected quote has a different holder or amount')
  return {
    status: 'paired',
    block: quote.checkpoint.block.number,
    holderStatus: holder.issue.result.status,
  }
}

async function pendingRows({ now, pool, issueOut, scoreOut, boundIssueOut, boundScoreOut }) {
  verifyIssues({ out: issueOut, now })
  const v1 = names(issueOut)
    .filter((filename) => !existsSync(join(scoreOut, filename)))
    .map((filename) => readRow(issueOut, filename))
  const v2 = names(boundIssueOut)
    .filter((filename) => !existsSync(join(boundScoreOut, filename)))
    .map((filename) => readRow(boundIssueOut, filename))
  const active = activePendingIssues({ v1, v2, nowUtc: now().toISOString() })
  if (active.some((row) => row.lane === 'v2')) {
    if (!pool) throw new Error('V2 DB witness connection required')
    for (const row of active.filter((item) => item.lane === 'v2'))
      await verifyBoundIssueWithPgV2({ pool, issueFilename: row.filename, now })
  }
  return active
}

function acquirePassLock(path) {
  try {
    mkdirSync(path)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Target capture pass lock busy or stale')
    throw error
  }
  return () => rmdirSync(path)
}

const reason = (error) => {
  if (error?.reason === 'disk_reserve' || /disk reserve/i.test(error?.message ?? ''))
    return 'disk_reserve'
  if (error?.reason === 'rpc_failure') return 'rpc_failure'
  return 'capture_failed'
}

export async function runTargetWindowPass({
  now = () => new Date(),
  quoteClient,
  holderClient,
  pool = null,
  issueOut = ISSUE_OUT,
  scoreOut = SCORE_OUT,
  boundIssueOut = BOUND_ISSUE_OUT,
  boundScoreOut = BOUND_SCORE_OUT,
  quoteOut = QUOTE_OUT,
  holderOut = HOLDER_OUT,
  attestationOut = ATTEST_OUT,
  lockPath = LOCK,
  collectQuote = collect,
  loadPending = pendingRows,
  readCheckpoints = readValidatedCheckpoints,
  observeHolder = observe,
  captureCode = captureAttestation,
  saveCode = saveAttestation,
} = {}) {
  if (!quoteClient?.request || !holderClient?.request) throw new Error('Two RPC clients required')
  const release = acquirePassLock(lockPath)
  try {
    const active = await loadPending({
      now,
      pool,
      issueOut,
      scoreOut,
      boundIssueOut,
      boundScoreOut,
    })
    if (!active.length) return { status: 'no_active_pending_target', active: 0 }
    const identity = sourceIdentity()
    const stage = { quote: null, attestation: [], holder: [] }
    try {
      const capture = await collectQuote({ client: quoteClient, out: quoteOut })
      stage.quote = capture.status
    } catch (error) {
      stage.quote = reason(error)
    }
    const checkpoints = readCheckpoints({ out: quoteOut, identity })
    const selected = active.map((row) => ({
      row,
      quote: scoreSelectedQuote(row.issue, checkpoints),
    }))
    const selectedBlocks = new Map()
    for (const item of selected)
      if (item.quote) selectedBlocks.set(item.quote.checkpoint.block.number, item.quote)
    if (selectedBlocks.size > MAX_SELECTED_BLOCKS)
      throw new Error('Selected target block count exceeds bounded pass')
    let afterHolderRows = []
    if (selectedBlocks.size) {
      verifyAttestations({
        out: attestationOut,
        identity,
        checkpoints,
        nowUtc: now().toISOString(),
      })
      const plan = readPlan({ out: holderOut, identity })
      if (!plan) throw new Error('Predeclared holder plan missing')
      const holderSources = readSources({ quoteOut, holderOut, now })
      for (const quote of selectedBlocks.values()) {
        const block = quote.checkpoint.block.number
        const related = selected.filter((item) => item.quote?.checkpoint.block.number === block)
        let attested = readVerifiedAtCheckpoint({
          out: attestationOut,
          identity,
          checkpoint: quote,
          asOfUtc: now().toISOString(),
          nowUtc: now().toISOString(),
        })
        if (!attested) {
          try {
            const receipt = await captureCode({
              client: quoteClient,
              checkpoints: [quote],
              identity,
              now,
            })
            saveCode({
              receipt,
              out: attestationOut,
              identity,
              checkpoints,
              nowUtc: now().toISOString(),
            })
            attested = readVerifiedAtCheckpoint({
              out: attestationOut,
              identity,
              checkpoint: quote,
              asOfUtc: now().toISOString(),
              nowUtc: now().toISOString(),
            })
          } catch (error) {
            stage.attestation.push({ block, status: reason(error) })
          }
        }
        if (attested) stage.attestation.push({ block, status: 'attested' })
        const already = holderSources.holderRows.find((item) =>
          sameBlock(item.issue.checkpoint.block, quote.checkpoint.block),
        )
        if (already) continue
        if (
          related.some(
            ({ row }) =>
              row.issue.holder !== plan.holder || row.issue.qAssetsRaw !== plan.rawCrvUsd,
          )
        )
          throw new Error('Pending issue holder or amount differs from fixed plan')
        try {
          const result = await observeHolder({
            client: holderClient,
            out: holderOut,
            quoteOut,
            checkpointBlock: block,
            now,
          })
          stage.holder.push({ block, status: result.status, reason: result.reason ?? null })
        } catch (error) {
          stage.holder.push({ block, status: reason(error) })
        }
      }
      afterHolderRows = readSources({ quoteOut, holderOut, now }).holderRows
    }
    const pairs = selected.map(({ row, quote }) => ({
      lane: row.lane,
      issueFilename: row.filename,
      ...selectedPair(row.issue, quote, afterHolderRows),
    }))
    const failures = [
      ...(!['recorded', 'unchanged'].includes(stage.quote) ? [stage.quote] : []),
      ...stage.attestation.filter((item) => item.status !== 'attested').map((item) => item.status),
      ...stage.holder
        .filter((item) => !['success', 'revert'].includes(item.status))
        .map((item) => item.reason ?? item.status),
      ...pairs
        .filter((item) => item.status !== 'paired' || item.holderStatus === 'provider_error')
        .map((item) => (item.status === 'paired' ? 'provider_ambiguity' : item.status)),
    ]
    return {
      status: failures.length ? 'partial' : 'observed',
      active: active.length,
      missingPairCount: pairs.filter((item) => item.status !== 'paired').length,
      failureReasons: [...new Set(failures)],
      stage,
      pairs,
      forecastEligible: false,
    }
  } finally {
    release()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 1 || args[0] !== '--run')) {
    console.error(JSON.stringify({ status: 'error', reason: 'invalid_options' }))
    process.exitCode = 1
  } else if (!args.length) {
    console.log(JSON.stringify({ mode: 'dry', study: STUDY, cadence: 'opt_in_target_window' }))
  } else {
    let pool
    try {
      const config = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL') || ''
      const hosts = config.split(',').map((value) => value.trim())
      if (hosts.length < 2 || hosts.some((host) => !/^https?:\/\//.test(host)))
        throw new Error('Two configured RPC hosts required')
      const url = process.env.SCRVUSD_SCHEDULE_PUBLISHER_DATABASE_URL
      if (url) pool = new Pool({ connectionString: url })
      console.log(
        JSON.stringify(
          await runTargetWindowPass({
            quoteClient: makeClient(hosts[0]),
            holderClient: makeClient(hosts[1]),
            pool,
          }),
        ),
      )
    } catch {
      console.error(JSON.stringify({ status: 'error', reason: 'target_capture_failed' }))
      process.exitCode = 1
    } finally {
      await pool?.end()
    }
  }
}
