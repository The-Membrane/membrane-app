// Forward outcomes for newly enrolled ApyUSD receipts. Intake tracks ownership;
// only a separate two-origin mined transaction proof can record a holder payout.
import { createHash } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { RECEIPT, normalizeMint, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { readHolderPayoutWitness, readOne } from './apyusd-receipt-cohort-payouts.mjs'
import { verifyProspectiveIntake } from './apyusd-prospective-receipt-intake.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-prospective-receipt-outcomes-v1')
const STUDY = 'apyusd_prospective_receipt_holder_payout_v1'
const ZERO = `0x${'0'.repeat(64)}`
const SHA = /^[0-9a-f]{64}$/
const POSITIVE = /^[1-9][0-9]*$/
const TOKEN = /^(0|[1-9][0-9]*)$/
const MAX_PROOF_BYTES = 16_384
const MIN_FREE_BYTES = 1_073_741_824 + 65_536
const MAX_RPC_CALLS = 48
const MAX_WALL_MS = 120_000
const CANDIDATE_ROTATION_MS = 3 * 60 * 60 * 1_000
const RECENT_CANDIDATES = 4
const FIELDS = [
  'study',
  'tokenId',
  'receipt',
  'intakeAnchorSha256',
  'mintWindowSha256',
  'burnWindowSha256',
  'mintSha256',
  'burnSha256',
  'origins',
  'proof',
  'capturedAtUtc',
  'sha256',
]
  .sort()
  .join(',')
const fail = (condition, code) => {
  if (!condition) throw Error(code)
}
const canonical = JSON.stringify
const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(canonical(body)) })
const bodyHash = (row) => {
  const { sha256: _seal, ...body } = row
  return sha(canonical(body))
}
const id = (event) => BigInt(event.topics[3]).toString()
const address = (topic) => `0x${topic.slice(-40)}`
const pathFor = (out, tokenId) => join(out, `${tokenId}.json`)

function allMints(intake) {
  fail(intake?.anchor && Array.isArray(intake.windows), 'apyusd_prospective_intake_missing')
  const seen = new Set()
  const entries = []
  for (const window of intake.windows) {
    for (const mint of window.mints) {
      fail(TOKEN.test(mint.tokenId) && !seen.has(mint.tokenId), 'apyusd_prospective_duplicate_mint')
      seen.add(mint.tokenId)
      entries.push({ mint, window })
    }
  }
  return entries
}

function indexIntake(intake) {
  const entries = allMints(intake)
  const entriesByToken = new Map(entries.map((entry) => [entry.mint.tokenId, entry]))
  const transfers = new Map()
  for (const window of intake.windows)
    for (const event of window.transfers) {
      const tokenId = id(event)
      if (!transfers.has(tokenId)) transfers.set(tokenId, [])
      transfers.get(tokenId).push({ event, window })
    }
  return { entries, entriesByToken, transfers }
}

// Full receipt-transfer replay from the enrolled mint through the last sealed
// contiguous window. A transfer away permanently excludes this original-holder
// episode, even if the NFT later comes back to the original address.
function replayIndexed(intake, tokenId, index) {
  fail(TOKEN.test(tokenId), 'apyusd_prospective_token_id_invalid')
  const entry = index.entriesByToken.get(tokenId)
  fail(entry, 'apyusd_prospective_token_not_enrolled')
  const { mint, window: mintWindow } = entry
  const mintEvent = normalizeMint(mint.rawLog, mintWindow.fromBlock, mintWindow.toBlock)
  fail(
    intake.coveredThrough === intake.windows.at(-1)?.toBlock &&
      canonical(mintEvent) ===
        canonical(
          mintWindow.transfers.find(
            (event) =>
              event.blockNumber === mint.issueBlockNumber &&
              event.logIndex === mint.logIndex &&
              id(event) === tokenId,
          ),
        ) &&
      mint.initialHolder === address(mintEvent.topics[2]),
    'apyusd_prospective_mint_invalid',
  )
  let owner = mint.initialHolder
  let started = false
  let lostOriginalControl = false
  let burn = null
  let burnWindow = null
  for (const { event, window } of index.transfers.get(tokenId) ?? []) {
    if (!started) {
      fail(canonical(event) === canonical(mintEvent), 'apyusd_prospective_pre_mint_transfer')
      started = true
      continue
    }
    fail(!burn, 'apyusd_prospective_post_burn_transfer')
    fail(
      event.topics[1] !== ZERO && address(event.topics[1]) === owner,
      'apyusd_prospective_ownership_chain_invalid',
    )
    const recipient = address(event.topics[2])
    if (event.topics[2] === ZERO) {
      burn = event
      burnWindow = window
    } else {
      if (recipient !== mint.initialHolder) lostOriginalControl = true
      owner = recipient
    }
  }
  fail(started, 'apyusd_prospective_mint_not_scanned')
  const observedThroughBlock = intake.coveredThrough
  const observedThroughTimestamp = intake.windows.at(-1).toHeader.timestamp
  fail(
    observedThroughBlock >= mint.issueBlockNumber &&
      observedThroughTimestamp >= mint.issueBlockTimestamp,
    'apyusd_prospective_coverage_invalid',
  )
  return {
    tokenId,
    holder: mint.initialHolder,
    mint,
    mintEvent,
    mintWindow,
    burn,
    burnWindow,
    lostOriginalControl,
    observedThroughBlock,
    observedThroughTimestamp,
    observedSeconds: observedThroughTimestamp - mint.issueBlockTimestamp,
  }
}

export function replayProspectiveReceipt(intake, tokenId) {
  return replayIndexed(intake, tokenId, indexIntake(intake))
}

function validWitness(payout, holder) {
  try {
    const witness = payout?.payoutTransferWitness
    return (
      canonical(readHolderPayoutWitness({ logs: [witness] }, holder)) === canonical(witness) &&
      BigInt(witness.data).toString() === payout.paidAssetRaw
    )
  } catch {
    return false
  }
}

export function validateProspectivePayout(row, candidate, intake) {
  const { mint, mintWindow, burn, burnWindow, tokenId, holder } = candidate
  fail(
    burn &&
      burnWindow &&
      !candidate.lostOriginalControl &&
      burn.topics[1] === candidate.mintEvent.topics[2] &&
      burn.topics[2] === ZERO,
    'apyusd_prospective_payout_candidate_invalid',
  )
  const burnHeader = burnWindow.eventBlockHeaders.find(
    (header) => header.number === burn.blockNumber && header.hash === burn.blockHash,
  )
  const capturedAtMs = Date.parse(row?.capturedAtUtc ?? '')
  const burnObservedAtMs = Date.parse(burnWindow.observedAtUtc ?? '')
  const proof = row?.proof
  const request = proof?.request
  const payout = proof?.payout
  fail(
    row?.study === STUDY &&
      Object.keys(row).sort().join(',') === FIELDS &&
      row.tokenId === tokenId &&
      row.receipt === RECEIPT &&
      row.intakeAnchorSha256 === intake.anchor.sha256 &&
      row.mintWindowSha256 === mintWindow.sha256 &&
      row.burnWindowSha256 === burnWindow.sha256 &&
      row.mintSha256 === sha(canonical(mint)) &&
      row.burnSha256 === sha(canonical(burn)) &&
      canonical(row.origins) === canonical(intake.anchor.origins) &&
      Number.isSafeInteger(capturedAtMs) &&
      Number.isSafeInteger(burnObservedAtMs) &&
      new Date(capturedAtMs).toISOString() === row.capturedAtUtc &&
      capturedAtMs + 120_000 >= Math.max(burnHeader?.timestamp * 1_000, burnObservedAtMs) &&
      proof?.tokenId === tokenId &&
      proof.holder === holder &&
      request?.blockNumber === mint.issueBlockNumber &&
      request.blockHash === mint.issueBlockHash &&
      request.transactionHash === mint.transactionHash &&
      request.logIndex === mint.logIndex &&
      request.timestamp === mint.issueBlockTimestamp &&
      POSITIVE.test(request.requestedAssetRaw ?? '') &&
      payout?.blockNumber === burn.blockNumber &&
      payout.blockHash === burn.blockHash &&
      payout.transactionHash === burn.transactionHash &&
      payout.logIndex === burn.logIndex &&
      payout.timestamp === burnHeader?.timestamp &&
      POSITIVE.test(payout.paidAssetRaw ?? '') &&
      validWitness(payout, holder) &&
      proof.requestToPayoutSeconds === payout.timestamp - request.timestamp &&
      proof.requestToPayoutSeconds > 0 &&
      Number.isSafeInteger(proof.payoutBpsFloor) &&
      proof.payoutBpsFloor ===
        Number((BigInt(payout.paidAssetRaw) * 10_000n) / BigInt(request.requestedAssetRaw)) &&
      SHA.test(row.sha256 ?? '') &&
      row.sha256 === bodyHash(row),
    'apyusd_prospective_payout_invalid',
  )
  return row
}

export function buildProspectivePayout(proof, candidate, intake, capturedAtUtc) {
  return validateProspectivePayout(
    seal({
      study: STUDY,
      tokenId: candidate.tokenId,
      receipt: RECEIPT,
      intakeAnchorSha256: intake.anchor.sha256,
      mintWindowSha256: candidate.mintWindow.sha256,
      burnWindowSha256: candidate.burnWindow.sha256,
      mintSha256: sha(canonical(candidate.mint)),
      burnSha256: sha(canonical(candidate.burn)),
      origins: intake.anchor.origins,
      proof,
      capturedAtUtc,
    }),
    candidate,
    intake,
  )
}

// Offline classification names the last observed block. A saved receipt proof
// is a recorded capture, not independent live re-verification of the RPCs.
function classifyCandidate(intake, candidate, savedProof) {
  const { tokenId } = candidate
  if (savedProof) validateProspectivePayout(savedProof, candidate, intake)
  fail(
    !savedProof || (candidate.burn && !candidate.lostOriginalControl),
    'apyusd_prospective_payout_candidate_invalid',
  )
  const status = candidate.lostOriginalControl
    ? 'transferred_lost_control'
    : !candidate.burn
      ? 'original_holder_by_transfer_replay_unburned'
      : savedProof
        ? 'burned_with_saved_payout_proof'
        : 'burned_no_verified_payout'
  return {
    tokenId,
    initialHolder: candidate.holder,
    status,
    issuedAt: candidate.mint.issueBlockTimestamp,
    observedThroughBlock: candidate.observedThroughBlock,
    observedThroughTimestamp: candidate.observedThroughTimestamp,
    observedSeconds: candidate.observedSeconds,
    burnBlock: candidate.burn?.blockNumber ?? null,
    paidAt: savedProof?.proof.payout.timestamp ?? null,
    ...(savedProof ? { payoutProofSha256: savedProof.sha256 } : {}),
    requestToPayoutSeconds: savedProof?.proof.requestToPayoutSeconds ?? null,
    paymentEvidence: savedProof ? 'sealed_two_origin_capture_not_live_reverified' : 'none',
  }
}

export function classifyProspectiveReceipt(intake, tokenId, savedProof = null) {
  return classifyCandidate(intake, replayProspectiveReceipt(intake, tokenId), savedProof)
}

async function readSaved(path) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let bytes
  try {
    const stat = await handle.stat()
    fail(stat.isFile() && stat.size <= MAX_PROOF_BYTES, 'apyusd_prospective_payout_size_invalid')
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const row = JSON.parse(bytes.toString('utf8'))
  fail(
    bytes.toString('utf8') === `${canonical(row)}\n`,
    'apyusd_prospective_payout_encoding_invalid',
  )
  return row
}

export async function readProspectiveStatus(
  tokenId,
  { out = OUT, intakeLoader = verifyProspectiveIntake } = {},
) {
  fail(TOKEN.test(tokenId), 'apyusd_prospective_token_id_invalid')
  const intake = await intakeLoader()
  const row = await readSaved(pathFor(out, tokenId))
  return classifyProspectiveReceipt(intake, tokenId, row)
}

export async function readProspectiveOutcomes({
  out = OUT,
  intakeLoader = verifyProspectiveIntake,
} = {}) {
  const intake = await intakeLoader()
  if (!intake.anchor || intake.windows.length === 0)
    return { status: 'not_enrolled', coveredThrough: intake.coveredThrough, receipts: [] }
  const receipts = []
  const index = indexIntake(intake)
  for (const { mint } of index.entries) {
    const row = await readSaved(pathFor(out, mint.tokenId))
    receipts.push(classifyCandidate(intake, replayIndexed(intake, mint.tokenId, index), row))
  }
  return {
    status: 'observed',
    anchorSha256: intake.anchor.sha256,
    coveredThrough: intake.coveredThrough,
    observedThroughTimestamp: intake.windows.at(-1).toHeader.timestamp,
    receipts,
  }
}

function boundedOrigins(origins, clock) {
  const deadline = clock() + MAX_WALL_MS
  let calls = 0
  const check = () => fail(clock() < deadline, 'apyusd_prospective_payout_rpc_budget')
  return {
    clients: origins.map((origin) => ({
      ...origin,
      async request(...args) {
        fail(calls < MAX_RPC_CALLS, 'apyusd_prospective_payout_rpc_budget')
        check()
        calls++
        return origin.request(...args)
      },
    })),
    check,
  }
}

async function liveProof(candidate, intake, { clientsForUrls, urls, reader, rpcClock }) {
  const clients = clientsForUrls(urls ?? configuredPublicRpcUrls(readEnv()))
  const origins = intake.anchor.origins.map((host) =>
    clients.find((client) => new URL(client.url).hostname === host),
  )
  fail(
    origins.length === 2 && origins.every(Boolean) && origins[0].provider !== origins[1].provider,
    'apyusd_prospective_payout_origins_invalid',
  )
  const bounded = boundedOrigins(origins, rpcClock)
  const proofs = await Promise.all(
    bounded.clients.map((client) =>
      reader(client, candidate.mintEvent, candidate.burn, {
        requireUniqueBurn: true,
        includePayoutWitness: true,
        requireCanonicalBurn: true,
      }),
    ),
  )
  bounded.check()
  fail(canonical(proofs[0]) === canonical(proofs[1]), 'apyusd_prospective_payout_origins_disagree')
  return proofs[0]
}

// At most one burned original-holder receipt is assayed per invocation. A
// specific tokenId can be selected to avoid starving later candidates when an
// earlier burn has no same-tx holder payout.
export async function captureProspectivePayout({
  tokenId = null,
  out = OUT,
  intakeLoader = verifyProspectiveIntake,
  clientsForUrls = publicRpcClients,
  urls = null,
  reader = readOne,
  writer = writeExclusive,
  rpcClock = Date.now,
  capturedAtUtc = null,
  freeBytes = () => {
    const disk = statfsSync(dirname(out))
    return Number(disk.bavail) * Number(disk.bsize)
  },
} = {}) {
  const intake = await intakeLoader()
  if (!intake.anchor || intake.windows.length === 0)
    return { status: 'no_enrolled_mints_yet', coveredThrough: intake.coveredThrough }
  const index = indexIntake(intake)
  if (index.entries.length === 0)
    return { status: 'no_enrolled_mints_yet', coveredThrough: intake.coveredThrough }
  fail(freeBytes() >= MIN_FREE_BYTES, 'apyusd_prospective_payout_disk_reserve')
  const eligible = index.entries
    .map(({ mint }) => replayIndexed(intake, mint.tokenId, index))
    .filter((candidate) => candidate.burn && !candidate.lostOriginalControl)
  fail(tokenId === null || TOKEN.test(tokenId), 'apyusd_prospective_token_id_invalid')
  let candidate = tokenId === null ? null : eligible.find((item) => item.tokenId === tokenId)
  if (tokenId === null) {
    const unproved = []
    for (const item of eligible) {
      const prior = await readSaved(pathFor(out, item.tokenId))
      if (prior) validateProspectivePayout(prior, item, intake)
      else unproved.push(item)
    }
    if (unproved.length > 0) {
      unproved.sort(
        (a, b) => b.burn.blockNumber - a.burn.blockNumber || b.burn.logIndex - a.burn.logIndex,
      )
      const nowMs = rpcClock()
      const epoch = Math.floor(nowMs / CANDIDATE_ROTATION_MS)
      fail(Number.isSafeInteger(epoch) && epoch >= 0, 'apyusd_prospective_payout_time_invalid')
      const recent = unproved.slice(0, RECENT_CANDIDATES)
      const older = unproved.slice(RECENT_CANDIDATES)
      if (epoch % 4 === 3 && older.length > 0)
        candidate = older[Math.floor(epoch / 4) % older.length]
      else {
        const newestObservedAt = Date.parse(recent[0].burnWindow.observedAtUtc)
        const freshNewest =
          Number.isSafeInteger(newestObservedAt) &&
          nowMs + 120_000 >= newestObservedAt &&
          nowMs - newestObservedAt < CANDIDATE_ROTATION_MS
        const recentOrdinal = older.length === 0 ? epoch : epoch - Math.floor(epoch / 4)
        candidate = freshNewest ? recent[0] : recent[recentOrdinal % recent.length]
      }
    }
  }
  if (!candidate) {
    if (tokenId !== null) throw Error('apyusd_prospective_payout_no_eligible_burn')
    return { status: 'no_unproved_eligible_burn', coveredThrough: intake.coveredThrough }
  }
  const path = pathFor(out, candidate.tokenId)
  const prior = await readSaved(path)
  if (prior) {
    validateProspectivePayout(prior, candidate, intake)
    const live = await liveProof(candidate, intake, { clientsForUrls, urls, reader, rpcClock })
    fail(canonical(live) === canonical(prior.proof), 'apyusd_prospective_payout_live_disagree')
    return prior
  }
  const proof = await liveProof(candidate, intake, { clientsForUrls, urls, reader, rpcClock })
  const row = buildProspectivePayout(
    proof,
    candidate,
    intake,
    capturedAtUtc ?? new Date(rpcClock()).toISOString(),
  )
  fail(
    Buffer.byteLength(`${canonical(row)}\n`) <= MAX_PROOF_BYTES &&
      freeBytes() >= MIN_FREE_BYTES + Buffer.byteLength(`${canonical(row)}\n`),
    'apyusd_prospective_payout_disk_reserve',
  )
  await writer(path, row)
  return row
}

export async function verifyProspectivePayout(
  tokenId,
  {
    out = OUT,
    intakeLoader = verifyProspectiveIntake,
    clientsForUrls = publicRpcClients,
    urls = null,
    reader = readOne,
    rpcClock = Date.now,
  } = {},
) {
  const intake = await intakeLoader()
  const candidate = replayProspectiveReceipt(intake, tokenId)
  const row = await readSaved(pathFor(out, tokenId))
  fail(row, 'apyusd_prospective_payout_missing')
  validateProspectivePayout(row, candidate, intake)
  const live = await liveProof(candidate, intake, { clientsForUrls, urls, reader, rpcClock })
  fail(canonical(live) === canonical(row.proof), 'apyusd_prospective_payout_live_disagree')
  return row
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const mode = process.argv[2]
    const tokenId = process.argv[3] ?? null
    fail(
      (mode === '--capture' || mode === '--verify') &&
        (mode === '--capture' || tokenId !== null) &&
        (tokenId === null || TOKEN.test(tokenId)) &&
        process.argv.length <= 4,
      'apyusd_prospective_payout_usage',
    )
    const result =
      mode === '--capture'
        ? await captureProspectivePayout({ tokenId })
        : await verifyProspectivePayout(tokenId)
    process.stdout.write(
      `${JSON.stringify(
        result.status
          ? result
          : {
              tokenId: result.tokenId,
              paidAssetRaw: result.proof.payout.paidAssetRaw,
              requestToPayoutSeconds: result.proof.requestToPayoutSeconds,
              sha256: result.sha256,
            },
      )}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${
        /^apyusd_[a-z0-9_]+$/.test(error?.message)
          ? error.message
          : 'apyusd_prospective_payout_failed'
      }\n`,
    )
    process.exitCode = 1
  }
}
