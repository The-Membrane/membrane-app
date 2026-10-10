import {
  carryExitV2RpcBudgetReason,
  startCarryExitV2BudgetedRpc,
} from './carry-exit-v2-rpc-budget.mjs'
import { freezeUmbrellaGhoGateTargets } from './carry-exit-v2-umbrella-gho-policy.mjs'
import { createHash } from 'node:crypto'
import { readUmbrellaGhoV2SeedHolders } from './carry-exit-v2-umbrella-gho-seed.mjs'
export { readUmbrellaGhoV2SeedHolders } from './carry-exit-v2-umbrella-gho-seed.mjs'

import { UMBRELLA_GHO_ROUTE, umbrellaGhoCalldata } from './carry-exit-v2-umbrella-gho-proof.mjs'
import { umbrellaGhoCaseFromMeasurement } from './carry-exit-v2-umbrella-gho-classifier.mjs'
import { captureFreshSyncVaultBaseline } from './carry-exit-v2-sync-vault-issuer-prep.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'

const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const DEFAULT_Q = '10000000000000000000000'
const WORD = /^0x[0-9a-f]{64}$/
/** Seed addresses are discovery hints only. Their current EOA and GHO claim are re-read. */
export async function discoverUmbrellaGhoV2Candidate({
  baseline,
  request,
  assetsRaw = DEFAULT_Q,
  holders = readUmbrellaGhoV2SeedHolders(),
  candidateLimit = 21,
}) {
  if (
    !/^[1-9][0-9]*$/.test(assetsRaw) ||
    BigInt(assetsRaw) >= 1n << 256n ||
    !Number.isInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 21 ||
    !Array.isArray(holders) ||
    holders.length > 21 ||
    holders.some((h) => !/^0x[0-9a-f]{40}$/.test(h))
  )
    throw Error('umbrella_candidate_input_invalid')
  const pin = { blockHash: baseline.targetHash, requireCanonical: true },
    screenedCandidates = []
  let holder = null
  for (const owner of holders.slice(0, candidateLimit)) {
    const row = {
      holderCommitment: sha(`${UMBRELLA_GHO_ROUTE.destination}:${owner}`),
      status: 'rpc_unavailable',
    }
    screenedCandidates.push(row)
    try {
      if ((await request('eth_getCode', [owner, pin])) !== '0x') {
        row.status = 'contract_holder'
        continue
      }
      const balance = await request('eth_call', [
        {
          to: UMBRELLA_GHO_ROUTE.destination,
          data: `0x70a08231${owner.slice(2).padStart(64, '0')}`,
        },
        pin,
      ])
      if (!WORD.test(balance ?? '')) throw Error('invalid_balance')
      const claim = await request('eth_call', [
        {
          to: UMBRELLA_GHO_ROUTE.destination,
          data: umbrellaGhoCalldata('previewRedeem', [BigInt(balance)]),
        },
        pin,
      ])
      if (!WORD.test(claim ?? '')) throw Error('invalid_claim')
      row.holderSharesRaw = BigInt(balance).toString()
      row.originalGhoClaimRaw = BigInt(claim).toString()
      if (BigInt(claim) < BigInt(assetsRaw)) {
        row.status = 'original_gho_claim_below_q'
        continue
      }
      row.status = 'eligible_holder'
      holder = owner
      break
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  const evidenceDoc = {
    schema: 'carry_exit_v2_umbrella_gho_candidate_v1',
    chainId: '1',
    routeKey: UMBRELLA_GHO_ROUTE.routeKey,
    destination: UMBRELLA_GHO_ROUTE.destination,
    asset: UMBRELLA_GHO_ROUTE.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    seedSha256: SEED_SHA256,
    selectedHolderCommitment: holder ? sha(`${UMBRELLA_GHO_ROUTE.destination}:${holder}`) : null,
    screenedCandidates,
    selectionRule: 'first_hash_bound_seed_pinned_eoa_covering_original_gho_q',
    unavailableReason: holder ? null : 'no_original_gho_q_holder_in_bounded_seed',
    ladder: { labels: [{ label: 'original_gho_fixed_q', assetsRaw, reason: null }] },
  }
  return { holder, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}

/** Fourth-source local issuance. Sealed recovery runs before any RPC starts. */
export async function issueUmbrellaGhoV2Route({
  sql,
  slot,
  route = UMBRELLA_GHO_ROUTE,
  primary,
  secondary,
  resumeSealedEpisode,
  persist,
  hashEvidence,
  appendAttempt,
  now = () => new Date(),
  deadlineMs = null,
  rpcBudget = null,
  captureBaseline = captureFreshSyncVaultBaseline,
  discoverCandidate = discoverUmbrellaGhoV2Candidate,
  measure = measureCarryExitV2Verified,
  assetsRaw = DEFAULT_Q,
}) {
  if (
    route.routeKey !== UMBRELLA_GHO_ROUTE.routeKey ||
    route.destination !== UMBRELLA_GHO_ROUTE.destination ||
    route.asset !== UMBRELLA_GHO_ROUTE.asset
  )
    throw Error('umbrella_route_required')
  const recovered = await resumeSealedEpisode?.({ route, slot })
  if (recovered)
    return {
      status: 'issued_recovered',
      batchId: recovered.episodeId,
      reason: 'local_sealed_plan_resumed',
    }
  const started = Date.now(),
    wallDeadline = started + 240000,
    deadline = Math.min(
      deadlineMs ?? now().getTime() + 240000,
      (slot + 1) * 900000 + 600000 - 30000,
    )
  const budget = rpcBudget ?? {
    starts: 0,
    limit: 256,
    deadlineMs: deadline,
    wallDeadlineMs: wallDeadline,
  }
  if (
    !Number.isSafeInteger(budget.starts) ||
    budget.starts < 0 ||
    budget.starts > budget.limit ||
    !Number.isSafeInteger(budget.deadlineMs) ||
    !Number.isSafeInteger(budget.wallDeadlineMs) ||
    !Number.isSafeInteger(budget.limit) ||
    budget.limit < 1 ||
    budget.limit > 256
  )
    throw Error('umbrella_budget_invalid')
  budget.deadlineMs = Math.min(budget.deadlineMs, deadline)
  budget.wallDeadlineMs = Math.min(budget.wallDeadlineMs, wallDeadline)
  const codes = { cap: 'issuer_rpc_start_limit', deadline: 'issuer_deadline_elapsed' }
  const exhausted = () => carryExitV2RpcBudgetReason(budget, now().getTime(), codes)
  const externalBudgeted = primary?.rpcBudget === budget && secondary?.rpcBudget === budget
  const guard = () => {
    if (externalBudgeted) {
      const reason = exhausted()
      if (reason) throw Error(reason)
    } else startCarryExitV2BudgetedRpc(budget, now().getTime(), codes)
  }
  const bounded =
    (fn) =>
    async (...args) => {
      guard()
      let timer
      try {
        const remaining = Math.min(
          15000,
          budget.deadlineMs - now().getTime(),
          budget.wallDeadlineMs - Date.now(),
        )
        const value = await Promise.race([
          fn(...args),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error('issuer_deadline_elapsed')),
              Math.max(1, remaining),
            )
          }),
        ])
        const reason = exhausted()
        if (reason) throw Error(reason)
        return value
      } finally {
        clearTimeout(timer)
      }
    }
  const unavailable = async (reason) => {
    reason = exhausted() ?? reason
    await appendAttempt?.({
      schema: 'carry_exit_v2_umbrella_gho_attempt_v1',
      slot,
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      at: now().toISOString(),
      status: 'unavailable',
      reason,
    })
    return { status: 'unavailable', reason }
  }
  try {
    const host = (url) => {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw Error('invalid_origin')
      const hostname = parsed.hostname.replace(/\.$/, '').replace(/^www\./, '')
      return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname) ? 'loopback' : hostname
    }
    if (
      !primary?.request ||
      !primary.send ||
      !secondary?.send ||
      host(primary.url) === host(secondary.url)
    )
      return unavailable('independent_rpc_unavailable')
    const request = bounded(primary.request.bind(primary)),
      send = bounded(primary.send.bind(primary)),
      secondarySend = bounded(secondary.send.bind(secondary))
    const baseline = await captureBaseline({
      ...route,
      provider: primary.provider,
      source: 'carry_exit_v2_umbrella_gho_issuer',
      request,
      now,
    })
    if (exhausted()) return unavailable(exhausted())
    if (baseline.assetDecimals !== 18 || baseline.shareDecimals !== 18)
      return unavailable('umbrella_decimals_invalid')
    const candidate = await discoverCandidate({ baseline, request, assetsRaw })
    if (exhausted()) return unavailable(exhausted())
    if (!candidate.holder) return unavailable(candidate.evidenceDoc.unavailableReason)
    const verified = await measure({
      ...route,
      holder: candidate.holder,
      assetsRaw,
      target: baseline,
      provider: primary.provider,
      source: 'carry_exit_v2_umbrella_gho_issuer',
      send,
      primary: { url: primary.url, request: send },
      secondary: { url: secondary.url, request: secondarySend },
      now,
    })
    if (exhausted()) return unavailable(exhausted())
    if (verified.status !== 'verified') return unavailable('umbrella_measurement_unavailable')
    const call = verified.callEvidenceDoc,
      decoded = validateCarryExitV2RpcProof({
        proof: call,
        ...route,
        holder: candidate.holder,
        assetsRaw,
        blockNumber: baseline.targetBlock,
        blockHash: baseline.targetHash,
      })
    candidate.evidenceDoc.gateProjection = freezeUmbrellaGhoGateTargets(
      decoded,
      now().toISOString(),
    )
    const entry = umbrellaGhoCaseFromMeasurement(assetsRaw, call, decoded)
    entry.callEvidenceSha256 = await hashEvidence(sql, entry.callEvidenceDoc)
    if (entry.entitlementEvidenceDoc)
      entry.entitlementEvidenceSha256 = await hashEvidence(sql, entry.entitlementEvidenceDoc)
    const plan = {
      version: 'carry_exit_v2',
      clock: 'db_issued_at',
      endpointSelection: 'first_finalized_at_or_after_target',
      captureDeadlineHours: 2,
      horizons: candidate.evidenceDoc.gateProjection.horizons,
      routeKey: route.routeKey,
      slotAt: new Date(slot * 900000 + 600000).toISOString(),
      destination: route.destination,
      asset: route.asset,
      assetDecimals: 18,
      holder: candidate.holder,
      baselineBlock: baseline.targetBlock,
      baselineHash: baseline.targetHash,
      baselineBlockAt: baseline.targetBlockAt,
      baselineObservedAt: baseline.targetObservedAt,
      candidateProvenance: 'hash_bound_frozen_seed_pinned_eoa_claim',
      candidateEvidenceSha256: await hashEvidence(sql, candidate.evidenceDoc),
      candidateEvidenceDoc: candidate.evidenceDoc,
      canonicalityEvidenceDoc: baseline.canonicalityEvidenceDoc,
      omittedLadder: [],
      cases: [entry],
    }
    if (now().getTime() >= deadline || Date.now() >= wallDeadline)
      return unavailable('issuer_deadline_elapsed')
    const batchId = await persist(sql, plan)
    return {
      status: 'issued',
      batchId,
      cases: 1,
      originalQRaw: assetsRaw,
      minedPayoutProven: false,
      forecastValidated: false,
    }
  } catch (error) {
    return unavailable(
      ['issuer_rpc_start_limit', 'issuer_deadline_elapsed'].includes(error.message)
        ? error.message
        : 'umbrella_capture_unavailable',
    )
  }
}
