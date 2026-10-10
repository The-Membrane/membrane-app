// Prospective observations of the seven frozen real ApyUSD receipts. Claim
// simulations are current ability checks; a disappeared receipt is not payout.
import { statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  appendChain,
  canonical,
  readChain,
  RECEIPT,
  sha,
} from './carry-public-apyusd-exit-common.mjs'
import { observeCurrent, sourceSet, validateCurrent } from './apyusd-open-receipt-current.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-open-receipt-continuity-v1')
const STUDY = 'apyusd_open_receipt_continuity_v1'
const SCOPE = 'frozen_seven_current_claimability_only'
const ORIGINS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const MIN_FREE_BYTES = 1_073_741_824
const MAX_BLOCK_AGE_MS = 45 * 60_000
const FUTURE_SKEW_MS = 120_000
const FIELDS = [
  'study',
  'sequence',
  'previousSha256',
  'scope',
  'source',
  'receipt',
  'origins',
  'block',
  'observedAtUtc',
  'subjects',
  'proofs',
  'prospectiveQForecast',
  'fullRouteExitAssessed',
  'terminalPayoutVerified',
  'sha256',
].sort()
const fail = (condition, code) => {
  if (!condition) throw Error(code)
}
const utc = (value) => {
  const ms = Date.parse(value ?? '')
  fail(
    Number.isSafeInteger(ms) && new Date(ms).toISOString() === value,
    'apyusd_continuity_clock_invalid',
  )
  return ms
}

function cleanProof(proof) {
  fail(proof && typeof proof.tokenId === 'string', 'apyusd_continuity_proof_invalid')
  const common = { tokenId: proof.tokenId, status: proof.status }
  let result
  if (proof.status === 'same_holder')
    result = {
      ...common,
      isClaimable: proof.isClaimable,
      claimStatus: proof.claimStatus,
      claimAmountRaw: proof.claimAmountRaw,
    }
  else if (proof.status === 'holder_changed')
    result = { ...common, currentOwner: proof.currentOwner }
  else if (proof.status === 'no_current_owner') result = common
  else throw Error('apyusd_continuity_proof_invalid')
  return { ...result, holderCodeStatus: proof.holderCodeStatus }
}

function validateRow(row, expected, prior) {
  fail(
    row?.study === STUDY &&
      Object.keys(row).sort().join(',') === FIELDS.join(',') &&
      row.sequence === (prior?.sequence ?? 0) + 1 &&
      row.previousSha256 === (prior?.sha256 ?? null) &&
      row.scope === SCOPE &&
      canonical(row.source) === canonical(expected.source) &&
      row.receipt === RECEIPT &&
      canonical(row.origins) === canonical(ORIGINS) &&
      canonical(row.subjects) === canonical(expected.subjects) &&
      Array.isArray(row.proofs) &&
      row.proofs.length === expected.subjects.length &&
      row.prospectiveQForecast === false &&
      row.fullRouteExitAssessed === false &&
      row.terminalPayoutVerified === false &&
      Number.isSafeInteger(row.block?.number) &&
      row.block.number > (prior?.block.number ?? 0) &&
      /^0x[0-9a-f]{64}$/.test(row.block?.hash ?? '') &&
      Number.isSafeInteger(row.block?.timestamp) &&
      row.block.timestamp > (prior?.block.timestamp ?? 0) &&
      canonical(row.proofs) === canonical(row.proofs.map(cleanProof)),
    'apyusd_continuity_row_invalid',
  )
  const observedAt = utc(row.observedAtUtc)
  fail(
    observedAt >= (prior ? utc(prior.observedAtUtc) : 0) &&
      observedAt - row.block.timestamp * 1_000 >= -FUTURE_SKEW_MS &&
      observedAt - row.block.timestamp * 1_000 <= MAX_BLOCK_AGE_MS,
    'apyusd_continuity_time_invalid',
  )
  const current = {
    study: 'apyusd_open_receipt_current_v1',
    source: row.source,
    receipt: row.receipt,
    origins: row.origins,
    block: row.block,
    subjects: row.subjects,
    proofs: row.proofs,
  }
  validateCurrent({ ...current, sha256: sha(canonical(current)) }, expected)
  const { sha256: _seal, ...body } = row
  fail(
    row.proofs.every((proof) =>
      ['no_code', 'eip7702_delegated', 'contract_code'].includes(proof.holderCodeStatus),
    ) && row.sha256 === sha(canonical(body)),
    'apyusd_continuity_seal_invalid',
  )
  return row
}

export function validateContinuityRows(rows, expected) {
  fail(Array.isArray(rows), 'apyusd_continuity_rows_invalid')
  for (let index = 0; index < rows.length; index++)
    validateRow(rows[index], expected, rows[index - 1])
  return rows
}

export async function verifyContinuity(out = OUT, sourceLoader = sourceSet) {
  const expected = await sourceLoader()
  return validateContinuityRows(await readChain(out), expected)
}

export function buildContinuityRow(observation, prior, expected) {
  fail(
    observation?.observationStatus === 'unsealed' &&
      observation.scope === 'current_status_of_frozen_historical_open_receipts' &&
      observation.prospectiveQForecast === false &&
      observation.holderCodeChecked === true,
    'apyusd_continuity_observation_invalid',
  )
  const body = {
    study: STUDY,
    sequence: (prior?.sequence ?? 0) + 1,
    previousSha256: prior?.sha256 ?? null,
    scope: SCOPE,
    source: observation.source,
    receipt: observation.receipt,
    origins: observation.origins,
    block: observation.block,
    observedAtUtc: observation.observedAtUtc,
    subjects: observation.subjects,
    proofs: observation.proofs.map(cleanProof),
    prospectiveQForecast: false,
    fullRouteExitAssessed: false,
    terminalPayoutVerified: false,
  }
  return validateRow({ ...body, sha256: sha(canonical(body)) }, expected, prior)
}

export async function captureContinuity({
  out = OUT,
  sourceLoader = sourceSet,
  observer = observeCurrent,
  writer = appendChain,
  freeBytes = () => {
    const disk = statfsSync(dirname(out))
    return Number(disk.bavail) * Number(disk.bsize)
  },
} = {}) {
  fail(freeBytes() >= MIN_FREE_BYTES + 262_144, 'apyusd_continuity_disk_reserve')
  const expected = await sourceLoader()
  const previous = validateContinuityRows(await readChain(out), expected)
  const observation = await observer({ sourceLoader: async () => expected })
  if (observation.block.number <= (previous.at(-1)?.block.number ?? 0))
    return { status: 'already_observed', row: previous.at(-1) }
  const row = buildContinuityRow(observation, previous.at(-1), expected)
  await writer(row, out, (path) => verifyContinuity(path, sourceLoader))
  return { status: 'captured', row }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--capture', '--verify'].includes(mode))
    throw Error('apyusd_continuity_usage')
  try {
    const result = mode === '--capture' ? await captureContinuity() : null
    const rows = await verifyContinuity()
    const row = result?.row ?? rows.at(-1)
    process.stdout.write(
      `${JSON.stringify({ status: result?.status ?? 'verified', observations: rows.length, block: row?.block ?? null, sameHolder: row?.proofs.filter((proof) => proof.status === 'same_holder').length ?? 0, simulatedClaimSuccess: row?.proofs.filter((proof) => proof.claimStatus === 'success').length ?? 0, contractHolderCount: row?.proofs.filter((proof) => proof.holderCodeStatus === 'contract_code').length ?? 0, terminalPayoutVerified: false })}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${/^apyusd_[a-z0-9_]+$/.test(error.message) ? error.message : 'apyusd_continuity_failed'}\n`,
    )
    process.exitCode = 1
  }
}
