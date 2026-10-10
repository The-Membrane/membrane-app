// Foreground retrospective pilot. A historical source block freezes the cohort
// before the H24 lookup. These observations do not validate a live forecast.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { selectCarryExitV2FirstFinalizedBlock } from '../lib/carry-exit-v2-block-auditor.mjs'
import {
  discoverMorphoHistoricalTransferCandidate,
  validateMorphoHistoricalTransferCandidateEvidence,
} from '../lib/carry-exit-v2-morpho-historical-transfer-candidate.mjs'
import { measureCarryExitV2Verified } from '../lib/carry-exit-v2-verified-measurement.mjs'
import { validateCarryExitV2RpcProof } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  configuredPublicRpcUrls,
  publicRpcClients,
  slicedCandidateRequest,
} from './carry-public-direct-exit-issue.mjs'
import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'
import { readVerifiedGrid } from './carry-morpho-retrospective-grid.mjs'

export const STUDY = 'carry_morpho_retrospective_holder_pairs_v1'
export const OUT = resolve('data/research/venue-signals/carry-morpho-retrospective-holder-pairs-v1')
export const RESERVE_BYTES = 1_073_741_824
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const WORD = /^0x[0-9a-f]{64}$/
const MAX_RECORD_BYTES = 512 * 1024
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hex = (n) => `0x${BigInt(n).toString(16)}`
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const bodyOf = ({ sha256: _sha256, ...body }) => body
const filename = (routeIndex, sourceBlock) =>
  `${String(routeIndex).padStart(2, '0')}-${String(sourceBlock).padStart(12, '0')}.json`

function assertInput({ routeIndex, sourceBlock, fromBlock, toBlock, primary, secondary }) {
  if (
    !Number.isSafeInteger(routeIndex) ||
    !BOARD_ROUTES[routeIndex] ||
    !Number.isSafeInteger(sourceBlock) ||
    sourceBlock < 3 ||
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 1 ||
    toBlock < fromBlock ||
    toBlock >= sourceBlock ||
    toBlock - fromBlock + 1 > 64 ||
    sourceBlock - toBlock > 4096 ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    typeof primary?.send !== 'function' ||
    typeof secondary?.send !== 'function' ||
    !primary.provider ||
    !secondary.provider ||
    primary.provider === secondary.provider ||
    new URL(primary.url).hostname === new URL(secondary.url).hostname
  )
    throw Error('retrospective_input_invalid')
}

async function sourceHeader(client, block) {
  if ((await client.request('eth_chainId', [])) !== '0x1') throw Error('retrospective_wrong_chain')
  const [raw, parent, finalized] = await Promise.all([
    client.request('eth_getBlockByNumber', [hex(block), false]),
    client.request('eth_getBlockByNumber', [hex(block - 1), false]),
    client.request('eth_getBlockByNumber', ['finalized', false]),
  ])
  if (
    !HASH.test(raw?.hash ?? '') ||
    !HASH.test(raw?.parentHash ?? '') ||
    !HASH.test(parent?.hash ?? '') ||
    BigInt(raw.number) !== BigInt(block) ||
    BigInt(parent.number) !== BigInt(block - 1) ||
    raw.parentHash !== parent.hash ||
    BigInt(parent.timestamp) >= BigInt(raw.timestamp) ||
    BigInt(finalized?.number ?? 0) < BigInt(block)
  )
    throw Error('retrospective_source_header_invalid')
  return {
    hash: raw.hash,
    parentHash: parent.hash,
    at: new Date(Number(BigInt(raw.timestamp)) * 1000).toISOString(),
  }
}

async function sourceState(client, route, hash) {
  const request = client.request.bind(client)
  const code = await request('eth_getCode', [route.destination, pin(hash)])
  if (code === '0x') return { status: 'no_code' }
  const [asset, assets, decimals] = await Promise.all([
    request('eth_call', [{ to: route.destination, data: '0x38d52e0f' }, pin(hash)]),
    request('eth_call', [{ to: route.destination, data: '0x01e1d114' }, pin(hash)]),
    request('eth_call', [{ to: route.asset, data: '0x313ce567' }, pin(hash)]),
  ])
  if (
    !/^0x(?:[0-9a-f]{2})+$/.test(code ?? '') ||
    !WORD.test(asset ?? '') ||
    `0x${asset.slice(-40)}` !== route.asset ||
    !WORD.test(assets ?? '') ||
    !WORD.test(decimals ?? '') ||
    BigInt(decimals) > 36n
  )
    throw Error('retrospective_source_state_invalid')
  return { totalAssetsRaw: BigInt(assets).toString(), assetDecimals: Number(BigInt(decimals)) }
}

function sameTarget(a, b) {
  return (
    a.targetBlock === b.targetBlock &&
    a.targetHash === b.targetHash &&
    a.targetParentHash === b.targetParentHash &&
    a.targetBlockAt === b.targetBlockAt
  )
}

export async function auditedPair({
  primary,
  secondary,
  targetAt,
  baselineBlock,
  baselineHash,
  choose,
  now,
}) {
  const args = { targetAt, baselineBlock: String(baselineBlock), baselineHash, source: STUDY, now }
  const [a, b] = await Promise.all([
    choose({ ...args, provider: primary.provider, request: primary.request.bind(primary) }),
    choose({ ...args, provider: secondary.provider, request: secondary.request.bind(secondary) }),
  ])
  if (!sameTarget(a, b)) throw Error('retrospective_target_disagreement')
  return { primary: a, secondary: b }
}

export function chooseQ(candidate) {
  const row = candidate.evidenceDoc.ladder.labels.find(
    (entry) => entry.label === 'holder_half_claim_capped_vault_0p001pct',
  )
  if (
    !row ||
    !DECIMAL.test(row.assetsRaw ?? '') ||
    BigInt(row.assetsRaw) <= 0n ||
    BigInt(row.assetsRaw) > BigInt(candidate.evidenceDoc.selectedClaimRaw ?? '0')
  )
    throw Error('retrospective_q_unavailable')
  return row.assetsRaw
}

async function assay({ route, holder, assetsRaw, target, primary, secondary, measure, now }) {
  const result = await measure({
    ...route,
    holder,
    assetsRaw,
    target,
    provider: primary.provider,
    source: STUDY,
    send: primary.send.bind(primary),
    primary: { url: primary.url, request: primary.send.bind(primary) },
    secondary: { url: secondary.url, request: secondary.send.bind(secondary) },
    now,
  })
  if (result.status !== 'verified')
    return { status: 'censored', reason: result.reason ?? 'measurement_unavailable' }
  const decoded = validateCarryExitV2RpcProof({
    proof: result.callEvidenceDoc,
    ...route,
    holder,
    assetsRaw,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  })
  return {
    status: 'verified',
    simulationStatus: decoded.simulationStatus,
    coveredRevert: decoded.coveredRevert,
    evidence: result.callEvidenceDoc,
  }
}

export async function capturePilot({
  routeIndex,
  sourceBlock,
  fromBlock,
  toBlock,
  primary,
  secondary,
  now = () => new Date(),
  choose = selectCarryExitV2FirstFinalizedBlock,
  discover = discoverMorphoHistoricalTransferCandidate,
  measure = measureCarryExitV2Verified,
}) {
  assertInput({ routeIndex, sourceBlock, fromBlock, toBlock, primary, secondary })
  const route = BOARD_ROUTES[routeIndex]
  const [first, second] = await Promise.all([
    sourceHeader(primary, sourceBlock),
    sourceHeader(secondary, sourceBlock),
  ])
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error('retrospective_source_disagreement')
  const source = await auditedPair({
    primary,
    secondary,
    targetAt: first.at,
    baselineBlock: sourceBlock - 1,
    baselineHash: first.parentHash,
    choose,
    now,
  })
  if (
    source.primary.targetBlock !== String(sourceBlock) ||
    source.primary.targetHash !== first.hash
  )
    throw Error('retrospective_source_boundary_invalid')
  const [stateA, stateB] = await Promise.all([
    sourceState(primary, route, first.hash),
    sourceState(secondary, route, first.hash),
  ])
  if (JSON.stringify(stateA) !== JSON.stringify(stateB))
    throw Error('retrospective_state_disagreement')
  if (stateA.status === 'no_code') {
    const body = {
      study: STUDY,
      chainId: '1',
      routeIndex,
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      sourceBlock,
      fromBlock,
      toBlock,
      capturedAtUtc: now().toISOString(),
      source,
      sourceState: stateA,
      candidate: null,
      holder: null,
      assetsRaw: null,
      targetAtUtc: null,
      future: null,
      sourceAssay: { status: 'censored', reason: 'vault_not_deployed' },
      futureAssay: { status: 'censored', reason: 'vault_not_deployed' },
      forecastValidated: false,
      interpretation: 'retrospective_simulation_not_paid_exit',
    }
    return validateRecord({ ...body, sha256: sha(JSON.stringify(body)) })
  }
  const baseline = { ...route, ...source.primary, ...stateA }
  const candidate = await discover({
    baseline,
    primary,
    secondary,
    windows: [{ fromBlock: String(fromBlock), toBlock: String(toBlock) }],
  })
  validateMorphoHistoricalTransferCandidateEvidence(candidate.evidenceDoc)
  if (!candidate.holder) {
    const body = {
      study: STUDY,
      chainId: '1',
      routeIndex,
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      sourceBlock,
      fromBlock,
      toBlock,
      capturedAtUtc: now().toISOString(),
      source,
      sourceState: stateA,
      candidate: candidate.evidenceDoc,
      holder: null,
      assetsRaw: null,
      targetAtUtc: null,
      future: null,
      sourceAssay: { status: 'censored', reason: 'no_source_holder' },
      futureAssay: { status: 'censored', reason: 'no_source_holder' },
      forecastValidated: false,
      interpretation: 'retrospective_simulation_not_paid_exit',
    }
    return validateRecord({ ...body, sha256: sha(JSON.stringify(body)) })
  }
  const assetsRaw = chooseQ(candidate)
  const targetAtUtc = new Date(Date.parse(first.at) + 24 * 3600_000).toISOString()
  const sourceAssay = await assay({
    route,
    holder: candidate.holder,
    assetsRaw,
    target: source.primary,
    primary,
    secondary,
    measure,
    now,
  })
  const future = await auditedPair({
    primary,
    secondary,
    targetAt: targetAtUtc,
    baselineBlock: sourceBlock,
    baselineHash: first.hash,
    choose,
    now,
  })
  const futureAssay = await assay({
    route,
    holder: candidate.holder,
    assetsRaw,
    target: future.primary,
    primary,
    secondary,
    measure,
    now,
  })
  const body = {
    study: STUDY,
    chainId: '1',
    routeIndex,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    sourceBlock,
    fromBlock,
    toBlock,
    capturedAtUtc: now().toISOString(),
    source,
    sourceState: stateA,
    candidate: candidate.evidenceDoc,
    holder: candidate.holder,
    assetsRaw,
    targetAtUtc,
    future,
    sourceAssay,
    futureAssay,
    forecastValidated: false,
    interpretation: 'retrospective_simulation_not_paid_exit',
  }
  return validateRecord({ ...body, sha256: sha(JSON.stringify(body)) })
}

export function validateRecord(record) {
  if (
    !record ||
    record.sha256 !== sha(JSON.stringify(bodyOf(record))) ||
    record.study !== STUDY ||
    record.chainId !== '1' ||
    record.forecastValidated !== false ||
    record.interpretation !== 'retrospective_simulation_not_paid_exit'
  )
    throw Error('retrospective_seal_invalid')
  const route = BOARD_ROUTES[record.routeIndex]
  if (
    !route ||
    record.routeKey !== route.routeKey ||
    record.destination !== route.destination ||
    record.asset !== route.asset ||
    !Number.isSafeInteger(record.sourceBlock) ||
    !Number.isSafeInteger(record.fromBlock) ||
    !Number.isSafeInteger(record.toBlock) ||
    record.fromBlock < 1 ||
    record.toBlock < record.fromBlock ||
    record.toBlock >= record.sourceBlock ||
    record.toBlock - record.fromBlock + 1 > 64 ||
    record.sourceBlock - record.toBlock > 4096 ||
    !HASH.test(record.source?.primary?.targetHash ?? '') ||
    record.source.primary.targetBlock !== String(record.sourceBlock) ||
    !sameTarget(record.source.primary, record.source.secondary)
  )
    throw Error('retrospective_identity_invalid')
  if (record.sourceState?.status === 'no_code') {
    if (
      record.candidate !== null ||
      record.holder !== null ||
      record.assetsRaw !== null ||
      record.targetAtUtc !== null ||
      record.future !== null ||
      record.sourceAssay?.reason !== 'vault_not_deployed' ||
      record.futureAssay?.reason !== 'vault_not_deployed'
    )
      throw Error('retrospective_censor_invalid')
    return record
  }
  if (
    record.candidate?.baselineBlock !== String(record.sourceBlock) ||
    record.candidate?.baselineHash !== record.source.primary.targetHash ||
    record.candidate?.baselineState?.totalAssetsRaw !== record.sourceState?.totalAssetsRaw ||
    record.candidate?.baselineState?.assetDecimals !== record.sourceState?.assetDecimals ||
    record.candidate?.discovery?.windows?.length !== 1 ||
    record.candidate.discovery.windows[0].fromBlock !== String(record.fromBlock) ||
    record.candidate.discovery.windows[0].toBlock !== String(record.toBlock)
  )
    throw Error('retrospective_identity_invalid')
  validateMorphoHistoricalTransferCandidateEvidence(record.candidate)
  if (record.holder === null) {
    if (
      record.candidate.selectedHolderCommitment !== null ||
      record.assetsRaw !== null ||
      record.targetAtUtc !== null ||
      record.future !== null ||
      record.sourceAssay?.status !== 'censored' ||
      record.sourceAssay?.reason !== 'no_source_holder' ||
      record.futureAssay?.status !== 'censored' ||
      record.futureAssay?.reason !== 'no_source_holder'
    )
      throw Error('retrospective_censor_invalid')
    return record
  }
  if (
    !/^0x[0-9a-f]{40}$/.test(record.holder ?? '') ||
    !DECIMAL.test(record.assetsRaw ?? '') ||
    BigInt(record.assetsRaw) <= 0n ||
    record.candidate.selectedHolderCommitment !== sha(`${route.destination}:${record.holder}`) ||
    !sameTarget(record.future?.primary ?? {}, record.future?.secondary ?? {}) ||
    record.source.primary.targetHash !==
      record.future.primary.canonicalityEvidenceDoc?.baselineHeader?.hash ||
    record.future.primary.targetParentBlockAt >= record.targetAtUtc ||
    record.future.primary.targetBlockAt < record.targetAtUtc ||
    record.targetAtUtc !==
      new Date(Date.parse(record.source.primary.targetBlockAt) + 24 * 3600_000).toISOString()
  )
    throw Error('retrospective_identity_invalid')
  if (record.assetsRaw !== chooseQ({ evidenceDoc: record.candidate }))
    throw Error('retrospective_q_mismatch')
  for (const [target, assay] of [
    [record.source.primary, record.sourceAssay],
    [record.future.primary, record.futureAssay],
  ]) {
    if (!['verified', 'censored'].includes(assay?.status))
      throw Error('retrospective_assay_invalid')
    if (assay.status === 'verified') {
      if (
        !assay.evidence ||
        !['success', 'evm_revert'].includes(assay.simulationStatus) ||
        typeof assay.coveredRevert !== 'boolean'
      )
        throw Error('retrospective_assay_invalid')
      const decoded = validateCarryExitV2RpcProof({
        proof: assay.evidence,
        ...route,
        holder: record.holder,
        assetsRaw: record.assetsRaw,
        blockNumber: target.targetBlock,
        blockHash: target.targetHash,
      })
      if (
        decoded.simulationStatus !== assay.simulationStatus ||
        decoded.coveredRevert !== assay.coveredRevert
      )
        throw Error('retrospective_verdict_mismatch')
    } else if (typeof assay.reason !== 'string' || !/^[a-z0-9_]{1,80}$/.test(assay.reason))
      throw Error('retrospective_censor_invalid')
  }
  return record
}

export function classifyAssays(sourceAssay, futureAssay) {
  if (sourceAssay.status !== 'verified' || futureAssay.status !== 'verified') return 'censored'
  if (sourceAssay.simulationStatus === 'success') {
    if (futureAssay.simulationStatus === 'success') return 'simulated_continuity'
    return futureAssay.coveredRevert ? 'covered_q_new_revert' : 'q_entitlement_below_frozen_amount'
  }
  if (!sourceAssay.coveredRevert) return 'source_q_not_covered'
  if (futureAssay.simulationStatus === 'success') return 'simulated_recovery'
  return futureAssay.coveredRevert ? 'still_covered_q_revert' : 'q_entitlement_below_frozen_amount'
}

export function classifyRetrospectivePair(record) {
  validateRecord(record)
  return classifyAssays(record.sourceAssay, record.futureAssay)
}

export async function verify({ out = OUT } = {}) {
  let files
  try {
    files = (await readdir(out)).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return { count: 0 }
    throw error
  }
  const transitions = {}
  for (const file of files) {
    if (!/^\d{2}-\d{12}\.json$/.test(file)) throw Error('retrospective_unknown_file')
    const bytes = await readFile(join(out, file))
    if (bytes.length > MAX_RECORD_BYTES) throw Error('retrospective_oversize')
    const record = JSON.parse(bytes.toString('utf8'))
    if (
      bytes.toString('utf8') !== `${JSON.stringify(record)}\n` ||
      file !== filename(record.routeIndex, record.sourceBlock)
    )
      throw Error('retrospective_file_invalid')
    validateRecord(record)
    const transition = classifyRetrospectivePair(record)
    transitions[transition] = (transitions[transition] ?? 0) + 1
  }
  return { count: files.length, transitions }
}

export async function save(
  record,
  {
    out = OUT,
    freeBytes = () => {
      const stat = statfsSync(out)
      return stat.bavail * stat.bsize
    },
  } = {},
) {
  validateRecord(record)
  await mkdir(out, { recursive: true, mode: 0o700 })
  if (freeBytes() < RESERVE_BYTES) throw Error('retrospective_disk_reserve')
  const bytes = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw Error('retrospective_oversize')
  const final = join(out, filename(record.routeIndex, record.sourceBlock))
  const temporary = join(out, `.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await link(temporary, final)
  } finally {
    await rm(temporary, { force: true })
  }
  return final
}

export function selectRpcUrls(urls, hosts = '') {
  if (!hosts) return urls.slice(0, 2)
  const names = hosts.split(',').map((name) => name.trim().toLowerCase())
  if (names.length !== 2 || names[0] === names[1] || names.some((name) => !name))
    throw Error('retrospective_two_hosts_required')
  const selected = names.map((name) =>
    urls.find((url) => new URL(url).hostname.toLowerCase() === name),
  )
  if (selected.some((url) => !url)) throw Error('retrospective_origin_not_configured')
  return selected
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--verify')
    return console.log(JSON.stringify(await verify()))
  let selection
  let expectedSourceHash = null
  if (args.length === 3 && args[0] === '--grid') {
    if (!DECIMAL.test(args[1]) || !DECIMAL.test(args[2]))
      throw Error('retrospective_grid_selection_invalid')
    const grid = await readVerifiedGrid()
    const routeIndex = Number(args[1])
    const anchorIndex = Number(args[2])
    const cell = grid.cells.find(
      (row) => row.routeIndex === routeIndex && row.anchorIndex === anchorIndex,
    )
    if (!cell) throw Error('retrospective_grid_selection_invalid')
    selection = cell
    expectedSourceHash = grid.anchors[anchorIndex].sourceHash
  } else if (args.length === 4 && args.every((x) => DECIMAL.test(x))) {
    selection = {
      routeIndex: Number(args[0]),
      sourceBlock: Number(args[1]),
      fromBlock: Number(args[2]),
      toBlock: Number(args[3]),
    }
  } else {
    throw Error('usage: --verify | --grid ROUTE_INDEX ANCHOR_INDEX | ROUTE SOURCE FROM TO')
  }
  if (statfsSync(resolve('data')).bavail * statfsSync(resolve('data')).bsize < RESERVE_BYTES)
    throw Error('retrospective_disk_reserve')
  const env = readEnv('.env.local')
  const urls = configuredPublicRpcUrls(env)
  const clients = publicRpcClients(
    selectRpcUrls(urls, process.env.CARRY_MORPHO_RETROSPECTIVE_ORIGINS),
  ).map((client) => ({ ...client, request: slicedCandidateRequest(client) }))
  if (clients.length !== 2) throw Error('retrospective_two_hosts_required')
  const record = await capturePilot({
    routeIndex: selection.routeIndex,
    sourceBlock: selection.sourceBlock,
    fromBlock: selection.fromBlock,
    toBlock: selection.toBlock,
    primary: clients[0],
    secondary: clients[1],
  })
  if (expectedSourceHash && record.source.primary.targetHash !== expectedSourceHash)
    throw Error('retrospective_grid_source_mismatch')
  const path = await save(record)
  console.log(
    JSON.stringify({
      path,
      sha256: record.sha256,
      sourceStatus: record.sourceAssay.status,
      futureStatus: record.futureAssay.status,
      forecastValidated: false,
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(String(error?.message ?? 'retrospective_capture_failed').split(' ')[0])
    process.exitCode = 1
  })
