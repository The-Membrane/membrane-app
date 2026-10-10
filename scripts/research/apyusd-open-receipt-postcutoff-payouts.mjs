// Same-receipt mined apxUSD payouts for frozen ApyUSD receipts after the cutoff.
// A burn is only a candidate until two origins agree on the paid transaction.
import { constants, statfsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { canonical, RECEIPT, sha } from './carry-public-apyusd-exit-common.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  readHolderPayout,
  readHolderPayoutWitness,
  readOne,
} from './apyusd-receipt-cohort-payouts.mjs'
import { verifyEscrow } from './apyusd-receipt-cohort-escrow.mjs'
import { verifySource, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyTransfers } from './apyusd-receipt-cohort-transfers.mjs'
import { verifyPostcutoff } from './apyusd-open-receipt-postcutoff-transfers.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-open-receipt-postcutoff-payouts-v1')
const STUDY = 'apyusd_open_receipt_postcutoff_payout_v1'
const ORIGINS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const ZERO = `0x${'0'.repeat(64)}`
const POSITIVE = /^[1-9][0-9]*$/
const SHA = /^[0-9a-f]{64}$/
const IDS = ['881', '891', '897', '906', '935', '941', '947']
const MAX_RPC_CALLS = 48
const MAX_WALL_MS = 120_000
const FIELDS = [
  'study',
  'scope',
  'tokenId',
  'receipt',
  'sourceSha256',
  'transfersSha256',
  'escrowSha256',
  'scanWindowSha256',
  'mintSha256',
  'burnSha256',
  'origins',
  'proof',
  'terminalPayoutVerified',
  'prospectiveQForecast',
  'sha256',
]
  .sort()
  .join(',')
const fail = (okay, code) => {
  if (!okay) throw Error(code)
}
const id = (event) => BigInt(event.topics[3]).toString()
const address = (topic) => `0x${topic.slice(-40)}`
const bodyHash = (row) => {
  const { sha256: _seal, ...body } = row
  return sha(canonical(body))
}
const pathFor = (out, tokenId) => join(out, `${tokenId}.json`)

function validPayoutWitness(payout, holder) {
  try {
    const witness = payout?.payoutTransferWitness
    return (
      canonical(readHolderPayoutWitness({ logs: [witness] }, holder)) === canonical(witness) &&
      readHolderPayout({ logs: [witness] }, holder) === payout.paidAssetRaw
    )
  } catch {
    return false
  }
}

function boundedOrigins(origins, clock) {
  const deadline = clock() + MAX_WALL_MS
  let calls = 0
  const check = () => fail(clock() < deadline, 'apyusd_postcutoff_payout_rpc_budget')
  return {
    origins: origins.map((origin) => ({
      ...origin,
      async request(...args) {
        fail(calls < MAX_RPC_CALLS, 'apyusd_postcutoff_payout_rpc_budget')
        check()
        calls++
        return origin.request(...args)
      },
    })),
    check,
  }
}

export function findPostcutoffBurn(tokenId, source, transfers, scanRows) {
  fail(IDS.includes(tokenId), 'apyusd_postcutoff_payout_id_invalid')
  fail(transfers.cohort?.openIds.includes(tokenId), 'apyusd_postcutoff_payout_source_invalid')
  const mint = source.mints.find((event) => id(event) === tokenId)
  fail(mint, 'apyusd_postcutoff_payout_mint_missing')
  const holderTopic = mint.topics[2]
  const older = transfers.transfers.filter((event) => id(event) === tokenId)
  fail(
    older.length === 1 && older[0].topics[1] === ZERO && older[0].topics[2] === holderTopic,
    'apyusd_postcutoff_payout_prior_transfer',
  )
  let burn = null
  let window = null
  for (const row of scanRows) {
    for (const event of row.transfers) {
      if (id(event) !== tokenId) continue
      if (burn || event.topics[1] !== holderTopic || event.topics[2] !== ZERO)
        throw Error('apyusd_postcutoff_payout_intermediate_transfer')
      burn = event
      window = row
    }
  }
  return burn ? { tokenId, holder: address(holderTopic), mint, burn, window } : null
}

export function validatePostcutoffPayout(row, candidate, source, transfers, escrow) {
  const proof = row?.proof
  const escrowProof = escrow.proofs.find((item) => item.tokenId === candidate.tokenId)
  const burnHeader = candidate.window.eventBlockHeaders.find(
    (item) => item.number === candidate.burn.blockNumber,
  )
  fail(
    row?.study === STUDY &&
      Object.keys(row).sort().join(',') === FIELDS &&
      row.scope === 'frozen_historical_open_receipt_postcutoff_payout' &&
      row.tokenId === candidate.tokenId &&
      row.receipt === RECEIPT &&
      row.sourceSha256 === source.sha256 &&
      row.transfersSha256 === transfers.sha256 &&
      row.escrowSha256 === escrow.sha256 &&
      row.scanWindowSha256 === candidate.window.sha256 &&
      row.mintSha256 === sha(canonical(candidate.mint)) &&
      row.burnSha256 === sha(canonical(candidate.burn)) &&
      canonical(row.origins) === canonical(ORIGINS) &&
      row.terminalPayoutVerified === true &&
      row.prospectiveQForecast === false &&
      proof?.tokenId === candidate.tokenId &&
      proof.holder === candidate.holder &&
      proof.request?.blockNumber === candidate.mint.blockNumber &&
      proof.request?.blockHash === candidate.mint.blockHash &&
      proof.request?.transactionHash === candidate.mint.transactionHash &&
      proof.request?.logIndex === candidate.mint.logIndex &&
      proof.request?.timestamp === escrowProof?.issuedAt &&
      proof.request?.requestedAssetRaw === escrowProof?.grossWithdrawRaw &&
      proof.payout?.blockNumber === candidate.burn.blockNumber &&
      proof.payout?.blockHash === candidate.burn.blockHash &&
      proof.payout?.transactionHash === candidate.burn.transactionHash &&
      proof.payout?.logIndex === candidate.burn.logIndex &&
      proof.payout?.timestamp === burnHeader?.timestamp &&
      POSITIVE.test(proof.request?.requestedAssetRaw ?? '') &&
      POSITIVE.test(proof.payout?.paidAssetRaw ?? '') &&
      validPayoutWitness(proof.payout, candidate.holder) &&
      Number.isSafeInteger(proof.request?.timestamp) &&
      Number.isSafeInteger(proof.payout?.timestamp) &&
      proof.payout.timestamp > proof.request.timestamp &&
      proof.requestToPayoutSeconds === proof.payout.timestamp - proof.request.timestamp &&
      Number.isSafeInteger(proof.payoutBpsFloor) &&
      proof.payoutBpsFloor ===
        Number(
          (BigInt(proof.payout.paidAssetRaw) * 10_000n) / BigInt(proof.request.requestedAssetRaw),
        ) &&
      SHA.test(row.sha256 ?? '') &&
      row.sha256 === bodyHash(row),
    'apyusd_postcutoff_payout_invalid',
  )
  return row
}

export function buildPostcutoffPayout(proof, candidate, source, transfers, escrow) {
  const body = {
    study: STUDY,
    scope: 'frozen_historical_open_receipt_postcutoff_payout',
    tokenId: candidate.tokenId,
    receipt: RECEIPT,
    sourceSha256: source.sha256,
    transfersSha256: transfers.sha256,
    escrowSha256: escrow.sha256,
    scanWindowSha256: candidate.window.sha256,
    mintSha256: sha(canonical(candidate.mint)),
    burnSha256: sha(canonical(candidate.burn)),
    origins: ORIGINS,
    proof,
    terminalPayoutVerified: true,
    prospectiveQForecast: false,
  }
  return validatePostcutoffPayout(
    { ...body, sha256: sha(canonical(body)) },
    candidate,
    source,
    transfers,
    escrow,
  )
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
    fail(stat.isFile() && stat.size <= 16_384, 'apyusd_postcutoff_payout_size_invalid')
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const row = JSON.parse(bytes.toString('utf8'))
  fail(
    bytes.toString('utf8') === `${canonical(row)}\n`,
    'apyusd_postcutoff_payout_encoding_invalid',
  )
  return row
}

async function context({ sourceLoader, transfersLoader, scanLoader, escrowLoader }) {
  const [source, transfers, scanRows, escrow] = await Promise.all([
    sourceLoader(),
    transfersLoader(),
    scanLoader(),
    escrowLoader(),
  ])
  return { source, transfers, scanRows, escrow }
}

async function liveProof(candidate, { clientsForUrls, urls, reader, rpcClock }) {
  const clients = clientsForUrls(urls ?? configuredPublicRpcUrls(readEnv()))
  const origins = ORIGINS.map((host) => clients.find((item) => new URL(item.url).hostname === host))
  fail(
    origins.every(Boolean) && origins[0].provider !== origins[1].provider,
    'apyusd_postcutoff_payout_origins_invalid',
  )
  const bounded = boundedOrigins(origins, rpcClock)
  const proofs = await Promise.all(
    bounded.origins.map((origin) =>
      reader(origin, candidate.mint, candidate.burn, {
        requireUniqueBurn: true,
        includePayoutWitness: true,
        requireCanonicalBurn: true,
      }),
    ),
  )
  bounded.check()
  fail(canonical(proofs[0]) === canonical(proofs[1]), 'apyusd_postcutoff_payout_origins_disagree')
  return proofs[0]
}

async function readVerifiedSaved(
  tokenId,
  {
    out = OUT,
    sourceLoader = verifySource,
    transfersLoader = verifyTransfers,
    scanLoader = verifyPostcutoff,
    escrowLoader = verifyEscrow,
  } = {},
) {
  const { source, transfers, scanRows, escrow } = await context({
    sourceLoader,
    transfersLoader,
    scanLoader,
    escrowLoader,
  })
  const candidate = findPostcutoffBurn(tokenId, source, transfers, scanRows)
  fail(candidate, 'apyusd_postcutoff_payout_no_burn')
  const row = await readSaved(pathFor(out, tokenId))
  fail(row, 'apyusd_postcutoff_payout_missing')
  validatePostcutoffPayout(row, candidate, source, transfers, escrow)
  return { row, candidate }
}

// Structural replay only. A locally resealed witness cannot authenticate a paid
// amount; the public --verify command also re-reads both live mined receipts.
export async function verifyPostcutoffPayoutLocal(tokenId, options = {}) {
  return (await readVerifiedSaved(tokenId, options)).row
}

export async function verifyPostcutoffPayout(
  tokenId,
  {
    clientsForUrls = publicRpcClients,
    urls = null,
    reader = readOne,
    rpcClock = Date.now,
    ...localOptions
  } = {},
) {
  const { row, candidate } = await readVerifiedSaved(tokenId, localOptions)
  const live = await liveProof(candidate, { clientsForUrls, urls, reader, rpcClock })
  fail(canonical(live) === canonical(row.proof), 'apyusd_postcutoff_payout_live_disagree')
  return row
}

export async function capturePostcutoffPayout(
  tokenId,
  {
    out = OUT,
    sourceLoader = verifySource,
    transfersLoader = verifyTransfers,
    scanLoader = verifyPostcutoff,
    escrowLoader = verifyEscrow,
    clientsForUrls = publicRpcClients,
    urls = null,
    reader = readOne,
    writer = writeExclusive,
    rpcClock = Date.now,
    freeBytes = () => {
      const disk = statfsSync(dirname(out))
      return Number(disk.bavail) * Number(disk.bsize)
    },
  } = {},
) {
  fail(freeBytes() >= 1_073_741_824 + 16_384, 'apyusd_postcutoff_payout_disk_reserve')
  const { source, transfers, scanRows, escrow } = await context({
    sourceLoader,
    transfersLoader,
    scanLoader,
    escrowLoader,
  })
  const candidate = findPostcutoffBurn(tokenId, source, transfers, scanRows)
  fail(candidate, 'apyusd_postcutoff_payout_no_burn')
  const path = pathFor(out, tokenId)
  const prior = await readSaved(path)
  if (prior) validatePostcutoffPayout(prior, candidate, source, transfers, escrow)
  const live = await liveProof(candidate, { clientsForUrls, urls, reader, rpcClock })
  if (prior) {
    fail(canonical(live) === canonical(prior.proof), 'apyusd_postcutoff_payout_live_disagree')
    return prior
  }
  const row = buildPostcutoffPayout(live, candidate, source, transfers, escrow)
  await writer(path, row)
  return row
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2]
  const tokenId = process.argv[3]
  try {
    fail(
      process.argv.length === 4 &&
        ['--capture', '--verify'].includes(mode) &&
        IDS.includes(tokenId),
      'apyusd_postcutoff_payout_usage',
    )
    const row =
      mode === '--capture'
        ? await capturePostcutoffPayout(tokenId)
        : await verifyPostcutoffPayout(tokenId)
    process.stdout.write(
      `${JSON.stringify({ tokenId: row.tokenId, paidAssetRaw: row.proof.payout.paidAssetRaw, requestToPayoutSeconds: row.proof.requestToPayoutSeconds, sha256: row.sha256 })}\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${/^apyusd_[a-z0-9_]+$/.test(error?.message) ? error.message : 'apyusd_postcutoff_payout_failed'}\n`,
    )
    process.exitCode = 1
  }
}
