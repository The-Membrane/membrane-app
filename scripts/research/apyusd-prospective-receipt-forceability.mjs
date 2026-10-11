// First-eligible, original-holder claim simulation for prospectively enrolled receipts.
// A positive eth_call is forceability evidence at that block, never a mined payment.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  attestIdentity,
  canonical,
  pin,
  RECEIPT,
  sha,
  VAULT,
} from './carry-public-apyusd-exit-common.mjs'
import { escrowFromReceipt } from './apyusd-receipt-cohort-escrow.mjs'
import { normalizeMint } from './apyusd-receipt-cohort-source.mjs'
import { readProspectiveStatus } from './apyusd-prospective-receipt-outcomes.mjs'
import { verifyProspectiveIntake } from './apyusd-prospective-receipt-intake.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-prospective-receipt-forceability-v1')
const ISSUE_STUDY = 'apyusd_prospective_receipt_issue_terms_v1'
const BOUNDARY_STUDY = 'apyusd_prospective_receipt_first_eligible_v1'
const ABI = parseAbi([
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function unlockingFee() view returns (uint256)',
  'function isClaimable(uint256) view returns (bool)',
  'function claim(uint256,address) returns (uint256)',
])
const ZERO = `0x${'0'.repeat(64)}`
const TOKEN = /^(0|[1-9][0-9]*)$/
const HASH = /^[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const MAX_RPC_CALLS = 128
const MAX_WALL_MS = 110_000
const MAX_HEAP_BYTES = 512 * 1024 * 1024
const MAX_PROOF_BYTES = 32 * 1024
const MIN_FREE_BYTES = 1_073_741_824 + 262_144
const MAX_CANDIDATES = 3
const CURSOR_FILE = 'selection-cursor.json'
const DELEGATION_CODE = /^0xef0100[0-9a-f]{40}$/
const fail = (ok, code) => {
  if (!ok) throw Error(code)
}
const digest = (value) => sha(canonical(value))
const seal = (body) => ({ ...body, sha256: digest(body) })
const hex = (number) => `0x${number.toString(16)}`
const pathFor = (out, tokenId, kind) => join(out, `${tokenId}.${kind}.json`)
const rowBody = ({ sha256: _seal, ...body }) => body
const holderCodeShape = (code) => {
  fail(
    typeof code === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(code),
    'apyusd_forceability_archive_unavailable',
  )
  const normalized = code.toLowerCase()
  return {
    kind:
      normalized === '0x' ? 'eoa' : DELEGATION_CODE.test(normalized) ? 'delegated_eoa' : 'contract',
    hash: keccak256(normalized),
  }
}

function checkHeap() {
  fail(process.memoryUsage().heapUsed < MAX_HEAP_BYTES, 'apyusd_forceability_heap_budget')
}

function checkedHeader(raw, expectedNumber = null) {
  const number = Number(BigInt(raw?.number ?? '0x0'))
  const timestamp = Number(BigInt(raw?.timestamp ?? '0x0'))
  const value = {
    number,
    hash: raw?.hash?.toLowerCase(),
    parentHash: raw?.parentHash?.toLowerCase(),
    timestamp,
  }
  fail(
    Number.isSafeInteger(number) &&
      number > 0 &&
      (expectedNumber === null || expectedNumber === number) &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0 &&
      WORD.test(value.hash ?? '') &&
      WORD.test(value.parentHash ?? ''),
    'apyusd_forceability_header_invalid',
  )
  return value
}

export function intakeMint(intake, tokenId) {
  fail(intake?.anchor && Array.isArray(intake.windows), 'apyusd_forceability_intake_missing')
  fail(TOKEN.test(tokenId), 'apyusd_forceability_token_invalid')
  for (const window of intake.windows) {
    const mint = window.mints.find((item) => item.tokenId === tokenId)
    if (!mint) continue
    const event = normalizeMint(mint.rawLog, window.fromBlock, window.toBlock)
    fail(
      mint.issueBlockNumber === event.blockNumber &&
        mint.issueBlockHash === event.blockHash &&
        mint.transactionHash === event.transactionHash &&
        mint.logIndex === event.logIndex &&
        mint.initialHolder === `0x${event.topics[2].slice(-40)}` &&
        mint.tokenId === BigInt(event.topics[3]).toString() &&
        window.transfers.some((item) => canonical(item) === canonical(event)) &&
        window.eventBlockHeaders.some(
          (item) =>
            item.number === mint.issueBlockNumber &&
            item.hash === mint.issueBlockHash &&
            item.timestamp === mint.issueBlockTimestamp,
        ),
      'apyusd_forceability_mint_invalid',
    )
    return { mint, event, window }
  }
  throw Error('apyusd_forceability_token_not_enrolled')
}

function base(intake, entry) {
  return {
    tokenId: entry.mint.tokenId,
    holder: entry.mint.initialHolder,
    receipt: RECEIPT,
    intakeAnchorSha256: intake.anchor.sha256,
    mintWindowSha256: entry.window.sha256,
    mintSha256: digest(entry.mint),
  }
}

function checkedIssue(row, intake, entry) {
  const mint = entry.mint
  const proof = row?.proof
  fail(
    row?.study === ISSUE_STUDY &&
      row.sha256 === digest(rowBody(row)) &&
      HASH.test(row.sha256 ?? '') &&
      Object.entries(base(intake, entry)).every(([key, value]) => row[key] === value) &&
      canonical(row.origins) === canonical(intake.anchor.origins) &&
      row.issueHeader?.number === mint.issueBlockNumber &&
      row.issueHeader.hash === mint.issueBlockHash &&
      row.issueHeader.timestamp === mint.issueBlockTimestamp &&
      proof?.tokenId === mint.tokenId &&
      proof.holder === mint.initialHolder &&
      proof.mintBlock === mint.issueBlockNumber &&
      proof.mintTransactionHash === mint.transactionHash &&
      proof.mintLogIndex === mint.logIndex &&
      proof.issuedAt === mint.issueBlockTimestamp &&
      Number.isSafeInteger(proof.claimableAt) &&
      proof.claimableAt > proof.issuedAt &&
      Array.isArray(row.receiptTerms) &&
      row.receiptTerms.length === 4 &&
      row.receiptTerms.every((value) => TOKEN.test(value)) &&
      row.receiptTerms[0] === proof.receiptEscrowRaw &&
      row.receiptTerms[2] === String(proof.issuedAt) &&
      row.receiptTerms[3] === String(proof.claimableAt) &&
      TOKEN.test(proof.grossWithdrawRaw ?? '') &&
      TOKEN.test(proof.vaultFeeRaw ?? '') &&
      TOKEN.test(proof.receiptEscrowRaw ?? '') &&
      BigInt(proof.grossWithdrawRaw) ===
        BigInt(proof.vaultFeeRaw) + BigInt(proof.receiptEscrowRaw) &&
      BigInt(proof.receiptEscrowRaw) > 0n &&
      ADDRESS.test(row.identity?.vaultImpl ?? '') &&
      ADDRESS.test(row.identity?.receiptImpl ?? '') &&
      Array.isArray(row.identity?.codeHashes) &&
      row.identity.codeHashes.length === 4 &&
      row.identity.codeHashes.every((hash) => WORD.test(hash)) &&
      Number.isFinite(Date.parse(row.capturedAtUtc)),
    'apyusd_forceability_issue_invalid',
  )
  return row
}

// The prefix is sealed by intake; later transfers must never affect this decision.
export function replayAtBoundary(intake, entry, blockNumber) {
  fail(
    Number.isSafeInteger(blockNumber) &&
      blockNumber >= entry.mint.issueBlockNumber &&
      blockNumber <= intake.coveredThrough,
    'apyusd_forceability_coverage_pending',
  )
  let owner = entry.mint.initialHolder
  let lostOriginalControl = false
  let burn = null
  let started = false
  const events = []
  const windowHashes = []
  for (const window of intake.windows) {
    if (window.toBlock < entry.mint.issueBlockNumber) continue
    if (window.fromBlock > blockNumber) break
    windowHashes.push(window.sha256)
    for (const event of window.transfers) {
      if (
        event.blockNumber > blockNumber ||
        BigInt(event.topics[3]).toString() !== entry.mint.tokenId
      )
        continue
      if (!started) {
        fail(canonical(event) === canonical(entry.event), 'apyusd_forceability_mint_replay_invalid')
        started = true
      } else {
        fail(
          !burn && event.topics[1] !== ZERO && `0x${event.topics[1].slice(-40)}` === owner,
          'apyusd_forceability_ownership_replay_invalid',
        )
        const to = `0x${event.topics[2].slice(-40)}`
        if (event.topics[2] === ZERO) burn = event
        else {
          if (to !== entry.mint.initialHolder) lostOriginalControl = true
          owner = to
        }
      }
      events.push(event)
    }
  }
  fail(started, 'apyusd_forceability_mint_replay_invalid')
  return {
    owner,
    lostOriginalControl,
    burn,
    transferReplaySha256: digest(events),
    transferWindowSha256s: windowHashes,
  }
}

function checkedBoundary(row, intake, entry, issue) {
  const { before, firstEligible, replay, claim } = row ?? {}
  const expectedReplay =
    firstEligible?.number <= intake.coveredThrough && Number.isSafeInteger(firstEligible.number)
      ? replayAtBoundary(intake, entry, firstEligible.number)
      : null
  const terminal = row?.status === 'holder-transferred' || row?.status === 'paid-before-assay'
  const terminalValid =
    row?.status === 'holder-transferred'
      ? expectedReplay?.lostOriginalControl &&
        claim === null &&
        row.payout === null &&
        row.holderOrigin === null
      : row?.status === 'paid-before-assay'
        ? Boolean(
            expectedReplay?.burn &&
            !expectedReplay.lostOriginalControl &&
            row.payout?.status === 'burned_with_saved_payout_proof' &&
            HASH.test(row.payout?.payoutProofSha256 ?? '') &&
            row.payout?.burnBlock === expectedReplay.burn.blockNumber &&
            row.payout?.burnEventSha256 === digest(expectedReplay.burn) &&
            claim === null &&
            row.holderOrigin === null,
          )
        : false
  const originKind = row?.holderOrigin?.kind
  const mayOriginate = originKind === 'eoa' || originKind === 'delegated_eoa'
  const positiveClaim =
    claim?.isClaimable &&
    claim.simulation?.status === 'success' &&
    BigInt(claim.simulation.amountRaw) > 0n
  const claimValid =
    !terminal &&
    !expectedReplay?.lostOriginalControl &&
    !expectedReplay?.burn &&
    replay?.owner === entry.mint.initialHolder &&
    row.payout === null &&
    ['eoa', 'delegated_eoa', 'contract'].includes(originKind) &&
    WORD.test(row.holderOrigin?.hash ?? '') &&
    typeof claim?.isClaimable === 'boolean' &&
    ['success', 'evm_revert'].includes(claim.simulation?.status) &&
    (claim.simulation.status === 'evm_revert' || TOKEN.test(claim.simulation.amountRaw ?? '')) &&
    (mayOriginate
      ? row.status === (positiveClaim ? 'claim-positive' : 'claim-reverted-or-zero')
      : row.status === 'holder-origin-unproven')
  fail(
    row?.study === BOUNDARY_STUDY &&
      row.sha256 === digest(rowBody(row)) &&
      HASH.test(row.sha256 ?? '') &&
      row.issueSha256 === issue.sha256 &&
      Object.entries(base(intake, entry)).every(([key, value]) => row[key] === value) &&
      canonical(row.origins) === canonical(intake.anchor.origins) &&
      before?.number + 1 === firstEligible?.number &&
      firstEligible.parentHash === before.hash &&
      before.timestamp < issue.proof.claimableAt &&
      issue.proof.claimableAt <= firstEligible.timestamp &&
      firstEligible.number <= intake.coveredThrough &&
      row.boundaryWindowSha256 ===
        intake.windows.find(
          (window) =>
            window.fromBlock <= firstEligible.number && firstEligible.number <= window.toBlock,
        )?.sha256 &&
      replay?.transferReplaySha256 === expectedReplay?.transferReplaySha256 &&
      canonical(replay.transferWindowSha256s) ===
        canonical(expectedReplay?.transferWindowSha256s) &&
      replay.owner === expectedReplay?.owner &&
      replay.lostOriginalControl === expectedReplay?.lostOriginalControl &&
      canonical(replay.burn) === canonical(expectedReplay?.burn) &&
      (terminal ? terminalValid : claimValid) &&
      ['on-time-boundary', 'late-boundary'].includes(row.timingStatus),
    'apyusd_forceability_boundary_invalid',
  )
  return row
}

async function verifyPaidBinding(boundary, intake, payoutReader) {
  if (boundary.status !== 'paid-before-assay') return
  const current = await payoutReader(boundary.tokenId, intake)
  fail(
    current?.status === 'burned_with_saved_payout_proof' &&
      current.payoutProofSha256 === boundary.payout.payoutProofSha256 &&
      current.burnBlock === boundary.payout.burnBlock &&
      boundary.payout.burnEventSha256 === digest(boundary.replay.burn),
    'apyusd_forceability_payout_binding_changed',
  )
}

async function readSaved(path) {
  let fd
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await fd.stat()
    fail(stat.isFile() && stat.size <= MAX_PROOF_BYTES, 'apyusd_forceability_proof_size_invalid')
    const bytes = (await fd.readFile()).toString('utf8')
    const row = JSON.parse(bytes)
    fail(bytes === `${canonical(row)}\n`, 'apyusd_forceability_proof_encoding_invalid')
    return row
  } finally {
    await fd.close()
  }
}

async function writeExclusive(path, row, freeBytes) {
  const bytes = `${canonical(row)}\n`
  fail(Buffer.byteLength(bytes) <= MAX_PROOF_BYTES, 'apyusd_forceability_proof_size_invalid')
  fail(freeBytes() >= MIN_FREE_BYTES + Buffer.byteLength(bytes), 'apyusd_forceability_disk_reserve')
  await mkdir(dirname(path), { recursive: true })
  // Staging stays outside the enumerated proof directory if a process crashes.
  const temp = join(dirname(dirname(path)), `.${basename(dirname(path))}-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(bytes)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await link(temp, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
}

async function readCursor(out, anchorSha256) {
  const row = await readSaved(join(out, CURSOR_FILE))
  if (!row || row.anchorSha256 !== anchorSha256) return 0
  fail(
    row.version === 1 && Number.isSafeInteger(row.nextIndex) && row.nextIndex >= 0,
    'apyusd_forceability_cursor_invalid',
  )
  return row.nextIndex
}

async function writeCursor(out, anchorSha256, nextIndex, freeBytes) {
  const bytes = `${canonical({ version: 1, anchorSha256, nextIndex })}\n`
  fail(freeBytes() >= MIN_FREE_BYTES + Buffer.byteLength(bytes), 'apyusd_forceability_disk_reserve')
  await mkdir(out, { recursive: true })
  const temp = join(dirname(out), `.${basename(out)}-cursor-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(bytes)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await rename(temp, join(out, CURSOR_FILE))
    const directory = await open(out, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
}

function bounded(origins, rpcClock, budget) {
  const check = () => {
    checkHeap()
    fail(
      rpcClock() < budget.deadline && budget.calls < MAX_RPC_CALLS,
      'apyusd_forceability_rpc_budget',
    )
  }
  return {
    clients: origins.map((origin) => ({
      ...origin,
      async request(...args) {
        check()
        budget.calls++
        return origin.request(...args)
      },
      async send(...args) {
        check()
        budget.calls++
        return origin.send(...args)
      },
    })),
    check,
  }
}

function selectOrigins(intake, urls, clientsForUrls) {
  const clients = clientsForUrls(urls ?? configuredPublicRpcUrls(readEnv()))
  const chosen = intake.anchor.origins.map((host) =>
    clients.find((client) => new URL(client.url).hostname.toLowerCase() === host),
  )
  fail(
    chosen.length === 2 && chosen.every(Boolean) && chosen[0].provider !== chosen[1].provider,
    'apyusd_forceability_origins_invalid',
  )
  return chosen
}

async function pairedHeader(origins, number) {
  const pair = await Promise.all(
    origins.map(async (origin) =>
      checkedHeader(await origin.request('eth_getBlockByNumber', [hex(number), false]), number),
    ),
  )
  fail(canonical(pair[0]) === canonical(pair[1]), 'apyusd_forceability_headers_disagree')
  return pair[0]
}

async function readContract(origin, to, functionName, args, blockHash) {
  const data = encodeFunctionData({ abi: ABI, functionName, args })
  const raw = await origin.request('eth_call', [{ to, data }, pin(blockHash)])
  return decodeFunctionResult({ abi: ABI, functionName, data: raw })
}

async function issueOne(origin, entry, issueHeader, attestor) {
  const mint = entry.mint
  const [identity, receipt, feeWad, position] = await Promise.all([
    attestor(origin, mint.issueBlockHash),
    origin.request('eth_getTransactionReceipt', [mint.transactionHash]),
    readContract(origin, VAULT, 'unlockingFee', [], mint.issueBlockHash),
    readContract(origin, RECEIPT, 'getReceipt', [BigInt(mint.tokenId)], mint.issueBlockHash),
  ])
  return {
    identity,
    receiptTerms: position.map((value) => value.toString()),
    proof: escrowFromReceipt(receipt, entry.event, feeWad, position, issueHeader.timestamp),
  }
}

async function issueProof(intake, entry, origins, attestor, capturedAtUtc) {
  const header = await pairedHeader(origins, entry.mint.issueBlockNumber)
  fail(
    header.hash === entry.mint.issueBlockHash &&
      header.timestamp === entry.mint.issueBlockTimestamp,
    'apyusd_forceability_issue_header_changed',
  )
  const values = await Promise.all(
    origins.map((origin) => issueOne(origin, entry, header, attestor)),
  )
  fail(canonical(values[0]) === canonical(values[1]), 'apyusd_forceability_issue_origins_disagree')
  return checkedIssue(
    seal({
      study: ISSUE_STUDY,
      ...base(intake, entry),
      origins: intake.anchor.origins,
      issueHeader: header,
      identity: values[0].identity,
      receiptTerms: values[0].receiptTerms,
      proof: values[0].proof,
      capturedAtUtc,
    }),
    intake,
    entry,
  )
}

async function observedFinalizedHead(origins) {
  const reported = await Promise.all(
    origins.map(async (origin) =>
      checkedHeader(await origin.request('eth_getBlockByNumber', ['finalized', false])),
    ),
  )
  const number = Math.min(...reported.map((item) => item.number))
  const agreed = await pairedHeader(origins, number)
  fail(
    reported.every(
      (item) =>
        item.number >= number && (item.number !== number || canonical(item) === canonical(agreed)),
    ),
    'apyusd_forceability_finality_disagree',
  )
  return agreed
}

async function locateBoundary(origins, issue, coverage) {
  let low = issue.issueHeader
  let high = await pairedHeader(origins, coverage.number)
  fail(canonical(high) === canonical(coverage), 'apyusd_forceability_coverage_header_changed')
  fail(
    low.timestamp < issue.proof.claimableAt && high.timestamp >= issue.proof.claimableAt,
    'apyusd_forceability_boundary_bracket_invalid',
  )
  while (high.number - low.number > 1) {
    const mid = await pairedHeader(origins, Math.floor((low.number + high.number) / 2))
    if (mid.timestamp >= issue.proof.claimableAt) high = mid
    else low = mid
  }
  // Re-read the lower edge on both origins; the issue header alone cannot prove
  // a distant predecessor is still canonical when this boundary is captured.
  const before = await pairedHeader(origins, low.number)
  fail(
    canonical(before) === canonical(low) && high.parentHash === before.hash,
    'apyusd_forceability_boundary_headers_changed',
  )
  return { before, firstEligible: high }
}

async function claimOne(origin, tokenId, holder, blockHash) {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'claim',
    args: [BigInt(tokenId), holder],
  })
  const response = await origin.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: RECEIPT, data, from: holder }, pin(blockHash)],
  })
  if (Object.hasOwn(response, 'error')) {
    fail(
      response.error?.message === 'execution reverted',
      'apyusd_forceability_archive_unavailable',
    )
    return { status: 'evm_revert', amountRaw: null }
  }
  const amount = decodeFunctionResult({ abi: ABI, functionName: 'claim', data: response.result })
  return { status: 'success', amountRaw: amount.toString() }
}

async function boundaryOne(origin, entry, boundary, attestor) {
  const hash = boundary.firstEligible.hash
  const [identity, terms, isClaimable, simulation, holderCode] = await Promise.all([
    attestor(origin, hash),
    readContract(origin, RECEIPT, 'getReceipt', [BigInt(entry.mint.tokenId)], hash),
    readContract(origin, RECEIPT, 'isClaimable', [BigInt(entry.mint.tokenId)], hash),
    claimOne(origin, entry.mint.tokenId, entry.mint.initialHolder, hash),
    origin.request('eth_getCode', [entry.mint.initialHolder, pin(hash)]),
  ])
  return {
    identity,
    terms: terms.map((value) => value.toString()),
    claim: { isClaimable, simulation },
    holderOrigin: holderCodeShape(holderCode),
  }
}

/** Two-origin exact-holder state at an intake-covered finalized block. */
export async function readProspectiveClaimAt({
  intake,
  tokenId,
  blockNumber,
  urls = null,
  clientsForUrls = publicRpcClients,
  attestor = attestIdentity,
  rpcClock = Date.now,
}) {
  fail(
    Number.isSafeInteger(blockNumber) && blockNumber <= intake.coveredThrough,
    'apyusd_forceability_coverage_pending',
  )
  const entry = intakeMint(intake, tokenId)
  const budget = { calls: 0, deadline: rpcClock() + MAX_WALL_MS }
  const origins = bounded(selectOrigins(intake, urls, clientsForUrls), rpcClock, budget).clients
  const block = await pairedHeader(origins, blockNumber)
  const expected = intake.windows.find(
    (window) => window.fromBlock <= blockNumber && blockNumber <= window.toBlock,
  )
  fail(
    expected &&
      (blockNumber === expected.toBlock
        ? canonical(block) === canonical(expected.toHeader)
        : expected.eventBlockHeaders.some((header) => canonical(header) === canonical(block))),
    'apyusd_forceability_followup_header_not_in_intake',
  )
  const states = await Promise.all(
    origins.map((origin) => boundaryOne(origin, entry, { firstEligible: block }, attestor)),
  )
  fail(
    canonical(states[0]) === canonical(states[1]),
    'apyusd_forceability_followup_origins_disagree',
  )
  return { block, ...states[0] }
}

function statusForError(error) {
  if (
    /^(public_rpc_|apyusd_forceability_(archive_unavailable|rpc_budget|header_invalid|coverage_header_changed|boundary_headers_changed))/.test(
      error?.message ?? '',
    ) ||
    ['AbortError', 'TimeoutError'].includes(error?.name)
  )
    return 'archive-unavailable'
  if (/^apyusd_(implementation_identity_invalid|asset_identity_invalid)/.test(error?.message ?? ''))
    return 'identity-or-terms-changed'
  if (
    /^apyusd_forceability_.*(origins_disagree|headers_disagree|finality_disagree)$/.test(
      error?.message ?? '',
    )
  )
    return 'source-disagreement'
  throw error
}

async function captureOne({
  intake,
  entry,
  out,
  urls,
  clientsForUrls,
  attestor,
  payoutReader,
  rpcClock,
  now,
  freeBytes,
  writer,
  budget,
}) {
  const tokenId = entry.mint.tokenId
  let issue = await readSaved(pathFor(out, tokenId, 'issue'))
  if (issue) checkedIssue(issue, intake, entry)
  let boundary = await readSaved(pathFor(out, tokenId, 'boundary'))
  if (boundary) {
    fail(issue, 'apyusd_forceability_issue_missing')
    checkedBoundary(boundary, intake, entry, issue)
    await verifyPaidBinding(boundary, intake, payoutReader)
    return {
      status: boundary.status,
      timingStatus: boundary.timingStatus,
      tokenId,
      evidence: 'saved_two_origin_capture_not_live_reverified',
    }
  }
  fail(freeBytes() >= MIN_FREE_BYTES, 'apyusd_forceability_disk_reserve')
  const origins = bounded(selectOrigins(intake, urls, clientsForUrls), rpcClock, budget).clients
  try {
    if (!issue) {
      issue = await issueProof(intake, entry, origins, attestor, new Date(now()).toISOString())
      await writer(pathFor(out, tokenId, 'issue'), issue, freeBytes)
    }
    const coverage = intake.windows.at(-1).toHeader
    if (coverage.timestamp < issue.proof.claimableAt) {
      const head = await observedFinalizedHead(origins)
      return {
        status: head.timestamp < issue.proof.claimableAt ? 'not-due' : 'coverage-pending',
        tokenId,
        claimableAt: issue.proof.claimableAt,
        coveredThrough: intake.coveredThrough,
      }
    }
    const found = await locateBoundary(origins, issue, coverage)
    const replay = replayAtBoundary(intake, entry, found.firstEligible.number)
    const timingStatus =
      now() / 1_000 > found.firstEligible.timestamp ? 'late-boundary' : 'on-time-boundary'
    const commonBoundary = {
      study: BOUNDARY_STUDY,
      ...base(intake, entry),
      issueSha256: issue.sha256,
      origins: intake.anchor.origins,
      before: found.before,
      firstEligible: found.firstEligible,
      boundaryWindowSha256: intake.windows.find(
        (window) =>
          window.fromBlock <= found.firstEligible.number &&
          found.firstEligible.number <= window.toBlock,
      ).sha256,
      replay: {
        owner: replay.owner,
        lostOriginalControl: replay.lostOriginalControl,
        burn: replay.burn,
        transferReplaySha256: replay.transferReplaySha256,
        transferWindowSha256s: replay.transferWindowSha256s,
      },
      timingStatus,
      capturedAtUtc: new Date(now()).toISOString(),
    }
    if (replay.lostOriginalControl) {
      boundary = checkedBoundary(
        seal({
          ...commonBoundary,
          claim: null,
          holderOrigin: null,
          payout: null,
          status: 'holder-transferred',
        }),
        intake,
        entry,
        issue,
      )
      await writer(pathFor(out, tokenId, 'boundary'), boundary, freeBytes)
      return {
        status: boundary.status,
        timingStatus,
        tokenId,
        firstEligibleBlock: found.firstEligible.number,
      }
    }
    if (replay.burn) {
      const payout = await payoutReader(tokenId, intake)
      if (payout?.status !== 'burned_with_saved_payout_proof')
        return {
          status: 'burn-unproved',
          timingStatus,
          tokenId,
          firstEligibleBlock: found.firstEligible.number,
        }
      fail(
        HASH.test(payout.payoutProofSha256 ?? '') && payout.burnBlock === replay.burn.blockNumber,
        'apyusd_forceability_payout_binding_invalid',
      )
      boundary = checkedBoundary(
        seal({
          ...commonBoundary,
          claim: null,
          holderOrigin: null,
          payout: {
            status: payout.status,
            payoutProofSha256: payout.payoutProofSha256,
            burnBlock: payout.burnBlock,
            burnEventSha256: digest(replay.burn),
          },
          status: 'paid-before-assay',
        }),
        intake,
        entry,
        issue,
      )
      await writer(pathFor(out, tokenId, 'boundary'), boundary, freeBytes)
      return {
        status: boundary.status,
        timingStatus,
        tokenId,
        firstEligibleBlock: found.firstEligible.number,
      }
    }
    const states = await Promise.all(
      origins.map((origin) => boundaryOne(origin, entry, found, attestor)),
    )
    fail(
      canonical(states[0]) === canonical(states[1]),
      'apyusd_forceability_boundary_origins_disagree',
    )
    if (
      canonical(states[0].identity) !== canonical(issue.identity) ||
      canonical(states[0].terms) !== canonical(issue.receiptTerms)
    )
      return {
        status: 'identity-or-terms-changed',
        timingStatus,
        tokenId,
        firstEligibleBlock: found.firstEligible.number,
      }
    const claim = states[0].claim
    const holderOrigin = states[0].holderOrigin
    const status =
      holderOrigin.kind === 'contract'
        ? 'holder-origin-unproven'
        : claim.isClaimable &&
            claim.simulation.status === 'success' &&
            BigInt(claim.simulation.amountRaw) > 0n
          ? 'claim-positive'
          : 'claim-reverted-or-zero'
    boundary = checkedBoundary(
      seal({
        ...commonBoundary,
        claim,
        holderOrigin,
        payout: null,
        status,
      }),
      intake,
      entry,
      issue,
    )
    await writer(pathFor(out, tokenId, 'boundary'), boundary, freeBytes)
    return {
      status,
      timingStatus,
      tokenId,
      firstEligibleBlock: found.firstEligible.number,
      simulatedAmountRaw: claim.simulation.amountRaw,
      evidence: 'sealed_two_origin_eth_call_not_mined_payment',
    }
  } catch (error) {
    if (
      [
        'apyusd_forceability_disk_reserve',
        'apyusd_forceability_heap_budget',
        'apyusd_forceability_rpc_budget',
      ].includes(error.message)
    )
      throw error
    return { status: statusForError(error), tokenId, reason: error.message }
  }
}

export async function verifyProspectiveForceability(
  tokenId,
  {
    out = OUT,
    intakeLoader = verifyProspectiveIntake,
    payoutReader = (id, intake) => readProspectiveStatus(id, { intakeLoader: async () => intake }),
  } = {},
) {
  checkHeap()
  const intake = await intakeLoader()
  const entry = intakeMint(intake, tokenId)
  const issue = await readSaved(pathFor(out, tokenId, 'issue'))
  if (!issue) return { status: 'issue-proof-pending', tokenId }
  checkedIssue(issue, intake, entry)
  const boundary = await readSaved(pathFor(out, tokenId, 'boundary'))
  if (!boundary) return { status: 'boundary-proof-pending', tokenId, issue }
  checkedBoundary(boundary, intake, entry, issue)
  await verifyPaidBinding(boundary, intake, payoutReader)
  return {
    status: boundary.status,
    timingStatus: boundary.timingStatus,
    tokenId,
    issue,
    boundary,
    evidence: 'saved_two_origin_capture_not_live_reverified',
  }
}

export async function captureProspectiveForceability({
  tokenId = null,
  out = OUT,
  intakeLoader = verifyProspectiveIntake,
  urls = null,
  clientsForUrls = publicRpcClients,
  attestor = attestIdentity,
  payoutReader = (id, intake) => readProspectiveStatus(id, { intakeLoader: async () => intake }),
  rpcClock = Date.now,
  now = Date.now,
  writer = writeExclusive,
  freeBytes = () => {
    const disk = statfsSync(dirname(out))
    return Number(disk.bavail) * Number(disk.bsize)
  },
} = {}) {
  const budget = { calls: 0, deadline: rpcClock() + MAX_WALL_MS }
  checkHeap()
  const intake = await intakeLoader()
  fail(rpcClock() < budget.deadline, 'apyusd_forceability_rpc_budget')
  if (!intake.anchor || intake.windows.length === 0 || intake.mints === 0)
    return { status: 'no-enrolled-mints-yet', coveredThrough: intake.coveredThrough }
  fail(tokenId === null || TOKEN.test(tokenId), 'apyusd_forceability_token_invalid')
  const entries =
    tokenId === null
      ? intake.windows.flatMap((window) => window.mints.map((mint) => ({ mint, window })))
      : [intakeMint(intake, tokenId)]
  if (entries.length === 0)
    return { status: 'no-enrolled-mints-yet', coveredThrough: intake.coveredThrough }
  fail(freeBytes() >= MIN_FREE_BYTES, 'apyusd_forceability_disk_reserve')
  let done = []
  try {
    done = (await readdir(out)).filter((file) => /^\d+\.boundary\.json$/.test(file))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const completed = new Set(done.map((file) => file.slice(0, -'.boundary.json'.length)))
  const cursor =
    tokenId === null ? (await readCursor(out, intake.anchor.sha256)) % entries.length : 0
  const candidates = []
  for (let offset = 0; offset < entries.length && candidates.length < MAX_CANDIDATES; offset++) {
    const index = (cursor + offset) % entries.length
    if (tokenId !== null || !completed.has(entries[index].mint.tokenId))
      candidates.push({ entry: entries[index], index })
  }
  if (candidates.length === 0)
    return { status: 'no-unassayed-mints', coveredThrough: intake.coveredThrough }
  let last = null
  const transient = new Set([
    'not-due',
    'coverage-pending',
    'archive-unavailable',
    'identity-or-terms-changed',
    'source-disagreement',
    'burn-unproved',
  ])
  for (const { entry, index } of candidates) {
    checkHeap()
    const checked = intakeMint(intake, entry.mint.tokenId)
    const result = await captureOne({
      intake,
      entry: checked,
      out,
      urls,
      clientsForUrls,
      attestor,
      payoutReader,
      rpcClock,
      now,
      freeBytes,
      writer,
      budget,
    })
    if (tokenId === null)
      await writeCursor(out, intake.anchor.sha256, (index + 1) % entries.length, freeBytes)
    if (tokenId !== null || !transient.has(result.status)) return result
    last = result
  }
  return last
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, tokenId] = process.argv.slice(2)
    fail(
      ['--capture', '--verify'].includes(mode) &&
        (mode === '--capture' || tokenId !== undefined) &&
        process.argv.length <= 4,
      'usage: node --import tsx apyusd-prospective-receipt-forceability.mjs --capture [tokenId] | --verify tokenId',
    )
    const result =
      mode === '--capture'
        ? await captureProspectiveForceability({ tokenId: tokenId ?? null })
        : await verifyProspectiveForceability(tokenId)
    console.log(canonical(result))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
