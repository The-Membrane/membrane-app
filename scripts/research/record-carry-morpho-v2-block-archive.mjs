// Retrospective, block-major VaultV2 gross-flow research archive. No forecast writes.
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbiItem, toEventHash } from 'viem'
import { mainnet } from 'viem/chains'
import { readEnv } from '../lib/venue-reads.mjs'
import { loadMorphoFlowSubjects } from '../record-carry-morpho-v2-flows.mjs'

export const ROOT = resolve('data/research/venue-signals/local-morpho-v2-block-flow-v1')
export const CAMPAIGN_ROOT = resolve('data/research/venue-signals/local-morpho-v2-block-flow-v2')
const STUDY = 'carry-morpho-v2-retrospective-block-gross-flow-v1'
const CAMPAIGN_STUDY = 'carry-morpho-v2-retrospective-block-gross-flow-v2'
const MAX_BYTES = 16 * 1024 * 1024
const RESERVE = 1024n ** 3n
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const TOPICS = Object.fromEntries(
  Object.entries({
    deposit:
      'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
    withdraw:
      'event Withdraw(address indexed sender,address indexed receiver,address indexed onBehalf,uint256 assets,uint256 shares)',
    force:
      'event ForceDeallocate(address indexed sender,address adapter,uint256 assets,address indexed onBehalf,bytes32[] ids,uint256 penaltyAssets)',
  }).map(([kind, abi]) => [kind, toEventHash(parseAbiItem(abi)).toLowerCase()]),
)
const DIGEST = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const fail = (code) => {
  throw Error(`morpho_block_archive_${code}`)
}
const check = (yes, code) => {
  if (!yes) fail(code)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const hex = (number) => `0x${BigInt(number).toString(16)}`
const filename = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const header = (block) => ({
  block: String(block.number),
  hash: block.hash?.toLowerCase(),
  timestamp: String(block.timestamp),
})
const sortable = (a, b) =>
  Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
  a.transactionIndex - b.transactionIndex ||
  a.logIndex - b.logIndex

export function rpcOrigin(url) {
  const parsed = new URL(url)
  check(
    ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
    'bad_origin',
  )
  return parsed.hostname.toLowerCase().replace(/\.$/, '')
}
function storageReserve(root, bytes) {
  let parent = root
  while (!existsSync(parent)) parent = dirname(parent)
  const stat = statfsSync(parent, { bigint: true })
  check(stat.bavail * stat.bsize - BigInt(bytes) >= RESERVE, 'disk_reserve')
}
export function publish(path, body) {
  const record = { ...body, sha256: DIGEST(body) }
  const bytes = `${JSON.stringify(record)}\n`
  check(Buffer.byteLength(bytes) <= MAX_BYTES, 'bundle_oversize')
  storageReserve(dirname(path), Buffer.byteLength(bytes))
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
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return record
}
function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size <= MAX_BYTES, 'unsafe_file')
    bytes = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  const record = JSON.parse(bytes)
  check(bytes === `${JSON.stringify(record)}\n`, 'noncanonical_file')
  const { sha256, ...body } = record
  check(SHA.test(sha256 ?? '') && DIGEST(body) === sha256, 'digest_mismatch')
  return record
}
function normalizedRaw(log) {
  return {
    address: String(log.address).toLowerCase(),
    blockNumber: String(BigInt(log.blockNumber)),
    blockHash: String(log.blockHash).toLowerCase(),
    transactionHash: String(log.transactionHash).toLowerCase(),
    transactionIndex: Number(BigInt(log.transactionIndex)),
    logIndex: Number(BigInt(log.logIndex)),
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}
function validateRaw(rows, from, to, subjects) {
  const addresses = new Set(subjects.map((subject) => subject.vault))
  const known = new Set(Object.values(TOPICS))
  const keys = new Set()
  for (const row of rows) {
    check(
      addresses.has(row.address) &&
        known.has(row.topics[0]) &&
        HASH.test(row.blockHash) &&
        HASH.test(row.transactionHash),
      'raw_identity',
    )
    check(
      BigInt(row.blockNumber) >= BigInt(from) && BigInt(row.blockNumber) <= BigInt(to),
      'raw_range',
    )
    check(
      Number.isSafeInteger(row.transactionIndex) && Number.isSafeInteger(row.logIndex),
      'raw_index',
    )
    const key = `${row.transactionHash}:${row.logIndex}`
    check(!keys.has(key), 'raw_duplicate')
    keys.add(key)
  }
  check(same(rows, [...rows].sort(sortable)), 'raw_order')
}
export function classifySubjects(subjects, manifest, from, to, raw) {
  const counts = new Map()
  for (const row of raw) {
    const key = `${row.address}:${Object.keys(TOPICS).find((kind) => TOPICS[kind] === row.topics[0])}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return subjects.map((subject) => {
    const creation = manifest.get(subject.vault)
    const state =
      creation === undefined ? 'unavailable' : creation > BigInt(to) ? 'predeployment' : 'deployed'
    return {
      vault: subject.vault,
      asset: subject.asset,
      routeKeys: subject.routeKeys,
      state,
      creationBlock: creation?.toString() ?? null,
      observedFromBlock:
        state === 'deployed' ? String(creation > BigInt(from) ? creation : BigInt(from)) : null,
      counts:
        state === 'deployed'
          ? Object.fromEntries(
              Object.keys(TOPICS).map((kind) => [
                kind,
                counts.get(`${subject.vault}:${kind}`) ?? 0,
              ]),
            )
          : null,
    }
  })
}
function validateEnrollment(enrollment, subjects, campaign, predecessorSha256) {
  check(
    enrollment.study === (campaign ? CAMPAIGN_STUDY : STUDY) &&
      enrollment.kind === 'enrollment' &&
      enrollment.chainId === 1 &&
      (!campaign || enrollment.predecessorArchiveSha256 === predecessorSha256),
    'enrollment_identity',
  )
  check(subjects.length === 49 && same(enrollment.subjects, subjects), 'route_drift')
  check(
    BigInt(enrollment.campaignEndBlock) >= BigInt(enrollment.startBlock) &&
      HASH.test(enrollment.startHash) &&
      HASH.test(enrollment.campaignEndHash),
    'campaign_invalid',
  )
}
function validateBundle(bundle, enrollment, previous, sequence, subjects, manifest, campaign) {
  check(
    bundle.study === (campaign ? CAMPAIGN_STUDY : STUDY) &&
      bundle.kind === 'bundle' &&
      bundle.chainId === 1 &&
      bundle.sequence === sequence,
    'bundle_identity',
  )
  check(
    bundle.enrollmentSha256 === enrollment.sha256 && bundle.previousSha256 === previous.sha256,
    'bundle_chain',
  )
  check(
    bundle.fromBlock === String(BigInt(previous.toBlock ?? enrollment.startBlock) + 1n) &&
      bundle.priorHash === (previous.toHash ?? enrollment.startHash),
    'cursor_gap',
  )
  check(
    BigInt(bundle.toBlock) >= BigInt(bundle.fromBlock) &&
      BigInt(bundle.toBlock) - BigInt(bundle.fromBlock) < (campaign ? 512n : 64n) &&
      BigInt(bundle.toBlock) <= BigInt(enrollment.campaignEndBlock),
    'range_invalid',
  )
  check(
    bundle.firstLocalReceiptAt &&
      bundle.researchOnly === true &&
      bundle.prospectiveValidated === false &&
      bundle.holderExecutableExit === false,
    'claim_invalid',
  )
  check(
    bundle.slices.length ===
      Math.ceil((Number(bundle.toBlock) - Number(bundle.fromBlock) + 1) / 10),
    'slice_count',
  )
  let sliceFrom = BigInt(bundle.fromBlock)
  for (const [sliceIndex, slice] of bundle.slices.entries()) {
    check(
      slice.fromBlock === String(sliceFrom) && BigInt(slice.toBlock) - sliceFrom < 10n,
      'slice_gap',
    )
    check(
      slice.headers.length === 2 &&
        slice.headers[0].origin !== slice.headers[1].origin &&
        same(slice.headers[0].prior, slice.headers[1].prior) &&
        same(slice.headers[0].end, slice.headers[1].end),
      'header_disagreement',
    )
    check(
      slice.headers[0].prior.block === String(sliceFrom - 1n) &&
        slice.headers[0].prior.hash ===
          (sliceIndex === 0 ? bundle.priorHash : bundle.slices[sliceIndex - 1].headers[0].end.hash),
      'slice_prior',
    )
    check(
      slice.headers[0].end.block === slice.toBlock && HASH.test(slice.headers[0].end.hash),
      'slice_end',
    )
    check(
      slice.witnesses.length === 2 && slice.witnesses[0].origin !== slice.witnesses[1].origin,
      'origin_count',
    )
    for (const witness of slice.witnesses) {
      validateRaw(witness.raw, slice.fromBlock, slice.toBlock, subjects)
      const joined = [
        ...witness.separate.deposit,
        ...witness.separate.withdraw,
        ...witness.separate.force,
      ].sort(sortable)
      check(same(joined, witness.raw), 'topic_set_disagreement')
      check(
        same(witness.eventHeaders, slice.witnesses[0].eventHeaders),
        'event_header_disagreement',
      )
      const byBlock = new Map(witness.eventHeaders.map((item) => [item.block, item.hash]))
      check(
        same([...byBlock.keys()], [...new Set(witness.raw.map((row) => row.blockNumber))]) &&
          witness.eventHeaders.every((item) => HASH.test(item.hash)),
        'event_header_set',
      )
      for (const row of witness.raw)
        check(byBlock.get(row.blockNumber) === row.blockHash, 'event_hash_disagreement')
    }
    check(same(slice.witnesses[0].raw, slice.witnesses[1].raw), 'origin_raw_disagreement')
    sliceFrom = BigInt(slice.toBlock) + 1n
  }
  check(
    sliceFrom === BigInt(bundle.toBlock) + 1n &&
      bundle.toHash === bundle.slices.at(-1).headers[0].end.hash,
    'end_cursor',
  )
  const raw = bundle.slices.flatMap((slice) => slice.witnesses[0].raw)
  check(
    same(
      bundle.vaults,
      classifySubjects(subjects, manifest, bundle.fromBlock, bundle.toBlock, raw),
    ),
    'vault_census_drift',
  )
  return raw.length
}
export function verifyArchive(
  subjects,
  manifest,
  root = ROOT,
  { requireComplete = true, campaign = false, predecessorSha256 = null } = {},
) {
  check(existsSync(join(root, 'enrollment.json')), 'missing_enrollment')
  const entries = readdirSync(root).sort()
  check(
    entries.every((name) => name === 'enrollment.json' || /^\d{12}\.json$/.test(name)),
    'orphan_or_partial_file',
  )
  const enrollment = read(join(root, 'enrollment.json'))
  validateEnrollment(enrollment, subjects, campaign, predecessorSha256)
  const files = entries.filter((name) => name !== 'enrollment.json')
  check(files.length <= 100_000, 'too_many_bundles')
  let previous = enrollment
  let events = 0
  for (const [i, name] of files.entries()) {
    check(name === filename(i + 1), 'sequence_gap')
    const bundle = read(join(root, name))
    events += validateBundle(bundle, enrollment, previous, i + 1, subjects, manifest, campaign)
    previous = bundle
  }
  const complete =
    BigInt(previous.toBlock ?? enrollment.startBlock) === BigInt(enrollment.campaignEndBlock)
  if (complete)
    check(
      (previous.toHash ?? enrollment.startHash) === enrollment.campaignEndHash,
      'campaign_end_hash',
    )
  if (requireComplete) check(complete, 'campaign_incomplete')
  return {
    complete,
    bundles: files.length,
    coveredBlocks: Number(
      BigInt(previous.toBlock ?? enrollment.startBlock) - BigInt(enrollment.startBlock),
    ),
    events,
    tipSha256: previous.sha256,
  }
}
async function atTimestamp(client, target, finalized) {
  let low = 1n,
    high = finalized
  while (low < high) {
    const mid = (low + high) / 2n
    const block = await client.getBlock({ blockNumber: mid })
    if (block.timestamp < target) low = mid + 1n
    else high = mid
  }
  return low
}
async function rawQuery(client, addresses, from, to, topics, origin) {
  // This QuikNode plan accepts at most five historical blocks per log request.
  // Preserve the same canonical 10-block slice while querying disjoint ranges.
  const maxBlocks = origin.endsWith('.quiknode.pro') ? 5n : 10n
  const logs = []
  for (let start = from; start <= to; start += maxBlocks) {
    const end = start + maxBlocks - 1n < to ? start + maxBlocks - 1n : to
    try {
      logs.push(
        ...(await client.request({
          method: 'eth_getLogs',
          params: [
            { address: addresses, fromBlock: hex(start), toBlock: hex(end), topics: [topics] },
          ],
        })),
      )
    } catch (error) {
      const status = error.status ?? (Number.isInteger(error.code) ? error.code : null)
      if (status) fail(`origin_${origin}_rpc_${status}`)
      throw error
    }
  }
  return logs.map(normalizedRaw).sort(sortable)
}
async function rpcCall(origin, operation) {
  try {
    return await operation()
  } catch (error) {
    const status = error.status ?? (Number.isInteger(error.code) ? error.code : null)
    if (status) fail(`origin_${origin}_rpc_${status}`)
    throw error
  }
}
export async function probe(clients, subjects, from, to) {
  const addresses = subjects.map((subject) => subject.vault)
  const outputs = []
  let reference = null
  for (const { origin, client } of clients) {
    const start = Date.now()
    const results = {}
    for (const [kind, topic] of Object.entries(TOPICS))
      results[kind] = await rawQuery(client, addresses, from, to, topic, origin)
    results.combined = await rawQuery(client, addresses, from, to, Object.values(TOPICS), origin)
    const separate = [...results.deposit, ...results.withdraw, ...results.force].sort(sortable)
    check(same(separate, results.combined), 'probe_topic_disagreement')
    if (reference !== null)
      check(same(reference, results.combined), 'probe_origin_raw_disagreement')
    reference = results.combined
    outputs.push({
      origin,
      addressBatchAccepted: addresses.length,
      fromBlock: String(from),
      toBlock: String(to),
      responseBytes: Buffer.byteLength(JSON.stringify(results)),
      wallMs: Date.now() - start,
      logCount: results.combined.length,
    })
  }
  check(outputs.length === 2, 'two_origins_required')
  return outputs
}
export async function run(argv = process.argv.slice(2), options = {}) {
  const campaign = argv[0]?.startsWith('--campaign-') ?? false
  const action = campaign ? `--${argv[0].slice('--campaign-'.length)}` : argv[0]
  check(
    ['--probe', '--capture', '--verify', '--verify-partial', '--tick'].includes(action) &&
      (action !== '--tick' || campaign) &&
      (argv.length === 1 ||
        (['--probe', '--capture'].includes(action) &&
          argv.length === 3 &&
          argv[1] === '--end-block' &&
          /^\d+$/.test(argv[2]))),
    'usage',
  )
  const root = options.root ?? (campaign ? CAMPAIGN_ROOT : ROOT)
  const subjects = await loadMorphoFlowSubjects()
  const file = JSON.parse(
    readFileSync(resolve('lib/carry/morpho-v2-asset-identities.json'), 'utf8'),
  )
  const manifest = new Map(
    file.entries.map((row) => [row.vault.toLowerCase(), BigInt(row.creation.blockNumber)]),
  )
  const pilotRoot = options.pilotRoot ?? ROOT
  const pilot = campaign
    ? verifyArchive(subjects, manifest, pilotRoot, { requireComplete: true })
    : null
  const pilotTip = pilot ? read(join(pilotRoot, filename(pilot.bundles))) : null
  if (action.startsWith('--verify'))
    return verifyArchive(subjects, manifest, root, {
      requireComplete: action === '--verify',
      campaign,
      predecessorSha256: pilotTip?.sha256 ?? null,
    })
  if (action === '--tick' && existsSync(join(root, 'enrollment.json'))) {
    const checkpoint = verifyArchive(subjects, manifest, root, {
      requireComplete: false,
      campaign,
      predecessorSha256: pilotTip?.sha256 ?? null,
    })
    if (checkpoint.complete) return checkpoint
  }
  const { get } = readEnv()
  const urls = String(
    options.rpcUrls ??
      process.env.RECORDER_RPC_URLS ??
      process.env.RECORDER_RPC_URL ??
      get('RECORDER_RPC_URLS') ??
      get('RECORDER_RPC_URL') ??
      '',
  )
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  const origins = new Map(urls.map((url) => [rpcOrigin(url), url]))
  check(origins.size >= 2, 'two_origins_required')
  const selected = String(options.origins ?? process.env.CARRY_MORPHO_ARCHIVE_ORIGINS ?? '')
    .split(',')
    .filter(Boolean)
  check(
    !selected.length ||
      (selected.length === 2 &&
        selected[0] !== selected[1] &&
        selected.every((name) => origins.has(name))),
    'origin_selection',
  )
  const clients = (
    selected.length ? selected.map((name) => [name, origins.get(name)]) : [...origins].slice(0, 2)
  ).map(([origin, url]) => ({
    origin,
    client:
      options.clientFactory?.(url) ??
      createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 15000, retryCount: 0 }),
      }),
  }))
  for (const { origin, client } of clients)
    check((await rpcCall(origin, () => client.getChainId())) === 1, 'wrong_chain')
  const heads = await Promise.all(
    clients.map(({ origin, client }) =>
      rpcCall(origin, () => client.getBlock({ blockTag: 'finalized' })),
    ),
  )
  const final = heads[0].number < heads[1].number ? heads[0].number : heads[1].number
  const existing = existsSync(join(root, 'enrollment.json'))
    ? read(join(root, 'enrollment.json'))
    : null
  const anchor = existing
    ? BigInt(existing.startBlock) + 1n
    : campaign
      ? BigInt(pilotTip.toBlock) + 1n
      : options.startBlock === undefined
        ? await atTimestamp(
            clients[0].client,
            BigInt(Math.floor(Date.now() / 1000) - 30 * 86400),
            final,
          )
        : BigInt(options.startBlock)
  const start = options.startBlock === undefined || campaign ? anchor : BigInt(options.startBlock)
  check(!campaign || options.startBlock === undefined, 'campaign_start_immutable')
  const end =
    options.endBlock !== undefined
      ? BigInt(options.endBlock)
      : argv[2]
        ? BigInt(argv[2])
        : existing
          ? BigInt(existing.campaignEndBlock)
          : campaign
            ? final
            : start + 63n
  check(
    start > 1n && end >= start && end <= final && end - start + 1n <= 250_000n,
    'bounded_campaign',
  )
  const boundaries = await Promise.all(
    clients.map(async ({ origin, client }) => ({
      prior: header(await rpcCall(origin, () => client.getBlock({ blockNumber: start - 1n }))),
      end: header(await rpcCall(origin, () => client.getBlock({ blockNumber: end }))),
    })),
  )
  check(same(boundaries[0], boundaries[1]), 'campaign_header_disagreement')
  if (campaign)
    check(
      boundaries[0].prior.hash === pilotTip.toHash && BigInt(pilotTip.toBlock) + 1n === start,
      'pilot_tip_changed',
    )
  if (action === '--probe') {
    const checkpoint = existing
      ? verifyArchive(subjects, manifest, root, {
          requireComplete: false,
          campaign,
          predecessorSha256: pilotTip?.sha256 ?? null,
        })
      : null
    const probeStart = checkpoint?.bundles
      ? BigInt(read(join(root, filename(checkpoint.bundles))).toBlock) + 1n
      : start
    check(probeStart <= end, 'campaign_complete')
    return {
      probe: await probe(
        clients,
        subjects,
        probeStart,
        probeStart + 9n <= end ? probeStart + 9n : end,
      ),
      startBlock: String(probeStart),
      endBlock: String(end),
      campaignEndHash: boundaries[0].end.hash,
    }
  }
  // Measure the actual first slice before any file is created. A failed probe
  // cannot leave an apparently enrolled campaign behind.
  if (!existing) await probe(clients, subjects, start, start + 9n <= end ? start + 9n : end)
  let enrollment
  if (existsSync(join(root, 'enrollment.json'))) {
    const verified = verifyArchive(subjects, manifest, root, {
      requireComplete: false,
      campaign,
      predecessorSha256: pilotTip?.sha256 ?? null,
    })
    enrollment = read(join(root, 'enrollment.json'))
    check(
      enrollment.campaignEndBlock === String(end) &&
        enrollment.campaignEndHash === boundaries[0].end.hash &&
        enrollment.startBlock === String(start - 1n),
      'campaign_boundary_changed',
    )
    if (verified.complete) return verified
  } else {
    const enrollmentBody = {
      study: campaign ? CAMPAIGN_STUDY : STUDY,
      kind: 'enrollment',
      chainId: 1,
      subjects,
      startBlock: String(start - 1n),
      startHash: boundaries[0].prior.hash,
      campaignEndBlock: String(end),
      campaignEndHash: boundaries[0].end.hash,
      providerOrigins: clients.map((c) => c.origin),
      ...(campaign ? { predecessorArchiveSha256: pilotTip.sha256 } : {}),
      firstLocalReceiptAt: new Date().toISOString(),
    }
    validateEnrollment(enrollmentBody, subjects, campaign, pilotTip?.sha256 ?? null)
    enrollment = publish(join(root, 'enrollment.json'), enrollmentBody)
  }
  const prior = verifyArchive(subjects, manifest, root, {
    requireComplete: false,
    campaign,
    predecessorSha256: pilotTip?.sha256 ?? null,
  })
  const previous = prior.bundles ? read(join(root, filename(prior.bundles))) : enrollment
  const from = BigInt(previous.toBlock ?? enrollment.startBlock) + 1n
  const requestedBundleBlocks = Number(
    options.bundleBlocks ?? process.env.CARRY_MORPHO_ARCHIVE_BUNDLE_BLOCKS ?? 512,
  )
  check(
    !campaign ||
      (Number.isInteger(requestedBundleBlocks) &&
        requestedBundleBlocks >= 1 &&
        requestedBundleBlocks <= 512),
    'bundle_bound',
  )
  const maxBundleBlocks = campaign ? BigInt(requestedBundleBlocks) : 64n
  const to = from + maxBundleBlocks - 1n < end ? from + maxBundleBlocks - 1n : end
  const slices = []
  for (let sliceFrom = from; sliceFrom <= to; sliceFrom += 10n) {
    const sliceTo = sliceFrom + 9n < to ? sliceFrom + 9n : to
    const sliceHeaders = await Promise.all(
      clients.map(async ({ origin, client }) => ({
        origin,
        prior: header(
          await rpcCall(origin, () => client.getBlock({ blockNumber: sliceFrom - 1n })),
        ),
        end: header(await rpcCall(origin, () => client.getBlock({ blockNumber: sliceTo }))),
      })),
    )
    check(
      same(sliceHeaders[0].prior, sliceHeaders[1].prior) &&
        same(sliceHeaders[0].end, sliceHeaders[1].end),
      'slice_header_disagreement',
    )
    const witnesses = []
    for (const { origin, client } of clients) {
      const addresses = subjects.map((subject) => subject.vault)
      const separate = {}
      for (const [kind, topic] of Object.entries(TOPICS))
        separate[kind] = await rawQuery(client, addresses, sliceFrom, sliceTo, topic, origin)
      const raw = await rawQuery(
        client,
        addresses,
        sliceFrom,
        sliceTo,
        Object.values(TOPICS),
        origin,
      )
      check(
        same([...separate.deposit, ...separate.withdraw, ...separate.force].sort(sortable), raw),
        'topic_set_disagreement',
      )
      const eventBlocks = [...new Set(raw.map((row) => row.blockNumber))]
      const eventHeaders = await Promise.all(
        eventBlocks.map(async (block) =>
          header(await rpcCall(origin, () => client.getBlock({ blockNumber: BigInt(block) }))),
        ),
      )
      witnesses.push({ origin, separate, raw, eventHeaders })
    }
    check(
      same(witnesses[0].raw, witnesses[1].raw) &&
        same(witnesses[0].eventHeaders, witnesses[1].eventHeaders),
      'origin_raw_disagreement',
    )
    slices.push({
      fromBlock: String(sliceFrom),
      toBlock: String(sliceTo),
      headers: sliceHeaders,
      witnesses,
    })
  }
  const raw = slices.flatMap((slice) => slice.witnesses[0].raw)
  const body = {
    study: campaign ? CAMPAIGN_STUDY : STUDY,
    kind: 'bundle',
    chainId: 1,
    sequence: prior.bundles + 1,
    enrollmentSha256: enrollment.sha256,
    previousSha256: previous.sha256,
    fromBlock: String(from),
    toBlock: String(to),
    priorHash: previous.toHash ?? enrollment.startHash,
    toHash: slices.at(-1).headers[0].end.hash,
    slices,
    vaults: classifySubjects(subjects, manifest, from, to, raw),
    firstLocalReceiptAt: new Date().toISOString(),
    researchOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
    providerCompleteness: 'two_hostnames_agreed_not_organizationally_independent_or_complete',
  }
  // Apply the exact offline verifier checks to the in-memory candidate before
  // the exclusive publication point. A bad provider row must never poison the
  // immutable archive and prevent future ticks from advancing.
  validateBundle(
    { ...body, sha256: DIGEST(body) },
    enrollment,
    previous,
    body.sequence,
    subjects,
    manifest,
    campaign,
  )
  const published = publish(join(root, filename(body.sequence)), body)
  return {
    ...verifyArchive(subjects, manifest, root, {
      requireComplete: false,
      campaign,
      predecessorSha256: pilotTip?.sha256 ?? null,
    }),
    bundleSha256: published.sha256,
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  run()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        error.message.startsWith('morpho_block_archive_')
          ? error.message
          : 'morpho_block_archive_rpc_unavailable',
      )
      process.exitCode = 1
    })
