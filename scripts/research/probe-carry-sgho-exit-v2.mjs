// Reproducible public-chain-only sGHO V2 issue feasibility probe. It keeps
// discovered holders, frozen Qs, RPC URLs, and all raw proofs in memory.
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { configuredRpcUrls, rpcTransport } from '../record-carry-morpho-exit-v2-issues.mjs'
import {
  prepareSyncVaultOrigin,
  syncVaultCaseFromMeasurement,
} from '../record-carry-sync-vault-exit-v2-issues.mjs'

const ROUTE_KEY = 'GHO → sGho [GHO]'
const VAULT = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
const ADDRESS = /^0x[0-9a-f]{40}$/
const POSITIVE = /^[1-9][0-9]*$/
const BUDGET_MS = 10 * 60_000
const SOURCE = 'carry_exit_v2_sgho_public_probe'

function exactRoute() {
  const matches = CARRY_EXIT_V2_FROZEN_ROUTES.filter(
    (route) =>
      route.kind === 'sgho' &&
      route.routeKey === ROUTE_KEY &&
      route.destination === VAULT &&
      route.asset === GHO,
  )
  if (matches.length !== 1) throw Error('sgho_frozen_route_invalid')
  if (
    CARRY_EXIT_V2_FROZEN_ROUTES.some(
      (route) => route.destination === VAULT && route.routeKey === 'USDe → sGho [GHO]',
    )
  )
    throw Error('sgho_conversion_route_unsupported')
  return matches[0]
}

function differentOrigin(primary, secondary) {
  const host = (client) => {
    const url = new URL(client.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw Error('probe_origin_invalid')
    return url.hostname.replace(/\.$/, '').replace(/^www\./, '')
  }
  return host(primary) !== host(secondary)
}

function sixCases(candidate) {
  if (
    !ADDRESS.test(candidate?.holder ?? '') ||
    !candidate.evidenceDoc ||
    createHash('sha256').update(JSON.stringify(candidate.evidenceDoc)).digest('hex') !==
      candidate.digest
  )
    throw Error('probe_candidate_invalid')
  const labels = candidate.evidenceDoc.ladder?.labels
  if (
    !Array.isArray(labels) ||
    labels.length !== 6 ||
    new Set(labels.map((row) => row.label)).size !== 6
  )
    throw Error('probe_ladder_invalid')
  const positive = labels.filter((row) => row.assetsRaw !== null)
  if (
    !positive.length ||
    new Set(positive.map((row) => row.assetsRaw)).size !== positive.length ||
    positive.some((row) => !POSITIVE.test(row.assetsRaw ?? '') || row.reason !== null) ||
    labels.some((row) => row.assetsRaw === null && typeof row.reason !== 'string')
  )
    throw Error('probe_ladder_invalid')
  return { positive, omitted: labels.length - positive.length }
}

function emptySummary() {
  return {
    schema: 'carry_exit_v2_sgho_public_probe_v1',
    candidateCount: 0,
    plannedCases: 6,
    positiveCases: 0,
    omittedCases: 0,
    verifiedCases: 0,
    counts: { success: 0, ineligible: 0, covered_revert: 0, inconclusive: 0, unavailable: 0 },
  }
}

/** Public finalized holder discovery and two-origin simulations; no persistence. */
export async function probeCarrySghoExitV2({
  urls,
  verifyUrl,
  now = () => new Date(),
  budgetMs = BUDGET_MS,
  transport = rpcTransport,
  prepare = prepareSyncVaultOrigin,
  measure = measureCarryExitV2Verified,
  decode = validateCarryExitV2RpcProof,
} = {}) {
  if (
    !Array.isArray(urls) ||
    !urls.length ||
    typeof verifyUrl !== 'string' ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 120_000 ||
    budgetMs > BUDGET_MS
  )
    throw Error('probe_input_invalid')
  const route = exactRoute()
  const started = now().getTime()
  if (!Number.isSafeInteger(started)) throw Error('probe_clock_invalid')
  const deadlineMs = started + budgetMs
  const slot = Math.floor((started - 10 * 60_000) / (15 * 60_000))
  const prepared = await prepare({
    urls,
    route,
    slot,
    deadlineMs: deadlineMs - 120_000,
    transport,
    now,
  })
  const result = emptySummary()
  if (!prepared?.primary || !prepared.baseline || !prepared.candidate?.holder) return result
  const { primary, baseline, candidate } = prepared
  if (
    baseline.routeKey !== route.routeKey ||
    baseline.destination !== VAULT ||
    baseline.asset !== GHO
  )
    throw Error('probe_baseline_identity_invalid')
  const secondary = transport(verifyUrl)
  if (!differentOrigin(primary, secondary)) throw Error('probe_independent_origin_missing')
  const { positive, omitted } = sixCases(candidate)
  result.candidateCount = 1
  result.positiveCases = positive.length
  result.omittedCases = omitted
  for (const entry of positive) {
    if (now().getTime() >= deadlineMs) {
      result.counts.unavailable++
      continue
    }
    try {
      const verified = await measure({
        routeKey: ROUTE_KEY,
        destination: VAULT,
        asset: GHO,
        holder: candidate.holder,
        assetsRaw: entry.assetsRaw,
        target: baseline,
        provider: primary.provider,
        source: SOURCE,
        send: (envelope) => primary.send(envelope),
        primary: { url: primary.url, request: (envelope) => primary.send(envelope) },
        secondary: { url: secondary.url, request: (envelope) => secondary.send(envelope) },
        now,
      })
      if (verified.status !== 'verified') {
        result.counts.unavailable++
        continue
      }
      const decoded = decode({
        proof: verified.callEvidenceDoc,
        routeKey: ROUTE_KEY,
        destination: VAULT,
        asset: GHO,
        holder: candidate.holder,
        assetsRaw: entry.assetsRaw,
        blockNumber: baseline.targetBlock,
        blockHash: baseline.targetHash,
      })
      const status = syncVaultCaseFromMeasurement(
        entry.assetsRaw,
        verified.callEvidenceDoc,
        decoded,
      ).baselineStatus
      if (!Object.hasOwn(result.counts, status)) throw Error('probe_case_status_invalid')
      result.counts[status]++
      result.verifiedCases++
    } catch {
      result.counts.unavailable++
    }
  }
  return result
}

async function main() {
  if (process.argv.length !== 2) throw Error('usage: no arguments')
  const { get } = readEnv()
  const urls = configuredRpcUrls(get('RECORDER_RPC_URLS') || get('RECORDER_RPC_URL'))
  const verifyUrl = get('CARRY_EXIT_V2_VERIFY_RPC_URL') || 'https://eth.drpc.org'
  return probeCarrySghoExitV2({ urls, verifyUrl })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch(() => {
      process.stderr.write('carry_exit_v2_sgho_public_probe_failed\n')
      process.exitCode = 1
    })
}
