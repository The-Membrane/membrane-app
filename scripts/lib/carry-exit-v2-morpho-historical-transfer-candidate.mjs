// A bounded, explicitly chosen historical Transfer window discovers addresses.
// It is not an exhaustive holder scan or evidence that a holder can exit now.
import { createHash } from 'node:crypto'

import { readPinned } from './carry-exit-v2-morpho-api-candidate.mjs'
import { freezeMorphoQLadder } from './carry-exit-v2-morpho-issuer-prep.mjs'
import { resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'

export const MORPHO_HISTORICAL_TRANSFER_SCHEMA =
  'carry_exit_v2_morpho_historical_transfer_candidate_v1'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const WORD = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const MAX_WINDOWS = 8
const MAX_BLOCKS = 64n
const sha = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    .digest('hex')
const fail = () => {
  throw Error('morpho_historical_transfer_candidate_invalid')
}
const hex = (value) => `0x${BigInt(value).toString(16)}`
const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const host = (url) => {
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail()
    return parsed.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '')
  } catch {
    fail()
  }
}
const canonicalLog = (row, vault, window) => {
  if (
    !same(row?.address, vault) ||
    !same(row?.topics?.[0], TRANSFER) ||
    row.topics?.length !== 3 ||
    !WORD.test(row.topics[1] ?? '') ||
    !WORD.test(row.topics[2] ?? '') ||
    !WORD.test(row.data ?? '') ||
    !HASH.test(row.blockHash ?? '') ||
    !HASH.test(row.transactionHash ?? '') ||
    row.removed === true
  )
    fail()
  let block, txIndex, logIndex
  try {
    block = BigInt(row.blockNumber)
    txIndex = BigInt(row.transactionIndex)
    logIndex = BigInt(row.logIndex)
  } catch {
    fail()
  }
  if (
    block < BigInt(window.fromBlock) ||
    block > BigInt(window.toBlock) ||
    txIndex < 0n ||
    logIndex < 0n
  )
    fail()
  return {
    address: row.address.toLowerCase(),
    blockNumber: block.toString(),
    blockHash: row.blockHash.toLowerCase(),
    transactionHash: row.transactionHash.toLowerCase(),
    transactionIndex: txIndex.toString(),
    logIndex: logIndex.toString(),
    topics: row.topics.map((x) => x.toLowerCase()),
    data: row.data.toLowerCase(),
  }
}
const orderLogs = (rows) =>
  [...rows].sort((a, b) =>
    BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? -1
      : BigInt(a.blockNumber) > BigInt(b.blockNumber)
        ? 1
        : BigInt(a.transactionIndex) < BigInt(b.transactionIndex)
          ? -1
          : BigInt(a.transactionIndex) > BigInt(b.transactionIndex)
            ? 1
            : BigInt(a.logIndex) < BigInt(b.logIndex)
              ? -1
              : BigInt(a.logIndex) > BigInt(b.logIndex)
                ? 1
                : 0,
  )
const header = (raw, number) => {
  if (
    !HASH.test(raw?.hash ?? '') ||
    !HASH.test(raw?.parentHash ?? '') ||
    raw.number !== hex(number)
  )
    fail()
  return {
    number: String(number),
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
  }
}
const receipt = (raw, log) => {
  if (
    raw?.status !== '0x1' ||
    !same(raw.transactionHash, log.transactionHash) ||
    !same(raw.blockHash, log.blockHash) ||
    BigInt(raw.blockNumber ?? -1) !== BigInt(log.blockNumber)
  )
    fail()
  const matching = raw.logs?.filter((row) => BigInt(row.logIndex ?? -1) === BigInt(log.logIndex))
  if (matching?.length !== 1) fail()
  const exact = canonicalLog(matching[0], log.address, {
    fromBlock: log.blockNumber,
    toBlock: log.blockNumber,
  })
  if (JSON.stringify(exact) !== JSON.stringify(log)) fail()
  return {
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    status: '0x1',
    matchingLog: exact,
  }
}
const windowList = (windows, baselineBlock) => {
  if (!Array.isArray(windows) || !windows.length || windows.length > MAX_WINDOWS) fail()
  let previous = 0n
  return windows.map((window) => {
    if (!DECIMAL.test(window?.fromBlock ?? '') || !DECIMAL.test(window?.toBlock ?? '')) fail()
    const from = BigInt(window.fromBlock),
      to = BigInt(window.toBlock)
    if (
      from < 1n ||
      to < from ||
      to - from + 1n > MAX_BLOCKS ||
      to >= BigInt(baselineBlock) ||
      from <= previous
    )
      fail()
    previous = to
    return { fromBlock: from.toString(), toBlock: to.toString() }
  })
}
const recipient = (log) => `0x${log.topics[2].slice(-40)}`
const candidates = (windows) => {
  const ranked = windows
    .flatMap((window) => window.logs)
    .filter((log) => BigInt(log.data) > 0n && recipient(log) !== `0x${'0'.repeat(40)}`)
    .sort((a, b) =>
      BigInt(a.data) > BigInt(b.data)
        ? -1
        : BigInt(a.data) < BigInt(b.data)
          ? 1
          : BigInt(a.blockNumber) > BigInt(b.blockNumber)
            ? -1
            : BigInt(a.blockNumber) < BigInt(b.blockNumber)
              ? 1
              : BigInt(a.logIndex) > BigInt(b.logIndex)
                ? -1
                : 1,
    )
  const seen = new Set()
  return ranked
    .filter((log) => {
      const owner = recipient(log)
      if (seen.has(owner)) return false
      seen.add(owner)
      return true
    })
    .slice(0, 8)
}
const sourceProof = async (request, log) => {
  const block = header(
    await request('eth_getBlockByNumber', [hex(log.blockNumber), false]),
    log.blockNumber,
  )
  if (block.hash !== log.blockHash) fail()
  const tx = receipt(await request('eth_getTransactionReceipt', [log.transactionHash]), log)
  return { block, receipt: tx }
}

/** All queried windows and every returned log are sealed; overflow fails closed. */
export async function discoverMorphoHistoricalTransferCandidate({
  baseline,
  primary,
  secondary,
  windows,
  pinnedRead = readPinned,
}) {
  const route = resolveCarryExitV2Route(baseline?.routeKey, baseline?.destination, baseline?.asset)
  if (
    route.kind !== 'morpho' ||
    baseline.canonicalityEvidenceDoc?.schema !== 'carry_exit_v2_headers_v1' ||
    baseline.canonicalityEvidenceDoc.targetHeader?.hash !== baseline.targetHash ||
    baseline.canonicalityEvidenceDoc.targetHeader?.number !== baseline.targetBlock ||
    !HASH.test(baseline.targetHash ?? '') ||
    !HASH.test(baseline.targetParentHash ?? '') ||
    !DECIMAL.test(baseline.targetBlock ?? '') ||
    !DECIMAL.test(baseline.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(baseline.assetDecimals) ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    host(primary.provider) === host(secondary.provider)
  )
    fail()
  const selectedWindows = windowList(windows, baseline.targetBlock)
  const hostCommitments = [sha(host(primary.provider)), sha(host(secondary.provider))]
  const discovered = []
  let count = 0
  for (const window of selectedWindows) {
    const filter = {
      address: baseline.destination,
      topics: [TRANSFER],
      fromBlock: hex(window.fromBlock),
      toBlock: hex(window.toBlock),
    }
    const [firstRaw, secondRaw] = await Promise.all([
      primary.request('eth_getLogs', [filter]),
      secondary.request('eth_getLogs', [filter]),
    ])
    if (
      !Array.isArray(firstRaw) ||
      !Array.isArray(secondRaw) ||
      (count += firstRaw.length) > 128 ||
      secondRaw.length !== firstRaw.length
    )
      fail()
    const first = orderLogs(firstRaw.map((row) => canonicalLog(row, baseline.destination, window)))
    const second = orderLogs(
      secondRaw.map((row) => canonicalLog(row, baseline.destination, window)),
    )
    if (
      sha(first) !== sha(second) ||
      new Set(first.map((row) => `${row.transactionHash}:${row.logIndex}`)).size !== first.length
    )
      fail()
    const boundary = []
    for (const number of [window.fromBlock, window.toBlock]) {
      const [a, b] = await Promise.all([
        primary.request('eth_getBlockByNumber', [hex(number), false]),
        secondary.request('eth_getBlockByNumber', [hex(number), false]),
      ])
      const one = header(a, number),
        two = header(b, number)
      if (sha(one) !== sha(two)) fail()
      boundary.push(one)
    }
    if (
      BigInt(window.toBlock) === BigInt(baseline.targetBlock) - 1n &&
      boundary[1].hash !== baseline.targetParentHash
    )
      fail()
    discovered.push({ ...window, boundary, logs: first, logsSha256: sha(first) })
  }
  const screenedCandidates = []
  let selected = null
  for (const [rank, log] of candidates(discovered).entries()) {
    const owner = recipient(log)
    const [firstSource, secondSource] = await Promise.all([
      sourceProof(primary.request.bind(primary), log),
      sourceProof(secondary.request.bind(secondary), log),
    ])
    if (sha(firstSource) !== sha(secondSource)) fail()
    const row = {
      rank,
      holderCommitment: sha(`${baseline.destination}:${owner}`),
      sourceLog: log,
      sourceProof: { hostCommitments, first: firstSource, second: secondSource },
      status: 'rpc_unavailable',
    }
    row.sourceProofSha256 = sha(row.sourceProof)
    screenedCandidates.push(row)
    try {
      const first = await pinnedRead(primary.request.bind(primary), baseline, owner)
      const second = await pinnedRead(secondary.request.bind(secondary), baseline, owner)
      if (sha(first) !== sha(second)) {
        row.status = 'rpc_disagreement'
        continue
      }
      row.status = first.status
      row.pinnedProof = {
        block: baseline.targetBlock,
        hash: baseline.targetHash,
        parentHash: baseline.targetParentHash,
        hostCommitments,
        holderCommitment: row.holderCommitment,
        first,
        second,
      }
      row.pinnedProofSha256 = sha(row.pinnedProof)
      if (first.status !== 'eligible_holder') continue
      row.sharesRaw = first.sharesRaw
      row.claimRaw = first.claimRaw
      if (!selected || BigInt(first.claimRaw) > BigInt(selected.claimRaw))
        selected = { holder: owner, ...row }
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  const evidenceDoc = {
    schema: MORPHO_HISTORICAL_TRANSFER_SCHEMA,
    chainId: '1',
    routeKey: baseline.routeKey,
    destination: baseline.destination,
    asset: baseline.asset,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    parentHash: baseline.targetParentHash,
    baselineState: {
      totalAssetsRaw: baseline.totalAssetsRaw,
      assetDecimals: baseline.assetDecimals,
    },
    discovery: {
      source: 'two_host_historical_erc20_transfer_windows',
      scope: 'non_exhaustive_explicit_historical_windows',
      exhaustiveHolderSearch: false,
      historicalHolderProof: false,
      candidateLimit: 8,
      hostCommitments,
      windows: discovered,
      attempted: screenedCandidates.length,
    },
    screenedCandidates,
    selectionRule:
      'largest_two_host_pinned_claim_among_receipt_verified_transfer_recipients_tie_by_transfer_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedSharesRaw: selected?.sharesRaw ?? null,
    selectedClaimRaw: selected?.claimRaw ?? null,
    unavailableReason: selected ? null : 'no_two_host_verified_transfer_recipient',
    ladder: freezeMorphoQLadder({
      totalAssetsRaw: baseline.totalAssetsRaw,
      selectedClaimRaw: selected?.claimRaw ?? null,
    }),
  }
  validateMorphoHistoricalTransferCandidateEvidence(evidenceDoc, hostCommitments)
  return { holder: selected?.holder ?? null, evidenceDoc, digest: sha(evidenceDoc) }
}

/** Replay checks recorded proof shape and agreement; RPC authenticity is checked at capture. */
export function validateMorphoHistoricalTransferCandidateEvidence(doc, expectedHostCommitments) {
  const discovery = doc?.discovery
  let route
  try {
    route = resolveCarryExitV2Route(doc?.routeKey, doc?.destination, doc?.asset)
  } catch {
    fail()
  }
  if (
    doc?.schema !== MORPHO_HISTORICAL_TRANSFER_SCHEMA ||
    route.kind !== 'morpho' ||
    doc.chainId !== '1' ||
    !ADDRESS.test(doc.destination ?? '') ||
    !ADDRESS.test(doc.asset ?? '') ||
    !HASH.test(doc.baselineHash ?? '') ||
    !HASH.test(doc.parentHash ?? '') ||
    !DECIMAL.test(doc.baselineBlock ?? '') ||
    !DECIMAL.test(doc.baselineState?.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(doc.baselineState?.assetDecimals) ||
    discovery?.source !== 'two_host_historical_erc20_transfer_windows' ||
    discovery.scope !== 'non_exhaustive_explicit_historical_windows' ||
    discovery.exhaustiveHolderSearch !== false ||
    discovery.historicalHolderProof !== false ||
    discovery.candidateLimit !== 8 ||
    !Array.isArray(discovery.hostCommitments) ||
    discovery.hostCommitments.length !== 2 ||
    discovery.hostCommitments.some((item) => !/^[0-9a-f]{64}$/.test(item)) ||
    discovery.hostCommitments[0] === discovery.hostCommitments[1] ||
    (expectedHostCommitments && sha(expectedHostCommitments) !== sha(discovery.hostCommitments)) ||
    !Array.isArray(discovery.windows) ||
    !Array.isArray(doc.screenedCandidates) ||
    discovery.attempted !== doc.screenedCandidates.length ||
    doc.selectionRule !==
      'largest_two_host_pinned_claim_among_receipt_verified_transfer_recipients_tie_by_transfer_rank'
  )
    fail()
  windowList(discovery.windows, doc.baselineBlock)
  let count = 0
  for (const window of discovery.windows) {
    if (
      !Array.isArray(window.logs) ||
      (count += window.logs.length) > 128 ||
      window.logsSha256 !== sha(window.logs) ||
      sha(window.logs) !==
        sha(
          orderLogs(
            window.logs.map((log) =>
              canonicalLog(
                {
                  ...log,
                  blockNumber: hex(log.blockNumber),
                  transactionIndex: hex(log.transactionIndex),
                  logIndex: hex(log.logIndex),
                },
                doc.destination,
                window,
              ),
            ),
          ),
        ) ||
      new Set(window.logs.map((row) => `${row.transactionHash}:${row.logIndex}`)).size !==
        window.logs.length ||
      !Array.isArray(window.boundary) ||
      window.boundary.length !== 2
    )
      fail()
    for (const [index, number] of [window.fromBlock, window.toBlock].entries()) {
      if (
        sha(window.boundary[index]) !==
        sha(
          header({ ...window.boundary[index], number: hex(window.boundary[index].number) }, number),
        )
      )
        fail()
    }
    if (
      BigInt(window.toBlock) === BigInt(doc.baselineBlock) - 1n &&
      window.boundary[1].hash !== doc.parentHash
    )
      fail()
  }
  const ranked = candidates(discovery.windows)
  if (ranked.length !== doc.screenedCandidates.length) fail()
  let selected = null
  for (const [rank, row] of doc.screenedCandidates.entries()) {
    const log = ranked[rank],
      proof = row.sourceProof
    if (
      row.rank !== rank ||
      sha(row.sourceLog) !== sha(log) ||
      row.holderCommitment !== sha(`${doc.destination}:${recipient(log)}`) ||
      sha(proof?.hostCommitments) !== sha(discovery.hostCommitments) ||
      sha(proof?.first) !== sha(proof?.second) ||
      row.sourceProofSha256 !== sha(proof) ||
      proof.first?.block?.number !== log.blockNumber ||
      proof.first.block.hash !== log.blockHash ||
      sha(proof.first.block) !==
        sha(
          header({ ...proof.first.block, number: hex(proof.first.block.number) }, log.blockNumber),
        ) ||
      proof.first.receipt?.status !== '0x1' ||
      proof.first.receipt.transactionHash !== log.transactionHash ||
      proof.first.receipt.blockHash !== log.blockHash ||
      proof.first.receipt.blockNumber !== log.blockNumber ||
      sha(proof.first.receipt.matchingLog) !== sha(log) ||
      ![
        'rpc_unavailable',
        'rpc_disagreement',
        'contract_holder',
        'no_pinned_shares',
        'no_pinned_claim',
        'eligible_holder',
      ].includes(row.status)
    )
      fail()
    if (row.status === 'rpc_unavailable' || row.status === 'rpc_disagreement') {
      if (
        row.pinnedProof !== undefined ||
        row.pinnedProofSha256 !== undefined ||
        row.sharesRaw !== undefined ||
        row.claimRaw !== undefined
      )
        fail()
      continue
    }
    const pinned = row.pinnedProof
    if (
      pinned?.block !== doc.baselineBlock ||
      pinned.hash !== doc.baselineHash ||
      pinned.parentHash !== doc.parentHash ||
      pinned.holderCommitment !== row.holderCommitment ||
      sha(pinned.hostCommitments) !== sha(discovery.hostCommitments) ||
      sha(pinned.first) !== sha(pinned.second) ||
      pinned.first?.status !== row.status ||
      row.pinnedProofSha256 !== sha(pinned)
    )
      fail()
    if (row.status === 'eligible_holder') {
      if (
        !DECIMAL.test(row.sharesRaw ?? '') ||
        !DECIMAL.test(row.claimRaw ?? '') ||
        BigInt(row.sharesRaw) === 0n ||
        BigInt(row.claimRaw) === 0n ||
        pinned.first.sharesRaw !== row.sharesRaw ||
        pinned.first.claimRaw !== row.claimRaw
      )
        fail()
      if (!selected || BigInt(row.claimRaw) > BigInt(selected.claimRaw)) selected = row
    } else if (row.sharesRaw !== undefined || row.claimRaw !== undefined) fail()
  }
  if (
    doc.selectedHolderCommitment !== (selected?.holderCommitment ?? null) ||
    doc.selectedSharesRaw !== (selected?.sharesRaw ?? null) ||
    doc.selectedClaimRaw !== (selected?.claimRaw ?? null) ||
    doc.unavailableReason !== (selected ? null : 'no_two_host_verified_transfer_recipient') ||
    sha(doc.ladder) !==
      sha(
        freezeMorphoQLadder({
          totalAssetsRaw: doc.baselineState.totalAssetsRaw,
          selectedClaimRaw: selected?.claimRaw ?? null,
        }),
      )
  )
    fail()
  return doc
}

/** Re-fetch a sealed source from two origins; structural replay alone cannot authenticate it. */
export async function auditMorphoHistoricalTransferCandidateLive(doc, primary, secondary) {
  validateMorphoHistoricalTransferCandidateEvidence(doc)
  if (
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    host(primary.provider) === host(secondary.provider)
  )
    fail()
  for (const window of doc.discovery.windows) {
    const filter = {
      address: doc.destination,
      topics: [TRANSFER],
      fromBlock: hex(window.fromBlock),
      toBlock: hex(window.toBlock),
    }
    for (const origin of [primary, secondary]) {
      const raw = await origin.request('eth_getLogs', [filter])
      if (!Array.isArray(raw) || raw.length !== window.logs.length) fail()
      const logs = orderLogs(raw.map((row) => canonicalLog(row, doc.destination, window)))
      if (sha(logs) !== window.logsSha256) fail()
      for (const [index, number] of [window.fromBlock, window.toBlock].entries()) {
        const observed = header(
          await origin.request('eth_getBlockByNumber', [hex(number), false]),
          number,
        )
        if (sha(observed) !== sha(window.boundary[index])) fail()
      }
    }
  }
  for (const row of doc.screenedCandidates)
    for (const origin of [primary, secondary]) {
      const observed = await sourceProof(origin.request.bind(origin), row.sourceLog)
      if (sha(observed) !== sha(row.sourceProof.first)) fail()
    }
  return {
    schema: 'carry_exit_v2_morpho_historical_transfer_live_audit_v1',
    candidateDigest: sha(doc),
    auditHostCommitments: [sha(host(primary.provider)), sha(host(secondary.provider))],
    verifiedWindows: doc.discovery.windows.length,
    verifiedCandidates: doc.screenedCandidates.length,
  }
}
