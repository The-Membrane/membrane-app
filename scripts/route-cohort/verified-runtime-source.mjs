// Research-only Sourcify source witness. Byte identity is not an accounting,
// holder-completeness, route-attribution, or public-TVL certificate.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyRecord as verifyIdentity } from './share-runtime-identity.mjs'
import { checkDisk, TOKENS } from './share-transfer-source.mjs'

export const MAX_RESPONSE_BYTES = 8_000_000
export const MAX_RECEIPT_BYTES = 8_300_000
export const TIMEOUT_MS = 20_000
const FILE = /^source-([a-f0-9]{64})\.json$/
const IDENTITY_FILE = /^identity-([a-f0-9]{64})\.json$/
const CODE = /^0x(?:[a-f0-9]{2})+$/
export const ATTESTATION = 'sourcify_response_attestation_not_independent_compilation'
const ADDRESSES = Object.freeze({
  sGHO: '0xff229a0bbb614a284de8ae0e41e5974878fd7c04',
  sGHOProxy: TOKENS.sGHO,
  sUSDe: TOKENS.sUSDe,
})
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (code) => {
  throw new Error(`verified_source_${code}`)
}

export function sourceUrl(address) {
  return `https://sourcify.dev/server/v2/contract/1/${address}?fields=all`
}

function target(token, address, url) {
  if (!Object.hasOwn(ADDRESSES, token) || address?.toLowerCase() !== ADDRESSES[token])
    fail('target_invalid')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail('url_invalid')
  }
  if (parsed.href !== sourceUrl(ADDRESSES[token])) fail('url_invalid')
  return { token, address: ADDRESSES[token], url: parsed.href }
}

function readIdentity(path, expected) {
  if (!IDENTITY_FILE.test(path.split('/').at(-1)) || lstatSync(path).isSymbolicLink())
    fail('identity_path_invalid')
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > 250_000) fail('identity_size_invalid')
  const bytes = readFileSync(path)
  const digest = sha(bytes)
  if (digest !== IDENTITY_FILE.exec(path.split('/').at(-1))[1]) fail('identity_hash_mismatch')
  let receipt
  try {
    receipt = JSON.parse(bytes)
  } catch {
    fail('identity_json_invalid')
  }
  verifyIdentity(receipt)
  const receiptToken = expected.token === 'sGHOProxy' ? 'sGHO' : expected.token
  if (receipt.config.token !== receiptToken || receipt.config.chainId !== 1)
    fail('identity_target_mismatch')
  const code =
    expected.token === 'sGHO' ? receipt.primary.implementationCode : receipt.primary.vaultCode
  if (expected.token === 'sGHO' && receipt.primary.implementation !== expected.address)
    fail('identity_target_mismatch')
  if (
    expected.token === 'sGHOProxy' &&
    (receipt.config.vault !== expected.address || receipt.primary.implementation !== ADDRESSES.sGHO)
  )
    fail('identity_target_mismatch')
  if (expected.token === 'sUSDe' && receipt.config.vault !== expected.address)
    fail('identity_target_mismatch')
  if (!CODE.test(code)) fail('identity_code_invalid')
  return { digest, path: realpathSync(path), receipt, code }
}

function validateResponse(response, expected, identity) {
  if (response?.chainId !== '1' && response?.chainId !== 1) fail('chain_mismatch')
  if (response.address?.toLowerCase() !== expected.address) fail('address_mismatch')
  if (!['match', 'exact_match'].includes(response.runtimeMatch)) fail('runtime_unverified')
  const onchain = response.runtimeBytecode?.onchainBytecode
  if (typeof onchain !== 'string' || !CODE.test(onchain.toLowerCase())) fail('runtime_invalid')
  if (onchain.toLowerCase() !== identity.code) fail('runtime_mismatch')
  if (
    !response.sources ||
    typeof response.sources !== 'object' ||
    Object.keys(response.sources).length === 0 ||
    Object.values(response.sources).some((source) => typeof source?.content !== 'string') ||
    Object.values(response.sources).every((source) => source.content.length === 0)
  )
    fail('sources_missing')
  if (typeof response.compilation?.fullyQualifiedName !== 'string') fail('source_identity_missing')
  if (!Object.hasOwn(response.sources, response.compilation.fullyQualifiedName.split(':')[0]))
    fail('source_identity_missing')
  return {
    runtimeMatch: response.runtimeMatch,
    fullyQualifiedName: response.compilation.fullyQualifiedName,
    sourceFiles: Object.keys(response.sources).length,
  }
}

async function boundedFetch(url, fetcher) {
  let response
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  } catch {
    fail('fetch_failed')
  }
  if (!response?.ok || response.status !== 200) fail('http_failed')
  if (response.url && response.url !== url) fail('redirect_rejected')
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail('response_size_cap')
  if (!response.body?.getReader) fail('response_unreadable')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) fail('response_size_cap')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function ensureSeparated(out, identityPath) {
  if (existsSync(out)) fail('output_exists')
  let ancestor = dirname(out)
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
  const prospective = join(realpathSync(ancestor), relative(resolve(ancestor), resolve(out)))
  const identity = realpathSync(identityPath)
  if (prospective === identity || identity.startsWith(`${prospective}/`))
    fail('output_overlaps_identity')
}

function seal(out, record, stat = statfsSync, link = linkSync) {
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > MAX_RECEIPT_BYTES) fail('receipt_size_cap')
  if (existsSync(out)) fail('output_exists')
  checkDisk(out, stat, bytes.length)
  try {
    mkdirSync(out, { recursive: false, mode: 0o700 })
  } catch {
    fail('output_unavailable')
  }
  const name = `source-${sha(bytes)}.json`
  const path = join(out, name)
  const temp = `${path}.${randomUUID()}.tmp`
  let fd
  let failed = false
  try {
    fd = openSync(temp, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    link(temp, path)
  } catch {
    failed = true
    fail('seal_failed')
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    if (failed && existsSync(out) && readdirSync(out).length === 0) rmdirSync(out)
  }
  return { name, sha256: sha(bytes) }
}

export function verify(out, identityPath, expected) {
  const names = readdirSync(out)
  if (names.length !== 1 || !FILE.test(names[0])) fail('output_invalid')
  const path = join(out, names[0])
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > MAX_RECEIPT_BYTES)
    fail('receipt_invalid')
  const bytes = readFileSync(path)
  if (bytes.length > MAX_RECEIPT_BYTES || sha(bytes) !== FILE.exec(names[0])[1])
    fail('receipt_hash_mismatch')
  let record
  try {
    record = JSON.parse(bytes)
  } catch {
    fail('receipt_json_invalid')
  }
  if (
    record?.schema !== 1 ||
    record.kind !== 'verified_runtime_source_research_only' ||
    record.attestation !== ATTESTATION
  )
    fail('receipt_invalid')
  const selected = target(record.token, record.address, record.sourceUrl)
  if (expected && (expected.token !== selected.token || expected.address !== selected.address))
    fail('target_mismatch')
  const identity = readIdentity(identityPath, selected)
  if (
    record.identitySha256 !== identity.digest ||
    record.identityBlock !== identity.receipt.config.block ||
    record.identityBlockHash !== identity.receipt.config.blockHash
  )
    fail('identity_binding_mismatch')
  if (
    typeof record.responseRaw !== 'string' ||
    Buffer.byteLength(record.responseRaw) > MAX_RESPONSE_BYTES
  )
    fail('response_invalid')
  if (sha(Buffer.from(record.responseRaw)) !== record.responseSha256) fail('response_hash_mismatch')
  let response
  try {
    response = JSON.parse(record.responseRaw)
  } catch {
    fail('response_json_invalid')
  }
  const summary = validateResponse(response, selected, identity)
  if (JSON.stringify(summary) !== JSON.stringify(record.summary)) fail('summary_mismatch')
  return {
    token: selected.token,
    address: selected.address,
    block: record.identityBlock,
    attestation: ATTESTATION,
    ...summary,
    name: names[0],
    sha256: sha(bytes),
  }
}

function options(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--run' || key === '--verify') {
      if (result[key]) fail('cli_invalid')
      result[key] = true
    } else if (['--token', '--address', '--url', '--identity', '--out'].includes(key)) {
      if (result[key] !== undefined || !argv[i + 1]) fail('cli_invalid')
      result[key] = argv[++i]
    } else fail('cli_invalid')
  }
  if (!result['--identity'] || !result['--out'] || result['--run'] === result['--verify'])
    fail('cli_invalid')
  return result
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const opts = options(argv)
  const expected = opts['--token']
    ? target(opts['--token'], opts['--address'], opts['--url'])
    : undefined
  if (opts['--verify']) {
    if (['--token', '--address', '--url'].some((key) => opts[key] !== undefined) && !expected)
      fail('cli_invalid')
    return verify(opts['--out'], opts['--identity'], expected)
  }
  if (!expected) fail('cli_invalid')
  ensureSeparated(opts['--out'], opts['--identity'])
  const identity = readIdentity(opts['--identity'], expected)
  checkDisk(opts['--out'], dependencies.stat ?? statfsSync)
  const raw = await boundedFetch(expected.url, dependencies.fetch ?? fetch)
  if (!Buffer.from(raw.toString('utf8'), 'utf8').equals(raw)) fail('response_utf8_invalid')
  let response
  try {
    response = JSON.parse(raw)
  } catch {
    fail('response_json_invalid')
  }
  const summary = validateResponse(response, expected, identity)
  const record = {
    schema: 1,
    kind: 'verified_runtime_source_research_only',
    attestation: ATTESTATION,
    token: expected.token,
    address: expected.address,
    sourceUrl: expected.url,
    identitySha256: identity.digest,
    identityBlock: identity.receipt.config.block,
    identityBlockHash: identity.receipt.config.blockHash,
    responseSha256: sha(raw),
    responseRaw: raw.toString('utf8'),
    summary,
  }
  seal(opts['--out'], record, dependencies.stat ?? statfsSync, dependencies.link ?? linkSync)
  return verify(opts['--out'], opts['--identity'], expected)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${String(error?.message).startsWith('verified_source_') ? error.message : 'verified_source_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
