// Issue-scoped same-episode sidecar. The archive and mined delivery remain immutable.
import { statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, parseAbi } from 'viem'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { OUT as ISSUE_OUT, verifyIssues } from './susde-public-pending-exit-issue.mjs'
import { OUT as DELIVERY_OUT, verifyDeliveries } from './susde-public-mined-delivery.mjs'
import {
  OUT as ARCHIVE_OUT,
  verifyContinuityArchive,
} from './susde-public-pending-continuity-archive.mjs'
import {
  HASH,
  VAULT,
  appendLedger,
  readLedger,
  seal,
  utc,
} from './susde-public-pending-exit-common.mjs'

export const STUDY = 'susde_public_pending_payout_same_episode_v2'
export const OUT = resolve('data/research/venue-signals/susde-public-pending-payout-v2')
export const ISSUE_SEQUENCE = 3
const outputForIssue = (issueSequence) =>
  issueSequence === ISSUE_SEQUENCE
    ? OUT
    : resolve(`data/research/venue-signals/susde-public-pending-payout-v2-issue-${issueSequence}`)
const archiveForIssue = (issueSequence) =>
  issueSequence === ISSUE_SEQUENCE
    ? ARCHIVE_OUT
    : resolve(`data/research/venue-signals/susde-public-pending-continuity-issue-${issueSequence}`)
const ABI = parseAbi([
  'function cooldowns(address) view returns (uint104 cooldownEnd,uint256 underlyingAmount)',
])
const MAX_CALLS = 60
const MAX_MS = 180_000
const MAX_BYTES = 32 * 1024
const MIN_TICK_FREE_BYTES = 1024n * 1024n * 1024n
const diskFreeBytes = async (directory) => {
  const disk = await statfs(dirname(directory), { bigint: true })
  return disk.bavail * disk.bsize
}
const hex = (value) => {
  if (!/^0x[0-9a-f]+$/i.test(value ?? '')) throw Error('susde_episode_hex_invalid')
  return BigInt(value)
}
const host = (provider) => {
  try {
    const name = new URL(provider).hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '')
    if (!name) throw Error('invalid')
    return name
  } catch {
    throw Error('susde_episode_origin_invalid')
  }
}
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const header = (value) => {
  if (
    !HASH.test(value?.hash ?? '') ||
    !HASH.test(value?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/i.test(value?.number ?? '') ||
    !/^0x[0-9a-f]+$/i.test(value?.timestamp ?? '')
  )
    throw Error('susde_episode_header_invalid')
  return {
    number: value.number,
    hash: value.hash,
    parentHash: value.parentHash,
    timestamp: value.timestamp,
  }
}

export function validateEpisode(row, { issue, delivery, archive }) {
  const summary = archive.summary
  const final = archive.rows.at(-1)
  const payout = delivery.origins[0]
  const payoutBlock = payout.block
  const anchor = issue.anchor
  const durationSeconds = Math.floor((utc(delivery.deliveredAtUtc) - utc(anchor.blockAtUtc)) / 1000)
  if (
    !final ||
    summary.complete !== true ||
    summary.preDeliveryWithdrawLogs !== 0 ||
    final.toBlock !== summary.endBlock ||
    final.origins[0].endHeader.hash !== payoutBlock.hash ||
    summary.issueSequence !== issue.sequence ||
    summary.issueSha256 !== issue.sha256 ||
    summary.deliverySha256 !== delivery.sha256 ||
    delivery.issueSequence !== issue.sequence ||
    delivery.issueSha256 !== issue.sha256 ||
    delivery.minedDeliveryProven !== true ||
    delivery.episodeAttribution !== 'unresolved' ||
    payout.tx.hash !== delivery.transactionHash ||
    payout.receipt.status !== '0x1' ||
    row.study !== STUDY ||
    row.issueSequence !== issue.sequence ||
    row.issueSha256 !== issue.sha256 ||
    row.deliverySha256 !== delivery.sha256 ||
    row.archiveFinalSha256 !== final.sha256 ||
    row.archiveWindows !== archive.rows.length ||
    row.transactionHash !== delivery.transactionHash ||
    row.holder !== issue.holder ||
    row.sameEpisodeEvidenceLevel !== 'two_origin_rpc_log_attested' ||
    row.cryptographicAbsenceProven !== false ||
    row.forecastValidated !== false ||
    row.minedDeliveryProven !== true ||
    row.observedPendingToPayoutSeconds !== durationSeconds ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 0 ||
    !Array.isArray(row.origins) ||
    row.origins.length !== 2 ||
    row.sequence !== 1 ||
    row.previousSha256 !== null ||
    Buffer.byteLength(JSON.stringify(row)) > MAX_BYTES
  )
    throw Error('susde_episode_binding_invalid')
  utc(row.attestedAtUtc)
  const [a, b] = row.origins
  if (
    a.providerHost !== host(a.provider) ||
    b.providerHost !== host(b.provider) ||
    a.providerHost === b.providerHost
  )
    throw Error('susde_episode_origins_invalid')
  if (
    !equal(
      { ...a, provider: null, providerHost: null, finalized: null },
      { ...b, provider: null, providerHost: null, finalized: null },
    )
  )
    throw Error('susde_episode_origin_disagreement')
  for (const origin of row.origins) {
    if (
      origin.chainId !== '0x1' ||
      !equal(header(origin.anchorHeader), origin.anchorHeader) ||
      !equal(header(origin.payoutHeader), origin.payoutHeader) ||
      !equal(header(origin.finalized), origin.finalized)
    )
      throw Error('susde_episode_chain_invalid')
    if (
      origin.anchorHeader.hash !== anchor.blockHash ||
      hex(origin.anchorHeader.number) !== BigInt(anchor.blockNumber) ||
      origin.payoutHeader.hash !== payoutBlock.hash ||
      hex(origin.payoutHeader.number) !== hex(payoutBlock.number) ||
      hex(origin.finalized.number) < hex(payoutBlock.number) ||
      (hex(origin.finalized.number) === hex(payoutBlock.number) &&
        origin.finalized.hash !== payoutBlock.hash)
    )
      throw Error('susde_episode_pin_invalid')
    if (
      origin.tx?.hash !== delivery.transactionHash ||
      origin.tx.blockHash !== payoutBlock.hash ||
      origin.tx.from?.toLowerCase() !== issue.holder.toLowerCase() ||
      origin.tx.to?.toLowerCase() !== VAULT ||
      origin.tx.input?.toLowerCase() !== payout.tx.input ||
      hex(origin.tx.blockNumber) !== hex(payoutBlock.number) ||
      hex(origin.tx.transactionIndex) !== hex(payout.receipt.transactionIndex)
    )
      throw Error('susde_episode_tx_invalid')
    if (
      hex(origin.anchorNonce) !== hex(origin.tx.nonce) ||
      hex(origin.payoutNonce) !== hex(origin.tx.nonce) + 1n
    )
      throw Error('susde_episode_nonce_invalid')
    if (
      !/^0x[0-9a-f]{128}$/i.test(origin.postCooldown ?? '') ||
      BigInt(`0x${origin.postCooldown.slice(2, 66)}`) !== 0n ||
      BigInt(`0x${origin.postCooldown.slice(66)}`) !== 0n
    )
      throw Error('susde_episode_queue_not_clear')
  }
  return row
}

export function validateEpisodeRows(rows, context) {
  if (rows.length > 1) throw Error('susde_episode_duplicate')
  rows.forEach((row) => validateEpisode(row, context))
  return rows
}

export async function verifyEpisodes(
  out = OUT,
  issueOut = ISSUE_OUT,
  deliveryOut = DELIVERY_OUT,
  archiveOut = ARCHIVE_OUT,
  loadArchive = verifyContinuityArchive,
  issueSequence = ISSUE_SEQUENCE,
) {
  const [issues, deliveries, archive, rows] = await Promise.all([
    verifyIssues(issueOut),
    verifyDeliveries(deliveryOut, issueOut),
    loadArchive(archiveOut, issueOut, deliveryOut, undefined, issueSequence),
    readLedger(out),
  ])
  const issue = issues[issueSequence - 1]
  const delivery = deliveries.find((item) => item.issueSequence === issueSequence)
  if (rows.length && (!issue || !delivery)) throw Error('susde_episode_target_unavailable')
  return validateEpisodeRows(rows, { issue, delivery, archive })
}

export async function captureEpisode({ issue, delivery, peers, nowMs = Date.now }) {
  if (
    !Array.isArray(peers) ||
    peers.length !== 2 ||
    host(peers[0]?.provider) === host(peers[1]?.provider)
  )
    return { status: 'susde_episode_origins_invalid' }
  const budget = { calls: 0, deadline: nowMs() + MAX_MS }
  const request = async (peer, method, params) => {
    const remaining = budget.deadline - nowMs()
    if (++budget.calls > MAX_CALLS || remaining <= 0) throw Error('susde_episode_budget_exhausted')
    let timeout
    try {
      return await Promise.race([
        peer.request(method, params),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('susde_episode_budget_exhausted')), remaining)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  const capture = async (peer) => {
    const anchorPin = pin(issue.anchor.blockHash)
    const payoutPin = pin(delivery.origins[0].block.hash)
    const [
      chainId,
      anchorHeader,
      payoutHeader,
      finalized,
      anchorNonce,
      payoutNonce,
      tx,
      postCooldown,
    ] = await Promise.all([
      request(peer, 'eth_chainId', []),
      request(peer, 'eth_getBlockByNumber', [
        `0x${BigInt(issue.anchor.blockNumber).toString(16)}`,
        false,
      ]),
      request(peer, 'eth_getBlockByNumber', [delivery.origins[0].block.number, false]),
      request(peer, 'eth_getBlockByNumber', ['finalized', false]),
      request(peer, 'eth_getTransactionCount', [issue.holder, anchorPin]),
      request(peer, 'eth_getTransactionCount', [issue.holder, payoutPin]),
      request(peer, 'eth_getTransactionByHash', [delivery.transactionHash]),
      request(peer, 'eth_call', [
        {
          to: VAULT,
          data: encodeFunctionData({ abi: ABI, functionName: 'cooldowns', args: [issue.holder] }),
        },
        payoutPin,
      ]),
    ])
    return {
      provider: peer.provider,
      providerHost: host(peer.provider),
      chainId,
      anchorHeader: header(anchorHeader),
      payoutHeader: header(payoutHeader),
      finalized: header(finalized),
      anchorNonce,
      payoutNonce,
      tx: {
        hash: tx?.hash,
        blockHash: tx?.blockHash,
        blockNumber: tx?.blockNumber,
        transactionIndex: tx?.transactionIndex,
        from: tx?.from?.toLowerCase(),
        to: tx?.to?.toLowerCase(),
        input: tx?.input?.toLowerCase(),
        nonce: tx?.nonce,
      },
      postCooldown,
    }
  }
  try {
    const origins = await Promise.all(peers.map(capture))
    if (nowMs() > budget.deadline) return { status: 'susde_episode_budget_exhausted' }
    return { status: 'captured', origins }
  } catch (error) {
    return {
      status: /^susde_episode_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_episode_rpc_unavailable',
    }
  }
}

export function selectEpisodePeers(configured, providerHostPairs = []) {
  if (!Array.isArray(configured) || configured.length < 2 || configured.length > 8)
    throw Error('susde_episode_origins_invalid')
  const preferredHosts = providerHostPairs
    .map((pair) => pair.split('|'))
    .find(
      (pair) =>
        pair.length === 2 &&
        pair.every((name) => configured.some((peer) => host(peer.provider) === name)),
    )
  const ordered = preferredHosts
    ? [
        ...preferredHosts.map((name) => configured.find((peer) => host(peer.provider) === name)),
        ...configured,
      ]
    : configured
  const distinct = []
  const hosts = new Set()
  for (const peer of ordered) {
    const name = host(peer.provider)
    if (!hosts.has(name)) {
      distinct.push(peer)
      hosts.add(name)
    }
    if (distinct.length === 2) break
  }
  return distinct
}

export async function attestSameEpisode({
  urls,
  issueSequence = ISSUE_SEQUENCE,
  out = outputForIssue(issueSequence),
  issueOut = ISSUE_OUT,
  deliveryOut = DELIVERY_OUT,
  archiveOut = archiveForIssue(issueSequence),
  clients = publicRpcClients,
  loadArchive = verifyContinuityArchive,
  now = () => new Date(),
  nowMs = Date.now,
  freeBytes = diskFreeBytes,
} = {}) {
  const [issues, deliveries, archive] = await Promise.all([
    verifyIssues(issueOut),
    verifyDeliveries(deliveryOut, issueOut),
    loadArchive(archiveOut, issueOut, deliveryOut, undefined, issueSequence),
  ])
  const issue = issues[issueSequence - 1]
  const delivery = deliveries.find((item) => item.issueSequence === issueSequence)
  if (!issue || !delivery || delivery.issueSha256 !== issue.sha256)
    return { status: 'susde_episode_target_unavailable' }
  if (!archive.summary.complete)
    return { status: 'susde_episode_archive_incomplete', summary: archive.summary }
  if (archive.summary.preDeliveryWithdrawLogs !== 0)
    return { status: 'susde_episode_prior_withdraw_observed' }
  if (
    archive.summary.issueSha256 !== issue.sha256 ||
    archive.summary.deliverySha256 !== delivery.sha256 ||
    archive.rows.at(-1)?.toBlock !== archive.summary.endBlock ||
    archive.rows.at(-1)?.origins[0].endHeader.hash !== delivery.origins[0].block.hash
  )
    return { status: 'susde_episode_archive_binding_invalid' }
  const existing = await verifyEpisodes(
    out,
    issueOut,
    deliveryOut,
    archiveOut,
    loadArchive,
    issueSequence,
  )
  if (existing.length) return { status: 'susde_episode_already_attested' }
  if ((await freeBytes(out)) < MIN_TICK_FREE_BYTES) return { status: 'susde_episode_disk_reserve' }
  const distinct = selectEpisodePeers(clients(urls), archive.summary.providerHostPairs)
  const capture = await captureEpisode({ issue, delivery, peers: distinct, nowMs })
  if (capture.status !== 'captured') return capture
  const body = {
    study: STUDY,
    sequence: 1,
    previousSha256: null,
    issueSequence,
    issueSha256: issue.sha256,
    deliverySha256: delivery.sha256,
    archiveFinalSha256: archive.rows.at(-1).sha256,
    archiveWindows: archive.rows.length,
    transactionHash: delivery.transactionHash,
    holder: issue.holder,
    attestedAtUtc: now().toISOString(),
    minedDeliveryProven: true,
    sameEpisodeEvidenceLevel: 'two_origin_rpc_log_attested',
    cryptographicAbsenceProven: false,
    forecastValidated: false,
    observedPendingToPayoutSeconds: Math.floor(
      (utc(delivery.deliveredAtUtc) - utc(issue.anchor.blockAtUtc)) / 1000,
    ),
    origins: capture.origins,
  }
  try {
    validateEpisode(body, { issue, delivery, archive })
  } catch (error) {
    return {
      status: /^susde_episode_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_episode_evidence_invalid',
    }
  }
  const row = seal(body)
  if ((await freeBytes(out)) < MIN_TICK_FREE_BYTES) return { status: 'susde_episode_disk_reserve' }
  await appendLedger(out, row, (directory) =>
    verifyEpisodes(directory, issueOut, deliveryOut, archiveOut, loadArchive, issueSequence),
  )
  return { status: 'attested', sequence: row.sequence, sha256: row.sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const issueSequence = process.argv[3] === undefined ? ISSUE_SEQUENCE : Number(process.argv[3])
    if (!Number.isInteger(issueSequence) || issueSequence < 1)
      throw Error('susde_episode_issue_unknown')
    if (process.argv[2] === '--verify')
      console.log(
        JSON.stringify({
          verified: (
            await verifyEpisodes(
              outputForIssue(issueSequence),
              ISSUE_OUT,
              DELIVERY_OUT,
              archiveForIssue(issueSequence),
              verifyContinuityArchive,
              issueSequence,
            )
          ).length,
        }),
      )
    else if (process.argv[2] === '--attest') {
      const result = await attestSameEpisode({
        issueSequence,
        urls: configuredPublicRpcUrls(readEnv()),
      })
      console.log(JSON.stringify(result))
      if (result.status !== 'attested' && result.status !== 'susde_episode_already_attested')
        process.exitCode = 1
    } else throw Error('susde_episode_usage')
  } catch (error) {
    console.error(
      /^susde_episode_[a-z0-9_]+$/.test(error?.message ?? '')
        ? error.message
        : 'susde_episode_failed',
    )
    process.exitCode = 1
  }
}
