// Local Mac, prospective gross-flow capture for the exact frozen 49 Morpho
// VaultV2 subjects. No database dependency. A receipt proves what this RPC
// returned for the requested finalized range; it does not prove a holder exit.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAbiItem, toEventHash } from 'viem'

import { makeClient, readEnv } from './lib/venue-reads.mjs'
import {
  collectFlowInterval,
  compareCombinedLogs,
  loadMorphoFlowSubjects,
  normalizeFlowLogs,
  orderSubjectsByCursor,
} from './record-carry-morpho-v2-flows.mjs'
import {
  appendLocalMorphoRange,
  enrollLocalMorpho,
  verifyLocalMorphoEnrollment,
  verifyLocalMorphoVault,
} from './lib/localMorphoV2FlowStore.mjs'

const ABI = [
  parseAbiItem(
    'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
  parseAbiItem(
    'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
  parseAbiItem(
    'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
  ),
]
const KINDS = ['deposit', 'withdraw', 'force']
const TOPICS = new Map(ABI.map((item, index) => [toEventHash(item).toLowerCase(), KINDS[index]]))
const HASH = /^0x[0-9a-f]{64}$/
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const CAPTURE_BUDGET_MS = 240_000
const MAX_INTERVALS = 49

function checkedHead(block, now = Date.now()) {
  const time = Number(block?.timestamp) * 1000
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 1n ||
    !HASH.test(block.hash?.toLowerCase() ?? '') ||
    !Number.isSafeInteger(time) ||
    time > now ||
    now - time > MAX_AGE_MS
  )
    throw new Error('local_morpho_finalized_head_invalid_or_stale')
  return block
}

async function checkExactAssets(client, subjects, block) {
  for (const subject of subjects) {
    const asset = await client.readContract({
      address: subject.vault,
      abi: [
        {
          type: 'function',
          name: 'asset',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'asset',
      blockNumber: block.number,
    })
    if (asset?.toLowerCase() !== subject.asset)
      throw new Error(`local_morpho_asset_changed:${subject.vault}`)
  }
}

function serializeRaw(log) {
  const kind = TOPICS.get(log.topics?.[0]?.toLowerCase())
  if (!kind || !HASH.test(log.blockHash?.toLowerCase() ?? '') || log.removed === true)
    throw new Error('local_morpho_raw_log_invalid')
  return {
    kind,
    address: log.address.toLowerCase(),
    blockNumber: String(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    topics: log.topics.map((value) => value.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}

export async function captureRawWitness(client, subject, payload) {
  const fromBlock = BigInt(payload.fromBlock)
  const toBlock = BigInt(payload.toBlock)
  const combined = await client.getLogs({
    address: subject.vault,
    events: ABI,
    fromBlock,
    toBlock,
  })
  const groups = { deposit: [], withdraw: [], force: [] }
  for (const log of combined) {
    const kind = TOPICS.get(log.topics?.[0]?.toLowerCase())
    if (!kind) throw new Error('local_morpho_raw_topic_invalid')
    groups[kind].push(log)
  }
  const digest = compareCombinedLogs(groups.deposit, groups.withdraw, groups.force, combined)
  if (digest !== payload.combinedSetSha256) throw new Error('local_morpho_raw_requery_disagrees')
  const decoded = normalizeFlowLogs(
    subject.vault,
    groups.deposit,
    groups.withdraw,
    groups.force,
    fromBlock,
    toBlock,
  )
  if (JSON.stringify(decoded) !== JSON.stringify(payload.events))
    throw new Error('local_morpho_raw_decoding_disagrees')
  const rawLogs = combined.map(serializeRaw)
  const eventBlocks = []
  for (const number of [...new Set(rawLogs.map((row) => row.blockNumber))].sort((a, b) =>
    Number(BigInt(a) - BigInt(b)),
  )) {
    const header = await client.getBlock({ blockNumber: BigInt(number) })
    const claimed = rawLogs.find((row) => row.blockNumber === number)?.blockHash
    if (header.number !== BigInt(number) || header.hash?.toLowerCase() !== claimed)
      throw new Error('local_morpho_event_header_disagrees')
    eventBlocks.push({ block: number, hash: claimed })
  }
  const [priorAgain, endAgain] = await Promise.all([
    client.getBlock({ blockNumber: fromBlock - 1n }),
    client.getBlock({ blockNumber: toBlock }),
  ])
  if (
    priorAgain.hash?.toLowerCase() !== payload.priorHash ||
    endAgain.hash?.toLowerCase() !== payload.toHash
  )
    throw new Error('local_morpho_range_reorg_after_raw')
  return { rawLogs, eventBlocks }
}

export async function runLocalMorpho(argv = process.argv.slice(2), options = {}) {
  if (argv.length !== 1 || !['--capture', '--verify'].includes(argv[0]))
    throw new Error('usage: node scripts/record-carry-morpho-v2-flows-local.mjs --capture|--verify')
  const subjects = await loadMorphoFlowSubjects()
  const enrollment = verifyLocalMorphoEnrollment(subjects, options.root)
  if (argv[0] === '--verify') {
    const coverage = subjects.map((subject) => ({
      vault: subject.vault,
      ranges: enrollment ? verifyLocalMorphoVault(subject, enrollment, options.root).length : 0,
    }))
    return {
      mode: 'verify',
      enrolled: !!enrollment,
      subjectCount: subjects.length,
      rangeCount: coverage.reduce((sum, row) => sum + row.ranges, 0),
      coverage,
    }
  }
  const { get } = readEnv()
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('local_morpho_rpc_required')
  const client = options.client ?? makeClient(rpc)
  if ((await client.getChainId()) !== 1) throw new Error('local_morpho_wrong_chain')
  const head = checkedHead(await client.getBlock({ blockTag: 'finalized' }))
  let anchor = enrollment
  if (!anchor) {
    await checkExactAssets(client, subjects, head)
    const again = await client.getBlock({ blockNumber: head.number })
    if (again.hash?.toLowerCase() !== head.hash?.toLowerCase())
      throw new Error('local_morpho_enrollment_reorg')
    anchor = enrollLocalMorpho(subjects, head, options.root)
    return {
      mode: 'capture',
      status: 'enrolled',
      block: anchor.block,
      subjectCount: subjects.length,
      rangeCount: 0,
    }
  }
  const byVault = new Map(
    subjects.map((subject) => {
      const prior = verifyLocalMorphoVault(subject, anchor, options.root).at(-1) ?? anchor
      return [
        subject.vault,
        {
          vault: subject.vault,
          last_block: prior.toBlock ?? prior.block,
          last_hash: prior.toHash ?? prior.blockHash,
        },
      ]
    }),
  )
  let captured = 0
  let events = 0
  const deadline = Date.now() + CAPTURE_BUDGET_MS
  for (const subject of orderSubjectsByCursor(subjects, byVault)) {
    if (Date.now() >= deadline || captured >= MAX_INTERVALS) break
    const cursor = byVault.get(subject.vault)
    if (BigInt(cursor.last_block) >= head.number) continue
    // Enrollment proves the initial asset only. Re-read at this capture head
    // so a route change cannot inherit the old identity.
    const liveAsset = await client.readContract({
      address: subject.vault,
      abi: [
        {
          type: 'function',
          name: 'asset',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'asset',
      blockNumber: head.number,
    })
    if (liveAsset?.toLowerCase() !== subject.asset)
      throw new Error(`local_morpho_asset_changed:${subject.vault}`)
    // A failed range never advances its local cursor. Later subjects may be
    // attempted in a later tick; this process exits nonzero for the failure.
    const payload = await collectFlowInterval(client, subject, cursor, head)
    if (!payload) continue
    const witness = await captureRawWitness(client, subject, payload)
    const headAgain = await client.getBlock({ blockNumber: head.number })
    if (headAgain.hash?.toLowerCase() !== head.hash?.toLowerCase())
      throw new Error('local_morpho_finalized_head_reorg')
    appendLocalMorphoRange(
      subject,
      anchor,
      payload,
      witness.rawLogs,
      witness.eventBlocks,
      options.root,
    )
    captured++
    events += payload.events.length
  }
  const remaining = [...byVault.values()].filter(
    (cursor) => BigInt(cursor.last_block) < head.number,
  ).length
  return {
    mode: 'capture',
    status: 'captured',
    finalizedBlock: String(head.number),
    subjectCount: subjects.length,
    rangesCaptured: captured,
    eventsCaptured: events,
    laggingAtStart: remaining,
    budgetExhausted: Date.now() >= deadline,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalMorpho()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}
