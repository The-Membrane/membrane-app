// Prospective borrower-authorized Twyne PT first-leg simulation only.
// No entry proves borrower key control, mined PT delivery, or USDe payout.
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
import * as borrowerModule from '../../lib/carry/twyneBorrowerExit.ts'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const readTwyneBorrowerExit =
  borrowerModule.readTwyneBorrowerExit ?? borrowerModule.default?.readTwyneBorrowerExit
const TWYNE_PT_BORROWER_DEPLOYMENT =
  borrowerModule.TWYNE_PT_BORROWER_DEPLOYMENT ??
  borrowerModule.default?.TWYNE_PT_BORROWER_DEPLOYMENT
if (
  typeof readTwyneBorrowerExit !== 'function' ||
  !TWYNE_PT_BORROWER_DEPLOYMENT ||
  typeof TWYNE_PT_BORROWER_DEPLOYMENT !== 'object'
)
  throw Error('twyne_borrower_pt_module_invalid')
export const STUDY = 'carry_twyne_borrower_pt_first_leg_v1'
export const ROOT = resolve('data/research/venue-signals/carry-twyne-borrower-pt-v1')
export const ROUTE = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'
export const ASSET = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
export const ORIGINS = Object.freeze(['https://rpc.ankr.com', 'https://lb.drpc.live'])
export const HORIZONS = Object.freeze([1, 4, 24, 168])
export const Q_RAW = '1000000000000000000' // 1 PT; fixed before reading the outcome.
export const WINDOW_HOURS = 2
const MAX_BYTES = 512 * 1024
const DISK_RESERVE = 1024 ** 3
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (condition, reason) => {
  if (!condition) throw Error(`twyne_borrower_pt_${reason}`)
}
const utc = (ms) => new Date(ms).toISOString()
const ms = (value) => {
  const parsed = Date.parse(value)
  fail(Number.isFinite(parsed) && utc(parsed) === value, 'clock')
  return parsed
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fileName = (n) => `${String(n).padStart(8, '0')}.json`
const stripSeal = ({ sha256: _seal, ...body }) => body
const SEED_TEXT = readFileSync(resolve('scripts/route-cohort/aug-2026-ab-vault-seed.json'), 'utf8')
export const SEED_SHA256 = sha(SEED_TEXT)
export const COLLATERAL_VAULTS = Object.freeze(
  [
    ...new Set(
      JSON.parse(SEED_TEXT)
        .positions.filter(
          (row) =>
            row.vault === '0x0af56afbddcb140323445bd7211ba90e54e5fd1c' &&
            row.routeIds?.includes(ROUTE),
        )
        .map((row) => row.owner.toLowerCase()),
    ),
  ].sort(),
)
fail(
  COLLATERAL_VAULTS.length === 16 && COLLATERAL_VAULTS.every((value) => ADDRESS.test(value)),
  'cohort',
)

export function configuredUrls(raw = readEnv().get('RECORDER_RPC_URL')) {
  const ring = String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const selected = ORIGINS.map((origin) => ring.find((value) => new URL(value).origin === origin))
  fail(selected.every(Boolean), 'two_origins_required')
  return selected
}

export function readChain(kind, root = ROOT) {
  fail(['issues', 'scores', 'attempts'].includes(kind), 'kind')
  const path = join(root, kind)
  if (!existsSync(path)) return []
  // An interrupted atomic append can leave its pre-link temp file behind.
  // Ignore only our exact temp naming scheme; every other stray entry fails closed.
  const names = readdirSync(path)
    .filter((name) => {
      if (
        /^\.twyne-borrower-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
          name,
        )
      )
        return false
      return true
    })
    .sort()
  fail(names.length <= 100_000, 'ledger_bound')
  const rows = []
  for (const name of names) {
    fail(name === fileName(rows.length + 1), 'ledger_filename')
    const fd = openSync(join(path, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd)
      fail(before.isFile() && before.size > 0 && before.size <= MAX_BYTES, 'ledger_file')
      const text = readFileSync(fd, 'utf8')
      fail(
        Buffer.byteLength(text) === before.size && fstatSync(fd).size === before.size,
        'ledger_changed',
      )
      const row = JSON.parse(text)
      fail(
        text === `${JSON.stringify(row)}\n` &&
          row.study === STUDY &&
          row.kind === kind &&
          row.sequence === rows.length + 1 &&
          row.previousSha256 === (rows.at(-1)?.sha256 ?? null) &&
          SHA.test(row.sha256 ?? '') &&
          sha(JSON.stringify(stripSeal(row))) === row.sha256,
        'ledger_chain',
      )
      rows.push(row)
    } finally {
      closeSync(fd)
    }
  }
  return rows
}

export function append(kind, body, root = ROOT) {
  const path = join(root, kind)
  mkdirSync(path, { recursive: true })
  const chain = readChain(kind, root)
  const row = {
    ...body,
    study: STUDY,
    kind,
    sequence: chain.length + 1,
    previousSha256: chain.at(-1)?.sha256 ?? null,
  }
  row.sha256 = sha(JSON.stringify(row))
  const serialized = `${JSON.stringify(row)}\n`
  fail(Buffer.byteLength(serialized) <= MAX_BYTES, 'record_size')
  const disk = statfsSync(path)
  fail(
    Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(serialized) >=
      (resolve(root) === ROOT ? DISK_RESERVE : 0),
    'disk_reserve',
  )
  const temporary = join(path, `.twyne-borrower-${randomUUID()}.tmp`)
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
    linkSync(temporary, join(path, fileName(row.sequence)))
    const dirFd = openSync(path, constants.O_RDONLY)
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

const blockShape = (block) => ({
  number: Number(block.number),
  hash: String(block.hash ?? '').toLowerCase(),
  timestamp: Number(block.timestamp),
})

export async function commonFinalized(clients, nowMs = Date.now()) {
  fail(clients?.length === 2, 'origin_count')
  const heads = await Promise.all(
    clients.map((client) => client.getBlock({ blockTag: 'finalized' })),
  )
  const target = Math.min(...heads.map((row) => Number(row.number)))
  fail(Number.isSafeInteger(target) && target > 0, 'finality')
  const blocks = await Promise.all(
    clients.map((client) => client.getBlock({ blockNumber: BigInt(target) })),
  )
  const left = blockShape(blocks[0])
  fail(
    same(left, blockShape(blocks[1])) &&
      HASH.test(left.hash) &&
      nowMs - left.timestamp * 1000 >= -120_000 &&
      nowMs - left.timestamp * 1000 <= 7_200_000,
    'finalized_disagreement',
  )
  return left
}

function pinnedClient(client, block) {
  return {
    getChainId: () => client.getChainId(),
    getBlock: (args) =>
      args.blockTag === 'finalized'
        ? Promise.resolve({
            number: BigInt(block.number),
            hash: block.hash,
            timestamp: BigInt(block.timestamp),
          })
        : client.getBlock(args),
    getCode: (args) => client.getCode(args),
    getStorageAt: (args) => client.getStorageAt(args),
    readContract: (args) => client.readContract(args),
    call: (args) => client.call(args),
  }
}

export function normalize(result) {
  const e = result?.evidence
  fail(
    ['observed', 'restricted', 'unsupported'].includes(result?.status) &&
      result.routeKey === ROUTE &&
      COLLATERAL_VAULTS.includes(result.collateralVault?.toLowerCase()) &&
      result.requestedPtRaw === Q_RAW &&
      (result.borrower === null || ADDRESS.test(result.borrower?.toLowerCase())) &&
      e?.chainId === 1 &&
      Number.isSafeInteger(e.blockNumber) &&
      HASH.test(e.blockHash?.toLowerCase() ?? '') &&
      Number.isSafeInteger(e.blockTimestamp) &&
      e.source === 'ethereum_finalized_eip1898_eth_call' &&
      e.firstLeg === 'twyne_cv_redeem_underlying_pt' &&
      e.receiver === 'borrower' &&
      e.borrowerKeyControl === 'unassessed' &&
      e.finalUsdePayout === 'unassessed' &&
      e.deploymentSourceEquivalence === 'unassessed' &&
      (result.status !== 'observed' ||
        (result.reason == null &&
          DECIMAL.test(e.returnedPtRaw ?? '') &&
          BigInt(e.returnedPtRaw) >= BigInt(Q_RAW))),
    'measurement',
  )
  return {
    status: result.status,
    reason: result.reason ?? null,
    routeKey: ROUTE,
    collateralVault: result.collateralVault.toLowerCase(),
    borrower: result.borrower?.toLowerCase() ?? null,
    requestedPtRaw: Q_RAW,
    evidence: {
      ...e,
      blockHash: e.blockHash.toLowerCase(),
      factory: e.factory?.toLowerCase() ?? null,
      beacon: e.beacon?.toLowerCase() ?? null,
      collateralVaultImplementation: e.collateralVaultImplementation?.toLowerCase() ?? null,
      asset: e.asset?.toLowerCase() ?? null,
      targetAsset: e.targetAsset?.toLowerCase() ?? null,
      targetVault: e.targetVault?.toLowerCase() ?? null,
      intermediateVault: e.intermediateVault?.toLowerCase() ?? null,
      aToken: e.aToken?.toLowerCase() ?? null,
    },
  }
}

export async function assayPair(clients, block, collateralVault, read = readTwyneBorrowerExit) {
  fail(clients?.length === 2 && COLLATERAL_VAULTS.includes(collateralVault), 'assay_subject')
  const request = { routeKey: ROUTE, collateralVault, requestedPtRaw: Q_RAW }
  const results = await Promise.all(
    clients.map((client) =>
      read(
        pinnedClient(client, block),
        request,
        TWYNE_PT_BORROWER_DEPLOYMENT,
        block.timestamp * 1000,
      ),
    ),
  )
  const left = normalize(results[0])
  fail(
    same(left, normalize(results[1])) &&
      left.evidence.blockNumber === block.number &&
      left.evidence.blockHash === block.hash &&
      left.evidence.blockTimestamp === block.timestamp,
    'assay_origin_disagreement',
  )
  return left
}

export function issueKey({ collateralVault, borrower, blockHash }) {
  fail(
    COLLATERAL_VAULTS.includes(collateralVault) && ADDRESS.test(borrower) && HASH.test(blockHash),
    'issue_key_input',
  )
  return sha(
    JSON.stringify([STUDY, SEED_SHA256, ROUTE, collateralVault, borrower, Q_RAW, blockHash]),
  )
}

export function targets(issuedAtUtc) {
  return HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: utc(ms(issuedAtUtc) + horizonHours * 3_600_000),
    deadlineAtUtc: utc(ms(issuedAtUtc) + (horizonHours + WINDOW_HOURS) * 3_600_000),
  }))
}

export function verifyLedgers(root = ROOT) {
  const issues = readChain('issues', root)
  const scores = readChain('scores', root)
  const attempts = readChain('attempts', root)
  const slots = new Set()
  const keys = new Set()
  for (const issue of issues) {
    const b = issue.baseline
    const slot = `${issue.slot}:${issue.collateralVault}`
    fail(
      issue.seedSha256 === SEED_SHA256 &&
        issue.routeKey === ROUTE &&
        issue.asset === ASSET &&
        issue.qRaw === Q_RAW &&
        COLLATERAL_VAULTS.includes(issue.collateralVault) &&
        ADDRESS.test(issue.borrower ?? '') &&
        same(issue.origins, ORIGINS) &&
        issue.scope === 'borrower_pt_first_leg_simulation_only' &&
        Number.isSafeInteger(issue.slot) &&
        issue.slot === Math.floor(ms(issue.issuedAtUtc) / 1_800_000) &&
        !slots.has(slot) &&
        !keys.has(issue.issueKey) &&
        b?.number > 0 &&
        HASH.test(b.hash ?? '') &&
        Number.isSafeInteger(b.timestamp) &&
        ms(issue.issuedAtUtc) >= b.timestamp * 1000 &&
        ms(issue.issuedAtUtc) - b.timestamp * 1000 <= 7_200_000 &&
        issue.issueKey ===
          issueKey({
            collateralVault: issue.collateralVault,
            borrower: issue.borrower,
            blockHash: b.hash,
          }) &&
        same(issue.targets, targets(issue.issuedAtUtc)) &&
        same(issue.measurement, normalize(issue.measurement)) &&
        issue.measurement.status !== 'unsupported' &&
        issue.measurement.borrower === issue.borrower &&
        issue.measurement.evidence.blockNumber === b.number &&
        issue.measurement.evidence.blockHash === b.hash &&
        issue.measurement.evidence.blockTimestamp === b.timestamp,
      'issue_invalid',
    )
    slots.add(slot)
    keys.add(issue.issueKey)
  }
  const scored = new Set()
  for (const score of scores) {
    const issue = issues[score.issueSequence - 1]
    const target = issue?.targets.find((value) => value.horizonHours === score.horizonHours)
    const key = `${score.issueSequence}:${score.horizonHours}`
    fail(
      issue &&
        target &&
        !scored.has(key) &&
        score.issueSha256 === issue.sha256 &&
        score.issueKey === issue.issueKey &&
        score.seedSha256 === SEED_SHA256 &&
        score.routeKey === ROUTE &&
        score.collateralVault === issue.collateralVault &&
        score.borrower === issue.borrower &&
        score.qRaw === issue.qRaw &&
        score.targetAtUtc === target.targetAtUtc &&
        score.deadlineAtUtc === target.deadlineAtUtc &&
        score.scope === 'borrower_pt_first_leg_simulation_only' &&
        same(score.origins, ORIGINS) &&
        ms(score.scoredAtUtc) >= ms(target.targetAtUtc) &&
        Number.isSafeInteger(score.block?.number) &&
        score.block.number > issue.baseline.number &&
        HASH.test(score.block?.hash ?? '') &&
        Number.isSafeInteger(score.block?.timestamp),
      'score_binding',
    )
    scored.add(key)
    if (score.status === 'censored') {
      fail(
        score.reason === 'missed_physical_window' &&
          score.measurement === null &&
          !Object.hasOwn(score, 'outcome') &&
          score.block.timestamp * 1000 > ms(target.deadlineAtUtc) &&
          ms(score.scoredAtUtc) > ms(target.deadlineAtUtc),
        'score_censor',
      )
      continue
    }
    fail(
      score.status === 'measured' &&
        ms(score.scoredAtUtc) <= ms(target.deadlineAtUtc) &&
        score.block.timestamp * 1000 >= ms(target.targetAtUtc) &&
        score.block.timestamp * 1000 <= ms(target.deadlineAtUtc) &&
        same(score.measurement, normalize(score.measurement)) &&
        score.measurement.collateralVault === issue.collateralVault &&
        score.measurement.evidence.blockNumber === score.block.number &&
        score.measurement.evidence.blockHash === score.block.hash &&
        score.measurement.evidence.blockTimestamp === score.block.timestamp &&
        score.outcome ===
          (score.measurement.borrower === null || score.measurement.status === 'unsupported'
            ? 'unavailable'
            : score.measurement.borrower !== issue.borrower
              ? 'controller_changed'
              : score.measurement.status === 'observed'
                ? 'pt_first_leg_simulated'
                : 'restricted'),
      'score_measurement',
    )
  }
  for (const attempt of attempts)
    fail(
      ['issue', 'score'].includes(attempt.phase) &&
        ['source_unavailable', 'identity_unavailable', 'target_not_finalized'].includes(
          attempt.reason,
        ) &&
        ms(attempt.atUtc) > 0,
      'attempt_invalid',
    )
  return { issues, scores, attempts }
}

export async function issue({
  clients,
  nowMs = Date.now(),
  clock = Date.now,
  root = ROOT,
  collateralVault = COLLATERAL_VAULTS[Math.floor(nowMs / 1_800_000) % COLLATERAL_VAULTS.length],
  read = readTwyneBorrowerExit,
} = {}) {
  fail(COLLATERAL_VAULTS.includes(collateralVault), 'issue_subject')
  const { issues } = verifyLedgers(root)
  if (
    issues.some(
      (row) =>
        row.collateralVault === collateralVault && row.slot === Math.floor(nowMs / 1_800_000),
    )
  )
    return { status: 'already_issued' }
  let block, measurement
  try {
    block = await commonFinalized(clients, nowMs)
    measurement = await assayPair(clients, block, collateralVault, read)
  } catch {
    append(
      'attempts',
      { phase: 'issue', reason: 'source_unavailable', atUtc: utc(clock()), collateralVault },
      root,
    )
    return { status: 'source_unavailable' }
  }
  if (!measurement.borrower || measurement.status === 'unsupported') {
    append(
      'attempts',
      {
        phase: 'issue',
        reason: 'identity_unavailable',
        atUtc: utc(clock()),
        collateralVault,
        block,
        measurement,
      },
      root,
    )
    return { status: 'identity_unavailable' }
  }
  const completedAt = clock()
  fail(Number.isSafeInteger(completedAt) && completedAt >= nowMs, 'completion_clock')
  if (completedAt - block.timestamp * 1000 > 7_200_000) {
    append(
      'attempts',
      {
        phase: 'issue',
        reason: 'source_unavailable',
        atUtc: utc(completedAt),
        collateralVault,
        block,
      },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const issuedAtUtc = utc(completedAt)
  const slot = Math.floor(completedAt / 1_800_000)
  if (issues.some((row) => row.collateralVault === collateralVault && row.slot === slot))
    return { status: 'already_issued' }
  const key = issueKey({ collateralVault, borrower: measurement.borrower, blockHash: block.hash })
  if (issues.some((row) => row.issueKey === key)) return { status: 'already_issued_on_block' }
  const saved = append(
    'issues',
    {
      issuedAtUtc,
      slot,
      seedSha256: SEED_SHA256,
      issueKey: key,
      routeKey: ROUTE,
      collateralVault,
      borrower: measurement.borrower,
      asset: ASSET,
      qRaw: Q_RAW,
      origins: ORIGINS,
      baseline: block,
      measurement,
      targets: targets(issuedAtUtc),
      scope: 'borrower_pt_first_leg_simulation_only',
    },
    root,
  )
  verifyLedgers(root)
  return { status: 'issued', sequence: saved.sequence, collateralVault }
}

export async function score({
  clients,
  nowMs = Date.now(),
  clock = Date.now,
  root = ROOT,
  read = readTwyneBorrowerExit,
} = {}) {
  const { issues, scores } = verifyLedgers(root)
  const completed = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  const due = issues
    .flatMap((issue) =>
      issue.targets
        .filter(
          (target) =>
            nowMs >= ms(target.targetAtUtc) &&
            !completed.has(`${issue.sequence}:${target.horizonHours}`),
        )
        .map((target) => ({ issue, target })),
    )
    .sort((a, b) => {
      const aOpen = nowMs <= ms(a.target.deadlineAtUtc)
      const bOpen = nowMs <= ms(b.target.deadlineAtUtc)
      if (aOpen !== bOpen) return aOpen ? -1 : 1
      return ms(a.target.targetAtUtc) - ms(b.target.targetAtUtc)
    })[0]
  if (!due) return { status: 'nothing_due' }
  const { issue: original, target } = due
  const base = {
    issueSequence: original.sequence,
    issueSha256: original.sha256,
    issueKey: original.issueKey,
    seedSha256: SEED_SHA256,
    routeKey: ROUTE,
    collateralVault: original.collateralVault,
    borrower: original.borrower,
    qRaw: original.qRaw,
    horizonHours: target.horizonHours,
    targetAtUtc: target.targetAtUtc,
    deadlineAtUtc: target.deadlineAtUtc,
    origins: ORIGINS,
    scope: 'borrower_pt_first_leg_simulation_only',
  }
  let block
  try {
    block = await commonFinalized(clients, nowMs)
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
  if (block.number <= original.baseline.number || block.timestamp * 1000 < ms(target.targetAtUtc))
    return { status: 'target_not_finalized' }
  if (block.timestamp * 1000 > ms(target.deadlineAtUtc)) {
    // A finalized block can be up to two minutes ahead of the local clock.
    // Do not censor until both the local capture clock and chain time are late.
    if (nowMs <= ms(target.deadlineAtUtc)) return { status: 'target_not_finalized' }
    const completedAt = clock()
    fail(Number.isSafeInteger(completedAt) && completedAt >= nowMs, 'completion_clock')
    const scoredAtUtc = utc(completedAt)
    const saved = append(
      'scores',
      {
        ...base,
        scoredAtUtc,
        status: 'censored',
        reason: 'missed_physical_window',
        block,
        measurement: null,
      },
      root,
    )
    verifyLedgers(root)
    return { status: 'censored', sequence: saved.sequence }
  }
  let measurement
  try {
    measurement = await assayPair(clients, block, original.collateralVault, read)
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
  const completedAt = clock()
  fail(Number.isSafeInteger(completedAt) && completedAt >= nowMs, 'completion_clock')
  const scoredAtUtc = utc(completedAt)
  if (ms(scoredAtUtc) > ms(target.deadlineAtUtc)) {
    append(
      'attempts',
      {
        phase: 'score',
        reason: 'source_unavailable',
        atUtc: scoredAtUtc,
        issueSequence: original.sequence,
        horizonHours: target.horizonHours,
      },
      root,
    )
    return { status: 'source_unavailable' }
  }
  const outcome =
    measurement.borrower === null || measurement.status === 'unsupported'
      ? 'unavailable'
      : measurement.borrower !== original.borrower
        ? 'controller_changed'
        : measurement.status === 'observed'
          ? 'pt_first_leg_simulated'
          : 'restricted'
  const saved = append(
    'scores',
    { ...base, scoredAtUtc, status: 'measured', outcome, block, measurement },
    root,
  )
  verifyLedgers(root)
  return { status: 'measured', outcome, sequence: saved.sequence }
}

export function publicCounts(root = ROOT) {
  const { issues, scores, attempts } = verifyLedgers(root)
  return {
    study: STUDY,
    frozenCollateralVaults: COLLATERAL_VAULTS.length,
    issued: issues.length,
    measured: scores.filter((row) => row.status === 'measured').length,
    controllerChanges: scores.filter((row) => row.outcome === 'controller_changed').length,
    censored: scores.filter((row) => row.status === 'censored').length,
    pending: issues.length * HORIZONS.length - scores.length,
    attempts: attempts.length,
    scope: 'borrower_pt_first_leg_simulation_only',
    holderExitForecastValidated: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  try {
    fail(process.argv.length === 3 && ['--issue', '--score', '--verify'].includes(mode), 'usage')
    const result =
      mode === '--verify'
        ? publicCounts()
        : await (mode === '--issue' ? issue : score)({ clients: configuredUrls().map(makeClient) })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write('twyne_borrower_pt_failed\n')
    process.exitCode = 1
  }
}
