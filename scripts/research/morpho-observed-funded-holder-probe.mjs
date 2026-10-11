/** Bounded, explicit CURRENT receiver-lead probe. Importing starts no native reads. */
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  statfsSync,
  mkdirSync,
} from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { morphoProbeResponseByteLimit } from './morpho-probe-raw-body-storage.mjs'
import { encodeFunctionData, erc20Abi } from 'viem'
import { parseUsd3HypotheticalJson } from './usd3-hypothetical-history-capture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const PLAN_PATH = 'scripts/research/morpho-observed-funded-holder-probe.plan.json'
export const PLAN_SHA = '914de1f5900a7ddf18977f3f5ca1f68955a6da4155f1bd3775b2ed19fb466f77'
const MB = 1024 * 1024,
  MAX = (1n << 256n) - 1n,
  ZERO = '0x' + '0'.repeat(40)
const ADDRESS = /^0x[0-9a-f]{40}$/,
  HASH = /^0x[0-9a-f]{64}$/,
  HEX = /^0x(?:[0-9a-f]{2})*$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (ok, reason) => {
  if (!ok) throw Error('morpho_holder_probe_' + reason)
}
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v)
    Object.freeze(value)
  }
  return value
}
const POLICY = Object.freeze({
  starts: 106,
  logStarts: 32,
  deadline: 120000,
  stage: 12000,
  timeout: 8000,
  spacing: 250,
  response: 65536,
  file: 8 * MB,
  cohort: 32 * MB,
  source: 6 * MB,
  report: 32768,
  terminal: 65536,
  pre: 288 * MB,
  reserve: 256 * MB,
  retries: 0,
})
const FLAGS = Object.freeze({
  researchOnly: true,
  authenticated: false,
  originalAuthority: false,
  historicalOwnership: false,
  currentWalletControl: false,
  profileApproval: false,
  sourceImplementationEquivalence: false,
  holderExecutableExit: false,
  calibrated: false,
  coveragePromotion: false,
  competingMRaw: null,
})
const ABI = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'liquidityAdapter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'previewRedeem',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
function freeBytes() {
  const s = statfsSync(ROOT, { bigint: true })
  return s.bavail * s.bsize
}
function guard(bytes = 0, terminal = false) {
  const free = freeBytes()
  check(
    free >= BigInt(POLICY.pre) &&
      free >= BigInt(POLICY.reserve + bytes + (terminal ? 0 : POLICY.terminal)),
    'disk_guard',
  )
}
function fixedPath(relative) {
  check(
    typeof relative === 'string' &&
      !relative.startsWith('/') &&
      !relative.includes('..') &&
      !relative.includes('\\') &&
      !relative.includes('://'),
    'fixed_path',
  )
  const path = resolve(ROOT, relative)
  let p = dirname(path)
  while (p !== ROOT) {
    const s = lstatSync(p)
    check(p.startsWith(ROOT + '/') && s.isDirectory() && !s.isSymbolicLink(), 'parent_identity')
    p = dirname(p)
  }
  return path
}
function readBytes(path, cap, budget) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const a = fstatSync(fd, { bigint: true })
    check(
      a.isFile() &&
        a.size > 0n &&
        a.size <= BigInt(cap) &&
        budget.bytes + Number(a.size) <= budget.maximum,
      'read_size',
    )
    const b = Buffer.alloc(Number(a.size) + 1)
    let n = 0
    while (n < b.length) {
      const got = readSync(fd, b, n, b.length - n, null)
      if (!got) break
      n += got
      check(n <= cap, 'read_cap')
    }
    const z = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true })
    check(
      named.isFile() &&
        !named.isSymbolicLink() &&
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(
          (k) => a[k] === z[k] && z[k] === named[k],
        ) &&
        BigInt(n) === z.size,
      'read_identity',
    )
    budget.bytes += n
    return b.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}
function readPin(pin, budget) {
  const b = readBytes(fixedPath(pin.path), Math.min(POLICY.file, pin.bytes), budget)
  check(b.length === pin.bytes && sha(b) === pin.fileSha256, 'file_pin')
  return b
}
export function prepareMorphoObservedFundedHolderProbe() {
  const budget = { bytes: 0, maximum: 32 * MB }
  const bytes = readBytes(fixedPath(PLAN_PATH), 65536, budget)
  check(sha(bytes) === PLAN_SHA, 'plan_pin')
  const plan = JSON.parse(bytes.toString('utf8'))
  check(
    plan.schema === 'morpho_observed_funded_holder_probe_plan_v1' &&
      plan.chainId === 1 &&
      plan.subjects.length === 3 &&
      plan.budget.maximumPhysicalStarts === 106 &&
      plan.budget.maximumSeparateLogStarts === 32 &&
      Object.values(plan.budget)
        .slice(0, 9)
        .reduce((n, x) => n + x, 0) === 106,
    'plan_budget',
  )
  const transfer = erc20Abi.find((x) => x.type === 'event' && x.name === 'Transfer')
  check(
    transfer &&
      same(
        transfer.inputs.map((x) => [x.name, x.type, x.indexed]),
        [
          ['from', 'address', true],
          ['to', 'address', true],
          ['value', 'uint256', false],
        ],
      ),
    'declared_transfer_ABI',
  )
  const sources = plan.sourcePins.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  check(sources.reduce((n, x) => n + x.bytes.length, 0) <= POLICY.source, 'source_cap')
  const ownPath = 'scripts/research/morpho-observed-funded-holder-probe.mjs'
  const own = readBytes(fixedPath(ownPath), POLICY.source, budget)
  sources.push({ pin: { path: ownPath, bytes: own.length, fileSha256: sha(own) }, bytes: own })
  check(sources.reduce((n, x) => n + x.bytes.length, 0) <= POLICY.source, 'source_cap')
  const originals = plan.leadOriginals.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  for (const subject of plan.subjects)
    for (const candidate of subject.candidates) {
      const input = originals.find((x) =>
        x.pin.path.endsWith(String(candidate.leadOrdinal).padStart(12, '0') + '.json'),
      )
      validatePinnedMorphoReceiverLead(
        input.bytes,
        input.pin,
        subject,
        candidate.owner,
        plan.depositTopic,
      )
    }
  return { plan: freeze(plan), planBytes: bytes, sources, originals }
}
export function validatePinnedMorphoReceiverLead(bytes, pin, subject, owner, topic) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length <= POLICY.file &&
      bytes.length === pin.bytes &&
      sha(bytes) === pin.fileSha256,
    'lead_file_pin',
  )
  const b = JSON.parse(bytes.toString('utf8')),
    { sha256, ...body } = b
  check(
    sha(JSON.stringify(body)) === sha256 &&
      bytes.toString('utf8') === JSON.stringify(b) + '\n' &&
      b.kind === 'bundle' &&
      b.chainId === 1 &&
      b.researchOnly === true &&
      b.holderExecutableExit === false,
    'lead_seal',
  )
  const hits = []
  for (const s of b.slices) {
    check(
      s.witnesses.length === 2 &&
        new Set(s.witnesses.map((w) => w.origin)).size === 2 &&
        same(s.witnesses[0].raw, s.witnesses[1].raw) &&
        same(s.witnesses[0].eventHeaders, s.witnesses[1].eventHeaders),
      'lead_pair',
    )
    for (const row of s.witnesses[0].raw)
      if (
        row.address === subject.vault &&
        row.topics[0] === topic &&
        '0x' + row.topics[2]?.slice(-40) === owner
      ) {
        check(
          row.topics.length === 3 &&
            row.topics.slice(1).every((x) => /^0x0{24}[0-9a-f]{40}$/.test(x)) &&
            /^0x[0-9a-f]{128}$/.test(row.data),
          'lead_Deposit_ABI',
        )
        const h = s.witnesses[0].eventHeaders.find((h) => h.block === row.blockNumber)
        check(h && h.hash === row.blockHash, 'lead_event_header')
        hits.push({
          block: row.blockNumber,
          blockHash: row.blockHash,
          occurredAtUtc: new Date(Number(h.timestamp) * 1000).toISOString(),
          txHash: row.transactionHash,
          logIndex: row.logIndex,
          receiver: owner,
          originalEnvelopeAtUtc: b.firstLocalReceiptAt,
        })
      }
  }
  check(hits.length > 0, 'lead_absent')
  return freeze({
    leadOnly: true,
    historicalOwnership: false,
    currentBalanceKnown: false,
    originalFileSha256: pin.fileSha256,
    occurrences: hits,
  })
}
export function decodeProbeHeader(envelope, nowMs = Date.now()) {
  const h = envelope?.result
  check(
    h && /^0x[0-9a-f]+$/.test(h.number) && HASH.test(h.hash) && /^0x[0-9a-f]+$/.test(h.timestamp),
    'header_shape',
  )
  const n = BigInt(h.number),
    t = BigInt(h.timestamp) * 1000n
  check(
    n >= 64n && n <= BigInt(Number.MAX_SAFE_INTEGER) && t > 0n && t <= BigInt(nowMs),
    'header_clock',
  )
  return {
    chainId: 1,
    blockNumber: String(n),
    blockHash: h.hash,
    blockTime: new Date(Number(t)).toISOString(),
    finalized: true,
  }
}
export const sameProbeSource = (a, b) => same(a, b)
export function probeNativeCall(key, to, name, args, source) {
  check(ADDRESS.test(to) && HASH.test(source.blockHash), 'call_source')
  return {
    key,
    method: 'eth_call',
    params: [
      { to, data: encodeFunctionData({ abi: ABI, functionName: name, args }) },
      { blockHash: source.blockHash, requireCanonical: true },
    ],
  }
}
export function pairedProbeResult(traces, key, hosts) {
  const rows = hosts.map((host) => traces.filter((t) => t.host === host && t.key === key))
  check(
    rows.every((x) => x.length === 1),
    'paired_trace_count',
  )
  const a = rows[0][0].envelope,
    b = rows[1][0].envelope
  check(
    a && b && !Object.hasOwn(a, 'error') && !Object.hasOwn(b, 'error') && same(a.result, b.result),
    'paired_result',
  )
  return a.result
}
export function decodeProbeWord(value) {
  check(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value), 'native_uint_word')
  const n = BigInt(value)
  check(n <= MAX, 'uint256')
  return String(n)
}
const wordAddress = (value) => {
  check(typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value), 'native_address_word')
  return '0x' + value.slice(-40).toLowerCase()
}
export function derivePairedFundedProbe(traces, subject, owner, source, hosts) {
  check(
    subject.shareDecimals === 18 &&
      Number.isInteger(subject.assetDecimals) &&
      subject.assetDecimals >= 0 &&
      subject.assetDecimals <= 36 &&
      ADDRESS.test(owner),
    'holder_units_or_owner',
  )
  const balanceKey = subject.id + ':S:' + owner,
    balanceRows = traces.filter((t) => t.key === balanceKey)
  check(
    balanceRows.length === 2 &&
      balanceRows.every((t) =>
        same(t.request, probeNativeCall(balanceKey, subject.vault, 'balanceOf', [owner], source)),
      ),
    'balance_source_request',
  )
  const S = decodeProbeWord(pairedProbeResult(traces, balanceKey, hosts))
  const key = subject.id + ':Ea:' + owner,
    quoteRows = traces.filter((t) => t.key === key)
  if (S === '0') {
    check(quoteRows.length === 0, 'zeroS_quote')
    return {
      ...FLAGS,
      subjectId: subject.id,
      vault: subject.vault,
      asset: subject.asset,
      assetDecimals: subject.assetDecimals,
      shareDecimals: 18,
      owner,
      sharesRaw: '0',
      fullEaRaw: null,
      source,
      status: 'zero_native_balance',
    }
  }
  check(
    quoteRows.length === 2 &&
      quoteRows.every((t) =>
        same(t.request, probeNativeCall(key, subject.vault, 'previewRedeem', [BigInt(S)], source)),
      ),
    'fullS_quote_request',
  )
  const Ea = decodeProbeWord(pairedProbeResult(traces, key, hosts))
  return {
    ...FLAGS,
    subjectId: subject.id,
    vault: subject.vault,
    asset: subject.asset,
    assetDecimals: subject.assetDecimals,
    shareDecimals: 18,
    owner,
    sharesRaw: S,
    fullEaRaw: Ea,
    source,
    status:
      Ea === '0' ? 'paired_native_funded_balance_zero_entitlement' : 'paired_native_funded_balance',
    nativeBalanceObservedAtSource: true,
  }
}
function normalizeLog(x, subject, topic, from, to) {
  const a = (v) => (typeof v === 'string' ? v.toLowerCase() : v)
  check(
    x && typeof x === 'object' && !Array.isArray(x) && x.removed === false,
    'log_removed_or_shape',
  )
  const row = {
    address: a(x.address),
    blockNumber: a(x.blockNumber),
    blockHash: a(x.blockHash),
    transactionHash: a(x.transactionHash),
    transactionIndex: a(x.transactionIndex),
    logIndex: a(x.logIndex),
    topics: Array.isArray(x.topics) ? x.topics.map(a) : null,
    data: a(x.data),
  }
  check(
    row.address === subject.vault &&
      /^0x[0-9a-f]+$/.test(row.blockNumber) &&
      BigInt(row.blockNumber) >= BigInt(from) &&
      BigInt(row.blockNumber) <= BigInt(to) &&
      HASH.test(row.blockHash) &&
      HASH.test(row.transactionHash) &&
      /^0x[0-9a-f]+$/.test(row.transactionIndex) &&
      /^0x[0-9a-f]+$/.test(row.logIndex) &&
      Array.isArray(row.topics) &&
      row.topics.length === 3 &&
      row.topics[0] === topic &&
      row.topics.slice(1).every((t) => /^0x0{24}[0-9a-f]{40}$/.test(t)) &&
      new RegExp('^0x[0-9a-f]{' + (topic === subject.depositTopic ? 128 : 64) + '}$').test(
        row.data,
      ),
    'log_native_ABI',
  )
  return row
}
const logOrder = (a, b) =>
  Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
  Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) ||
  Number(BigInt(a.logIndex) - BigInt(b.logIndex))
export function pairProbeLogShard(a, b, subject, topic, from, to) {
  check(Array.isArray(a) && Array.isArray(b) && a.length <= 128 && b.length <= 128, 'log_count')
  const rows = a.map((x) => normalizeLog(x, subject, topic, from, to)),
    other = b.map((x) => normalizeLog(x, subject, topic, from, to))
  check(
    same(rows, [...rows].sort(logOrder)) &&
      same(rows, other) &&
      new Set(rows.map((x) => x.transactionHash + ':' + x.logIndex)).size === rows.length,
    'log_pair_or_order',
  )
  return rows
}
export function probeReceiverCandidates(logs, subject, declaredExclusions, maximum = 3) {
  check(
    Array.isArray(logs) &&
      logs.length <= 2048 &&
      maximum === 3 &&
      subject &&
      ADDRESS.test(subject.vault) &&
      ADDRESS.test(subject.liquidityAdapter) &&
      Array.isArray(declaredExclusions) &&
      same(declaredExclusions, [...new Set([subject.vault, subject.liquidityAdapter])]) &&
      logs.every((row) => row.address === subject.vault),
    'candidate_bounds_or_exclusions',
  )
  const candidates = []
  for (const row of [...logs].sort(logOrder).reverse()) {
    const receiver = '0x' + row.topics[2].slice(-40)
    const shares = BigInt('0x' + row.data.slice(-64))
    if (
      receiver !== ZERO &&
      !declaredExclusions.includes(receiver) &&
      shares > 0n &&
      !candidates.some((x) => x.owner === receiver)
    )
      candidates.push({ owner: receiver, lead: row })
    if (candidates.length === maximum) break
  }
  return candidates
}
function credentialVariants(origins) {
  const tokens = new Set(),
    generic = new Set(['', 'eth', 'ethereum', 'mainnet', 'rpc', 'api', 'v1', 'v2', 'v3', 'jsonrpc'])
  for (const o of origins) {
    const u = new URL(o.url),
      values = [o.url, ...[...u.searchParams].map(([, v]) => v)]
    for (const part of u.pathname.split('/')) {
      let decoded = part
      try {
        decoded = decodeURIComponent(part)
      } catch {}
      if (!generic.has(decoded.toLowerCase())) values.push(part, decoded)
    }
    for (const value of values) {
      let decoded = value
      try {
        decoded = decodeURIComponent(value)
      } catch {}
      for (const token of [value, decoded])
        if (token)
          for (const v of [
            token,
            encodeURIComponent(token),
            JSON.stringify(token).slice(1, -1),
            Buffer.from(token).toString('hex'),
            Buffer.from(token).toString('hex').toUpperCase(),
          ])
            tokens.add(v)
    }
  }
  return [...tokens]
}
export function assertFundedHolderProbePrivacy(value, secrets, headerResponsePolicy = null) {
  morphoProbeResponseByteLimit(headerResponsePolicy)
  check(
    Array.isArray(secrets) &&
      Object.getPrototypeOf(secrets) === Array.prototype &&
      secrets.length <= 128 &&
      Object.getOwnPropertySymbols(secrets).length === 0,
    'privacy_tokens',
  )
  const tokenDescriptors = Object.getOwnPropertyDescriptors(secrets)
  check(
    Object.keys(tokenDescriptors).length === secrets.length + 1 &&
      Object.values(tokenDescriptors).every((d) => Object.hasOwn(d, 'value')),
    'privacy_tokens',
  )
  secrets = Array.from({ length: secrets.length }, (_, i) => {
    const d = tokenDescriptors[i]
    check(
      d?.enumerable &&
        typeof d.value === 'string' &&
        d.value.length > 0 &&
        Buffer.byteLength(d.value) <= 65536,
      'privacy_token',
    )
    return d.value
  })
  let nodes = 0,
    bytes = 0
  const ancestors = new WeakSet()
  const scan = (s) => {
    bytes += Buffer.byteLength(s)
    check(bytes <= 32 * MB && !secrets.some((x) => s.includes(x)), 'credential_echo')
  }
  const visit = (v, key = '', depth = 0, rawLimit = 65536) => {
    check(++nodes <= 100000 && depth <= 32, 'privacy_bounds')
    if (v === null || typeof v === 'boolean') return
    if (typeof v === 'number') {
      check(Number.isFinite(v), 'privacy_number')
      return
    }
    if (typeof v === 'string') {
      scan(v)
      if (/base64$/i.test(key)) {
        check(v.length <= 4 * Math.ceil(rawLimit / 3), 'privacy_raw')
        const b = Buffer.from(v, 'base64')
        check(b.length <= rawLimit && b.toString('base64') === v, 'privacy_raw')
        const s = b.toString('utf8')
        check(Buffer.from(s).equals(b), 'privacy_utf8')
        scan(s)
        let parsed
        try {
          parsed = JSON.parse(s)
        } catch {
          check(!s.includes('\\'), 'privacy_escaped_malformed')
          return
        }
        visit(parsed, '', depth + 1)
      }
      return
    }
    check(v && typeof v === 'object' && !ancestors.has(v), 'privacy_object')
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v),
      ds = Object.getOwnPropertyDescriptors(v)
    check(
      (array ? proto === Array.prototype : proto === Object.prototype || proto === null) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.values(ds).every((d) => Object.hasOwn(d, 'value')),
      'privacy_descriptor',
    )
    const rawLimitForObject = Object.hasOwn(ds, 'nativeHeaderRole')
      ? morphoProbeResponseByteLimit(headerResponsePolicy, ds.request?.value, ds.nativeHeaderRole.value)
      : 65536
    ancestors.add(v)
    try {
      if (array) {
        check(Object.keys(ds).length === v.length + 1, 'privacy_array')
        for (let i = 0; i < v.length; i++) visit(ds[i].value, '', depth + 1)
      } else
        for (const [k, d] of Object.entries(ds)) {
          check(d.enumerable, 'privacy_enumerable')
          scan(k)
          visit(d.value, k, depth + 1, k === 'rawBodyBase64' ? rawLimitForObject : 65536)
        }
    } finally {
      ancestors.delete(v)
    }
  }
  visit(value)
  scan(JSON.stringify(value))
  return true
}
export function createProbeWriter(
  out,
  secrets,
  { clock = () => performance.now(), started = performance.now() } = {},
) {
  const parent = resolve(ROOT, 'data/research/venue-signals')
  check(
    dirname(out) === parent &&
      /^morpho-observed-funded-holder-probe-[A-Za-z0-9.-]+$/.test(basename(out)),
    'output_root',
  )
  guard()
  const p = lstatSync(parent)
  check(p.isDirectory() && !p.isSymbolicLink(), 'output_parent')
  mkdirSync(out, { mode: 0o700 })
  const made = lstatSync(out)
  check(
    made.isDirectory() && !made.isSymbolicLink() && (made.mode & 0o777) === 0o700,
    'output_directory',
  )
  let bytes = 0
  const refs = []
  const directory = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
  const deadline = () => check(clock() - started <= POLICY.deadline, 'overall_deadline')
  return {
    refs,
    used: () => bytes,
    deadline,
    write(name, value, terminal = false) {
      deadline()
      check(/^[a-z0-9_.-]{1,80}$/.test(name), 'artifact_name')
      assertFundedHolderProbePrivacy(value, secrets)
      const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) + '\n')
      check(
        data.length <= POLICY.file &&
          (!terminal || data.length <= POLICY.terminal) &&
          bytes + data.length <= POLICY.cohort - (terminal ? 0 : POLICY.terminal),
        'write_cap',
      )
      guard(data.length, terminal)
      const path = resolve(out, name),
        fd = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
      bytes += data.length
      try {
        let n = 0
        while (n < data.length) {
          const wrote = writeSync(fd, data, n, data.length - n)
          check(wrote > 0, 'short_write')
          n += wrote
        }
        fsyncSync(fd)
        const d = openSync(out, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          fsyncSync(d)
        } finally {
          closeSync(d)
        }
        const a = fstatSync(fd),
          b = lstatSync(path)
        check(
          a.isFile() &&
            b.isFile() &&
            !b.isSymbolicLink() &&
            a.dev === b.dev &&
            a.ino === b.ino &&
            a.size === data.length &&
            b.size === data.length &&
            a.nlink === 1 &&
            b.nlink === 1 &&
            (a.mode & 0o777) === 0o600 &&
            (b.mode & 0o777) === 0o600,
          'postfsync_identity',
        )
      } finally {
        closeSync(fd)
      }
      const back = readBytes(path, data.length, { bytes: 0, maximum: data.length })
      check(back.equals(data), 'write_readback')
      deadline()
      const ref = { file: name, bytes: data.length, fileSha256: sha(data) }
      refs.push(ref)
      return ref
    },
  }
}
/** @param {typeof import('./morpho-probe-raw-body-storage.mjs').MORPHO_NATIVE_HEADER_RESPONSE_POLICY | null} [headerResponsePolicy=null] */
export function verifyProbeControl(receipt, requests, settlements, namespace, headerResponsePolicy = null) {
  morphoProbeResponseByteLimit(headerResponsePolicy)
  check(
    receipt.pendingSettlements === 0 &&
      receipt.failure === null &&
      receipt.physicalStarts === receipt.ledger.length &&
      receipt.ledger.length === requests.length &&
      settlements.length === requests.length,
    'control_complete',
  )
  const utc = (value) =>
    typeof value === 'string' &&
    Number.isSafeInteger(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  check(
    utc(receipt.startedAtUtc) &&
      utc(receipt.availableAtUtc) &&
      Date.parse(receipt.startedAtUtc) <= Date.parse(receipt.availableAtUtc) &&
      Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0 &&
      receipt.elapsedMs <= 120000,
    'control_clock',
  )
  const priorStarts = new Map()
  for (const row of receipt.ledger) {
    check(
      utc(row.startedAtUtc) &&
        utc(row.completedAtUtc) &&
        row.startedAtUtc >= receipt.startedAtUtc &&
        row.startedAtUtc <= row.completedAtUtc &&
        row.completedAtUtc <= receipt.availableAtUtc &&
        Number.isFinite(row.startedElapsedMs) &&
        Number.isFinite(row.completedElapsedMs) &&
        row.startedElapsedMs >= 0 &&
        row.completedElapsedMs >= row.startedElapsedMs &&
        row.completedElapsedMs - row.startedElapsedMs <= 8000 &&
        row.completedElapsedMs <= receipt.elapsedMs &&
        row.startedElapsedMs - (priorStarts.get(row.host) ?? -Infinity) >= 250,
      'native_row_clock',
    )
    priorStarts.set(row.host, row.startedElapsedMs)
    const req = requests.find(
        (x) => x.physicalId === row.physicalId && x.controlNamespace === namespace,
      ),
      commitment = receipt.terminalCommitments.filter((x) => x.physicalId === row.physicalId),
      settlement = settlements.filter((x) => x.physicalId === row.physicalId)
    check(
      req &&
        commitment.length === 1 &&
        settlement.length === 1 &&
        commitment[0].rowSha256 === sha(JSON.stringify(row)),
      'raw_row_join',
    )
    const { sha256, ...body } = settlement[0]
    check(
      sha(JSON.stringify(body)) === sha256 && same(settlement[0].observation, row),
      'settlement_join',
    )
    const request = Buffer.from(req.requestBodyBase64, 'base64'),
      response = Buffer.from(row.rawBodyBase64 ?? '', 'base64')
    check(
      request.toString('base64') === req.requestBodyBase64 &&
        response.toString('base64') === row.rawBodyBase64 &&
        sha(request) === req.requestBodySha256 &&
        same(parseUsd3HypotheticalJson(request.toString()), row.request) &&
        response.length === row.bodyBytes &&
        response.length <= morphoProbeResponseByteLimit(headerResponsePolicy, row.request,
          row.nativeHeaderRole ?? null, req.key ?? null) &&
        sha(response) === row.bodySha256 &&
        row.accepted === true &&
        row.status === 'success',
      'native_raw_join',
    )
    const envelope = parseUsd3HypotheticalJson(response.toString('utf8'))
    check(
      envelope.jsonrpc === '2.0' &&
        envelope.id === row.request.id &&
        !Object.hasOwn(envelope, 'error'),
      'native_envelope',
    )
  }
  return true
}
export async function captureMorphoObservedFundedHolderProbe(prepared, origins, options = {}) {
  const { plan } = prepared,
    now = options.now ?? Date.now,
    clock = options.monotonic ?? (() => performance.now()),
    pace = options.pace ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    started = clock(),
    startedAtUtc = new Date(now()).toISOString()
  check(
    origins.length === 2 &&
      same(
        origins.map((x) => x.host),
        plan.origins,
      ),
    'origins',
  )
  const helpers =
      options.controllerModule ?? (await import('./usd3-hypothetical-history-capture.mjs')),
    fetcher = options.fetcher ?? globalThis.fetch
  const control = helpers.createUsd3HypotheticalCaptureControl(origins, {
    fetcher,
    now,
    monotonic: clock,
    pace,
  })
  const namespace = 'default-' + randomUUID(),
    logNamespace = 'logs-' + randomUUID(),
    hosts = plan.origins,
    requests = [],
    logRequests = [],
    traces = [],
    logLedger = [],
    logSettlements = [],
    last = new Map(),
    logPending = new Set(),
    logAborts = new Set()
  let scheduled = 0,
    stage = 'bootstrap',
    source = null,
    failure = null,
    logBytes = 0,
    logStageEnd = 0,
    stopped = false
  const deadline = () => check(!stopped && clock() - started < POLICY.deadline, 'overall_deadline')
  const spacing = async (host) => {
    while (clock() < (last.get(host) ?? -Infinity) + 250) {
      const before = clock()
      await pace(Math.ceil(last.get(host) + 250 - before))
      check(clock() > before, 'pacing_clock')
    }
  }
  const dispatch = async (o, spec, logs = false) => {
    deadline()
    await spacing(o.host)
    deadline()
    check(scheduled < 106 && (!logs || logLedger.length < 32), 'start_budget')
    const request = { jsonrpc: '2.0', id: ++scheduled, method: spec.method, params: spec.params },
      body = JSON.stringify(request),
      at = clock()
    last.set(o.host, at)
    if (!logs) {
      const requestRecord = {
        controlNamespace: namespace,
        physicalId: null,
        rpcId: request.id,
        key: spec.key,
        host: o.host,
        requestBodyBase64: Buffer.from(body).toString('base64'),
        requestBodySha256: sha(body),
      }
      requests.push(requestRecord)
      const response = await control.fetcher(o.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const physicalId = Number(response.headers.get('x-usd3-physical-id'))
      check(Number.isSafeInteger(physicalId) && physicalId > 0, 'default_physical_id')
      requestRecord.physicalId = physicalId
      const envelope = helpers.parseUsd3HypotheticalJson(await response.text())
      check(!Object.hasOwn(envelope, 'error'), 'rpc_native_error')
      traces.push({
        host: o.host,
        key: spec.key,
        request: spec,
        envelope,
        physicalId,
        controlNamespace: namespace,
      })
      return envelope
    }
    // eth_getLogs is excluded by the unchanged controller. This wrapper permits only a closed shard.
    check(
      spec.method === 'eth_getLogs' &&
        spec.params.length === 1 &&
        spec.params[0].address === plan.subjects[2].vault &&
        [plan.depositTopic, plan.transferTopic].includes(spec.params[0].topics[0]) &&
        BigInt(spec.params[0].toBlock) - BigInt(spec.params[0].fromBlock) < 8n,
      'log_spec',
    )
    const row = {
      physicalId: logLedger.length + 1,
      host: o.host,
      stage,
      request,
      startedAtUtc: new Date(now()).toISOString(),
      startedElapsedMs: at - started,
      completedAtUtc: null,
      completedElapsedMs: null,
      status: 'pending',
      httpStatus: null,
      bodyBytes: null,
      bodySha256: null,
      rawBodyBase64: null,
      safeCode: null,
      accepted: false,
    }
    logLedger.push(row)
    logRequests.push({
      controlNamespace: logNamespace,
      physicalId: row.physicalId,
      key: spec.key,
      host: o.host,
      requestBodyBase64: Buffer.from(body).toString('base64'),
      requestBodySha256: sha(body),
    })
    check(at < logStageEnd, 'log_stage_dispatch')
    const abort = new AbortController(),
      limit = Math.min(8000, 120000 - (at - started), logStageEnd - at)
    logAborts.add(abort)
    let reader,
      expired = false,
      timer
    const cancel = () => {
      if (reader) void reader.cancel().catch(() => {})
    }
    abort.signal.addEventListener('abort', cancel)
    const operation = (async () => {
      try {
        const response = await fetcher(o.url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body,
          signal: abort.signal,
        })
        row.httpStatus = response.status
        reader = response.body?.getReader()
        check(reader, 'log_stream')
        const chunks = [],
          digest = createHash('sha256')
        let n = 0
        while (true) {
          const v = await reader.read()
          if (v.done) break
          n += v.value.byteLength
          digest.update(v.value)
          row.bodyBytes = n
          row.bodySha256 = digest.copy().digest('hex')
          check(n <= 65536, 'log_response_cap')
          chunks.push(Buffer.from(v.value))
        }
        const bytes = Buffer.concat(chunks)
        row.rawBodyBase64 = bytes.toString('base64')
        row.bodyBytes = bytes.length
        row.bodySha256 = sha(bytes)
        logBytes += bytes.length
        check(
          logBytes <= 32 * 65536 && Buffer.from(bytes.toString('utf8')).equals(bytes),
          'log_aggregate_or_utf8',
        )
        const envelope = helpers.parseUsd3HypotheticalJson(bytes.toString('utf8'))
        check(
          response.ok &&
            !response.redirected &&
            (!response.url || new URL(response.url).hostname === o.host) &&
            envelope.jsonrpc === '2.0' &&
            envelope.id === request.id &&
            !Object.hasOwn(envelope, 'error'),
          'log_envelope',
        )
        check(
          !expired && !abort.signal.aborted && clock() - at <= limit && clock() < logStageEnd,
          'log_time',
        )
        row.accepted = true
        row.status = 'success'
        traces.push({
          host: o.host,
          key: spec.key,
          request: spec,
          envelope,
          physicalId: row.physicalId,
          controlNamespace: logNamespace,
        })
        return envelope
      } catch (error) {
        row.safeCode = expired ? 'log_timeout' : 'log_read_failed'
        row.status = 'failed'
        throw error
      } finally {
        if (reader) {
          if (!row.accepted) cancel()
          reader.releaseLock()
        }
        abort.signal.removeEventListener('abort', cancel)
        logAborts.delete(abort)
        row.completedAtUtc = new Date(now()).toISOString()
        row.completedElapsedMs = clock() - started
        logSettlements.push(
          seal({
            schema: 'morpho_holder_probe_log_settlement_v1',
            physicalId: row.physicalId,
            captureAcceptance: false,
            observation: structuredClone(row),
          }),
        )
      }
    })()
    logPending.add(operation)
    operation.then(
      () => logPending.delete(operation),
      () => logPending.delete(operation),
    )
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true
              abort.abort()
              reject(Error('morpho_holder_probe_log_timeout'))
            },
            Math.max(1, limit),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const group = async (name, specs) => {
    stage = name
    control.beginStage(name)
    const start = clock()
    await Promise.all(
      origins.map(async (o) => {
        for (const spec of specs) {
          check(clock() - start < 12000, 'stage_window')
          await dispatch(o, spec)
        }
      }),
    )
    check(clock() - start <= 12000, 'stage_window')
  }
  const hdr = (key, block) => ({ key, method: 'eth_getBlockByNumber', params: [block, false] })
  const native = (key, to, name, args = []) => probeNativeCall(key, to, name, args, source)
  let outputs = [],
    candidates = [],
    discoveryLogs = [],
    completedDiscoveryShards = 0,
    ausdAdapter = null
  try {
    await group('bootstrap', [
      { key: 'chain', method: 'eth_chainId', params: [] },
      hdr('finalized', 'finalized'),
    ])
    check(pairedProbeResult(traces, 'chain', hosts) === '0x1', 'chain')
    const headers = hosts.map((host) =>
      decodeProbeHeader(
        traces.find((t) => t.host === host && t.key === 'finalized').envelope,
        now(),
      ),
    )
    check(sameProbeSource(headers[0], headers[1]), 'source_pair')
    source = headers[0]
    check(now() - Date.parse(source.blockTime) <= 1800000, 'source_age')
    const pin = { blockHash: source.blockHash, requireCanonical: true },
      number = '0x' + BigInt(source.blockNumber).toString(16)
    await group('source_before', [hdr('source_before', number)])
    for (const o of hosts)
      check(
        sameProbeSource(
          decodeProbeHeader(
            traces.find((t) => t.host === o && t.key === 'source_before').envelope,
            now(),
          ),
          source,
        ),
        'source_before',
      )
    for (const subject of plan.subjects) {
      await group('identity_' + subject.id, [
        { key: subject.id + ':vault_code', method: 'eth_getCode', params: [subject.vault, pin] },
        { key: subject.id + ':asset_code', method: 'eth_getCode', params: [subject.asset, pin] },
        native(subject.id + ':asset', subject.vault, 'asset'),
        native(subject.id + ':shareDecimals', subject.vault, 'decimals'),
        native(subject.id + ':assetDecimals', subject.asset, 'decimals'),
        ...(subject.id === 'AUSD'
          ? [native('AUSD:liquidityAdapter', subject.vault, 'liquidityAdapter')]
          : []),
      ])
      check(
        wordAddress(pairedProbeResult(traces, subject.id + ':asset', hosts)) === subject.asset &&
          decodeProbeWord(pairedProbeResult(traces, subject.id + ':shareDecimals', hosts)) ===
            '18' &&
          decodeProbeWord(pairedProbeResult(traces, subject.id + ':assetDecimals', hosts)) ===
            String(subject.assetDecimals),
        'native_identity_units',
      )
      if (subject.id === 'AUSD')
        ausdAdapter = wordAddress(pairedProbeResult(traces, 'AUSD:liquidityAdapter', hosts))
      for (const key of [':vault_code', ':asset_code']) {
        const value = pairedProbeResult(traces, subject.id + key, hosts)
        check(HEX.test(value) && value !== '0x', 'runtime_presence')
      }
      await group(
        'balances_' + subject.id,
        subject.candidates.map((c) =>
          native(subject.id + ':S:' + c.owner, subject.vault, 'balanceOf', [c.owner]),
        ),
      )
      const quotes = subject.candidates.flatMap((c) => {
        const S = decodeProbeWord(pairedProbeResult(traces, subject.id + ':S:' + c.owner, hosts))
        return S === '0'
          ? []
          : [native(subject.id + ':Ea:' + c.owner, subject.vault, 'previewRedeem', [BigInt(S)])]
      })
      await group('full_previews_' + subject.id, quotes)
      outputs.push(
        ...subject.candidates.map((c) =>
          derivePairedFundedProbe(traces, subject, c.owner, source, hosts),
        ),
      )
    }
    const ausd = {
        ...plan.subjects[2],
        depositTopic: plan.depositTopic,
        liquidityAdapter: ausdAdapter,
      },
      excludedReceivers = [...new Set([ausd.vault, ausd.liquidityAdapter])],
      start = BigInt(source.blockNumber) - 63n,
      all = discoveryLogs
    for (let j = 0; j < 8; j++) {
      stage = 'ausd_log_shard_' + j
      const entered = clock(),
        from = start + BigInt(j * 8),
        to = from + 7n
      logStageEnd = entered + 12000
      for (const topic of [plan.depositTopic, plan.transferTopic]) {
        const spec = {
          key: 'logs:' + j + ':' + topic,
          method: 'eth_getLogs',
          params: [
            {
              address: ausd.vault,
              fromBlock: '0x' + from.toString(16),
              toBlock: '0x' + to.toString(16),
              topics: [topic],
            },
          ],
        }
        const envelopes = await Promise.all(origins.map((o) => dispatch(o, spec, true)))
        all.push(
          ...pairProbeLogShard(envelopes[0].result, envelopes[1].result, ausd, topic, from, to),
        )
      }
      check(clock() - entered <= 12000, 'log_stage_window')
      completedDiscoveryShards++
    }
    check(
      new Set(all.map((x) => x.transactionHash + ':' + x.logIndex)).size === all.length,
      'duplicate_discovery_log',
    )
    candidates = probeReceiverCandidates(all, ausd, excludedReceivers)
    await group(
      'selected_event_headers',
      [...new Set(candidates.map((c) => c.lead.blockNumber))].map((b) => hdr('event:' + b, b)),
    )
    for (const c of candidates) {
      const hs = hosts.map((host) =>
        decodeProbeHeader(
          traces.find((t) => t.host === host && t.key === 'event:' + c.lead.blockNumber).envelope,
          now(),
        ),
      )
      check(
        sameProbeSource(hs[0], hs[1]) &&
          hs[0].blockHash === c.lead.blockHash &&
          hs[0].blockTime <= source.blockTime,
        'selected_event_canonical',
      )
    }
    await group(
      'ausd_discovered_balances',
      candidates.map((c) => native('AUSD:S:' + c.owner, ausd.vault, 'balanceOf', [c.owner])),
    )
    const quotes = candidates.flatMap((c) => {
      const S = decodeProbeWord(pairedProbeResult(traces, 'AUSD:S:' + c.owner, hosts))
      return S === '0'
        ? []
        : [native('AUSD:Ea:' + c.owner, ausd.vault, 'previewRedeem', [BigInt(S)])]
    })
    await group('ausd_discovered_full_previews', quotes)
    outputs.push(
      ...candidates.map((c) => derivePairedFundedProbe(traces, ausd, c.owner, source, hosts)),
    )
    await group('source_after', [hdr('source_after', number)])
    for (const key of ['source_after'])
      for (const host of hosts)
        check(
          sameProbeSource(
            decodeProbeHeader(traces.find((t) => t.host === host && t.key === key).envelope, now()),
            source,
          ),
          'source_after',
        )
    deadline()
  } catch (error) {
    failure =
      error instanceof Error && /^morpho_holder_probe_[a-zA-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'morpho_holder_probe_provider_unavailable'
    stopped = true
    control.stop('probe_failed')
  }
  stopped = true
  for (const abort of logAborts) abort.abort()
  if (logPending.size) {
    let cleanup
    try {
      await Promise.race([
        Promise.allSettled([...logPending]),
        new Promise((r) => {
          cleanup = setTimeout(r, 250)
        }),
      ])
    } finally {
      clearTimeout(cleanup)
    }
  }
  const receipt = await control.finish(),
    settlements = structuredClone(control.settlementReceipts),
    logReceipt = {
      startedAtUtc,
      availableAtUtc: new Date(now()).toISOString(),
      elapsedMs: clock() - started,
      physicalStarts: logLedger.length,
      pendingSettlements: logPending.size,
      failure: failure ? 'probe_incomplete' : null,
      ledger: structuredClone(logLedger),
      terminalCommitments: logLedger.map((row) => ({
        physicalId: row.physicalId,
        rowSha256: sha(JSON.stringify(row)),
      })),
    }
  // Failed reads retain their original pre-dispatch bytes. Only a native ledger join can fill the local id.
  for (const request of requests)
    if (request.physicalId === null) {
      const row = receipt.ledger.find(
        (row) => row.host === request.host && row.request.id === request.rpcId,
      )
      if (row) request.physicalId = row.physicalId
    }
  if (!failure)
    try {
      check(
        !logPending.size &&
          clock() - started <= 120000 &&
          now() - Date.parse(source.blockTime) <= 1800000,
        'post_capture_clock',
      )
      verifyProbeControl(receipt, requests, settlements, namespace)
      verifyProbeControl(logReceipt, logRequests, logSettlements, logNamespace)
    } catch {
      failure = 'morpho_holder_probe_final_join_failed'
    }
  const secrets = credentialVariants(origins)
  const retainedLogSettlements = structuredClone(logSettlements)
  for (const value of [
    receipt,
    settlements,
    requests,
    logReceipt,
    retainedLogSettlements,
    logRequests,
    outputs,
  ])
    assertFundedHolderProbePrivacy(value, secrets)
  const discovery = {
    sourceBlockFrom: source ? (BigInt(source.blockNumber) - 63n).toString() : null,
    sourceBlockTo: source?.blockNumber ?? null,
    windowBlocks: 64,
    completedShards: completedDiscoveryShards,
    pairedNativeLogCount: discoveryLogs.length,
    selectedReceiverCount: candidates.length,
    nativeConfiguredAdapter: ausdAdapter,
    excludedReceivers:
      ausdAdapter === null ? null : [...new Set([plan.subjects[2].vault, ausdAdapter])],
    fundedReceiverCount: outputs.filter(
      (x) => x.subjectId === 'AUSD' && x.status === 'paired_native_funded_balance',
    ).length,
    status: failure
      ? 'incomplete'
      : candidates.length
        ? 'receiver_leads_observed'
        : 'no_receiver_leads_in_bounded_window',
    reason:
      failure ??
      (candidates.length ? null : 'no_paired_positive_share_receiver_leads_in_recent_64_blocks'),
    eventCatalogueComplete: false,
    universalNoHolderClaim: false,
    holderAvailabilityClaimed: false,
  }
  return {
    complete: failure === null,
    failure,
    source,
    outputs,
    candidates,
    discovery,
    default: { namespace, receipt, requests, settlements },
    logs: {
      namespace: logNamespace,
      receipt: logReceipt,
      requests: logRequests,
      settlements: retainedLogSettlements,
    },
    scheduledReads: scheduled,
    physicalStarts: receipt.physicalStarts + logLedger.length,
    acquisitionCompletedAtUtc: new Date(now()).toISOString(),
    elapsedMs: clock() - started,
    secrets,
  }
}
function verifySources(prepared) {
  const budget = { bytes: 0, maximum: POLICY.source }
  for (const s of prepared.sources) readPin(s.pin, budget)
}
export async function runMorphoObservedFundedHolderProbe(argv = process.argv.slice(2)) {
  check(argv.length === 0, 'fixed_CLI_no_options')
  guard()
  const started = performance.now(),
    prepared = prepareMorphoObservedFundedHolderProbe()
  const helper = await import('./usd3-hypothetical-history-capture.mjs'),
    origins = await helper.configuredUsd3HypotheticalOrigins()
  verifySources(prepared)
  const capture = await captureMorphoObservedFundedHolderProbe(prepared, origins)
  verifySources(prepared)
  const out = resolve(
    ROOT,
    'data/research/venue-signals/morpho-observed-funded-holder-probe-' +
      new Date().toISOString().replaceAll(':', '-') +
      '-' +
      randomUUID(),
  )
  const writer = createProbeWriter(out, capture.secrets, { started })
  let terminal
  try {
    writer.write('plan.json', {
      rawText: prepared.planBytes.toString('utf8'),
      fileSha256: PLAN_SHA,
    })
    for (let i = 0; i < prepared.sources.length; i++)
      writer.write('source-' + i + '.json', {
        pin: prepared.sources[i].pin,
        sourceText: prepared.sources[i].bytes.toString('utf8'),
      })
    for (let i = 0; i < prepared.originals.length; i++)
      writer.write('old-lead-' + i + '.json', {
        pin: prepared.originals[i].pin,
        rawText: prepared.originals[i].bytes.toString('utf8'),
        historicalOwnership: false,
      })
    writer.write(
      'default-control.json',
      seal({
        namespace: capture.default.namespace,
        receipt: capture.default.receipt,
        requests: capture.default.requests,
        ...FLAGS,
      }),
    )
    writer.write(
      'default-settlements.json',
      seal({
        namespace: capture.default.namespace,
        settlements: capture.default.settlements,
        ...FLAGS,
      }),
    )
    writer.write(
      'log-control.json',
      seal({
        namespace: capture.logs.namespace,
        receipt: capture.logs.receipt,
        requests: capture.logs.requests,
        ...FLAGS,
      }),
    )
    writer.write(
      'log-settlements.json',
      seal({ namespace: capture.logs.namespace, settlements: capture.logs.settlements, ...FLAGS }),
    )
    const report = seal({
      schema: 'morpho_observed_funded_holder_probe_report_v1',
      ...FLAGS,
      status: capture.complete ? 'complete' : 'partial',
      reason: capture.failure,
      source: capture.source,
      outputs: capture.outputs,
      discoveredReceivers: capture.candidates,
      ausdDiscovery: capture.discovery,
      positiveEntitlementLeads: capture.outputs.filter(
        (x) => x.status === 'paired_native_funded_balance',
      ),
      positiveEntitlementCount: capture.outputs.filter(
        (x) => x.status === 'paired_native_funded_balance',
      ).length,
      fundedSharesZeroEntitlementCount: capture.outputs.filter(
        (x) => x.status === 'paired_native_funded_balance_zero_entitlement',
      ).length,
      physicalStarts: capture.physicalStarts,
      scheduledReads: capture.scheduledReads,
      maximumPhysicalStarts: 106,
      defaultControllerStarts: capture.default.receipt.physicalStarts,
      separateLogStarts: capture.logs.receipt.physicalStarts,
      selectedEventHeadersOnly: true,
      unselectedEventHeadersVerified: false,
      eventCatalogueComplete: false,
      nativeAcquisitionCompletedAtUtc: capture.acquisitionCompletedAtUtc,
      availabilityBoundary: 'series_retention_pending',
      postRetentionAvailableAtUtc: null,
      sourcePins: prepared.sources.map((s) => s.pin),
      inputPins: prepared.originals.map((s) => s.pin),
    })
    check(Buffer.byteLength(JSON.stringify(report)) <= 32768, 'report_32KiB')
    writer.write('report.json', report)
    verifySources(prepared)
    writer.deadline()
    terminal = writer.write(
      'terminal.json',
      seal({
        schema: 'morpho_observed_funded_holder_probe_terminal_v1',
        ...FLAGS,
        status: capture.complete ? 'complete' : 'partial',
        reason: capture.failure,
        qualificationAtUtc: new Date().toISOString(),
        qualificationBoundary: 'before_terminal_fsync',
        references: writer.refs,
        attemptedBytesBeforeTerminal: writer.used(),
        source: capture.source,
        physicalStarts: capture.physicalStarts,
        originalsAreNotReissuableCapabilities: true,
      }),
      true,
    )
    writer.deadline()
    if (capture.complete)
      check(
        capture.source && Date.now() - Date.parse(capture.source.blockTime) <= 1800000,
        'post_retention_source_age',
      )
    return {
      complete: capture.complete,
      out,
      terminal,
      reason: capture.failure,
      physicalStarts: capture.physicalStarts,
      fundedLeads: capture.outputs.filter((x) => x.status === 'paired_native_funded_balance')
        .length,
      availableAtUtc: new Date().toISOString(),
      availabilityBoundary: 'after_terminal_fsync_readback_identity_and_deadline',
      elapsedMs: performance.now() - started,
      ...FLAGS,
    }
  } catch (error) {
    return {
      complete: false,
      out,
      reason: error instanceof Error ? error.message : 'morpho_holder_probe_retention_failed',
      retainedFiles: writer.refs.length,
      attemptedWriteBytes: writer.used(),
      physicalStarts: capture.physicalStarts,
      ...FLAGS,
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMorphoObservedFundedHolderProbe()
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + '\n')
      if (!result.complete) process.exitCode = 2
    })
    .catch(() => {
      process.stderr.write('morpho_holder_probe_failed\n')
      process.exitCode = 1
    })
}
