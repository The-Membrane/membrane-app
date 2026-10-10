// Prospective read-only Aave USDC holder assay. An eth_call is never proof of
// private-key control, transaction inclusion, or a future withdrawal promise.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import quoteModule from '../../lib/carry/directSupplyExitQuote.ts'
import marketModule from '../../lib/carry/directSupplyMarketConstants.ts'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  assayEndpoint,
  FIXED_SMALL_Q_RAW,
  loadVerifiedEndpoint,
  preferredIndependentUrls,
} from './aave-usdc-holder-flow-pair.mjs'
import { CONTINUATION_STUDY, replayJoin } from './aave-usdc-cash-direct-flow-join.mjs'

const { readDirectSupplyExitQuote } = quoteModule
const { DIRECT_SUPPLY_MARKETS } = marketModule
export const STUDY = 'aave-usdc-holder-prospective-v1'
export const ROOT = resolve('data/research/venue-signals/aave-usdc-holder-prospective-v1')
export const HORIZONS = Object.freeze([1, 4, 24])
export const WINDOW_HOURS = 2
export const MAX_PROBE_CANDIDATES = 4
const MARKET = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const MAX_RECORD_BYTES = 128 * 1024
const MAX_RECORDS = 20_000
const DISK_RESERVE_BYTES = 1_073_741_824
const MAX_BASELINE_AGE_MS = 2 * 3_600_000
const SLOT_MS = 30 * 60_000
const HASH = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^[1-9][0-9]*$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (yes, code) => {
  if (!yes) throw new Error(`aave_holder_${code}`)
}
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
const utc = (time) => new Date(time).toISOString()
const millis = (value) => {
  const n = Date.parse(value)
  fail(Number.isSafeInteger(n) && utc(n) === value, 'clock_invalid')
  return n
}
const nameOf = (sequence) => `${String(sequence).padStart(8, '0')}.json`
const stripSeal = ({ sha256: _seal, ...body }) => body

export function targets(issuedAtUtc) {
  const start = millis(issuedAtUtc)
  return HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: utc(start + horizonHours * 3_600_000),
    deadlineAtUtc: utc(start + (horizonHours + WINDOW_HOURS) * 3_600_000),
  }))
}

/** Hash all verified source digests, including every cash slice through B. */
export function sourceManifest(joined) {
  fail(
    ['aave-usdc-cash-direct-flow-join-v1', CONTINUATION_STUDY].includes(joined?.study) &&
      Number.isSafeInteger(joined.fromBlock) &&
      Number.isSafeInteger(joined.toBlock) &&
      joined.fromBlock < joined.toBlock &&
      Array.isArray(joined.slices) &&
      joined.slices.length > 0 &&
      joined.slices.length <= 128 &&
      joined.slices[0].fromExclusive === joined.fromBlock &&
      joined.slices.at(-1).toInclusive === joined.toBlock &&
      Array.isArray(joined.directSupplySourceFiles) &&
      Array.isArray(joined.directWithdrawalSourceFiles),
    'source_manifest_invalid',
  )
  const manifest = {
    joinStudy: joined.study,
    fromBlock: joined.fromBlock,
    joinedToBlock: joined.toBlock,
    joinedToHash: joined.slices.at(-1).toHash,
    continuity: joined.study === CONTINUATION_STUDY ? joined.continuity : null,
    cashSlices: joined.slices.length,
    cashSourcesSha256: sha(
      JSON.stringify(
        joined.slices.map((slice) => ({
          fromExclusive: slice.fromExclusive,
          toInclusive: slice.toInclusive,
          sources: slice.sources,
        })),
      ),
    ),
    supplyFiles: joined.directSupplySourceFiles.length,
    supplySourcesSha256: sha(JSON.stringify(joined.directSupplySourceFiles)),
    withdrawalFiles: joined.directWithdrawalSourceFiles.length,
    withdrawalSourcesSha256: sha(JSON.stringify(joined.directWithdrawalSourceFiles)),
  }
  fail(
    BLOCK_HASH.test(lower(manifest.joinedToHash)) &&
      (joined.study === CONTINUATION_STUDY
        ? manifest.continuity?.v1ThroughBlock === 26_095_417 &&
          BLOCK_HASH.test(lower(manifest.continuity.v1LastHash)) &&
          Number.isSafeInteger(manifest.continuity.verifiedV2ThroughBlock) &&
          manifest.continuity.verifiedV2ThroughBlock === manifest.joinedToBlock &&
          lower(manifest.continuity.verifiedV2LastHash) === lower(manifest.joinedToHash) &&
          HASH.test(manifest.continuity.archivePrefixSha256 ?? '') &&
          Number.isSafeInteger(manifest.continuity.archivedSlices) &&
          manifest.continuity.archivedSlices >= joined.slices.length &&
          typeof manifest.continuity.windowed === 'boolean'
        : manifest.continuity === null) &&
      joined.directSupplySourceFiles.length <= 512 &&
      joined.directWithdrawalSourceFiles.length <= 512 &&
      joined.slices.every(
        (slice) =>
          HASH.test(slice.sources?.cashSidecarSha256 ?? '') &&
          HASH.test(slice.sources?.cashLeftSha256 ?? '') &&
          HASH.test(slice.sources?.cashProjectionSha256 ?? ''),
      ) &&
      [...joined.directSupplySourceFiles, ...joined.directWithdrawalSourceFiles].every(
        (row) =>
          HASH.test(row.sha256 ?? '') &&
          typeof row.file === 'string' &&
          /^(?:supply-)?aaveV3Usdc-[0-9]+-[0-9]+\.json$/.test(row.file),
      ),
    'source_manifest_invalid',
  )
  return { manifest, digest: sha(JSON.stringify(manifest)) }
}

function validateIssue(row) {
  fail(
    row.study === STUDY &&
      row.kind === 'issues' &&
      row.routeKey === MARKET.routeKey &&
      lower(row.destination) === lower(MARKET.destination) &&
      lower(row.underlying) === lower(MARKET.underlying) &&
      ADDRESS.test(row.holder) &&
      RAW.test(row.qRaw) &&
      RAW.test(row.balanceRaw) &&
      BigInt(row.qRaw) === FIXED_SMALL_Q_RAW &&
      BigInt(row.balanceRaw) >= FIXED_SMALL_Q_RAW &&
      Number.isSafeInteger(row.slot) &&
      row.slot === Math.floor(millis(row.issuedAtUtc) / SLOT_MS) &&
      Number.isSafeInteger(row.baseline?.blockNumber) &&
      BLOCK_HASH.test(row.baseline?.blockHash ?? '') &&
      Number.isSafeInteger(row.baseline?.blockTimeMs) &&
      row.baseline.blockTimeMs <= millis(row.issuedAtUtc) &&
      millis(row.issuedAtUtc) - row.baseline.blockTimeMs <= MAX_BASELINE_AGE_MS &&
      ['success', 'evm_revert'].includes(row.baseline?.simulation?.status) &&
      row.baseline.noDeployedCodeAtEndpoint === true &&
      row.baseline.sourceDigest === sha(JSON.stringify(row.sourceManifest)) &&
      ['aave-usdc-cash-direct-flow-join-v1', CONTINUATION_STUDY].includes(
        row.sourceManifest?.joinStudy,
      ) &&
      Number.isSafeInteger(row.sourceManifest?.fromBlock) &&
      row.sourceManifest.fromBlock < row.baseline.blockNumber &&
      Number.isSafeInteger(row.sourceManifest?.cashSlices) &&
      row.sourceManifest.cashSlices > 0 &&
      row.sourceManifest.cashSlices <= 128 &&
      HASH.test(row.sourceManifest?.cashSourcesSha256 ?? '') &&
      HASH.test(row.sourceManifest?.supplySourcesSha256 ?? '') &&
      HASH.test(row.sourceManifest?.withdrawalSourcesSha256 ?? '') &&
      (row.sourceManifest.joinStudy === CONTINUATION_STUDY
        ? HASH.test(row.sourceManifest.continuity?.archivePrefixSha256 ?? '') &&
          BLOCK_HASH.test(lower(row.sourceManifest.continuity?.v1LastHash)) &&
          row.sourceManifest.continuity?.verifiedV2ThroughBlock === row.baseline.blockNumber &&
          lower(row.sourceManifest.continuity?.verifiedV2LastHash) === lower(row.baseline.blockHash)
        : row.sourceManifest.continuity === null) &&
      row.sourceManifest?.joinedToBlock === row.baseline.blockNumber &&
      row.sourceManifest?.joinedToHash === row.baseline.blockHash &&
      HASH.test(row.baseline.joinedContentSha256 ?? '') &&
      Array.isArray(row.rpcOperators) &&
      row.rpcOperators.length === 2 &&
      row.rpcOperators.every((value) =>
        ['ankr', 'drpc', 'infura', 'alchemy', 'quicknode', 'mevblocker', 'flashbots'].includes(
          value,
        ),
      ) &&
      row.rpcOperators[0] !== row.rpcOperators[1] &&
      JSON.stringify(row.targets) === JSON.stringify(targets(row.issuedAtUtc)) &&
      row.issueKey ===
        sha(
          JSON.stringify([
            STUDY,
            row.routeKey,
            row.holder,
            row.qRaw,
            row.baseline.blockNumber,
            row.baseline.blockHash,
            row.baseline.sourceDigest,
          ]),
        ) &&
      row.scope === 'same_holder_same_q_eth_call_only' &&
      row.keyControlVerified === false &&
      row.forecast === false,
    'issue_invalid',
  )
}

function validateScore(row, issues) {
  const issue = issues[row.issueSequence - 1]
  const target = issue?.targets.find((item) => item.horizonHours === row.horizonHours)
  fail(
    row.study === STUDY &&
      row.kind === 'scores' &&
      issue &&
      target &&
      row.issueSha256 === issue.sha256 &&
      row.issueKey === issue.issueKey &&
      row.holder === issue.holder &&
      row.qRaw === issue.qRaw &&
      row.routeKey === issue.routeKey &&
      row.targetAtUtc === target.targetAtUtc &&
      row.deadlineAtUtc === target.deadlineAtUtc &&
      millis(row.scoredAtUtc) >= millis(target.targetAtUtc) &&
      ['measured', 'censored'].includes(row.status) &&
      row.forecast === false &&
      row.keyControlVerified === false &&
      (row.status === 'measured'
        ? Number.isSafeInteger(row.block?.number) &&
          row.block.number > issue.baseline.blockNumber &&
          BLOCK_HASH.test(row.block.hash) &&
          row.block.timestampMs >= millis(target.targetAtUtc) &&
          row.block.timestampMs <= millis(target.deadlineAtUtc) &&
          millis(row.scoredAtUtc) <= millis(target.deadlineAtUtc) &&
          ['simulated_callable', 'simulated_revert', 'balance_below_q'].includes(row.outcome) &&
          row.measurement?.source?.blockNumber === row.block.number &&
          lower(row.measurement.source.blockHash) === row.block.hash &&
          row.measurement.request?.assetsRaw === issue.qRaw &&
          row.measurement.position?.suppliedBalanceRaw === row.holderBalanceRaw &&
          typeof row.holderBalanceRaw === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(row.holderBalanceRaw) &&
          row.outcome ===
            (BigInt(row.holderBalanceRaw) < BigInt(issue.qRaw)
              ? 'balance_below_q'
              : row.measurement.simulation?.status === 'success'
                ? 'simulated_callable'
                : 'simulated_revert') &&
          (row.outcome === 'balance_below_q'
            ? ['not_holder_exit', 'evm_revert'].includes(row.measurement.simulation?.status)
            : row.measurement.simulation?.status ===
              (row.outcome === 'simulated_callable' ? 'success' : 'evm_revert'))
        : ['source_unavailable', 'holder_eligibility_unavailable', 'missed_target_window'].includes(
            row.reason,
          ) && row.outcome === null),
    'score_invalid',
  )
}

/** Strict SHA-chained, canonical replay; only an exact crash temp is ignored. */
export function readChain(kind, root = ROOT) {
  fail(['issues', 'scores', 'attempts'].includes(kind), 'chain_kind')
  const directory = join(root, kind)
  if (!existsSync(directory)) return []
  const allNames = readdirSync(directory)
  fail(allNames.length <= MAX_RECORDS + 32, 'ledger_bound')
  const names = allNames
    .filter(
      (name) =>
        !/^\.aave-holder-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
          name,
        ),
    )
    .sort()
  fail(allNames.length - names.length <= 32, 'ledger_temp_bound')
  fail(names.length <= MAX_RECORDS, 'ledger_bound')
  const rows = []
  for (const name of names) {
    fail(name === nameOf(rows.length + 1), 'ledger_filename')
    const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      fail(stat.isFile() && stat.size > 0 && stat.size <= MAX_RECORD_BYTES, 'ledger_file_bound')
      const contents = readFileSync(fd, 'utf8')
      fail(
        Buffer.byteLength(contents) === stat.size && fstatSync(fd).size === stat.size,
        'ledger_file_changed',
      )
      const row = JSON.parse(contents)
      fail(
        contents === `${JSON.stringify(row)}\n` &&
          row.study === STUDY &&
          row.kind === kind &&
          row.sequence === rows.length + 1 &&
          row.previousSha256 === (rows.at(-1)?.sha256 ?? null) &&
          HASH.test(row.sha256 ?? '') &&
          row.sha256 === sha(JSON.stringify(stripSeal(row))),
        'ledger_chain_invalid',
      )
      rows.push(row)
    } finally {
      closeSync(fd)
    }
  }
  return rows
}

export function verifyLedgers(root = ROOT) {
  const issues = readChain('issues', root)
  const scores = readChain('scores', root)
  const attempts = readChain('attempts', root)
  const slots = new Set()
  const issueKeys = new Set()
  const scoreKeys = new Set()
  for (const issue of issues) {
    validateIssue(issue)
    fail(!slots.has(issue.slot) && !issueKeys.has(issue.issueKey), 'issue_duplicate')
    slots.add(issue.slot)
    issueKeys.add(issue.issueKey)
  }
  for (const score of scores) {
    validateScore(score, issues)
    const key = `${score.issueSequence}:${score.horizonHours}`
    fail(!scoreKeys.has(key), 'score_duplicate')
    scoreKeys.add(key)
  }
  for (const attempt of attempts) {
    fail(
      ['issue', 'score'].includes(attempt.phase) &&
        ['source_unavailable', 'no_eligible_holder', 'holder_eligibility_unavailable'].includes(
          attempt.reason,
        ) &&
        Number.isSafeInteger(millis(attempt.atUtc)),
      'attempt_invalid',
    )
  }
  return { issues, scores, attempts }
}

export function append(kind, body, root = ROOT) {
  const directory = join(root, kind)
  mkdirSync(directory, { recursive: true })
  const chain = readChain(kind, root)
  fail(chain.length < MAX_RECORDS, 'ledger_bound')
  const row = {
    ...body,
    study: STUDY,
    kind,
    sequence: chain.length + 1,
    previousSha256: chain.at(-1)?.sha256 ?? null,
  }
  row.sha256 = sha(JSON.stringify(row))
  const serialized = `${JSON.stringify(row)}\n`
  fail(Buffer.byteLength(serialized) <= MAX_RECORD_BYTES, 'record_size')
  const disk = statfsSync(directory)
  fail(
    Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(serialized) >=
      (resolve(root) === ROOT ? DISK_RESERVE_BYTES : 0),
    'disk_reserve',
  )
  const temporary = join(directory, `.aave-holder-${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, serialized)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, join(directory, nameOf(row.sequence)))
    const dirFd = openSync(directory, constants.O_RDONLY)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return row
}

function sameBlock(left, right) {
  const a = {
    number: Number(left?.number),
    hash: lower(left?.hash),
    timestampMs: Number(left?.timestamp) * 1000,
  }
  const b = {
    number: Number(right?.number),
    hash: lower(right?.hash),
    timestampMs: Number(right?.timestamp) * 1000,
  }
  fail(
    Number.isSafeInteger(a.number) &&
      a.number >= 0 &&
      BLOCK_HASH.test(a.hash) &&
      Number.isSafeInteger(a.timestampMs) &&
      JSON.stringify(a) === JSON.stringify(b),
    'origin_block_disagreement',
  )
  return a
}

export async function commonFinalized(clients) {
  fail(
    Array.isArray(clients) && clients.length === 2 && clients[0] !== clients[1],
    'two_origins_required',
  )
  const heads = await Promise.all(
    clients.map((client) => client.getBlock({ blockTag: 'finalized' })),
  )
  const number = Math.min(...heads.map((head) => Number(head?.number)))
  fail(Number.isSafeInteger(number) && number > 0, 'finality_unavailable')
  const blocks = await Promise.all(
    clients.map((client) => client.getBlock({ blockNumber: BigInt(number) })),
  )
  return sameBlock(blocks[0], blocks[1])
}

function operatorOf(url) {
  const host = new URL(url).hostname.replace(/\.$/, '').replace(/^www\./, '')
  const known = [
    ['ankr.com', 'ankr'],
    ['drpc.live', 'drpc'],
    ['infura.io', 'infura'],
    ['alchemy.com', 'alchemy'],
    ['quiknode.pro', 'quicknode'],
    ['mevblocker.io', 'mevblocker'],
    ['flashbots.net', 'flashbots'],
  ]
  return known.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1]
}

function chosenOrigins() {
  const urls = preferredIndependentUrls(configuredPublicRpcUrls(readEnv()))
  const rpcOperators = urls.map(operatorOf)
  fail(rpcOperators.every(Boolean) && rpcOperators[0] !== rpcOperators[1], 'two_origins_required')
  return { clients: urls.map(makeClient), rpcOperators }
}

export async function issue({
  clients,
  root = ROOT,
  nowMs = Date.now(),
  clock = Date.now,
  load = loadVerifiedEndpoint,
  replay = replayJoin,
  assay = assayEndpoint,
  rpcOperators,
} = {}) {
  fail(Number.isSafeInteger(nowMs), 'clock_invalid')
  const { issues } = verifyLedgers(root)
  const slot = Math.floor(nowMs / SLOT_MS)
  if (issues.some((row) => row.slot === slot)) return { status: 'already_issued' }
  let loaded, sources, baseline, sourceBlock
  try {
    loaded = load()
    const joined = replay({ throughBlock: loaded.endpoint.blockNumber })
    sources = sourceManifest(joined)
    fail(
      joined.toBlock === loaded.endpoint.blockNumber &&
        lower(sources.manifest.joinedToHash) === lower(loaded.endpoint.blockHash) &&
        loaded.source?.joinedContentSha256 === sha(JSON.stringify(joined)),
      'source_endpoint_changed',
    )
    // The archived B must remain contemporaneous with the issue clock.
    const block = await commonFinalized(clients)
    fail(
      block.number >= loaded.endpoint.blockNumber &&
        nowMs - block.timestampMs >= -120_000 &&
        nowMs - block.timestampMs <= MAX_BASELINE_AGE_MS,
      'source_unavailable',
    )
    const historical = await Promise.all(
      clients.map((client) =>
        client.getBlock({ blockNumber: BigInt(loaded.endpoint.blockNumber) }),
      ),
    )
    sourceBlock = sameBlock(historical[0], historical[1])
    fail(
      sourceBlock.hash === lower(loaded.endpoint.blockHash) &&
        nowMs >= sourceBlock.timestampMs &&
        nowMs - sourceBlock.timestampMs <= MAX_BASELINE_AGE_MS,
      'source_unavailable',
    )
    baseline = await assay({
      endpoint: loaded.endpoint,
      candidates: loaded.candidates.slice(0, MAX_PROBE_CANDIDATES),
      clients,
      source: loaded.source,
      rpcOperators,
    })
  } catch {
    append('attempts', { phase: 'issue', reason: 'source_unavailable', atUtc: utc(clock()) }, root)
    return { status: 'source_unavailable' }
  }
  if (baseline.status !== 'same_holder_same_block_two_origin_assay') {
    append('attempts', { phase: 'issue', reason: 'no_eligible_holder', atUtc: utc(clock()) }, root)
    return { status: 'no_eligible_holder' }
  }
  fail(
    baseline.noDeployedCodeAtEndpoint === true &&
      JSON.stringify(baseline.rpcOperators) === JSON.stringify(rpcOperators) &&
      baseline.source?.joinedContentSha256 === loaded.source.joinedContentSha256 &&
      baseline.endpoint?.blockNumber === loaded.endpoint.blockNumber &&
      lower(baseline.endpoint?.blockHash) === lower(loaded.endpoint.blockHash) &&
      loaded.candidates
        .slice(0, MAX_PROBE_CANDIDATES)
        .some((row) => row.holder === lower(baseline.holder)) &&
      RAW.test(baseline.assetsRaw ?? '') &&
      RAW.test(baseline.balanceRaw ?? '') &&
      BigInt(baseline.assetsRaw) === FIXED_SMALL_Q_RAW &&
      BigInt(baseline.balanceRaw) >= FIXED_SMALL_Q_RAW,
    'baseline_assay_invalid',
  )
  const completed = clock()
  fail(Number.isSafeInteger(completed) && completed >= nowMs, 'clock_invalid')
  const issuedAtUtc = utc(completed)
  fail(
    completed >= sourceBlock.timestampMs &&
      completed - sourceBlock.timestampMs <= MAX_BASELINE_AGE_MS,
    'source_unavailable',
  )
  const issueSlot = Math.floor(completed / SLOT_MS)
  if (issues.some((row) => row.slot === issueSlot)) return { status: 'already_issued' }
  const body = {
    issuedAtUtc,
    slot: issueSlot,
    routeKey: MARKET.routeKey,
    destination: lower(MARKET.destination),
    underlying: lower(MARKET.underlying),
    holder: lower(baseline.holder),
    qRaw: baseline.assetsRaw,
    balanceRaw: baseline.balanceRaw,
    sourceManifest: sources.manifest,
    rpcOperators,
    baseline: {
      blockNumber: baseline.endpoint.blockNumber,
      blockHash: lower(baseline.endpoint.blockHash),
      blockTimeMs: sourceBlock.timestampMs,
      sourceDigest: sources.digest,
      joinedContentSha256: loaded.source.joinedContentSha256,
      simulation: baseline.simulation,
      noDeployedCodeAtEndpoint: baseline.noDeployedCodeAtEndpoint,
    },
    targets: targets(issuedAtUtc),
    scope: 'same_holder_same_q_eth_call_only',
    keyControlVerified: false,
    forecast: false,
  }
  body.issueKey = sha(
    JSON.stringify([
      STUDY,
      body.routeKey,
      body.holder,
      body.qRaw,
      body.baseline.blockNumber,
      body.baseline.blockHash,
      sources.digest,
    ]),
  )
  validateIssue({ ...body, study: STUDY, kind: 'issues' })
  const saved = append('issues', body, root)
  verifyLedgers(root)
  return { status: 'issued', sequence: saved.sequence, issueKey: saved.issueKey }
}

export function selectDue(issues, scores, nowMs) {
  const done = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  return (
    issues
      .flatMap((issue) =>
        issue.targets
          .filter(
            (target) =>
              nowMs >= millis(target.targetAtUtc) &&
              !done.has(`${issue.sequence}:${target.horizonHours}`),
          )
          .map((target) => ({ issue, target })),
      )
      .sort((a, b) => {
        const aOpen = nowMs <= millis(a.target.deadlineAtUtc)
        const bOpen = nowMs <= millis(b.target.deadlineAtUtc)
        return (
          Number(bOpen) - Number(aOpen) ||
          millis(a.target.targetAtUtc) - millis(b.target.targetAtUtc)
        )
      })[0] ?? null
  )
}

export function compareFutureQuotes(left, right, issue, block) {
  const shape = (quote) => ({
    status: quote?.status,
    chainId: quote?.source?.chainId,
    blockNumber: quote?.source?.blockNumber,
    blockHash: lower(quote?.source?.blockHash),
    routeKey: quote?.routeKey,
    marketKind: quote?.market?.kind,
    destination: lower(quote?.market?.address),
    underlying: lower(quote?.market?.assetAddress),
    marketIdentity: quote?.market?.identity,
    assetDecimals: quote?.market?.assetDecimals,
    holder: lower(quote?.owner),
    balanceRaw: quote?.position?.suppliedBalanceRaw,
    qRaw: quote?.request?.assetsRaw,
    simulation: quote?.simulation,
  })
  const a = shape(left)
  const b = shape(right)
  fail(
    a.status === 'checked_at_finalized_block' &&
      a.chainId === 1 &&
      a.blockNumber === block.number &&
      a.blockHash === block.hash &&
      a.routeKey === issue.routeKey &&
      a.marketKind === 'aaveV3Usdc' &&
      a.destination === lower(issue.destination) &&
      a.underlying === lower(issue.underlying) &&
      a.marketIdentity === 'pinned_market_and_live_underlying' &&
      a.assetDecimals === 6 &&
      a.holder === lower(issue.holder) &&
      b.holder === lower(issue.holder) &&
      RAW.test(a.qRaw ?? '') &&
      a.qRaw === issue.qRaw &&
      typeof a.balanceRaw === 'string' &&
      /^(0|[1-9][0-9]*)$/.test(a.balanceRaw) &&
      ['success', 'evm_revert', 'not_holder_exit'].includes(a.simulation?.status),
    'future_quote_identity_invalid',
  )
  fail(JSON.stringify(a) === JSON.stringify(b), 'future_quote_origin_disagreement')
  const belowQ = BigInt(a.balanceRaw) < BigInt(issue.qRaw)
  fail(
    belowQ
      ? ['not_holder_exit', 'evm_revert'].includes(a.simulation.status)
      : a.simulation.status !== 'not_holder_exit',
    'future_quote_balance_status_invalid',
  )
  return a
}

export async function score({
  clients,
  root = ROOT,
  nowMs = Date.now(),
  clock = Date.now,
  quoteReader = readDirectSupplyExitQuote,
  rpcOperators,
} = {}) {
  const { issues, scores, attempts } = verifyLedgers(root)
  const due = selectDue(issues, scores, nowMs)
  if (!due) return { status: 'nothing_due' }
  const { issue: original, target } = due
  fail(
    JSON.stringify(rpcOperators) === JSON.stringify(original.rpcOperators),
    'score_operator_mismatch',
  )
  const base = {
    issueSequence: original.sequence,
    issueSha256: original.sha256,
    issueKey: original.issueKey,
    holder: original.holder,
    qRaw: original.qRaw,
    routeKey: original.routeKey,
    horizonHours: target.horizonHours,
    targetAtUtc: target.targetAtUtc,
    deadlineAtUtc: target.deadlineAtUtc,
    keyControlVerified: false,
    forecast: false,
  }
  const persist = (body) => {
    const saved = append('scores', { ...base, scoredAtUtc: utc(clock()), ...body }, root)
    verifyLedgers(root)
    return {
      status: saved.status,
      outcome: saved.outcome,
      reason: saved.reason,
      sequence: saved.sequence,
    }
  }
  if (nowMs > millis(target.deadlineAtUtc)) {
    const lastFailure = attempts
      .filter(
        (row) =>
          row.phase === 'score' &&
          row.issueSequence === original.sequence &&
          row.horizonHours === target.horizonHours,
      )
      .at(-1)
    return persist({
      status: 'censored',
      reason: lastFailure?.reason ?? 'missed_target_window',
      outcome: null,
      block: null,
      measurement: null,
    })
  }
  let block
  try {
    block = await commonFinalized(clients)
  } catch {
    append(
      'attempts',
      {
        phase: 'score',
        reason: 'source_unavailable',
        atUtc: utc(clock()),
        issueSequence: original.sequence,
        horizonHours: target.horizonHours,
      },
      root,
    )
    return { status: 'source_unavailable' }
  }
  if (
    block.timestampMs < millis(target.targetAtUtc) ||
    block.number <= original.baseline.blockNumber
  )
    return { status: 'target_not_finalized' }
  if (block.timestampMs > millis(target.deadlineAtUtc))
    return { status: 'target_outside_window_pending_deadline' }
  const historical = {
    mode: 'internal_historical_finalized_block',
    blockNumber: BigInt(block.number),
    blockHash: block.hash,
  }
  const request = {
    routeKey: original.routeKey,
    destinationAddress: MARKET.destination,
    owner: original.holder,
    assetsRaw: original.qRaw,
  }
  let left, right
  try {
    ;[left, right] = await Promise.all(
      clients.map((client) => quoteReader(client, request, () => Date.now(), historical)),
    )
  } catch (error) {
    const eligibility = error?.message === 'direct_supply_exit_contract_holder_unavailable'
    append(
      'attempts',
      {
        phase: 'score',
        reason: eligibility ? 'holder_eligibility_unavailable' : 'source_unavailable',
        atUtc: utc(clock()),
        issueSequence: original.sequence,
        horizonHours: target.horizonHours,
      },
      root,
    )
    return { status: eligibility ? 'holder_eligibility_unavailable' : 'source_unavailable' }
  }
  let compared
  try {
    compared = compareFutureQuotes(left, right, original, block)
  } catch {
    append(
      'attempts',
      {
        phase: 'score',
        reason: 'source_unavailable',
        atUtc: utc(clock()),
        issueSequence: original.sequence,
        horizonHours: target.horizonHours,
      },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const doneAt = clock()
  if (doneAt > millis(target.deadlineAtUtc)) {
    append(
      'attempts',
      {
        phase: 'score',
        reason: 'source_unavailable',
        atUtc: utc(doneAt),
        issueSequence: original.sequence,
        horizonHours: target.horizonHours,
      },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const outcome =
    BigInt(compared.balanceRaw) < BigInt(original.qRaw)
      ? 'balance_below_q'
      : compared.simulation.status === 'success'
        ? 'simulated_callable'
        : 'simulated_revert'
  return persist({
    status: 'measured',
    reason: null,
    outcome,
    block,
    holderBalanceRaw: compared.balanceRaw,
    measurement: {
      source: { blockNumber: block.number, blockHash: block.hash },
      position: { suppliedBalanceRaw: compared.balanceRaw },
      request: { assetsRaw: original.qRaw },
      simulation: compared.simulation,
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2]
    fail(process.argv.length === 3 && ['--issue', '--score', '--verify'].includes(mode), 'usage')
    const result =
      mode === '--verify'
        ? {
            ...Object.fromEntries(
              Object.entries(verifyLedgers()).map(([key, rows]) => [key, rows.length]),
            ),
            forecast: false,
          }
        : await (mode === '--issue' ? issue : score)(chosenOrigins())
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const code =
      typeof error?.message === 'string' && /^aave_holder_[a-z_]+$/.test(error.message)
        ? error.message
        : 'aave_holder_rpc_or_source_unavailable'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}
