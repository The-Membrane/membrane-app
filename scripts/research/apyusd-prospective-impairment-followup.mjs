// Continue a prospectively observed failed first-eligible holder claim.
// A recovery is interval-censored between exact-holder checks, never timed to a point.
import { randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { appendChain, canonical, readChain, sha } from './carry-public-apyusd-exit-common.mjs'
import {
  OUT as FORCEABILITY_OUT,
  intakeMint,
  readProspectiveClaimAt,
  replayAtBoundary,
  verifyProspectiveForceability,
} from './apyusd-prospective-receipt-forceability.mjs'
import { verifyProspectiveIntake } from './apyusd-prospective-receipt-intake.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-prospective-impairment-v1')
const STUDY = 'apyusd_prospective_holder_impairment_followup_v1'
const SCOPE = 'apyusd_receipt_claim_stage_only'
const TOKEN_FILE = /^(0|[1-9][0-9]*)\.boundary\.json$/
const HASH = /^[0-9a-f]{64}$/
const MAX_BLOCK_AGE_MS = 45 * 60_000
const MIN_FREE_BYTES = 1_073_741_824 + 262_144
const MAX_BOUNDARIES = 4_096
const MAX_ROWS_PER_RECEIPT = 4_096
const CURSOR_FILE = 'selection-cursor.json'
const TERMINAL = new Set([
  'recovered',
  'censored_transfer',
  'censored_burn',
  'censored_terms',
  'censored_origin',
])
const fail = (condition, code) => {
  if (!condition) throw Error(code)
}
const digest = (value) => sha(canonical(value))
const eventToken = (event) => BigInt(event.topics[3]).toString()
const eventTo = (event) => `0x${event.topics[2].slice(-40)}`

async function boundaryTokenIds(out) {
  try {
    const ids = (await readdir(out))
      .filter((name) => TOKEN_FILE.test(name))
      .map((name) => name.slice(0, -'.boundary.json'.length))
    fail(ids.length <= MAX_BOUNDARIES, 'apyusd_impairment_boundary_budget')
    return ids
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readBoundedChain(path) {
  let files
  try {
    files = await readdir(path)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  fail(
    files.filter((name) => name.endsWith('.json')).length <= MAX_ROWS_PER_RECEIPT,
    'apyusd_impairment_row_budget',
  )
  return readChain(path)
}

async function readCursor(out, anchorSha256) {
  let fd
  try {
    fd = await open(join(out, CURSOR_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  try {
    const stat = await fd.stat()
    fail(stat.isFile() && stat.size <= 256, 'apyusd_impairment_cursor_invalid')
    const row = JSON.parse((await fd.readFile()).toString('utf8'))
    if (row.anchorSha256 !== anchorSha256) return 0
    fail(
      row.version === 1 && Number.isSafeInteger(row.nextIndex) && row.nextIndex >= 0,
      'apyusd_impairment_cursor_invalid',
    )
    return row.nextIndex
  } finally {
    await fd.close()
  }
}

async function writeCursor(out, anchorSha256, nextIndex, freeBytes) {
  const bytes = `${canonical({ version: 1, anchorSha256, nextIndex })}\n`
  fail(freeBytes() >= MIN_FREE_BYTES + Buffer.byteLength(bytes), 'apyusd_impairment_disk_reserve')
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

function windowAt(intake, number) {
  return intake.windows.find((window) => window.fromBlock <= number && number <= window.toBlock)
}

function firstCensorEvent(intake, tokenId, holder, afterBlock, throughBlock) {
  for (const window of intake.windows) {
    if (window.toBlock <= afterBlock || window.fromBlock > throughBlock) continue
    for (const event of window.transfers) {
      if (
        event.blockNumber <= afterBlock ||
        event.blockNumber > throughBlock ||
        eventToken(event) !== tokenId
      )
        continue
      const to = eventTo(event)
      if (to === holder) continue
      const header = window.eventBlockHeaders.find(
        (item) => item.number === event.blockNumber && item.hash === event.blockHash,
      )
      fail(header, 'apyusd_impairment_event_header_missing')
      return { event, header, kind: to === `0x${'0'.repeat(40)}` ? 'burn' : 'transfer' }
    }
  }
  return null
}

function classifyObservation(observation, issue) {
  const identity = observation?.identity
  const terms = observation?.terms
  const origin = observation?.holderOrigin
  const claim = observation?.claim
  fail(
    /^0x[0-9a-f]{40}$/.test(identity?.vaultImpl ?? '') &&
      /^0x[0-9a-f]{40}$/.test(identity?.receiptImpl ?? '') &&
      Array.isArray(identity?.codeHashes) &&
      identity.codeHashes.length === 4 &&
      identity.codeHashes.every((hash) => /^0x[0-9a-f]{64}$/.test(hash)) &&
      Array.isArray(terms) &&
      terms.length === 4 &&
      terms.every((value) => /^(0|[1-9][0-9]*)$/.test(value)) &&
      ['eoa', 'delegated_eoa', 'contract'].includes(origin?.kind) &&
      /^0x[0-9a-f]{64}$/.test(origin?.hash ?? '') &&
      typeof claim?.isClaimable === 'boolean' &&
      ['success', 'evm_revert'].includes(claim.simulation?.status) &&
      (claim.simulation.status === 'evm_revert' ||
        /^(0|[1-9][0-9]*)$/.test(claim.simulation.amountRaw ?? '')),
    'apyusd_impairment_observation_invalid',
  )
  if (
    canonical(identity) !== canonical(issue.identity) ||
    canonical(terms) !== canonical(issue.receiptTerms)
  )
    return 'censored_terms'
  if (origin.kind === 'contract') return 'censored_origin'
  return claim.isClaimable &&
    claim.simulation.status === 'success' &&
    BigInt(claim.simulation.amountRaw) > 0n
    ? 'recovered'
    : 'impaired'
}

/** Verify interval/censor math against the immutable first-eligible proof and intake. */
export function validateImpairmentRows(rows, { intake, issue, boundary, entry }) {
  fail(
    Array.isArray(rows) &&
      rows.length <= MAX_ROWS_PER_RECEIPT &&
      boundary.status === 'claim-reverted-or-zero' &&
      issue?.sha256 === boundary.issueSha256,
    'apyusd_impairment_start_invalid',
  )
  const first = boundary.firstEligible
  let previous = null
  for (const row of rows) {
    const { sha256: _seal, ...body } = row
    const window = windowAt(intake, row.block?.number)
    const replay = replayAtBoundary(intake, entry, row.block?.number)
    const censor = firstCensorEvent(
      intake,
      entry.mint.tokenId,
      entry.mint.initialHolder,
      first.number,
      row.block.number,
    )
    const elapsed = row.block.timestamp - first.timestamp
    const negativeAt = previous?.block.timestamp ?? first.timestamp
    const derivedStatus = censor
      ? censor.kind === 'burn'
        ? 'censored_burn'
        : 'censored_transfer'
      : classifyObservation(row.observation, issue)
    fail(
      row.study === STUDY &&
        row.scope === SCOPE &&
        row.sequence === (previous?.sequence ?? 0) + 1 &&
        row.previousSha256 === (previous?.sha256 ?? null) &&
        row.tokenId === entry.mint.tokenId &&
        row.holder === entry.mint.initialHolder &&
        row.intakeAnchorSha256 === intake.anchor.sha256 &&
        row.boundarySha256 === boundary.sha256 &&
        row.issueSha256 === issue.sha256 &&
        canonical(row.origins) === canonical(intake.anchor.origins) &&
        row.block.number > (previous?.block.number ?? first.number) &&
        row.block.number <= intake.coveredThrough &&
        row.block.timestamp > (previous?.block.timestamp ?? first.timestamp) &&
        window &&
        row.block.number === window.toBlock &&
        canonical(row.block) === canonical(window.toHeader) &&
        row.intakeWindowSha256 === window.sha256 &&
        row.transferReplaySha256 === replay.transferReplaySha256 &&
        row.status === derivedStatus &&
        row.elapsedSinceFirstEligibleSeconds === elapsed &&
        !TERMINAL.has(previous?.status) &&
        Number.isSafeInteger(Date.parse(row.observedAtUtc)) &&
        new Date(Date.parse(row.observedAtUtc)).toISOString() === row.observedAtUtc &&
        Date.parse(row.observedAtUtc) + 120_000 >= row.block.timestamp * 1_000 &&
        Date.parse(row.observedAtUtc) - row.block.timestamp * 1_000 <= MAX_BLOCK_AGE_MS &&
        HASH.test(row.sha256 ?? '') &&
        row.sha256 === digest(body),
      'apyusd_impairment_row_invalid',
    )
    if (censor) {
      fail(
        censor.header.timestamp > negativeAt &&
          censor.header.timestamp <= row.block.timestamp &&
          row.observation === null &&
          row.censor?.eventSha256 === digest(censor.event) &&
          row.censor?.blockNumber === censor.header.number &&
          row.censor?.timestamp === censor.header.timestamp &&
          row.censor?.elapsedSeconds === censor.header.timestamp - first.timestamp &&
          row.recoveryInterval === null,
        'apyusd_impairment_censor_invalid',
      )
    } else {
      fail(
        !replay.lostOriginalControl &&
          !replay.burn &&
          row.censor === null &&
          (row.status === 'recovered'
            ? row.recoveryInterval?.lowerSeconds === negativeAt - first.timestamp &&
              row.recoveryInterval.upperSeconds === elapsed &&
              row.recoveryInterval.lowerSeconds < row.recoveryInterval.upperSeconds
            : row.recoveryInterval === null),
        'apyusd_impairment_observation_invalid',
      )
    }
    previous = row
  }
  return rows
}

function makeRow({
  intake,
  issue,
  boundary,
  entry,
  previous,
  block,
  replay,
  observation,
  censor,
  now,
}) {
  const first = boundary.firstEligible
  const status = censor
    ? censor.kind === 'burn'
      ? 'censored_burn'
      : 'censored_transfer'
    : classifyObservation(observation, issue)
  const elapsed = block.timestamp - first.timestamp
  const body = {
    study: STUDY,
    scope: SCOPE,
    sequence: (previous?.sequence ?? 0) + 1,
    previousSha256: previous?.sha256 ?? null,
    tokenId: entry.mint.tokenId,
    holder: entry.mint.initialHolder,
    intakeAnchorSha256: intake.anchor.sha256,
    boundarySha256: boundary.sha256,
    issueSha256: issue.sha256,
    origins: intake.anchor.origins,
    block,
    intakeWindowSha256: windowAt(intake, block.number).sha256,
    transferReplaySha256: replay.transferReplaySha256,
    status,
    elapsedSinceFirstEligibleSeconds: elapsed,
    recoveryInterval:
      status === 'recovered'
        ? {
            lowerSeconds: (previous?.block.timestamp ?? first.timestamp) - first.timestamp,
            upperSeconds: elapsed,
          }
        : null,
    censor: censor
      ? {
          eventSha256: digest(censor.event),
          blockNumber: censor.header.number,
          timestamp: censor.header.timestamp,
          elapsedSeconds: censor.header.timestamp - first.timestamp,
        }
      : null,
    observation,
    observedAtUtc: new Date(now()).toISOString(),
  }
  return { ...body, sha256: digest(body) }
}

export async function captureProspectiveImpairment({
  out = OUT,
  forceabilityOut = FORCEABILITY_OUT,
  intakeLoader = verifyProspectiveIntake,
  tokensLoader = boundaryTokenIds,
  forceabilityLoader = verifyProspectiveForceability,
  reader = readProspectiveClaimAt,
  writer = appendChain,
  cursorReader = readCursor,
  cursorWriter = writeCursor,
  now = Date.now,
  freeBytes = () => {
    const disk = statfsSync(dirname(out))
    return Number(disk.bavail) * Number(disk.bsize)
  },
} = {}) {
  const intake = await intakeLoader()
  if (!intake.anchor || !intake.windows.length)
    return { status: 'no-enrolled-mints-yet', coveredThrough: intake.coveredThrough }
  const ids = await tokensLoader(forceabilityOut)
  const candidates = []
  for (const tokenId of ids) {
    const proof = await forceabilityLoader(tokenId, {
      out: forceabilityOut,
      intakeLoader: async () => intake,
    })
    if (proof.status !== 'claim-reverted-or-zero') continue
    const entry = intakeMint(intake, tokenId)
    const rows = validateImpairmentRows(await readBoundedChain(join(out, tokenId)), {
      intake,
      issue: proof.issue,
      boundary: proof.boundary,
      entry,
    })
    const previous = rows.at(-1)
    if (TERMINAL.has(previous?.status)) continue
    const block = intake.windows.at(-1).toHeader
    if (block.number <= (previous?.block.number ?? proof.boundary.firstEligible.number)) continue
    candidates.push({ tokenId, proof, entry, previous })
  }
  if (!candidates.length)
    return { status: 'no-due-impairment', coveredThrough: intake.coveredThrough }
  const block = intake.windows.at(-1).toHeader
  if (now() - block.timestamp * 1_000 > MAX_BLOCK_AGE_MS)
    return { status: 'coverage-stale', coveredThrough: intake.coveredThrough }
  fail(freeBytes() >= MIN_FREE_BYTES, 'apyusd_impairment_disk_reserve')
  candidates.sort((a, b) =>
    BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : BigInt(a.tokenId) > BigInt(b.tokenId) ? 1 : 0,
  )
  const cursor = (await cursorReader(out, intake.anchor.sha256)) % candidates.length
  const { tokenId, proof, entry, previous } = candidates[cursor]
  const replay = replayAtBoundary(intake, entry, block.number)
  const censor = firstCensorEvent(
    intake,
    tokenId,
    entry.mint.initialHolder,
    proof.boundary.firstEligible.number,
    block.number,
  )
  let observation = null
  let observedBlock = block
  if (!censor) {
    try {
      const result = await reader({ intake, tokenId, blockNumber: block.number })
      observedBlock = result.block
      observation = {
        identity: result.identity,
        terms: result.terms,
        claim: result.claim,
        holderOrigin: result.holderOrigin,
      }
    } catch (error) {
      const message = error?.message ?? ''
      const status = /^(public_rpc_|apyusd_forceability_(archive_unavailable|rpc_budget))/.test(
        message,
      )
        ? 'archive-unavailable'
        : /^apyusd_forceability_.*(origins_disagree|headers_disagree)$/.test(message)
          ? 'source-disagreement'
          : /^apyusd_(implementation_identity_invalid|asset_identity_invalid)/.test(message)
            ? 'identity-check-failed'
            : null
      if (!status) throw error
      await cursorWriter(out, intake.anchor.sha256, (cursor + 1) % candidates.length, freeBytes)
      return { status, tokenId }
    }
  }
  const row = makeRow({
    intake,
    issue: proof.issue,
    boundary: proof.boundary,
    entry,
    previous,
    block: observedBlock,
    replay,
    observation,
    censor,
    now,
  })
  const directory = join(out, tokenId)
  validateImpairmentRows([...(await readBoundedChain(directory)), row], {
    intake,
    issue: proof.issue,
    boundary: proof.boundary,
    entry,
  })
  await writer(row, directory, (path) =>
    readBoundedChain(path).then((rows) =>
      validateImpairmentRows(rows, {
        intake,
        issue: proof.issue,
        boundary: proof.boundary,
        entry,
      }),
    ),
  )
  await cursorWriter(out, intake.anchor.sha256, (cursor + 1) % candidates.length, freeBytes)
  return {
    status: row.status,
    tokenId,
    block: row.block.number,
    recoveryInterval: row.recoveryInterval,
  }
}

/** Offline verified stage-only recovery bounds; no full-route or forecast claim. */
export async function readVerifiedProspectiveImpairment({
  out = OUT,
  forceabilityOut = FORCEABILITY_OUT,
  intakeLoader = verifyProspectiveIntake,
  tokensLoader = boundaryTokenIds,
  forceabilityLoader = verifyProspectiveForceability,
} = {}) {
  const intake = await intakeLoader()
  const episodes = []
  if (intake.anchor && intake.windows.length) {
    const ids = await tokensLoader(forceabilityOut)
    for (const tokenId of ids) {
      const proof = await forceabilityLoader(tokenId, {
        out: forceabilityOut,
        intakeLoader: async () => intake,
      })
      if (proof.status !== 'claim-reverted-or-zero') continue
      const rows = validateImpairmentRows(await readBoundedChain(join(out, tokenId)), {
        intake,
        issue: proof.issue,
        boundary: proof.boundary,
        entry: intakeMint(intake, tokenId),
      })
      const last = rows.at(-1)
      episodes.push({
        tokenId,
        firstEligibleTimestamp: proof.boundary.firstEligible.timestamp,
        observations: rows.length,
        status: last?.status ?? 'awaiting_followup',
        recoveryInterval: last?.recoveryInterval ?? null,
        rightCensoredAtSeconds: last?.status?.startsWith('censored_')
          ? (last.censor?.elapsedSeconds ?? last.elapsedSinceFirstEligibleSeconds)
          : last?.status === 'impaired'
            ? last.elapsedSinceFirstEligibleSeconds
            : null,
        evidenceSha256: last?.sha256 ?? proof.boundary.sha256,
      })
    }
  }
  return {
    scope: SCOPE,
    intakeAnchorSha256: intake.anchor?.sha256 ?? null,
    summary: {
      failedFirstEligibleEpisodes: episodes.length,
      recoveredIntervals: episodes.filter((episode) => episode.status === 'recovered').length,
      rightCensoredEpisodes: episodes.filter((episode) => episode.status.startsWith('censored_'))
        .length,
      stillImpairedEpisodes: episodes.filter((episode) => episode.status === 'impaired').length,
      awaitingFollowupEpisodes: episodes.filter((episode) => episode.status === 'awaiting_followup')
        .length,
    },
    episodes,
    prospectiveValidated: false,
    fullRouteExitAssessed: false,
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || mode !== '--capture') throw Error('apyusd_impairment_usage')
  try {
    console.log(JSON.stringify(await captureProspectiveImpairment()))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
