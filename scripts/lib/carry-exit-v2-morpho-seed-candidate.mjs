// Historical route borrowers are an untrusted shortlist, not live holder proof.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { freezeMorphoQLadder } from './carry-exit-v2-morpho-issuer-prep.mjs'
import { resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'

const SEED_URL = new URL('../route-cohort/aug-2026-ab-vault-seed.json', import.meta.url)
const SEED_PATH = 'scripts/route-cohort/aug-2026-ab-vault-seed.json'
const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const ROUTE = 'AUSD → VaultV2 [AUSD]'
const DESTINATION = '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589'
const ASSET = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const word = (value) => value.toString(16).padStart(64, '0')
const host = (url) => {
  const parsed = new URL(url)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('morpho_seed_origin_invalid')
  return parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}
const quantity = (value) => {
  if (!WORD.test(value ?? '')) throw Error('morpho_seed_rpc_state_invalid')
  return BigInt(value)
}
const invalid = () => {
  throw Error('morpho_seed_candidate_evidence_invalid')
}

export function readMorphoSeedCandidates(read = () => readFileSync(SEED_URL)) {
  const bytes = read()
  if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024 || sha(bytes) !== SEED_SHA256)
    throw Error('morpho_seed_integrity_invalid')
  const seed = JSON.parse(bytes.toString('utf8'))
  if (
    seed.schemaVersion !== 1 ||
    seed.cohortId !== 'aug-2026-ab-vault-routes' ||
    !Array.isArray(seed.positions)
  )
    throw Error('morpho_seed_schema_invalid')
  const owners = [
    ...new Set(
      seed.positions
        .filter((row) => row.vault === DESTINATION && row.routeIds?.includes(ROUTE))
        .map((row) => row.owner),
    ),
  ]
  if (owners.length !== 9 || owners.some((owner) => !ADDRESS.test(owner)))
    throw Error('morpho_seed_membership_invalid')
  return { owners, sha256: SEED_SHA256 }
}

async function readPinned(request, baseline, holder) {
  const block = await request('eth_getBlockByNumber', [
    `0x${BigInt(baseline.targetBlock).toString(16)}`,
    false,
  ])
  const chainId = await request('eth_chainId', [])
  const vaultCode = await request('eth_getCode', [DESTINATION, pin(baseline.targetHash)])
  const asset = await request('eth_call', [
    { to: DESTINATION, data: '0x38d52e0f' },
    pin(baseline.targetHash),
  ])
  const totalAssets = await request('eth_call', [
    { to: DESTINATION, data: '0x01e1d114' },
    pin(baseline.targetHash),
  ])
  if (
    chainId !== '0x1' ||
    block?.hash !== baseline.targetHash ||
    block?.parentHash !== baseline.targetParentHash ||
    !/^0x(?:[0-9a-f]{2})+$/.test(vaultCode ?? '') ||
    !WORD.test(asset ?? '') ||
    `0x${asset.slice(-40)}` !== ASSET ||
    quantity(totalAssets).toString() !== baseline.totalAssetsRaw
  )
    throw Error('morpho_seed_baseline_disagreement')
  const code = await request('eth_getCode', [holder, pin(baseline.targetHash)])
  if (code !== '0x') return { status: 'contract_holder' }
  const shares = quantity(
    await request('eth_call', [
      { to: DESTINATION, data: `0x70a08231${holder.slice(2).padStart(64, '0')}` },
      pin(baseline.targetHash),
    ]),
  )
  if (shares === 0n) return { status: 'no_pinned_shares' }
  const claim = quantity(
    await request('eth_call', [
      { to: DESTINATION, data: `0x4cdad506${word(shares)}` },
      pin(baseline.targetHash),
    ]),
  )
  return claim === 0n
    ? { status: 'no_pinned_claim' }
    : { status: 'eligible_holder', sharesRaw: shares.toString(), claimRaw: claim.toString() }
}

export async function discoverMorphoSeedIssuerCandidate({
  baseline,
  primary,
  secondary,
  readSeed = readMorphoSeedCandidates,
}) {
  const route = resolveCarryExitV2Route(baseline?.routeKey, baseline?.destination, baseline?.asset)
  if (
    route.kind !== 'morpho' ||
    route.routeKey !== ROUTE ||
    route.destination !== DESTINATION ||
    route.asset !== ASSET ||
    baseline.canonicalityEvidenceDoc?.schema !== 'carry_exit_v2_headers_v1' ||
    baseline.canonicalityEvidenceDoc.targetHeader?.hash !== baseline.targetHash ||
    baseline.canonicalityEvidenceDoc.targetHeader?.number !== baseline.targetBlock ||
    !HASH.test(baseline.targetHash ?? '') ||
    !DECIMAL.test(baseline.totalAssetsRaw ?? '') ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    host(primary.provider) === host(secondary.provider)
  )
    throw Error('morpho_seed_input_invalid')
  const seed = readSeed()
  if (
    seed.sha256 !== SEED_SHA256 ||
    seed.owners.length !== 9 ||
    new Set(seed.owners).size !== 9 ||
    seed.owners.some((owner) => !ADDRESS.test(owner))
  )
    throw Error('morpho_seed_membership_invalid')
  const screenedCandidates = []
  const hostCommitments = [sha(host(primary.provider)), sha(host(secondary.provider))]
  let selected = null
  for (const [rank, owner] of seed.owners.entries()) {
    const holderCommitment = sha(`${DESTINATION}:${owner}`)
    const row = { holderCommitment, seedRank: rank, status: 'rpc_unavailable' }
    screenedCandidates.push(row)
    try {
      const first = await readPinned(primary.request.bind(primary), baseline, owner)
      const second = await readPinned(secondary.request.bind(secondary), baseline, owner)
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        row.status = 'rpc_disagreement'
        continue
      }
      row.status = first.status
      row.pinnedProof = {
        block: baseline.targetBlock,
        hash: baseline.targetHash,
        hostCommitments,
        holderCommitment,
        first,
        second,
      }
      row.pinnedProofSha256 = sha(JSON.stringify(row.pinnedProof))
      if (first.status !== 'eligible_holder') continue
      row.sharesRaw = first.sharesRaw
      row.claimRaw = first.claimRaw
      if (!selected || BigInt(first.claimRaw) > BigInt(selected.claimRaw))
        selected = { holder: owner, holderCommitment, ...first }
    } catch {
      row.status = 'rpc_unavailable'
    }
  }
  const evidenceDoc = {
    schema: 'carry_exit_v2_morpho_seed_candidate_v1',
    chainId: '1',
    routeKey: ROUTE,
    destination: DESTINATION,
    asset: ASSET,
    baselineBlock: baseline.targetBlock,
    baselineHash: baseline.targetHash,
    parentHash: baseline.targetParentHash,
    baselineState: {
      totalAssetsRaw: baseline.totalAssetsRaw,
      assetDecimals: baseline.assetDecimals,
    },
    discovery: {
      source: 'frozen_route_borrower_seed',
      seedPath: SEED_PATH,
      seedSha256: SEED_SHA256,
      candidateCommitments: seed.owners.map((owner) => sha(`${DESTINATION}:${owner}`)),
      hostCommitments,
      attempted: screenedCandidates.length,
      exhaustiveHolderSearch: false,
      historicalHolderProof: false,
      scope: 'untrusted_historical_route_borrower_shortlist',
    },
    screenedCandidates,
    selectionRule: 'largest_two_host_pinned_claim_among_frozen_seed_eoas_tie_by_seed_rank',
    selectedHolderCommitment: selected?.holderCommitment ?? null,
    selectedSharesRaw: selected?.sharesRaw ?? null,
    selectedClaimRaw: selected?.claimRaw ?? null,
    unavailableReason: selected ? null : 'no_two_host_verified_seed_holder',
    ladder: freezeMorphoQLadder({
      totalAssetsRaw: baseline.totalAssetsRaw,
      selectedClaimRaw: selected?.claimRaw ?? null,
    }),
  }
  return { holder: selected?.holder ?? null, evidenceDoc, digest: sha(JSON.stringify(evidenceDoc)) }
}

/** Structural verification binds the physical seed, not any claimed transfer/API source. */
export function validateMorphoSeedCandidateEvidence(
  doc,
  { primaryProvider, secondaryProvider } = {},
) {
  const seed = readMorphoSeedCandidates()
  const discovery = doc?.discovery
  let expectedHosts
  try {
    expectedHosts = [sha(host(primaryProvider)), sha(host(secondaryProvider))]
  } catch {
    invalid()
  }
  if (
    doc?.schema !== 'carry_exit_v2_morpho_seed_candidate_v1' ||
    doc.chainId !== '1' ||
    doc.routeKey !== ROUTE ||
    doc.destination !== DESTINATION ||
    doc.asset !== ASSET ||
    !HASH.test(doc.baselineHash ?? '') ||
    !HASH.test(doc.parentHash ?? '') ||
    !DECIMAL.test(doc.baselineBlock ?? '') ||
    !DECIMAL.test(doc.baselineState?.totalAssetsRaw ?? '') ||
    !Number.isSafeInteger(doc.baselineState?.assetDecimals) ||
    discovery?.source !== 'frozen_route_borrower_seed' ||
    discovery.seedPath !== SEED_PATH ||
    discovery.seedSha256 !== seed.sha256 ||
    discovery.scope !== 'untrusted_historical_route_borrower_shortlist' ||
    discovery.exhaustiveHolderSearch !== false ||
    discovery.historicalHolderProof !== false ||
    expectedHosts[0] === expectedHosts[1] ||
    JSON.stringify(discovery.hostCommitments) !== JSON.stringify(expectedHosts) ||
    JSON.stringify(discovery.candidateCommitments) !==
      JSON.stringify(seed.owners.map((owner) => sha(`${DESTINATION}:${owner}`))) ||
    !Array.isArray(doc.screenedCandidates) ||
    discovery.attempted !== doc.screenedCandidates.length ||
    doc.screenedCandidates.length !== seed.owners.length ||
    doc.selectionRule !== 'largest_two_host_pinned_claim_among_frozen_seed_eoas_tie_by_seed_rank'
  )
    invalid()
  const eligible = []
  for (const [rank, row] of doc.screenedCandidates.entries()) {
    if (
      row.seedRank !== rank ||
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
      invalid()
    if (row.status === 'rpc_unavailable' || row.status === 'rpc_disagreement') {
      if (
        row.pinnedProof !== undefined ||
        row.pinnedProofSha256 !== undefined ||
        row.sharesRaw !== undefined ||
        row.claimRaw !== undefined
      )
        invalid()
      continue
    }
    const proof = row.pinnedProof
    if (
      !proof ||
      proof.block !== doc.baselineBlock ||
      proof.hash !== doc.baselineHash ||
      proof.holderCommitment !== row.holderCommitment ||
      !Array.isArray(proof.hostCommitments) ||
      JSON.stringify(proof.hostCommitments) !== JSON.stringify(expectedHosts) ||
      JSON.stringify(proof.first) !== JSON.stringify(proof.second) ||
      proof.first?.status !== row.status ||
      row.pinnedProofSha256 !== sha(JSON.stringify(proof))
    )
      invalid()
    if (row.status === 'eligible_holder') {
      if (
        proof.first.sharesRaw !== row.sharesRaw ||
        proof.first.claimRaw !== row.claimRaw ||
        !DECIMAL.test(row.sharesRaw ?? '') ||
        BigInt(row.sharesRaw) === 0n ||
        !DECIMAL.test(row.claimRaw ?? '') ||
        BigInt(row.claimRaw) === 0n
      )
        invalid()
      eligible.push(row)
    } else if (row.sharesRaw !== undefined || row.claimRaw !== undefined) invalid()
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
    doc.unavailableReason !== (best ? null : 'no_two_host_verified_seed_holder') ||
    JSON.stringify(doc.ladder) !==
      JSON.stringify(
        freezeMorphoQLadder({
          totalAssetsRaw: doc.baselineState.totalAssetsRaw,
          selectedClaimRaw: doc.selectedClaimRaw,
        }),
      )
  )
    invalid()
  return doc
}
