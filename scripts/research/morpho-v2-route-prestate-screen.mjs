// B-1 funding/identity screen only. No holder, withdrawal, headroom or prediction claim.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
} from 'viem'
import { mainnet } from 'viem/chains'
import { readEnv } from '../lib/venue-reads.mjs'
import { baselineSlots, readSealedFullBaselinePlan } from './morpho-v2-route-full-baselines.mjs'
import { FACTORY_SHA } from './morpho-v2-route-census.mjs'
import { DEFAULT_HEADER_PATH, DEFAULT_ROUTE_PATH } from './morpho-v2-route-risk-manifest.mjs'

export const STUDY = 'morpho-v2-route-prestate-screen-v1'
export const EXPECTED_SLOTS = 18_279
export const MAX_SLOTS = 64
export const RESERVE_BYTES = 2_500_000_000
const MAX_RPC = 8 * MAX_SLOTS + 2
const MAX_RESPONSE_BYTES = 256 * 1024
export const RPC_TRANSPORT_OPTIONS = Object.freeze({
  retryCount: 0,
  timeout: 12_000,
  maxResponseBodySize: MAX_RESPONSE_BYTES,
})
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
])
const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
const DECIMAL = /^(0|[1-9][0-9]*)$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b
const factoryDefault = resolve(`data/research/venue-signals/${FACTORY_SHA}.json`)
const outputDefault = resolve('data/research/venue-signals/morpho-v2-route-prestate-screen')

export function loadPinnedSlots({
  factoryPath = factoryDefault,
  routePath = DEFAULT_ROUTE_PATH,
  headerPath = DEFAULT_HEADER_PATH,
} = {}) {
  const sources = { factory: factoryPath, route: routePath, headers: headerPath }
  const sourcePhysicalSha256 = Object.fromEntries(
    Object.entries(sources).map(([name, path]) => [name, sha(readFileSync(path))]),
  )
  const plan = readSealedFullBaselinePlan({ factoryPath, routePath, headerPath })
  const routeEvents = JSON.parse(readFileSync(routePath, 'utf8')).events
  const routeByVault = new Map()
  for (const event of routeEvents) {
    const vault = event.vault.toLowerCase()
    if (!routeByVault.has(vault)) routeByVault.set(vault, [])
    routeByVault.get(vault).push(event)
  }
  const slots = baselineSlots(plan).map((slot) => {
    const prior = (routeByVault.get(slot.vault) || []).filter(
      (event) => event.block < slot.anchorBlock,
    )
    const sourceExpectedPreRoute = prior.length ? prior.at(-1).adapter.toLowerCase() : null
    if (slot.expectedPreRoute && sourceExpectedPreRoute !== slot.expectedPreRoute)
      throw new Error('Treated B-1 route differs from sealed route source')
    return { ...slot, sourceExpectedPreRoute }
  })
  if (
    plan.sourceVerification !== 'physically-pinned-factory-route-header' ||
    plan.anchorCount !== 116 ||
    slots.length !== EXPECTED_SLOTS
  )
    throw new Error('Incomplete physically pinned full B-1 plan')
  const keys = slots.map((slot) => `${slot.vault}:${slot.preBlock}`)
  if (new Set(keys).size !== EXPECTED_SLOTS) throw new Error('Duplicate vault x B-1 slot')
  for (const [name, path] of Object.entries(sources))
    if (sha(readFileSync(path)) !== sourcePhysicalSha256[name])
      throw new Error(`${name} source changed during plan load`)
  return {
    plan,
    slots,
    sources: Object.fromEntries(
      Object.entries(sources).map(([name, path]) => [name, resolve(path)]),
    ),
    sourcePhysicalSha256,
  }
}

function unsigned(receipt) {
  const { receiptSha256: _discard, ...body } = receipt
  return body
}
function seal(body) {
  return { ...body, receiptSha256: sha(JSON.stringify(body)) }
}
function filename(sequence, from, to) {
  return `${String(sequence).padStart(5, '0')}-${String(from).padStart(5, '0')}-${String(to).padStart(5, '0')}.json`
}
function slotIdentity(slot) {
  return {
    planSha256: slot.planSha256,
    anchorIndex: slot.anchorIndex,
    eventKey: slot.eventKey,
    role: slot.role,
    vault: slot.vault,
    asset: slot.asset,
    creationBlock: slot.creationBlock,
    anchorBlock: slot.anchorBlock,
    anchorBlockHash: slot.anchorBlockHash,
    preBlock: slot.preBlock,
    expectedPreRoute: slot.expectedPreRoute,
    sourceExpectedPreRoute: slot.sourceExpectedPreRoute,
  }
}
function guard(out, stat = statfsSync, bytes = 0) {
  let location = resolve(out)
  while (!existsSync(location)) {
    const parent = dirname(location)
    if (parent === location) throw new Error('No existing output ancestor')
    location = parent
  }
  const fs = stat(location)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < RESERVE_BYTES)
    throw new Error('Prestate disk reserve reached before RPC/write')
}
function block(raw, expected) {
  if (
    !raw ||
    Number(BigInt(raw.number)) !== expected ||
    !HASH.test(String(raw.hash).toLowerCase()) ||
    !HASH.test(String(raw.parentHash).toLowerCase())
  )
    throw new Error('Provider block truncation/identity mismatch')
  return {
    number: expected,
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
  }
}
function hex(value) {
  return `0x${value.toString(16)}`
}

export function verifyReceipts({ out = outputDefault } = {}) {
  const pinned = loadPinnedSlots()
  const names = existsSync(out)
    ? readdirSync(out)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const covered = new Set(),
    attempted = new Set(),
    lastStatus = new Map(),
    receipts = []
  for (const name of names) {
    const bytes = readFileSync(join(out, name))
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Oversized receipt')
    const receipt = JSON.parse(bytes)
    if (bytes.toString('utf8') !== JSON.stringify(receipt) + '\n')
      throw new Error(`Noncanonical receipt bytes ${name}`)
    if (
      receipt.study !== STUDY ||
      receipt.receiptOrigin !== 'collector-local-write-once-unanchored' ||
      receipt.planSha256 !== pinned.plan.planSha256 ||
      receipt.chainId !== 1 ||
      JSON.stringify(receipt.sources) !== JSON.stringify(pinned.sources) ||
      JSON.stringify(receipt.sourcePhysicalSha256) !==
        JSON.stringify(pinned.sourcePhysicalSha256) ||
      !/^[0-9a-f]{64}$/.test(receipt.receiptSha256 || '') ||
      sha(JSON.stringify(unsigned(receipt))) !== receipt.receiptSha256 ||
      !Number.isInteger(receipt.fromIndex) ||
      !Number.isInteger(receipt.toIndex) ||
      receipt.fromIndex < 0 ||
      receipt.toIndex >= EXPECTED_SLOTS ||
      receipt.toIndex < receipt.fromIndex ||
      receipt.toIndex - receipt.fromIndex + 1 > MAX_SLOTS ||
      receipt.attemptSequence !== receipts.length ||
      name !== filename(receipt.attemptSequence, receipt.fromIndex, receipt.toIndex) ||
      receipt.rows?.length !== receipt.toIndex - receipt.fromIndex + 1
    )
      throw new Error(`Invalid receipt ${name}`)
    const counts = Object.fromEntries(
      [
        'funded-screen',
        'unfunded-screen',
        'discordant-screen',
        'inactive-zero-adapter',
        'adapter-unattested',
        'missing-code',
        'identity-mismatch',
        'read-failure',
      ].map((status) => [status, receipt.rows.filter((row) => row.status === status).length]),
    )
    if (
      JSON.stringify(receipt.counts) !== JSON.stringify(counts) ||
      receipt.quietSlots !== counts['unfunded-screen'] ||
      receipt.failureSlots !== counts['read-failure'] ||
      !Number.isSafeInteger(receipt.captureStartedMs) ||
      !Number.isSafeInteger(receipt.captureEndedMs) ||
      receipt.captureEndedMs < receipt.captureStartedMs
    )
      throw new Error(`Receipt ledger mismatch ${name}`)
    for (let i = receipt.fromIndex; i <= receipt.toIndex; i++) {
      if (lastStatus.has(i) && lastStatus.get(i) !== 'read-failure')
        throw new Error('Nonfailure receipt slot replay')
      attempted.add(i)
      const row = receipt.rows[i - receipt.fromIndex],
        expected = slotIdentity(pinned.slots[i])
      if (
        row.index !== i ||
        JSON.stringify(row.slot) !== JSON.stringify(expected) ||
        ![
          'funded-screen',
          'unfunded-screen',
          'discordant-screen',
          'inactive-zero-adapter',
          'adapter-unattested',
          'missing-code',
          'identity-mismatch',
          'read-failure',
        ].includes(row.status)
      )
        throw new Error(`Receipt slot mismatch ${i}`)
      if (
        !HASH.test(row.preHeader?.hash) ||
        !HASH.test(row.anchorHeader?.hash) ||
        row.anchorHeader.hash !== expected.anchorBlockHash ||
        row.anchorHeader.parentHash !== row.preHeader.hash ||
        row.preHeader.number !== expected.preBlock ||
        row.anchorHeader.number !== expected.anchorBlock
      )
        throw new Error(`Receipt ancestry mismatch ${i}`)
      if (
        [
          'funded-screen',
          'unfunded-screen',
          'discordant-screen',
          'inactive-zero-adapter',
          'adapter-unattested',
        ].includes(row.status)
      ) {
        if (!DECIMAL.test(row.totalSupplyRaw) || !DECIMAL.test(row.totalAssetsRaw))
          throw new Error(`Receipt totals malformed ${i}`)
        const totalsScreen =
          BigInt(row.totalSupplyRaw) > 0n && BigInt(row.totalAssetsRaw) > 0n
            ? 'positive-both'
            : BigInt(row.totalSupplyRaw) === 0n && BigInt(row.totalAssetsRaw) === 0n
              ? 'zero-both'
              : 'discordant'
        if (
          !HASH.test(row.runtimeCodeHash) ||
          row.observedAsset !== expected.asset ||
          !ADDRESS.test(row.observedAdapter) ||
          row.adapterSourceStatus !==
            (expected.sourceExpectedPreRoute ? 'matched-prior-event' : 'no-prior-event') ||
          row.totalsScreen !== totalsScreen ||
          row.status !==
            (expected.sourceExpectedPreRoute
              ? expected.sourceExpectedPreRoute === ZERO_ADDRESS
                ? 'inactive-zero-adapter'
                : totalsScreen === 'positive-both'
                  ? 'funded-screen'
                  : totalsScreen === 'zero-both'
                    ? 'unfunded-screen'
                    : 'discordant-screen'
              : 'adapter-unattested')
        )
          throw new Error(`Receipt positive screen malformed ${i}`)
        if (
          expected.sourceExpectedPreRoute &&
          row.observedAdapter !== expected.sourceExpectedPreRoute
        )
          throw new Error(`Treated route mismatch ${i}`)
      }
      if (row.status === 'read-failure' && row.failure !== 'rpc-read-error')
        throw new Error(`Missing failure ledger ${i}`)
      if (
        row.status === 'identity-mismatch' &&
        row.adapterSourceStatus !==
          (expected.sourceExpectedPreRoute ? 'prior-event-present' : 'no-prior-event')
      )
        throw new Error(`Identity ledger malformed ${i}`)
      lastStatus.set(i, row.status)
      if (row.status !== 'read-failure') covered.add(i)
    }
    receipts.push({
      file: name,
      fromIndex: receipt.fromIndex,
      toIndex: receipt.toIndex,
      receiptSha256: receipt.receiptSha256,
      receiptFileSha256: sha(bytes),
    })
  }
  const gaps = []
  for (let i = 0; i < EXPECTED_SLOTS; ) {
    if (covered.has(i)) {
      i++
      continue
    }
    const fromIndex = i
    while (i < EXPECTED_SLOTS && !covered.has(i)) i++
    gaps.push({ fromIndex, toIndex: i - 1 })
  }
  return {
    study: STUDY,
    expectedSlots: EXPECTED_SLOTS,
    attemptedSlots: attempted.size,
    resolvedSlots: covered.size,
    coveredSlots: covered.size,
    retryableFailureSlots: [...lastStatus.values()].filter((status) => status === 'read-failure')
      .length,
    gaps,
    receipts,
    attemptCoverageComplete: attempted.size === EXPECTED_SLOTS,
    resolvedScreenCoverageComplete: covered.size === EXPECTED_SLOTS,
    fundedRiskSetEstablished: false,
    assurance:
      'Offline consistency of locally write-once collector receipts and sealed sources only; no external immutable timestamp or hash anchor, independent RPC witness, or complete funded risk set.',
  }
}

export async function collectPrestate({
  out = outputDefault,
  rpc,
  fromIndex,
  maxSlots = MAX_SLOTS,
  stat = statfsSync,
  timeoutMs = 12_000,
} = {}) {
  const pinned = loadPinnedSlots()
  if (
    !Number.isInteger(maxSlots) ||
    maxSlots < 1 ||
    maxSlots > MAX_SLOTS ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30_000
  )
    throw new Error('Invalid invocation bounds')
  const prior = verifyReceipts({ out })
  const start = fromIndex ?? prior.gaps[0]?.fromIndex
  if (start === undefined) return prior
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start >= EXPECTED_SLOTS ||
    !prior.gaps.some((g) => start >= g.fromIndex && start <= g.toIndex)
  )
    throw new Error('Requested slot already covered or outside full plan')
  const gap = prior.gaps.find((g) => start >= g.fromIndex && start <= g.toIndex)
  const end = Math.min(start + maxSlots - 1, gap.toIndex)
  guard(out, stat)
  if (typeof rpc !== 'function') throw new Error('RPC request function required')
  let calls = 0
  const captureStartedMs = Date.now()
  const deadline = Date.now() + 120_000
  const request = async (method, params) => {
    guard(out, stat)
    if (++calls > MAX_RPC) throw new Error('RPC cap reached')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Invocation time cap reached')
    let timer
    const result = await Promise.race([
      rpc(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC timeout')), Math.min(timeoutMs, remaining))
      }),
    ]).finally(() => clearTimeout(timer))
    if (
      result === undefined ||
      result === null ||
      Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES
    )
      throw new Error('Provider response truncated/oversized')
    return result
  }
  if (Number(BigInt(await request('eth_chainId', []))) !== 1) throw new Error('Wrong chain')
  const rawFinalized = await request('eth_getBlockByNumber', ['finalized', false])
  if (!rawFinalized?.number) throw new Error('Provider finalized header truncated')
  const finalizedNumber = Number(BigInt(rawFinalized.number))
  block(rawFinalized, finalizedNumber)
  const headers = new Map(),
    rows = []
  for (let i = start; i <= end; i++) {
    const slot = pinned.slots[i],
      identity = slotIdentity(slot)
    if (slot.anchorBlock > finalizedNumber) throw new Error('Anchor not finalized')
    let anchorHeader = headers.get(`a:${slot.anchorBlock}`)
    if (!anchorHeader) {
      anchorHeader = block(
        await request('eth_getBlockByNumber', [hex(slot.anchorBlock), false]),
        slot.anchorBlock,
      )
      if (anchorHeader.hash !== slot.anchorBlockHash) throw new Error('Canonical anchor changed')
      headers.set(`a:${slot.anchorBlock}`, anchorHeader)
    }
    let preHeader = headers.get(`p:${slot.preBlock}`)
    if (!preHeader) {
      preHeader = block(
        await request('eth_getBlockByNumber', [hex(slot.preBlock), false]),
        slot.preBlock,
      )
      if (anchorHeader.parentHash !== preHeader.hash) throw new Error('B-1 ancestry mismatch')
      headers.set(`p:${slot.preBlock}`, preHeader)
    }
    const base = { index: i, slot: identity, anchorHeader, preHeader }
    const at = { blockHash: preHeader.hash, requireCanonical: true }
    try {
      const code = await request('eth_getCode', [slot.vault, at])
      if (code === '0x') {
        rows.push({ ...base, status: 'missing-code' })
        continue
      }
      if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code))
        throw new Error('Provider runtime code truncated')
      const runtimeCodeHash = keccak256(code)
      const call = async (name) => {
        const data = encodeFunctionData({ abi: ABI, functionName: name })
        const raw = await request('eth_call', [{ to: slot.vault, data }, at])
        if (typeof raw !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(raw))
          throw new Error(`Provider ${name} bytes truncated`)
        try {
          return decodeFunctionResult({ abi: ABI, functionName: name, data: raw })
        } catch {
          throw new Error(`Provider ${name} bytes truncated`)
        }
      }
      const observedAsset = String(await call('asset')).toLowerCase()
      const observedAdapter = String(await call('liquidityAdapter')).toLowerCase()
      if (
        !same(observedAsset, slot.asset) ||
        !ADDRESS.test(observedAdapter) ||
        (slot.sourceExpectedPreRoute && !same(observedAdapter, slot.sourceExpectedPreRoute))
      ) {
        rows.push({
          ...base,
          status: 'identity-mismatch',
          runtimeCodeHash,
          observedAsset,
          observedAdapter,
          adapterSourceStatus: slot.sourceExpectedPreRoute
            ? 'prior-event-present'
            : 'no-prior-event',
        })
        continue
      }
      const totalSupplyRaw = String(await call('totalSupply'))
      const totalAssetsRaw = String(await call('totalAssets'))
      if (!DECIMAL.test(totalSupplyRaw) || !DECIMAL.test(totalAssetsRaw))
        throw new Error('Malformed raw totals')
      const totalsScreen =
        BigInt(totalSupplyRaw) > 0n && BigInt(totalAssetsRaw) > 0n
          ? 'positive-both'
          : BigInt(totalSupplyRaw) === 0n && BigInt(totalAssetsRaw) === 0n
            ? 'zero-both'
            : 'discordant'
      rows.push({
        ...base,
        status: slot.sourceExpectedPreRoute
          ? slot.sourceExpectedPreRoute === ZERO_ADDRESS
            ? 'inactive-zero-adapter'
            : totalsScreen === 'positive-both'
              ? 'funded-screen'
              : totalsScreen === 'zero-both'
                ? 'unfunded-screen'
                : 'discordant-screen'
          : 'adapter-unattested',
        totalsScreen,
        runtimeCodeHash,
        observedAsset,
        observedAdapter,
        adapterSourceStatus: slot.sourceExpectedPreRoute ? 'matched-prior-event' : 'no-prior-event',
        totalSupplyRaw,
        totalAssetsRaw,
      })
    } catch (error) {
      if (
        /disk reserve|RPC cap|RPC timeout|time cap|truncat|oversized|Wrong chain|Canonical|ancestry/i.test(
          error.message,
        )
      )
        throw error
      rows.push({ ...base, status: 'read-failure', failure: 'rpc-read-error' })
    }
  }
  // Recheck ancestry after reads to detect chain drift during the batch.
  for (const anchor of new Set(rows.map((row) => row.slot.anchorBlock))) {
    const current = block(await request('eth_getBlockByNumber', [hex(anchor), false]), anchor)
    if (
      current.hash !== headers.get(`a:${anchor}`).hash ||
      current.parentHash !== headers.get(`a:${anchor}`).parentHash
    )
      throw new Error('Canonical anchor changed during batch')
  }
  const counts = Object.fromEntries(
    [
      'funded-screen',
      'unfunded-screen',
      'discordant-screen',
      'inactive-zero-adapter',
      'adapter-unattested',
      'missing-code',
      'identity-mismatch',
      'read-failure',
    ].map((status) => [status, rows.filter((row) => row.status === status).length]),
  )
  const body = {
    study: STUDY,
    receiptOrigin: 'collector-local-write-once-unanchored',
    chainId: 1,
    planSha256: pinned.plan.planSha256,
    sources: pinned.sources,
    sourcePhysicalSha256: pinned.sourcePhysicalSha256,
    attemptSequence: prior.receipts.length,
    fromIndex: start,
    toIndex: end,
    captureStartedMs,
    captureEndedMs: Date.now(),
    counts,
    quietSlots: counts['unfunded-screen'],
    failureSlots: counts['read-failure'],
    rows,
    caveat:
      'Screen only. Receipt is locally write-once and self-sealed, with no external immutable timestamp or hash anchor. Observed runtime hash is not independently matched to verified deployed source. No holder, fixed-q exit, executable withdrawal, headroom, control matching, or prediction.',
  }
  const bytes = JSON.stringify(seal(body)) + '\n'
  guard(out, stat, Buffer.byteLength(bytes))
  mkdirSync(out, { recursive: true })
  const temp = join(out, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, bytes, { flag: 'wx' })
    linkSync(temp, join(out, filename(prior.receipts.length, start, end)))
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return verifyReceipts({ out })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map((arg) => {
        const match = /^--([^=]+)=(.*)$/.exec(arg)
        if (!match) throw new Error('Use --key=value')
        return [match[1], match[2]]
      }),
    )
    loadPinnedSlots()
    const out = args.out ? resolve(args.out) : outputDefault
    if (args.verify === 'true' || args.live !== 'true')
      console.log(JSON.stringify(verifyReceipts({ out })))
    else {
      guard(out)
      const url = readEnv().get('MORPHO_PRESTATE_RPC_URL') || readEnv().get('RECORDER_RPC_URL')
      if (!url || url.includes(',')) throw new Error('One explicit prestate RPC URL required')
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, RPC_TRANSPORT_OPTIONS),
      })
      const result = await collectPrestate({
        out,
        maxSlots: args.maxSlots ? Number(args.maxSlots) : MAX_SLOTS,
        fromIndex: args.fromIndex === undefined ? undefined : Number(args.fromIndex),
        rpc: (method, params) => client.request({ method, params }),
      })
      console.log(JSON.stringify(result))
    }
  } catch {
    process.stderr.write('MORPHO_PRESTATE_SCREEN_FAILED\n')
    process.exitCode = 1
  }
}
