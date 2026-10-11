// One foreground, read-only continuity check for the frozen seven open receipts.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { pin } from './carry-public-apyusd-exit-common.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { RECEIPT, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyTransfers } from './apyusd-receipt-cohort-transfers.mjs'
import { verifyEscrow } from './apyusd-receipt-cohort-escrow.mjs'
import { verifyBoundaries } from './apyusd-receipt-cohort-boundaries.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-open-receipt-current-v1.json')
const STUDY = 'apyusd_open_receipt_current_v1'
const ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function isClaimable(uint256) view returns (bool)',
  'function claim(uint256,address) returns (uint256)',
])
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const EXPECTED_IMPL = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
const ORIGINS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
// Match the live fixed-Q issue lanes' 45-minute finalized-baseline limit;
// allow the same two-minute local clock skew as the Aave holder probe.
const MAX_OBSERVATION_AGE_MS = 45 * 60_000
const MAX_FUTURE_CLOCK_SKEW_MS = 120_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (okay, code) => {
  if (!okay) throw Error(code)
}
const encoded = (functionName, tokenId, holder = null) =>
  encodeFunctionData({
    abi: ABI,
    functionName,
    args: holder === null ? [BigInt(tokenId)] : [BigInt(tokenId), holder],
  })

export async function sourceSet() {
  const [transfers, escrow, boundaries] = await Promise.all([
    verifyTransfers(),
    verifyEscrow(),
    verifyBoundaries(),
  ])
  const openIds = transfers.cohort.openIds
  fail(openIds.length === 7, 'apyusd_current_open_cohort_changed')
  const escrowById = new Map(escrow.proofs.map((row) => [row.tokenId, row]))
  const boundaryById = new Map(boundaries.proofs.map((row) => [row.tokenId, row]))
  const subjects = openIds.map((tokenId) => {
    const prior = escrowById.get(tokenId)
    const boundary = boundaryById.get(tokenId)
    fail(
      prior &&
        boundary &&
        prior.holder.toLowerCase() === boundary.holder.toLowerCase() &&
        prior.claimableAt === boundary.schedule.claimableAt &&
        boundary.firstEligible.claim.status === 'success',
      'apyusd_current_source_binding',
    )
    return {
      tokenId,
      holder: prior.holder.toLowerCase(),
      receiptEscrowRaw: prior.receiptEscrowRaw,
      issuedAt: prior.issuedAt,
      claimableAt: prior.claimableAt,
    }
  })
  return {
    subjects,
    source: {
      transfersSha256: transfers.sha256,
      escrowSha256: escrow.sha256,
      boundariesSha256: boundaries.sha256,
    },
  }
}

async function call(origin, functionName, subject, blockHash) {
  const response = await origin.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      {
        to: RECEIPT,
        data: encoded(
          functionName,
          subject.tokenId,
          functionName === 'claim' ? subject.holder : null,
        ),
        ...(functionName === 'claim' ? { from: subject.holder } : {}),
      },
      pin(blockHash),
    ],
  })
  if (Object.hasOwn(response, 'error')) {
    fail(response.error.message === 'execution reverted', 'apyusd_current_rpc_call_failed')
    return { status: 'evm_revert' }
  }
  const result = decodeFunctionResult({ abi: ABI, functionName, data: response.result })
  return {
    status: 'success',
    value: Array.isArray(result) ? result.map(String) : String(result),
  }
}

async function stateAt(origin, subject, block) {
  const impl = await origin.request('eth_getStorageAt', [RECEIPT, SLOT, pin(block.hash)])
  fail(
    typeof impl === 'string' && impl.toLowerCase().endsWith(EXPECTED_IMPL.slice(2)),
    'apyusd_current_implementation_changed',
  )
  const owner = await call(origin, 'ownerOf', subject, block.hash)
  if (owner.status === 'evm_revert') return { tokenId: subject.tokenId, status: 'no_current_owner' }
  fail(/^0x[0-9a-fA-F]{40}$/.test(owner.value), 'apyusd_current_owner_invalid')
  if (owner.value.toLowerCase() !== subject.holder)
    return {
      tokenId: subject.tokenId,
      status: 'holder_changed',
      currentOwner: owner.value.toLowerCase(),
    }
  const [receipt, eligible, claim] = await Promise.all([
    call(origin, 'getReceipt', subject, block.hash),
    call(origin, 'isClaimable', subject, block.hash),
    call(origin, 'claim', subject, block.hash),
  ])
  fail(
    receipt.status === 'success' &&
      receipt.value[0] === subject.receiptEscrowRaw &&
      receipt.value[2] === String(subject.issuedAt) &&
      receipt.value[3] === String(subject.claimableAt) &&
      eligible.status === 'success',
    'apyusd_current_receipt_changed',
  )
  fail(block.timestamp >= subject.claimableAt, 'apyusd_current_before_eligibility')
  return {
    tokenId: subject.tokenId,
    status: 'same_holder',
    isClaimable: eligible.value === 'true',
    claimStatus: claim.status,
    claimAmountRaw: claim.status === 'success' ? claim.value : null,
  }
}

async function measureCurrent({
  urls = configuredPublicRpcUrls(readEnv()),
  sourceLoader = sourceSet,
  clientsForUrls = publicRpcClients,
} = {}) {
  const { subjects, source } = await sourceLoader()
  const clients = clientsForUrls(urls)
  const origins = ORIGINS.map((host) => clients.find((row) => new URL(row.url).hostname === host))
  fail(origins.every(Boolean), 'apyusd_current_origins_missing')
  const headers = await Promise.all(
    origins.map(async (origin) => {
      const raw = await origin.request('eth_getBlockByNumber', ['finalized', false])
      return {
        number: Number(BigInt(raw.number)),
        hash: raw.hash.toLowerCase(),
        timestamp: Number(BigInt(raw.timestamp)),
      }
    }),
  )
  fail(JSON.stringify(headers[0]) === JSON.stringify(headers[1]), 'apyusd_current_headers_disagree')
  const block = headers[0]
  const proofs = []
  for (const subject of subjects) {
    const states = await Promise.all(origins.map((origin) => stateAt(origin, subject, block)))
    fail(JSON.stringify(states[0]) === JSON.stringify(states[1]), 'apyusd_current_origins_disagree')
    proofs.push(states[0])
  }
  const body = { study: STUDY, source, receipt: RECEIPT, origins: ORIGINS, block, subjects, proofs }
  return validateCurrent({ ...body, sha256: sha(JSON.stringify(body)) }, { subjects, source })
}

export async function observeCurrent({
  urls = configuredPublicRpcUrls(readEnv()),
  sourceLoader = sourceSet,
  clientsForUrls = publicRpcClients,
  now = Date.now,
} = {}) {
  const clients = clientsForUrls(urls)
  const { sha256: _seal, ...body } = await measureCurrent({
    urls,
    sourceLoader,
    clientsForUrls: () => clients,
  })
  const observedAtMs = now()
  const blockTimeMs = body.block.timestamp * 1000
  fail(
    Number.isSafeInteger(observedAtMs) && Number.isSafeInteger(blockTimeMs),
    'apyusd_current_observation_clock_invalid',
  )
  fail(observedAtMs - blockTimeMs >= -MAX_FUTURE_CLOCK_SKEW_MS, 'apyusd_current_block_future')
  fail(observedAtMs - blockTimeMs <= MAX_OBSERVATION_AGE_MS, 'apyusd_current_block_stale')
  const origins = ORIGINS.map((host) => clients.find((row) => new URL(row.url).hostname === host))
  const proofs = []
  for (let index = 0; index < body.subjects.length; index++) {
    const subject = body.subjects[index]
    const codes = await Promise.all(
      origins.map((origin) =>
        origin.request('eth_getCode', [subject.holder, pin(body.block.hash)]),
      ),
    )
    fail(
      codes.every((code) => typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(code)),
      'apyusd_current_holder_code_invalid',
    )
    fail(codes[0].toLowerCase() === codes[1].toLowerCase(), 'apyusd_current_holder_code_diverged')
    // EIP-7702 delegation designators contain code but belong to an EOA.
    // Code class does not prove key possession or a future mined payout.
    const code = codes[0].toLowerCase()
    proofs.push({
      ...body.proofs[index],
      holderCodeStatus:
        code === '0x'
          ? 'no_code'
          : /^0xef0100[0-9a-f]{40}$/.test(code)
            ? 'eip7702_delegated'
            : 'contract_code',
    })
  }
  return {
    ...body,
    proofs,
    observationStatus: 'unsealed',
    scope: 'current_status_of_frozen_historical_open_receipts',
    prospectiveQForecast: false,
    holderCodeChecked: true,
    observedAtUtc: new Date(observedAtMs).toISOString(),
  }
}

export async function captureCurrent({
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
  sourceLoader = sourceSet,
  clientsForUrls = publicRpcClients,
  writer = writeExclusive,
} = {}) {
  const row = await measureCurrent({ urls, sourceLoader, clientsForUrls })
  await writer(out, row)
  return row
}

export function validateCurrent(row, expected) {
  fail(
    row?.study === STUDY &&
      row.receipt === RECEIPT &&
      JSON.stringify(row.origins) === JSON.stringify(ORIGINS) &&
      JSON.stringify(row.source) === JSON.stringify(expected.source) &&
      JSON.stringify(row.subjects) === JSON.stringify(expected.subjects) &&
      Array.isArray(row.proofs) &&
      row.proofs.length === expected.subjects.length &&
      Number.isSafeInteger(row.block?.number) &&
      Number.isSafeInteger(row.block?.timestamp) &&
      /^0x[0-9a-f]{64}$/.test(row.block?.hash ?? ''),
    'apyusd_current_artifact_invalid',
  )
  for (let index = 0; index < row.proofs.length; index++) {
    const proof = row.proofs[index]
    fail(proof.tokenId === expected.subjects[index].tokenId, 'apyusd_current_subject_order')
    if (proof.status === 'no_current_owner') {
      fail(
        proof.claimStatus === undefined &&
          proof.claimAmountRaw === undefined &&
          proof.currentOwner === undefined,
        'apyusd_current_absent_owner_invalid',
      )
      continue
    }
    if (proof.status === 'holder_changed') {
      fail(
        /^0x[0-9a-f]{40}$/.test(proof.currentOwner ?? '') &&
          proof.currentOwner !== expected.subjects[index].holder &&
          proof.claimStatus === undefined &&
          proof.claimAmountRaw === undefined,
        'apyusd_current_owner_change_invalid',
      )
      continue
    }
    fail(
      proof.status === 'same_holder' &&
        typeof proof.isClaimable === 'boolean' &&
        ['success', 'evm_revert'].includes(proof.claimStatus) &&
        (proof.claimStatus !== 'success' || proof.isClaimable) &&
        (proof.claimStatus === 'success'
          ? /^(0|[1-9][0-9]*)$/.test(proof.claimAmountRaw) &&
            BigInt(proof.claimAmountRaw) > 0n &&
            BigInt(proof.claimAmountRaw) <= BigInt(expected.subjects[index].receiptEscrowRaw)
          : proof.claimAmountRaw === null),
      'apyusd_current_proof_invalid',
    )
  }
  const { sha256, ...body } = row
  fail(sha256 === sha(JSON.stringify(body)), 'apyusd_current_hash_invalid')
  return row
}

export async function verifyCurrent(out = OUT) {
  const bytes = await readFile(out)
  fail(bytes.length < 100_000, 'apyusd_current_artifact_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  fail(bytes.toString('utf8') === `${JSON.stringify(row)}\n`, 'apyusd_current_encoding_invalid')
  return validateCurrent(row, await sourceSet())
}

export async function runCurrentMode(mode, options = {}) {
  if (mode === '--observe') return observeCurrent(options)
  if (mode === '--capture') return captureCurrent(options)
  if (mode === '--verify') return verifyCurrent(options.out ?? OUT)
  throw Error('apyusd_current_usage')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  try {
    fail(
      process.argv.length === 3 && ['--observe', '--capture', '--verify'].includes(mode),
      'apyusd_current_usage',
    )
    const row = await runCurrentMode(mode)
    process.stdout.write(
      `${JSON.stringify(
        mode === '--observe'
          ? row
          : {
              study: row.study,
              block: row.block,
              counts: {
                sameHolder: row.proofs.filter((proof) => proof.status === 'same_holder').length,
                claimSuccess: row.proofs.filter((proof) => proof.claimStatus === 'success').length,
                noCurrentOwner: row.proofs.filter((proof) => proof.status === 'no_current_owner')
                  .length,
              },
              sha256: row.sha256,
            },
      )}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${/^apyusd_current_|^apyusd_cohort_/.test(error?.message) ? error.message : 'apyusd_current_run_failed'}\n`,
    )
    process.exitCode = 1
  }
}
