// Morpho API positions are an untrusted address shortlist, never historical
// holder evidence. Eligibility comes only from two pinned, agreeing RPC hosts.
import { createHash } from 'node:crypto'

import { freezeMorphoQLadder } from './carry-exit-v2-morpho-issuer-prep.mjs'
import { resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'

const ENDPOINT = 'https://api.morpho.org/graphql'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const PAGE_SIZE = 10
const MAX_BYTES = 32_768
const TIMEOUT_MS = 8_000
const sha = (value) => createHash('sha256').update(value).digest('hex')
const pinned = (hash) => ({ blockHash: hash, requireCanonical: true })
const word = (value) => value.toString(16).padStart(64, '0')
const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const host = (url) => {
  const parsed = new URL(url)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('morpho_api_rpc_hosts_invalid')
  return parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}
const quantity = (value) => {
  if (!WORD.test(value ?? '')) throw Error('morpho_api_rpc_state_invalid')
  return BigInt(value)
}
const query = `query MorphoVaultV2CandidatePage($address: String!) {
  vaultV2ByAddress(address: $address, chainId: 1) {
    address
    totalSupply
    positions(first: 10, skip: 0) {
      items { user { address } shares }
      pageInfo { count countTotal skip limit }
    }
  }
}`

export async function fetchMorphoV2CandidatePage(
  address,
  { fetcher = fetch, now = () => new Date() } = {},
) {
  if (!ADDRESS.test(address ?? '') || typeof fetcher !== 'function')
    throw Error('morpho_api_input_invalid')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response
  let bytes = 0
  let body = ''
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables: { address } }),
      signal: controller.signal,
    })
    if (
      !response?.ok ||
      !response.body ||
      Number(response.headers?.get('content-length') ?? 0) > MAX_BYTES
    )
      throw Error('morpho_api_unavailable')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_BYTES) throw Error('morpho_api_response_too_large')
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
  } catch (error) {
    if (error?.message === 'morpho_api_response_too_large') throw error
    throw Error('morpho_api_unavailable')
  } finally {
    clearTimeout(timeout)
  }
  let decoded
  try {
    decoded = JSON.parse(body)
  } catch {
    throw Error('morpho_api_response_invalid')
  }
  const vault = decoded?.data?.vaultV2ByAddress
  const positions = vault?.positions
  const info = positions?.pageInfo
  if (
    decoded.errors != null ||
    !same(vault?.address, address) ||
    !DECIMAL.test(vault?.totalSupply ?? '') ||
    !Array.isArray(positions?.items) ||
    positions.items.length > PAGE_SIZE ||
    !Number.isSafeInteger(info?.count) ||
    !Number.isSafeInteger(info?.countTotal) ||
    info.count !== positions.items.length ||
    info.countTotal < info.count ||
    info.skip !== 0 ||
    info.limit !== PAGE_SIZE ||
    positions.items.some(
      (row) =>
        !ADDRESS.test(row?.user?.address?.toLowerCase() ?? '') || !DECIMAL.test(row?.shares ?? ''),
    )
  )
    throw Error('morpho_api_response_invalid')
  return {
    fetchedAtUtc: now().toISOString(),
    querySha256: sha(query),
    totalSupplyRaw: vault.totalSupply,
    pageInfo: { count: info.count, countTotal: info.countTotal, skip: 0, limit: PAGE_SIZE },
    items: positions.items.map((row) => ({
      address: row.user.address.toLowerCase(),
      apiSharesRaw: row.shares,
    })),
  }
}

export async function readPinned(request, baseline, holder) {
  const pin = pinned(baseline.targetHash)
  const block = await request('eth_getBlockByNumber', [
    `0x${BigInt(baseline.targetBlock).toString(16)}`,
    false,
  ])
  const chainId = await request('eth_chainId', [])
  const vaultCode = await request('eth_getCode', [baseline.destination, pin])
  const asset = await request('eth_call', [{ to: baseline.destination, data: '0x38d52e0f' }, pin])
  const totalAssets = await request('eth_call', [
    { to: baseline.destination, data: '0x01e1d114' },
    pin,
  ])
  if (
    chainId !== '0x1' ||
    block?.hash !== baseline.targetHash ||
    block?.parentHash !== baseline.targetParentHash ||
    !/^0x(?:[0-9a-f]{2})+$/.test(vaultCode ?? '') ||
    !WORD.test(asset ?? '') ||
    !same(`0x${asset.slice(-40)}`, baseline.asset) ||
    quantity(totalAssets).toString() !== baseline.totalAssetsRaw
  )
    throw Error('morpho_api_baseline_disagreement')
  const code = await request('eth_getCode', [holder, pin])
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code))
    throw Error('morpho_api_rpc_state_invalid')
  if (code.toLowerCase() !== '0x') return { status: 'contract_holder' }
  const shares = quantity(
    await request('eth_call', [
      { to: baseline.destination, data: `0x70a08231${holder.slice(2).padStart(64, '0')}` },
      pin,
    ]),
  )
  if (shares === 0n) return { status: 'no_pinned_shares' }
  const claim = quantity(
    await request('eth_call', [
      { to: baseline.destination, data: `0x4cdad506${word(shares)}` },
      pin,
    ]),
  )
  return claim === 0n
    ? { status: 'no_pinned_claim' }
    : { status: 'eligible_holder', sharesRaw: shares.toString(), claimRaw: claim.toString() }
}

/** One API page, at most eight candidates, and two independent pinned witnesses. */
export async function discoverMorphoApiIssuerCandidate({
  baseline,
  primary,
  secondary,
  candidateLimit = 8,
  fetchPage = fetchMorphoV2CandidatePage,
  now = () => new Date(),
}) {
  const route = resolveCarryExitV2Route(baseline?.routeKey, baseline?.destination, baseline?.asset)
  if (
    route.kind !== 'morpho' ||
    baseline.canonicalityEvidenceDoc?.schema !== 'carry_exit_v2_headers_v1' ||
    baseline.canonicalityEvidenceDoc.targetHeader?.hash !== baseline.targetHash ||
    baseline.canonicalityEvidenceDoc.targetHeader?.number !== baseline.targetBlock ||
    !HASH.test(baseline.targetHash ?? '') ||
    !DECIMAL.test(baseline.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 8 ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    host(primary.provider) === host(secondary.provider)
  )
    throw Error('morpho_api_input_invalid')
  const page = await fetchPage(baseline.destination, { now })
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > PAGE_SIZE ||
    page.pageInfo?.count !== page.items.length ||
    page.pageInfo?.limit !== PAGE_SIZE ||
    page.pageInfo?.skip !== 0 ||
    !DECIMAL.test(page.totalSupplyRaw ?? '') ||
    !Number.isSafeInteger(page.pageInfo?.countTotal) ||
    page.pageInfo.countTotal < page.items.length ||
    !Number.isFinite(Date.parse(page.fetchedAtUtc ?? '')) ||
    !/^[0-9a-f]{64}$/.test(page.querySha256 ?? '') ||
    page.items.some(
      (item) => !ADDRESS.test(item?.address ?? '') || !DECIMAL.test(item?.apiSharesRaw ?? ''),
    )
  )
    throw Error('morpho_api_response_invalid')
  const unique = [...new Map(page.items.map((item) => [item.address, item])).values()]
  const screenedCandidates = []
  let selected = null
  for (const [rank, item] of unique.slice(0, candidateLimit).entries()) {
    const holderCommitment = sha(`${baseline.destination}:${item.address}`)
    const row = { holderCommitment, apiPageRank: rank, status: 'rpc_unavailable' }
    screenedCandidates.push(row)
    try {
      const first = await readPinned(primary.request.bind(primary), baseline, item.address)
      const second = await readPinned(secondary.request.bind(secondary), baseline, item.address)
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        row.status = 'rpc_disagreement'
        continue
      }
      row.status = first.status
      row.pinnedProof = {
        block: baseline.targetBlock,
        hash: baseline.targetHash,
        hostCommitments: [sha(host(primary.provider)), sha(host(secondary.provider))],
        holderCommitment,
        first,
        second,
      }
      row.pinnedProofSha256 = sha(JSON.stringify(row.pinnedProof))
      if (first.status !== 'eligible_holder') continue
      row.sharesRaw = first.sharesRaw
      row.claimRaw = first.claimRaw
      if (!selected || BigInt(first.claimRaw) > BigInt(selected.claimRaw))
        selected = { holder: item.address, holderCommitment, ...first }
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  const ladder = freezeMorphoQLadder({
    totalAssetsRaw: baseline.totalAssetsRaw,
    selectedClaimRaw: selected?.claimRaw ?? null,
  })
  const evidenceDoc = {
    schema: 'carry_exit_v2_morpho_api_candidate_v1',
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
      source: ENDPOINT,
      querySha256: page.querySha256,
      fetchedAtUtc: page.fetchedAtUtc,
      apiTotalSupplyRaw: page.totalSupplyRaw,
      pageInfo: page.pageInfo,
      candidateCommitments: unique.map((item) => sha(`${baseline.destination}:${item.address}`)),
      attempted: screenedCandidates.length,
      candidateLimit,
      exhaustiveHolderSearch: false,
      historicalHolderProof: false,
      scope: 'untrusted_live_api_first_page_address_discovery',
    },
    screenedCandidates,
    selectionRule: 'largest_two_host_pinned_claim_among_first_page_eoas_tie_by_api_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedSharesRaw: selected?.sharesRaw ?? null,
    selectedClaimRaw: selected?.claimRaw ?? null,
    unavailableReason: selected ? null : 'no_two_host_verified_first_page_holder',
    ladder,
  }
  return { holder: selected?.holder ?? null, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}

/** Offline structural verifier; it checks recorded agreement, not RPC honesty. */
export function validateMorphoApiCandidateEvidence(doc) {
  const discovery = doc?.discovery
  if (
    doc?.schema !== 'carry_exit_v2_morpho_api_candidate_v1' ||
    doc.chainId !== '1' ||
    !HASH.test(doc.baselineHash ?? '') ||
    discovery?.source !== ENDPOINT ||
    discovery.querySha256 !== sha(query) ||
    !Number.isFinite(Date.parse(discovery.fetchedAtUtc ?? '')) ||
    discovery.scope !== 'untrusted_live_api_first_page_address_discovery' ||
    discovery.exhaustiveHolderSearch !== false ||
    discovery.historicalHolderProof !== false ||
    !DECIMAL.test(discovery.apiTotalSupplyRaw ?? '') ||
    discovery.pageInfo?.skip !== 0 ||
    discovery.pageInfo?.limit !== PAGE_SIZE ||
    !Number.isSafeInteger(discovery.pageInfo.count) ||
    !Number.isSafeInteger(discovery.pageInfo.countTotal) ||
    discovery.pageInfo.countTotal < discovery.pageInfo.count ||
    !Array.isArray(discovery.candidateCommitments) ||
    discovery.candidateCommitments.length > discovery.pageInfo.count ||
    discovery.candidateCommitments.some((value) => !/^[0-9a-f]{64}$/.test(value)) ||
    !Array.isArray(doc.screenedCandidates) ||
    discovery.attempted !== doc.screenedCandidates.length ||
    !Number.isSafeInteger(discovery.candidateLimit) ||
    discovery.candidateLimit < 1 ||
    discovery.candidateLimit > 8 ||
    doc.screenedCandidates.length !==
      Math.min(discovery.candidateCommitments.length, discovery.candidateLimit) ||
    new Set(discovery.candidateCommitments).size !== discovery.candidateCommitments.length ||
    !DECIMAL.test(doc.baselineState?.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(doc.baselineState?.assetDecimals) ||
    doc.selectionRule !== 'largest_two_host_pinned_claim_among_first_page_eoas_tie_by_api_rank'
  )
    throw Error('morpho_api_candidate_evidence_invalid')
  const eligible = []
  for (const [rank, row] of doc.screenedCandidates.entries()) {
    if (row.apiPageRank !== rank || row.holderCommitment !== discovery.candidateCommitments[rank])
      throw Error('morpho_api_candidate_evidence_invalid')
    if (
      ![
        'rpc_unavailable',
        'rpc_disagreement',
        'contract_holder',
        'no_pinned_shares',
        'no_pinned_claim',
        'eligible_holder',
      ].includes(row.status)
    )
      throw Error('morpho_api_candidate_evidence_invalid')
    if (row.status === 'rpc_unavailable' || row.status === 'rpc_disagreement') {
      if (
        row.pinnedProof !== undefined ||
        row.pinnedProofSha256 !== undefined ||
        row.sharesRaw !== undefined ||
        row.claimRaw !== undefined
      )
        throw Error('morpho_api_candidate_evidence_invalid')
      continue
    }
    {
      const proof = row.pinnedProof
      if (
        !proof ||
        proof.block !== doc.baselineBlock ||
        proof.hash !== doc.baselineHash ||
        proof.holderCommitment !== row.holderCommitment ||
        !Array.isArray(proof.hostCommitments) ||
        proof.hostCommitments.length !== 2 ||
        proof.hostCommitments[0] === proof.hostCommitments[1] ||
        proof.hostCommitments.some((value) => !/^[0-9a-f]{64}$/.test(value)) ||
        JSON.stringify(proof.first) !== JSON.stringify(proof.second) ||
        proof.first?.status !== row.status ||
        row.pinnedProofSha256 !== sha(JSON.stringify(proof))
      )
        throw Error('morpho_api_candidate_evidence_invalid')
      if (row.status === 'eligible_holder') {
        if (
          proof.first.sharesRaw !== row.sharesRaw ||
          proof.first.claimRaw !== row.claimRaw ||
          !DECIMAL.test(row.sharesRaw ?? '') ||
          BigInt(row.sharesRaw) === 0n ||
          !DECIMAL.test(row.claimRaw ?? '') ||
          BigInt(row.claimRaw) === 0n
        )
          throw Error('morpho_api_candidate_evidence_invalid')
        eligible.push(row)
      } else if (row.sharesRaw !== undefined || row.claimRaw !== undefined)
        throw Error('morpho_api_candidate_evidence_invalid')
    }
  }
  const best = eligible.reduce(
    (selected, row) =>
      !selected || BigInt(row.claimRaw) > BigInt(selected.claimRaw) ? row : selected,
    null,
  )
  if (
    doc.selectedHolderCommitment !== (best?.holderCommitment ?? null) ||
    doc.selectedSharesRaw !== (best?.sharesRaw ?? null) ||
    doc.selectedClaimRaw !== (best?.claimRaw ?? null) ||
    doc.unavailableReason !== (best ? null : 'no_two_host_verified_first_page_holder') ||
    JSON.stringify(doc.ladder) !==
      JSON.stringify(
        freezeMorphoQLadder({
          totalAssetsRaw: doc.baselineState.totalAssetsRaw,
          selectedClaimRaw: doc.selectedClaimRaw,
        }),
      )
  )
    throw Error('morpho_api_candidate_evidence_invalid')
  return doc
}

// V2 deliberately has a separate query and receipt schema. V1 first-page
// receipts remain readable with their original query commitment.
const V2_PAGE_SIZE = 8
const queryV2 = `query MorphoVaultV2CandidatePageV2($address: String!, $skip: Int!) {
  vaultV2ByAddress(address: $address, chainId: 1) {
    address
    totalSupply
    positions(first: 8, skip: $skip) {
      items { user { address } shares }
      pageInfo { count countTotal skip limit }
    }
  }
}`
const COMMITMENT = /^[0-9a-f]{64}$/
const pageSkipValid = (skip) => Number.isSafeInteger(skip) && skip >= 0 && skip % V2_PAGE_SIZE === 0
const pageCommitment = ({ pageSkip, querySha256, pageInfo, candidateCommitments }) =>
  sha(JSON.stringify({ pageSkip, querySha256, pageInfo, candidateCommitments }))

function validateV2Page(page, skip) {
  const info = page?.pageInfo
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > V2_PAGE_SIZE ||
    !Number.isFinite(Date.parse(page.fetchedAtUtc ?? '')) ||
    page.querySha256 !== sha(queryV2) ||
    !DECIMAL.test(page.totalSupplyRaw ?? '') ||
    !Number.isSafeInteger(info?.count) ||
    !Number.isSafeInteger(info?.countTotal) ||
    info.count !== page.items.length ||
    info.countTotal < 0 ||
    (info.count > 0 && info.countTotal < skip + info.count) ||
    (info.count < V2_PAGE_SIZE &&
      info.countTotal !== skip + info.count &&
      !(info.count === 0 && info.countTotal < skip)) ||
    info.skip !== skip ||
    info.limit !== V2_PAGE_SIZE ||
    page.items.some(
      (item) => !ADDRESS.test(item?.address ?? '') || !DECIMAL.test(item?.apiSharesRaw ?? ''),
    ) ||
    new Set(page.items.map((item) => item.address)).size !== page.items.length
  )
    throw Error('morpho_api_response_invalid')
  return page
}

/** Untrusted current API addresses, one bounded page at an explicit offset. */
export async function fetchMorphoV2CandidatePageV2(
  address,
  { skip = 0, fetcher = fetch, now = () => new Date() } = {},
) {
  if (!ADDRESS.test(address ?? '') || !pageSkipValid(skip) || typeof fetcher !== 'function')
    throw Error('morpho_api_input_invalid')
  const controller = new AbortController()
  let rejectDeadline
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject
  })
  const timeout = setTimeout(() => {
    controller.abort()
    rejectDeadline(Error('morpho_api_unavailable'))
  }, TIMEOUT_MS)
  let body = ''
  let bytes = 0
  try {
    const response = await Promise.race([
      fetcher(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: queryV2, variables: { address, skip } }),
        signal: controller.signal,
      }),
      deadline,
    ])
    if (
      !response?.ok ||
      !response.body ||
      Number(response.headers?.get('content-length') ?? 0) > MAX_BYTES
    )
      throw Error('morpho_api_unavailable')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const part = await Promise.race([reader.read(), deadline])
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_BYTES) throw Error('morpho_api_response_too_large')
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
  } catch (error) {
    if (error?.message === 'morpho_api_response_too_large') throw error
    throw Error('morpho_api_unavailable')
  } finally {
    clearTimeout(timeout)
  }
  let decoded
  try {
    decoded = JSON.parse(body)
  } catch {
    throw Error('morpho_api_response_invalid')
  }
  const vault = decoded?.data?.vaultV2ByAddress
  const positions = vault?.positions
  if (decoded.errors != null || !same(vault?.address, address))
    throw Error('morpho_api_response_invalid')
  return validateV2Page(
    {
      fetchedAtUtc: now().toISOString(),
      querySha256: sha(queryV2),
      totalSupplyRaw: vault.totalSupply,
      pageInfo: positions?.pageInfo,
      items: positions?.items?.map((row) => ({
        address: row?.user?.address?.toLowerCase(),
        apiSharesRaw: row?.shares,
      })),
    },
    skip,
  )
}

/** Screen every API address against two independent RPC hosts at one baseline. */
export async function discoverMorphoApiIssuerCandidateV2({
  baseline,
  primary,
  secondary,
  pageSkip = 0,
  fetchPage = fetchMorphoV2CandidatePageV2,
  now = () => new Date(),
}) {
  const route = resolveCarryExitV2Route(baseline?.routeKey, baseline?.destination, baseline?.asset)
  const headers = baseline?.canonicalityEvidenceDoc
  if (
    route.kind !== 'morpho' ||
    headers?.schema !== 'carry_exit_v2_headers_v1' ||
    headers.targetHeader?.hash !== baseline.targetHash ||
    headers.targetHeader?.number !== baseline.targetBlock ||
    headers.targetHeader?.parentHash !== baseline.targetParentHash ||
    !HASH.test(baseline.targetHash ?? '') ||
    !HASH.test(baseline.targetParentHash ?? '') ||
    !DECIMAL.test(baseline.targetBlock ?? '') ||
    !DECIMAL.test(baseline.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(baseline.assetDecimals) ||
    !pageSkipValid(pageSkip) ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    host(primary.provider) === host(secondary.provider)
  )
    throw Error('morpho_api_input_invalid')
  const page = validateV2Page(
    await fetchPage(baseline.destination, { skip: pageSkip, now }),
    pageSkip,
  )
  const commitments = page.items.map((item) => sha(`${baseline.destination}:${item.address}`))
  const screenedCandidates = []
  let selected = null
  for (const [rank, item] of page.items.entries()) {
    const holderCommitment = commitments[rank]
    const row = { holderCommitment, apiPageRank: rank, status: 'rpc_unavailable' }
    screenedCandidates.push(row)
    try {
      const first = await readPinned(primary.request.bind(primary), baseline, item.address)
      const second = await readPinned(secondary.request.bind(secondary), baseline, item.address)
      row.status =
        JSON.stringify(first) === JSON.stringify(second) ? first.status : 'rpc_disagreement'
      row.pinnedProof = {
        block: baseline.targetBlock,
        hash: baseline.targetHash,
        parentHash: baseline.targetParentHash,
        hostCommitments: [sha(host(primary.provider)), sha(host(secondary.provider))],
        holderCommitment,
        first,
        second,
      }
      row.pinnedProofSha256 = sha(JSON.stringify(row.pinnedProof))
      if (row.status !== 'eligible_holder') continue
      row.sharesRaw = first.sharesRaw
      row.claimRaw = first.claimRaw
      if (!selected || BigInt(first.claimRaw) > BigInt(selected.claimRaw))
        selected = { holder: item.address, holderCommitment, ...first }
    } catch {
      row.status = 'rpc_unavailable'
      delete row.pinnedProof
      delete row.pinnedProofSha256
    }
  }
  const evidenceDoc = {
    schema: 'carry_exit_v2_morpho_api_candidate_page_v2',
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
      source: ENDPOINT,
      querySha256: page.querySha256,
      fetchedAtUtc: page.fetchedAtUtc,
      apiTotalSupplyRaw: page.totalSupplyRaw,
      pageSkip,
      pageInfo: page.pageInfo,
      candidateCommitments: commitments,
      pageSha256: pageCommitment({
        pageSkip,
        querySha256: page.querySha256,
        pageInfo: page.pageInfo,
        candidateCommitments: commitments,
      }),
      attempted: screenedCandidates.length,
      candidateLimit: V2_PAGE_SIZE,
      exhaustiveHolderSearch: false,
      historicalHolderProof: false,
      scope: 'untrusted_live_api_paged_address_discovery',
    },
    screenedCandidates,
    selectionRule: 'largest_two_host_pinned_claim_among_page_eoas_tie_by_api_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedSharesRaw: selected?.sharesRaw ?? null,
    selectedClaimRaw: selected?.claimRaw ?? null,
    unavailableReason: selected ? null : 'no_two_host_verified_page_holder',
    ladder: freezeMorphoQLadder({
      totalAssetsRaw: baseline.totalAssetsRaw,
      selectedClaimRaw: selected?.claimRaw ?? null,
    }),
  }
  return { holder: selected?.holder ?? null, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}

/** Structural replay of the sealed page and pinned-RPC claims; no RPC honesty claim. */
export function validateMorphoApiCandidateEvidenceV2(doc) {
  const discovery = doc?.discovery
  const info = discovery?.pageInfo
  if (
    doc?.schema !== 'carry_exit_v2_morpho_api_candidate_page_v2' ||
    doc.chainId !== '1' ||
    resolveCarryExitV2Route(doc.routeKey, doc.destination, doc.asset).kind !== 'morpho' ||
    !HASH.test(doc.baselineHash ?? '') ||
    !HASH.test(doc.parentHash ?? '') ||
    !DECIMAL.test(doc.baselineBlock ?? '') ||
    !DECIMAL.test(doc.baselineState?.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(doc.baselineState?.assetDecimals) ||
    discovery?.source !== ENDPOINT ||
    discovery.querySha256 !== sha(queryV2) ||
    !Number.isFinite(Date.parse(discovery.fetchedAtUtc ?? '')) ||
    discovery.scope !== 'untrusted_live_api_paged_address_discovery' ||
    discovery.exhaustiveHolderSearch !== false ||
    discovery.historicalHolderProof !== false ||
    !DECIMAL.test(discovery.apiTotalSupplyRaw ?? '') ||
    !pageSkipValid(discovery.pageSkip) ||
    info?.skip !== discovery.pageSkip ||
    info?.limit !== V2_PAGE_SIZE ||
    !Number.isSafeInteger(info?.count) ||
    !Number.isSafeInteger(info?.countTotal) ||
    info.count < 0 ||
    info.countTotal < 0 ||
    info.count > V2_PAGE_SIZE ||
    (info.count > 0 && info.countTotal < info.skip + info.count) ||
    (info.count < V2_PAGE_SIZE &&
      info.countTotal !== info.skip + info.count &&
      !(info.count === 0 && info.countTotal < info.skip)) ||
    !Array.isArray(discovery.candidateCommitments) ||
    discovery.candidateCommitments.length !== info.count ||
    new Set(discovery.candidateCommitments).size !== info.count ||
    discovery.candidateCommitments.some((value) => !COMMITMENT.test(value)) ||
    discovery.pageSha256 !== pageCommitment(discovery) ||
    !Array.isArray(doc.screenedCandidates) ||
    doc.screenedCandidates.length !== info.count ||
    discovery.attempted !== info.count ||
    discovery.candidateLimit !== V2_PAGE_SIZE ||
    doc.selectionRule !== 'largest_two_host_pinned_claim_among_page_eoas_tie_by_api_rank'
  )
    throw Error('morpho_api_candidate_evidence_invalid')
  const eligible = []
  for (const [rank, row] of doc.screenedCandidates.entries()) {
    if (
      row.apiPageRank !== rank ||
      row.holderCommitment !== discovery.candidateCommitments[rank] ||
      ![
        'rpc_unavailable',
        'rpc_disagreement',
        'contract_holder',
        'no_pinned_shares',
        'no_pinned_claim',
        'eligible_holder',
      ].includes(row.status)
    )
      throw Error('morpho_api_candidate_evidence_invalid')
    if (row.status === 'rpc_unavailable') {
      if (
        row.pinnedProof !== undefined ||
        row.pinnedProofSha256 !== undefined ||
        row.sharesRaw !== undefined ||
        row.claimRaw !== undefined
      )
        throw Error('morpho_api_candidate_evidence_invalid')
      continue
    }
    const proof = row.pinnedProof
    if (
      !proof ||
      proof.block !== doc.baselineBlock ||
      proof.hash !== doc.baselineHash ||
      proof.parentHash !== doc.parentHash ||
      proof.holderCommitment !== row.holderCommitment ||
      !Array.isArray(proof.hostCommitments) ||
      proof.hostCommitments.length !== 2 ||
      proof.hostCommitments[0] === proof.hostCommitments[1] ||
      proof.hostCommitments.some((value) => !COMMITMENT.test(value)) ||
      row.pinnedProofSha256 !== sha(JSON.stringify(proof)) ||
      (row.status === 'rpc_disagreement') !==
        (JSON.stringify(proof.first) !== JSON.stringify(proof.second)) ||
      (row.status !== 'rpc_disagreement' && proof.first?.status !== row.status) ||
      row.sharesRaw !== (row.status === 'eligible_holder' ? proof.first.sharesRaw : undefined) ||
      row.claimRaw !== (row.status === 'eligible_holder' ? proof.first.claimRaw : undefined)
    )
      throw Error('morpho_api_candidate_evidence_invalid')
    if (row.status === 'eligible_holder') {
      if (
        !DECIMAL.test(row.sharesRaw ?? '') ||
        BigInt(row.sharesRaw) === 0n ||
        !DECIMAL.test(row.claimRaw ?? '') ||
        BigInt(row.claimRaw) === 0n
      )
        throw Error('morpho_api_candidate_evidence_invalid')
      eligible.push(row)
    }
  }
  const best = eligible.reduce(
    (selected, row) =>
      !selected || BigInt(row.claimRaw) > BigInt(selected.claimRaw) ? row : selected,
    null,
  )
  if (
    doc.selectedHolderCommitment !== (best?.holderCommitment ?? null) ||
    doc.selectedSharesRaw !== (best?.sharesRaw ?? null) ||
    doc.selectedClaimRaw !== (best?.claimRaw ?? null) ||
    doc.unavailableReason !== (best ? null : 'no_two_host_verified_page_holder') ||
    JSON.stringify(doc.ladder) !==
      JSON.stringify(
        freezeMorphoQLadder({
          totalAssetsRaw: doc.baselineState.totalAssetsRaw,
          selectedClaimRaw: doc.selectedClaimRaw,
        }),
      )
  )
    throw Error('morpho_api_candidate_evidence_invalid')
  return doc
}
