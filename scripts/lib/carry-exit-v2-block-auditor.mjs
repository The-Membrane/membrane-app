// Select the first canonical finalized Ethereum block at/after a DB-issued
// target. This is read-only single-provider evidence for carry_exit_v2_scores,
// not a cryptographic proof of canonicality or a holder exit quote.

const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x[0-9a-f]+$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_PROBES = 64
const MAX_CLOCK_SKEW_US = 120n * 1_000_000n

export class ExitV2BlockAuditError extends Error {
  constructor(code, cause) {
    super(code, { cause })
    this.name = 'ExitV2BlockAuditError'
    this.code = code
  }
}

function fail(code, cause) {
  throw new ExitV2BlockAuditError(code, cause)
}

export function exactUtcMicros(value) {
  if (typeof value !== 'string') fail('invalid_target_at')
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value)
  if (!match) fail('invalid_target_at')
  const millis = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1])
    fail('invalid_target_at')
  return BigInt(millis) * 1_000n + BigInt((match[2] ?? '').padEnd(6, '0') || '0')
}

function blockNumber(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value)
  if (typeof value === 'bigint') {
    if (value <= 0n) fail('invalid_baseline_block')
    return value
  }
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) <= 0n)
    fail('invalid_baseline_block')
  return BigInt(value)
}

function header(raw, expectedNumber) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !HEX.test(raw.number ?? '') ||
    !HASH.test(raw.hash ?? '') ||
    !HASH.test(raw.parentHash ?? '') ||
    !HEX.test(raw.timestamp ?? '')
  )
    fail('invalid_rpc_header')
  const number = BigInt(raw.number)
  const timestamp = BigInt(raw.timestamp)
  if (number <= 0n || timestamp <= 0n || (expectedNumber != null && number !== expectedNumber))
    fail('invalid_rpc_header')
  const at = new Date(Number(timestamp) * 1_000)
  if (!Number.isSafeInteger(Number(timestamp)) || !Number.isFinite(at.getTime()))
    fail('invalid_rpc_header')
  return {
    number,
    hash: raw.hash,
    parentHash: raw.parentHash,
    timestamp,
    at: at.toISOString(),
  }
}

function evidenceHeader(value) {
  return {
    number: value.number.toString(),
    hash: value.hash,
    parentHash: value.parentHash,
    timestamp: value.at,
  }
}

function sameHeader(left, right) {
  return (
    left.number === right.number &&
    left.hash === right.hash &&
    left.parentHash === right.parentHash &&
    left.timestamp === right.timestamp
  )
}

async function readBlock(request, block) {
  const tag = typeof block === 'bigint' ? `0x${block.toString(16)}` : block
  try {
    return header(
      await request('eth_getBlockByNumber', [tag, false]),
      typeof block === 'bigint' ? block : null,
    )
  } catch (error) {
    if (error instanceof ExitV2BlockAuditError) throw error
    fail('rpc_unavailable', error)
  }
}

/**
 * @param {object} args
 * @param {string} args.targetAt Exact DB UTC timestamp, including microseconds.
 * @param {string|bigint} args.baselineBlock Decimal block number, or bigint.
 * @param {string} args.baselineHash Canonical baseline hash from the frozen case.
 * @param {string} args.provider Stable non-secret provider label, max 160 chars.
 * @param {string} args.source Stable recorder/source label, max 160 chars.
 * @param {(method: string, params: unknown[]) => Promise<unknown>} args.request JSON-RPC transport.
 * @param {() => Date} [args.now] Clock used only for observedAt, after all checks.
 */
export async function selectCarryExitV2FirstFinalizedBlock(args) {
  const { targetAt, baselineHash, provider, source, request, now = () => new Date() } = args
  const targetUs = exactUtcMicros(targetAt)
  const baselineNumber = blockNumber(args.baselineBlock)
  if (
    !HASH.test(baselineHash ?? '') ||
    typeof request !== 'function' ||
    typeof provider !== 'string' ||
    !provider.trim() ||
    provider.length > 160 ||
    typeof source !== 'string' ||
    !source.trim() ||
    source.length > 160
  )
    fail('invalid_audit_input')

  let chainId
  try {
    chainId = await request('eth_chainId', [])
  } catch (error) {
    fail('rpc_unavailable', error)
  }
  if (chainId !== '0x1') fail('wrong_chain')

  const finalized = await readBlock(request, 'finalized')
  if (finalized.number <= baselineNumber) fail('target_not_finalized')
  const baseline = await readBlock(request, baselineNumber)
  if (baseline.hash !== baselineHash) fail('baseline_not_canonical')
  if (baseline.timestamp * 1_000_000n >= targetUs) fail('target_precedes_baseline')
  if (finalized.timestamp * 1_000_000n < targetUs) fail('target_not_finalized')

  let low = baselineNumber + 1n
  let high = finalized.number
  let probes = 0
  while (low < high) {
    if (++probes > MAX_PROBES) fail('block_search_limit')
    const middle = low + (high - low) / 2n
    const candidate = await readBlock(request, middle)
    if (candidate.timestamp * 1_000_000n >= targetUs) high = middle
    else low = middle + 1n
  }
  const target = await readBlock(request, low)
  const parent = await readBlock(request, low - 1n)
  // A second finalized read guards an endpoint whose chain changed mid-search.
  const finalizedAfter = await readBlock(request, 'finalized')
  const baselineAfter = await readBlock(request, baselineNumber)
  const targetAfter = await readBlock(request, low)
  const parentAfter = await readBlock(request, low - 1n)
  if (
    finalizedAfter.number < target.number ||
    (finalizedAfter.number === finalized.number && finalizedAfter.hash !== finalized.hash) ||
    !sameHeader(baselineAfter, baseline) ||
    !sameHeader(targetAfter, target) ||
    !sameHeader(parentAfter, parent) ||
    target.number !== parent.number + 1n ||
    target.parentHash !== parent.hash ||
    parent.timestamp * 1_000_000n >= targetUs ||
    target.timestamp * 1_000_000n < targetUs ||
    target.number <= baselineNumber ||
    finalizedAfter.timestamp < target.timestamp
  )
    fail('noncanonical_target_boundary')

  const observedAt = now().toISOString()
  const observedUs = exactUtcMicros(observedAt)
  if (observedUs < target.timestamp * 1_000_000n) fail('observation_clock_before_block')
  if (finalizedAfter.timestamp * 1_000_000n > observedUs + MAX_CLOCK_SKEW_US)
    fail('finalized_head_after_observation')
  const canonicalityEvidenceDoc = {
    schema: 'carry_exit_v2_headers_v1',
    chainId: '1',
    finalityTag: 'finalized',
    provider,
    source,
    targetAt,
    observedAt,
    baselineHeader: evidenceHeader(baseline),
    targetHeader: evidenceHeader(target),
    parentHeader: evidenceHeader(parent),
    finalizedHead: evidenceHeader(finalizedAfter),
  }
  return {
    targetBlock: target.number.toString(),
    targetHash: target.hash,
    targetBlockAt: target.at,
    targetParentBlock: parent.number.toString(),
    targetParentHash: target.parentHash,
    parentHeaderHash: parent.hash,
    targetParentBlockAt: parent.at,
    targetObservedAt: observedAt,
    canonicalityEvidenceDoc,
  }
}

export function createCarryExitV2JsonRpcRequest(url, fetchImpl = fetch) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('invalid_rpc_url')
  let id = 0
  return async (method, params) => {
    const requestId = ++id
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`rpc_http_${response.status}`)
    const body = await response.json()
    if (body?.error || body?.id !== requestId || !Object.hasOwn(body ?? {}, 'result'))
      throw new Error('rpc_response_invalid')
    return body.result
  }
}
