// Append-only, local receipt proofs for frozen Morpho VaultV2 Withdraw events.
// A flow event is not a holder payout until two distinct RPC origins agree on
// the finalized receipt and the underlying ERC20 Transfer matches the receiver.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'

import { readEnv } from './lib/venue-reads.mjs'
import { loadMorphoFlowSubjects } from './record-carry-morpho-v2-flows.mjs'
import {
  LOCAL_MORPHO_ROOT,
  verifyLocalMorphoEnrollment,
  verifyLocalMorphoVault,
} from './lib/localMorphoV2FlowStore.mjs'
import { canonicalJson, reconcileTransaction } from './reconcile-carry-morpho-v2-withdrawals.mjs'

export const LOCAL_MORPHO_PAYOUT_ROOT = resolve(
  'data/research/venue-signals/local-morpho-v2-payout-v1',
)
const STUDY = 'carry-morpho-v2-exact-vault-receipt-payout-v1'
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const TX_FILE = /^0x[0-9a-f]{64}\.json$/
const MAX_BYTES = 600_000
const RESERVE = 1024n * 1024n * 1024n
const ASSET = parseAbi(['function asset() view returns (address)'])
const lower = (value) => String(value ?? '').toLowerCase()
const sha = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const assert = (condition, reason) => {
  if (!condition) throw new Error(`local_morpho_payout_${reason}`)
}

export function rpcOrigin(url) {
  const parsed = new URL(url)
  assert(
    ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
    'origin_invalid',
  )
  const host = parsed.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(host) ? 'loopback' : host
}

export function candidateTransactions(subject, ranges) {
  const candidates = new Map()
  for (const range of ranges) {
    for (const event of range.events) {
      if (event.event_kind !== 'withdraw') continue
      const key = event.transaction_hash
      const entry = candidates.get(key) ?? {
        subject,
        rangeSha256: range.sha256,
        intervalFromBlock: range.fromBlock,
        vault: subject.vault,
        asset: subject.asset,
        block: event.block,
        blockHash: event.block_hash,
        transactionHash: key,
        rows: [],
      }
      assert(entry.rangeSha256 === range.sha256, 'transaction_spans_ranges')
      entry.rows.push({
        ...event,
        vault: subject.vault,
        asset: subject.asset,
        manifest_sha256: subject.manifestSha256,
        seed_sha256: subject.seedSha256,
        board_sha256: subject.boardSha256,
        displayed_routes_sha256: subject.displayedRoutesSha256,
        cohort_id: subject.cohortId,
        interval_from_block: range.fromBlock,
      })
      candidates.set(key, entry)
    }
  }
  return [...candidates.values()]
    .filter((entry) =>
      entry.rows.some((row) => row.flow_class === 'external_receiver_unreconciled'),
    )
    .sort(
      (a, b) =>
        Number(BigInt(a.block) - BigInt(b.block)) ||
        a.transactionHash.localeCompare(b.transactionHash),
    )
}

function normalizedLog(log) {
  return {
    address: lower(log.address),
    topics: log.topics.map(lower),
    data: lower(log.data),
    logIndex: Number(log.logIndex),
    blockHash: lower(log.blockHash),
    transactionHash: lower(log.transactionHash),
    transactionIndex: Number(log.transactionIndex),
    blockNumber: String(log.blockNumber),
  }
}

export function normalizedWitness({ receipt, header, finalized, liveAsset }) {
  return {
    receipt: {
      transactionHash: lower(receipt.transactionHash),
      blockNumber: String(receipt.blockNumber),
      blockHash: lower(receipt.blockHash),
      transactionIndex: Number(receipt.transactionIndex),
      status: receipt.status,
      logs: receipt.logs.map(normalizedLog),
    },
    header: { number: String(header.number), hash: lower(header.hash) },
    finalized: { number: String(finalized.number), hash: lower(finalized.hash) },
    liveAsset: lower(liveAsset),
  }
}

export async function collectWitness(client, candidate) {
  const [chainId, finalized, receipt, header] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: 'finalized' }),
    client.getTransactionReceipt({ hash: candidate.transactionHash }),
    client.getBlock({ blockNumber: BigInt(candidate.block) }),
  ])
  assert(chainId === 1, 'wrong_chain')
  assert(BigInt(finalized.number) >= BigInt(candidate.block), 'not_finalized')
  assert(lower(header.hash) === candidate.blockHash, 'header_disagrees')
  const call = await client.call({
    to: candidate.vault,
    data: encodeFunctionData({ abi: ASSET, functionName: 'asset' }),
    blockHash: header.hash,
  })
  const liveAsset = decodeFunctionResult({ abi: ASSET, functionName: 'asset', data: call.data })
  return normalizedWitness({ receipt, header, finalized, liveAsset })
}

// Finalized heads may advance between reads. The immutable transaction proof
// must agree exactly, while each independent finalized head must include it.
export function reconcileIndependent(candidate, first, second, origins) {
  assert(origins.length === 2 && origins[0] !== origins[1], 'origins_not_independent')
  const sameTransaction =
    canonicalJson({ receipt: first.receipt, header: first.header, liveAsset: first.liveAsset }) ===
    canonicalJson({ receipt: second.receipt, header: second.header, liveAsset: second.liveAsset })
  const a = reconcileTransaction(
    candidate.rows,
    first.receipt,
    first.header,
    first.finalized,
    first.liveAsset,
  )
  const b = reconcileTransaction(
    candidate.rows,
    second.receipt,
    second.header,
    second.finalized,
    second.liveAsset,
  )
  const agree =
    sameTransaction &&
    canonicalJson(
      a.map(({ status, reason, evidence }) => ({
        status,
        reason,
        group: evidence.group,
      })),
    ) ===
      canonicalJson(
        b.map(({ status, reason, evidence }) => ({
          status,
          reason,
          group: evidence.group,
        })),
      )
  return {
    status:
      agree &&
      a.some((proof) => proof.status === 'reconciled_external_supplier') &&
      a.every((proof) =>
        [
          'reconciled_external_supplier',
          'internal_vault_receiver',
          'internal_force_deallocate',
        ].includes(proof.status),
      )
        ? 'receipt_reconciled'
        : 'ambiguous',
    reason: !sameTransaction
      ? 'independent_receipts_disagree'
      : !agree
        ? 'independent_classification_disagrees'
        : 'receipt_classification',
    proofs: agree
      ? a.map(({ logIndex, status, reason, evidenceSha256 }) => ({
          logIndex,
          status,
          reason,
          evidenceSha256,
        }))
      : [],
  }
}

function pathFor(root, candidate) {
  return join(root, candidate.vault, `${candidate.transactionHash}.json`)
}

export function verifyLocalPayoutRecord(candidate, record) {
  assert(
    record.study === STUDY && record.kind === 'receipt' && record.chainId === 1,
    'identity_invalid',
  )
  assert(
    record.vault === candidate.vault &&
      record.asset === candidate.asset &&
      record.transactionHash === candidate.transactionHash &&
      record.block === candidate.block &&
      record.blockHash === candidate.blockHash &&
      record.rangeSha256 === candidate.rangeSha256 &&
      record.subjectSha256 === sha(candidate.subject) &&
      record.sourceRowsSha256 === sha(candidate.rows),
    'source_changed',
  )
  assert(
    SHA.test(record.sha256 ?? '') &&
      sha(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'sha256'))) ===
        record.sha256,
    'hash_mismatch',
  )
  assert(
    Array.isArray(record.origins) &&
      record.origins.length === 2 &&
      record.origins[0] !== record.origins[1],
    'origins_invalid',
  )
  assert(record.witnesses?.length === 2, 'witness_count_invalid')
  const outcome = reconcileIndependent(
    candidate,
    record.witnesses[0],
    record.witnesses[1],
    record.origins,
  )
  assert(canonicalJson(outcome) === canonicalJson(record.outcome), 'outcome_replay_mismatch')
  return record
}

function reserve(root, bytes) {
  let ancestor = root
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const disk = statfsSync(ancestor, { bigint: true })
  assert(disk.bavail * disk.bsize - BigInt(bytes) >= RESERVE, 'disk_reserve_reached')
}

export function appendLocalPayoutRecord(
  candidate,
  witnesses,
  origins,
  root = LOCAL_MORPHO_PAYOUT_ROOT,
) {
  const path = pathFor(root, candidate)
  assert(!existsSync(path), 'already_sealed')
  const body = {
    study: STUDY,
    kind: 'receipt',
    chainId: 1,
    vault: candidate.vault,
    asset: candidate.asset,
    transactionHash: candidate.transactionHash,
    block: candidate.block,
    blockHash: candidate.blockHash,
    rangeSha256: candidate.rangeSha256,
    subjectSha256: sha(candidate.subject),
    sourceRowsSha256: sha(candidate.rows),
    origins,
    witnesses,
    outcome: reconcileIndependent(candidate, witnesses[0], witnesses[1], origins),
  }
  const record = { ...body, sha256: sha(body) }
  const bytes = `${JSON.stringify(record)}\n`
  assert(Buffer.byteLength(bytes) <= MAX_BYTES, 'record_oversize')
  reserve(root, Buffer.byteLength(bytes))
  verifyLocalPayoutRecord(candidate, record)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, path)
    const dirFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return record
}

export function readLocalPayoutRecord(candidate, root = LOCAL_MORPHO_PAYOUT_ROOT) {
  const path = pathFor(root, candidate)
  if (!existsSync(path)) return null
  let fd
  let bytes
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    assert(stat.isFile() && stat.size <= MAX_BYTES, 'unsafe_file')
    bytes = readFileSync(fd, 'utf8')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  assert(Buffer.byteLength(bytes) <= MAX_BYTES, 'record_oversize')
  const record = JSON.parse(bytes)
  assert(bytes === `${JSON.stringify(record)}\n`, 'noncanonical_bytes')
  return verifyLocalPayoutRecord(candidate, record)
}

export function summarizeVerifiedMorphoPayoutsBySubject(subjects, candidates, existing) {
  const seen = new Set()
  for (const candidate of candidates) {
    const key = `${candidate.vault}:${candidate.transactionHash}`
    assert(!seen.has(key) && existing.get(key), 'subject_summary_missing_or_duplicate')
    seen.add(key)
  }
  return subjects.map((subject) => {
    assert(subject.routeKeys.length === 1, 'subject_route_ambiguous')
    return {
      routeKey: subject.routeKeys[0],
      destination: subject.vault,
      asset: subject.asset,
      reconciledTransactions: candidates.filter(
        (candidate) =>
          candidate.vault === subject.vault &&
          existing.get(`${candidate.vault}:${candidate.transactionHash}`).outcome.status ===
            'receipt_reconciled',
      ).length,
    }
  })
}

export async function runLocalPayout(argv = process.argv.slice(2), options = {}) {
  assert(argv.length === 1 && ['--run', '--verify', '--dry-run'].includes(argv[0]), 'usage')
  const subjects = await loadMorphoFlowSubjects()
  const enrollment = verifyLocalMorphoEnrollment(subjects, options.flowRoot ?? LOCAL_MORPHO_ROOT)
  assert(enrollment, 'flow_enrollment_missing')
  const candidates = subjects.flatMap((subject) =>
    candidateTransactions(
      subject,
      verifyLocalMorphoVault(subject, enrollment, options.flowRoot ?? LOCAL_MORPHO_ROOT),
    ),
  )
  const payoutRoot = options.payoutRoot ?? LOCAL_MORPHO_PAYOUT_ROOT
  const existing = new Map(
    candidates.map((candidate) => [
      `${candidate.vault}:${candidate.transactionHash}`,
      readLocalPayoutRecord(candidate, payoutRoot),
    ]),
  )
  // Unknown files cannot silently inflate route totals or hide a changed flow.
  if (existsSync(payoutRoot)) {
    for (const vault of readdirSync(payoutRoot)) {
      if (vault === '.DS_Store') {
        assert(lstatSync(join(payoutRoot, vault)).isFile(), 'unknown_vault_file')
        continue
      }
      assert(/^0x[0-9a-f]{40}$/.test(vault), 'unknown_vault_file')
      assert(lstatSync(join(payoutRoot, vault)).isDirectory(), 'unsafe_directory')
      for (const file of readdirSync(join(payoutRoot, vault))) {
        if (file === '.DS_Store') {
          assert(lstatSync(join(payoutRoot, vault, file)).isFile(), 'orphan_proof')
          continue
        }
        assert(TX_FILE.test(file) && existing.has(`${vault}:${file.slice(0, -5)}`), 'orphan_proof')
      }
    }
  }
  const statuses = {}
  for (const record of existing.values())
    if (record) statuses[record.outcome.status] = (statuses[record.outcome.status] ?? 0) + 1
  const remaining = candidates.filter(
    (candidate) => !existing.get(`${candidate.vault}:${candidate.transactionHash}`),
  )
  if (argv[0] !== '--run') {
    if (options.includeBySubject)
      assert(argv[0] === '--verify' && remaining.length === 0, 'subject_summary_incomplete')
    return {
      mode: argv[0],
      candidateTransactions: candidates.length,
      sealedTransactions: candidates.length - remaining.length,
      remainingTransactions: remaining.length,
      statuses,
      ...(options.includeBySubject
        ? {
            bySubject: summarizeVerifiedMorphoPayoutsBySubject(subjects, candidates, existing),
          }
        : {}),
    }
  }

  const { get } = readEnv()
  const rawUrls =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const urls = String(rawUrls ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const independent = [...new Map(urls.map((url) => [rpcOrigin(url), url])).entries()]
  assert(independent.length >= 2, 'two_origins_required')
  const clients = independent.map(([origin, url]) => ({
    origin,
    client:
      options.clientFactory?.(url) ??
      createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8_000, retryCount: 0 }),
      }),
  }))
  let processed = 0
  let attempted = 0
  let failed = 0
  const max = Math.min(Math.max(Number(options.maxTransactions ?? 32), 1), 32)
  const deadline =
    Date.now() + Math.min(Math.max(Number(options.timeBudgetMs ?? 180_000), 1), 180_000)
  // An archive RPC failure on one transaction must not starve later vaults.
  const start = remaining.length
    ? Math.floor(Number(options.startIndex ?? Date.now() / (30 * 60_000))) % remaining.length
    : 0
  const ordered = remaining.slice(start).concat(remaining.slice(0, start))
  for (const candidate of ordered) {
    if (attempted >= max || Date.now() >= deadline) break
    attempted++
    const observations = []
    for (const source of clients) {
      if (Date.now() >= deadline) break
      try {
        observations.push({
          origin: source.origin,
          witness: await collectWitness(source.client, candidate),
        })
      } catch {
        failed++
      }
      if (observations.length === 2) break
    }
    if (observations.length < 2) continue
    const record = appendLocalPayoutRecord(
      candidate,
      observations.map((row) => row.witness),
      observations.map((row) => row.origin),
      payoutRoot,
    )
    statuses[record.outcome.status] = (statuses[record.outcome.status] ?? 0) + 1
    processed++
  }
  assert(processed > 0 || attempted === 0 || failed === 0, 'origins_unavailable')
  return {
    mode: '--run',
    candidateTransactions: candidates.length,
    sealedTransactions: candidates.length - remaining.length + processed,
    remainingTransactions: remaining.length - processed,
    processedTransactions: processed,
    attemptedTransactions: attempted,
    originFailures: failed,
    statuses,
  }
}

export async function readVerifiedMorphoPayoutsByExactSubject(options = {}) {
  const result = await runLocalPayout(['--verify'], { ...options, includeBySubject: true })
  assert(result.bySubject.length === 49, 'subject_summary_shape')
  assert(
    result.bySubject.reduce((sum, row) => sum + row.reconciledTransactions, 0) ===
      (result.statuses.receipt_reconciled ?? 0),
    'subject_summary_count',
  )
  return result.bySubject
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalPayout()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${/^local_morpho_payout_[a-z_]+$/.test(error.message) ? error.message : 'local_morpho_payout_failed'}\n`,
      )
      process.exitCode = 1
    })
}
