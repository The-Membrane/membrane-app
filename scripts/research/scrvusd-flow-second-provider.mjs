// Independent-provider corroboration of immutable scrvUSD vault-flow receipts.
// Sidecars are research evidence, never a replacement for the primary ledger.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  collect,
  OUT as PRIMARY_OUT,
  readValidatedReceipts,
  sourceIdentity,
  RESERVE_BYTES,
  validateReceipt,
} from './curve-vault-flow-ledger.mjs'

export const STUDY = 'scrvusd-vault-flow-second-provider-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-vault-flow-second-provider')
const SHA = /^[0-9a-f]{64}$/
const HOST = /^[a-z0-9.-]{1,255}$/
const nativeFetch = globalThis.fetch
const digest = (value) => createHash('sha256').update(value).digest('hex')
const unsigned = ({ sha256: _sha, ...payload }) => payload
const seal = (payload) => ({ ...payload, sha256: digest(JSON.stringify(payload)) })
const filename = (receipt) => `${receipt.sha256}.json`
const secondaryPath = (out, receipt) => join(out, 'secondary', filename(receipt))
const primaryFilename = (receipt) =>
  `${String(receipt.range.from.number).padStart(12, '0')}-${String(receipt.range.to.number).padStart(12, '0')}-${receipt.range.to.hash.slice(2)}.json`

function primaryPhysicalSha(receipt, primaryOut) {
  const bytes = readFileSync(join(primaryOut, primaryFilename(receipt)))
  if (bytes.length > 2 * 1024 * 1024 || bytes.toString('utf8') !== `${JSON.stringify(receipt)}\n`)
    throw new Error('Primary receipt physical seal mismatch')
  return digest(bytes)
}

function diskGuard(path, extra, stat = statfsSync) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Second-provider disk reserve reached')
}

function checkPrimary(receipt, source) {
  if (
    !receipt ||
    !SHA.test(receipt.sha256) ||
    receipt.source?.identitySha256 !== source.identitySha256
  )
    throw new Error('Invalid primary receipt identity')
  if (receipt.sha256 !== digest(JSON.stringify(unsigned(receipt))))
    throw new Error('Primary receipt SHA mismatch')
  if (!HOST.test(receipt.pin?.rpcHost)) throw new Error('Missing primary RPC host')
}

function clientForUrl(secondRpcUrl, fetchImpl) {
  let url
  try {
    url = new URL(secondRpcUrl)
  } catch {
    throw new Error('Valid second RPC URL required')
  }
  if (url.protocol !== 'https:' || !HOST.test(url.hostname) || url.username || url.password)
    throw new Error('HTTPS second RPC URL with hostname required')
  let nextId = 0
  return {
    host: url.hostname,
    client: {
      async request({ method, params }) {
        const id = ++nextId
        const response = await fetchImpl(url.href, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        })
        if (!response?.ok) throw new Error('Second RPC HTTP request failed')
        const body = await response.json()
        if (body?.jsonrpc !== '2.0' || body.id !== id || body.error || !('result' in body))
          throw new Error('Second RPC response invalid')
        return body.result
      },
    },
  }
}

const canonical = (receipt) => ({
  sourceIdentitySha256: receipt.source.identitySha256,
  range: receipt.range,
  counts: receipt.counts,
  events: receipt.events,
})

function readSecondary(out, receipt, sidecar, source) {
  const bytes = readFileSync(secondaryPath(out, receipt))
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Secondary receipt size cap')
  const second = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${JSON.stringify(second)}\n`)
    throw new Error('Secondary receipt physical seal mismatch')
  validateReceipt(second, source, null)
  if (
    second.sha256 !== sidecar.secondaryReceiptSha256 ||
    digest(bytes) !== sidecar.secondaryReceiptPhysicalSha256 ||
    second.pin.rpcHost !== sidecar.secondRpcHost ||
    JSON.stringify(canonical(second)) !== JSON.stringify(canonical(receipt))
  )
    throw new Error('Secondary receipt disagrees with sidecar or primary')
  return second
}

function verifySidecar(sidecar, receipt, source, primaryOut, out) {
  checkPrimary(receipt, source)
  if (!sidecar || sidecar.sha256 !== digest(JSON.stringify(unsigned(sidecar))))
    throw new Error('Second-provider sidecar seal mismatch')
  if (
    sidecar.study !== STUDY ||
    sidecar.primaryReceiptSha256 !== receipt.sha256 ||
    sidecar.primaryReceiptPhysicalSha256 !== primaryPhysicalSha(receipt, primaryOut) ||
    sidecar.sourceIdentitySha256 !== source.identitySha256 ||
    !HOST.test(sidecar.primaryRpcHost) ||
    sidecar.primaryRpcHost !== receipt.pin.rpcHost ||
    !HOST.test(sidecar.secondRpcHost) ||
    sidecar.secondRpcHost === receipt.pin.rpcHost ||
    !['url_bound_fetch', 'injected_transport'].includes(sidecar.transportMode) ||
    !Number.isFinite(Date.parse(sidecar.firstLocalObservedAtUtc)) ||
    new Date(sidecar.firstLocalObservedAtUtc).toISOString() !== sidecar.firstLocalObservedAtUtc ||
    sidecar.fromBlock !== receipt.range.from.number ||
    sidecar.throughBlock !== receipt.range.to.number ||
    sidecar.fromHash !== receipt.range.from.hash ||
    sidecar.throughHash !== receipt.range.to.hash ||
    sidecar.eventCount !== receipt.events.length ||
    sidecar.canonicalSha256 !== digest(JSON.stringify(canonical(receipt))) ||
    !SHA.test(sidecar.secondaryReceiptSha256) ||
    !SHA.test(sidecar.secondaryReceiptPhysicalSha256)
  )
    throw new Error('Second-provider sidecar disagrees with primary receipt')
  const second = readSecondary(out, receipt, sidecar, source)
  if (Date.parse(sidecar.firstLocalObservedAtUtc) < Date.parse(second.captureEndUtc))
    throw new Error('Second-provider observation time predates collection')
  return sidecar
}

function appendSecondary(out, receipt, second, stat) {
  const path = secondaryPath(out, receipt)
  const bytes = `${JSON.stringify(second)}\n`
  diskGuard(out, Buffer.byteLength(bytes), stat)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes)
      throw new Error('Existing secondary receipt differs from collection')
    return
  }
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function appendSidecar(out, receipt, sidecar, stat, primaryOut) {
  const path = join(out, filename(receipt))
  if (existsSync(path)) {
    return readExactSidecar(path, receipt, receipt.source, primaryOut, out)
  }
  const bytes = `${JSON.stringify(sidecar)}\n`
  diskGuard(out, Buffer.byteLength(bytes), stat)
  mkdirSync(out, { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return sidecar
}

function readExactSidecar(path, receipt, source, primaryOut, out) {
  const bytes = readFileSync(path)
  if (bytes.length > 4096) throw new Error('Second-provider sidecar size cap')
  const saved = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${JSON.stringify(saved)}\n`)
    throw new Error('Second-provider physical seal mismatch')
  return verifySidecar(saved, receipt, source, primaryOut, out)
}

export async function reconcileReceipt({
  receipt,
  secondRpcUrl,
  fetchImpl = nativeFetch,
  source = sourceIdentity(),
  primaryOut = PRIMARY_OUT,
  out = OUT,
  stat = statfsSync,
} = {}) {
  checkPrimary(receipt, source)
  if (
    !readValidatedReceipts({ out: primaryOut, source }).some((row) => row.sha256 === receipt.sha256)
  )
    throw new Error('Primary receipt absent from validated ledger')
  const primaryReceiptPhysicalSha256 = primaryPhysicalSha(receipt, primaryOut)
  const { client, host: secondRpcHost } = clientForUrl(secondRpcUrl, fetchImpl)
  const transportMode = fetchImpl === nativeFetch ? 'url_bound_fetch' : 'injected_transport'
  if (secondRpcHost === receipt.pin.rpcHost)
    throw new Error('Distinct second RPC hostname required')
  const existing = join(out, filename(receipt))
  if (existsSync(existing)) {
    const old = readExactSidecar(existing, receipt, source, primaryOut, out)
    if (old.secondRpcHost !== secondRpcHost) throw new Error('Second-provider host changed')
    return old
  }
  diskGuard(out, 0, stat)
  const temporary = mkdtempSync(join(tmpdir(), 'scrvusd-second-provider-'))
  try {
    const result = await collect({
      client,
      out: temporary,
      source,
      fromBlock: receipt.range.from.number,
      toBlock: receipt.range.to.number,
      expectedTargetHash: receipt.range.to.hash,
      maxChunks: 1,
      range: receipt.range.to.number - receipt.range.from.number + 1,
      rpcHost: secondRpcHost,
      stat,
    })
    if (!result.completeThroughTarget || result.saved !== 1)
      throw new Error('Second provider could not verify exact primary range')
    const second = readValidatedReceipts({ out: temporary, source })[0]
    if (JSON.stringify(canonical(second)) !== JSON.stringify(canonical(receipt)))
      throw new Error('Second provider event set or finalized boundary disagrees')
    appendSecondary(out, receipt, second, stat)
    const observed = new Date()
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime()))
      throw new Error('Invalid local observation time')
    const sidecar = seal({
      study: STUDY,
      primaryReceiptSha256: receipt.sha256,
      primaryReceiptPhysicalSha256,
      secondaryReceiptSha256: second.sha256,
      secondaryReceiptPhysicalSha256: digest(`${JSON.stringify(second)}\n`),
      sourceIdentitySha256: source.identitySha256,
      primaryRpcHost: receipt.pin.rpcHost,
      secondRpcHost,
      transportMode,
      firstLocalObservedAtUtc: observed.toISOString(),
      fromBlock: receipt.range.from.number,
      throughBlock: receipt.range.to.number,
      fromHash: receipt.range.from.hash,
      throughHash: receipt.range.to.hash,
      eventCount: receipt.events.length,
      canonicalSha256: digest(JSON.stringify(canonical(receipt))),
    })
    return appendSidecar(out, receipt, sidecar, stat, primaryOut)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

// A caller supplies receipts from readValidatedReceipts; this function also checks
// their contiguous SHA chain so a partial set cannot certify a claimed window.
export function auditSidecars({
  receipts,
  out = OUT,
  primaryOut = PRIMARY_OUT,
  source = sourceIdentity(),
  fromBlock,
  throughBlock,
} = {}) {
  if (!Array.isArray(receipts) || !receipts.length)
    return { certified: false, reason: 'no_primary_receipts' }
  if (
    JSON.stringify(receipts) !== JSON.stringify(readValidatedReceipts({ out: primaryOut, source }))
  )
    throw new Error('Primary receipts differ from validated physical ledger')
  let previous = null
  for (const receipt of receipts) {
    checkPrimary(receipt, source)
    if (
      receipt.previousReceiptSha256 !== (previous?.sha256 ?? null) ||
      (previous && receipt.range.from.number !== previous.range.to.number + 1)
    )
      throw new Error('Primary receipt coverage gap or broken chain')
    previous = receipt
  }
  const first = receipts[0].range.from.number
  const last = receipts.at(-1).range.to.number
  if (
    (fromBlock !== undefined && first > fromBlock) ||
    (throughBlock !== undefined && last < throughBlock)
  )
    return {
      certified: false,
      reason: 'primary_window_incomplete',
      fromBlock: first,
      throughBlock: last,
    }
  const expected = new Set(receipts.map(filename))
  const found = existsSync(out) ? readdirSync(out).filter((name) => name.endsWith('.json')) : []
  if (found.some((name) => !expected.has(name)))
    throw new Error('Unexpected second-provider sidecar')
  const missing = receipts.filter((receipt) => !found.includes(filename(receipt)))
  if (missing.length)
    return {
      certified: false,
      reason: 'second_provider_coverage_incomplete',
      receiptCount: receipts.length,
      confirmedCount: receipts.length - missing.length,
      firstMissingReceiptSha256: missing[0].sha256,
    }
  const hosts = new Set()
  const transportModes = new Set()
  for (const receipt of receipts) {
    const path = join(out, filename(receipt))
    const saved = readExactSidecar(path, receipt, source, primaryOut, out)
    hosts.add(saved.secondRpcHost)
    transportModes.add(saved.transportMode)
  }
  if (transportModes.has('injected_transport'))
    return {
      certified: false,
      reason: 'injected_transport_unattested',
      fromBlock: first,
      throughBlock: last,
      receiptCount: receipts.length,
    }
  return {
    certified: true,
    claim: 'distinct_rpc_url_event_agreement_without_operator_attestation',
    fromBlock: first,
    throughBlock: last,
    receiptCount: receipts.length,
    sidecarCount: found.length,
    secondRpcHosts: [...hosts].sort(),
  }
}
