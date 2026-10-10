// Bounded, read-only diagnostic for two sealed AUSD VaultV2 impaired Q cells.
// Historical eth_call answers are size callability observations, never payouts.
import { pathToFileURL } from 'node:url'

import { encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import { readV2Issues, readV2Scores } from './carry-local-morpho-holder-v2.mjs'

export const ISSUE_IDS = Object.freeze([66, 67])
export const ISSUE_SHAS = Object.freeze({
  66: 'ea958a9397996e5e7831e33969f531e7afd5e6e381664394f30eb9512b2d8619',
  67: '6cdec512567a59440665d6832d2b91fb625fbba10b7da02d31755983ae823f20',
})
export const MAX_RPC_CALLS = 100
export const MAX_RESPONSE_BYTES = 32 * 1024
export const MAX_TOTAL_RESPONSE_BYTES = 1024 * 1024
export const MAX_RUN_MS = 180_000
export const MAX_BISECTION_STEPS = 6
const GAS = '0x1312d00' // 20,000,000 diagnostic cap; original holder call omitted gas.
export const GAS_BASIS = 'diagnostic_gas_cap_original_holder_measurement_gas_omitted'
const ABI = parseAbi([
  'function maxWithdraw(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const UINT = /^0x[0-9a-fA-F]{64}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_NUMBER = /^0x[0-9a-fA-F]+$/

export function selectOrigins(urls) {
  const seen = new Set()
  const selected = []
  for (const url of urls) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw Error('ausd_origin_invalid')
    if (seen.has(parsed.hostname)) continue
    seen.add(parsed.hostname)
    selected.push({ url, host: parsed.hostname })
    if (selected.length === 2) break
  }
  if (selected.length !== 2) throw Error('ausd_two_origins_required')
  return selected
}

export function selectCells(issues, scores) {
  return ISSUE_IDS.map((id) => {
    const issue = issues[id - 1]
    if (
      issue?.sequence !== id ||
      issue.sha256 !== ISSUE_SHAS[id] ||
      issue.routeKey !== 'AUSD → VaultV2 [AUSD]' ||
      !ADDRESS.test(issue.destination ?? '') ||
      !ADDRESS.test(issue.asset ?? '') ||
      !ADDRESS.test(issue.holder ?? '')
    )
      throw Error('ausd_issue_identity_changed')
    const small = issue.cases.find((row) => row.label === 'holder_small_sentinel')
    const high = issue.cases.find((row) => row.label === 'holder_near_claim_90pct')
    if (
      small?.baselineStatus !== 'simulated_withdraw_success' ||
      high?.baselineStatus !== 'baseline_revert' ||
      BigInt(small.assetsRaw) <= 0n ||
      BigInt(small.assetsRaw) >= BigInt(high.assetsRaw)
    )
      throw Error('ausd_issue_case_changed')
    const score = scores.find(
      (row) => row.issueSequence === id && row.caseLabel === high.label && row.horizonHours === 1,
    )
    if (
      score?.issueSha256 !== issue.sha256 ||
      score.outcome !== 'covered_revert_cause_unknown' ||
      score.transition !== 'still_reverting' ||
      score.assetsRaw !== high.assetsRaw ||
      !HASH.test(score.target?.targetHash ?? '') ||
      score.target?.targetHash !== score.targetWitness?.targetHash
    )
      throw Error('ausd_h1_cell_changed')
    return {
      issueSequence: id,
      issueSha256: issue.sha256,
      scoreSha256: score.sha256,
      vault: issue.destination,
      asset: issue.asset,
      holder: issue.holder,
      lowQ: small.assetsRaw,
      impairedQ: high.assetsRaw,
      points: [
        { label: 'baseline', number: issue.baseline.targetBlock, hash: issue.baseline.targetHash },
        { label: 'h1', number: score.target.targetBlock, hash: score.target.targetHash },
      ],
    }
  })
}

export function makeRpc(fetchImpl, nowMs = Date.now) {
  const started = nowMs()
  let calls = 0
  let responseBytes = 0
  const rpc = async (origin, method, params) => {
    if (++calls > MAX_RPC_CALLS || nowMs() - started > MAX_RUN_MS)
      throw Error('ausd_rpc_budget_exhausted')
    const request = { jsonrpc: '2.0', id: calls, method, params }
    const response = await fetchImpl(origin.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) throw Error(`ausd_http_${response.status}`)
    // Check Content-Length before materializing; then enforce actual bytes too.
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    if (declared > MAX_RESPONSE_BYTES) throw Error('ausd_response_oversize')
    let raw
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      const chunks = []
      let total = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > MAX_RESPONSE_BYTES || total + responseBytes > MAX_TOTAL_RESPONSE_BYTES)
            throw Error('ausd_response_oversize')
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      raw = Buffer.concat(chunks, total).toString('utf8')
    } else raw = await response.text()
    const bytes = Buffer.byteLength(raw)
    responseBytes += bytes
    if (bytes > MAX_RESPONSE_BYTES || responseBytes > MAX_TOTAL_RESPONSE_BYTES)
      throw Error('ausd_response_oversize')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      throw Error('ausd_rpc_json_invalid')
    }
    if (
      body?.id !== request.id ||
      body?.jsonrpc !== '2.0' ||
      (body.result === undefined && body.error === undefined)
    )
      throw Error('ausd_rpc_envelope_invalid')
    return { request, response: body, responseBytes: bytes }
  }
  return { rpc, budget: () => ({ calls, responseBytes, elapsedMs: nowMs() - started }) }
}

function decodedUint(reply) {
  const value = reply.response.result
  return typeof value === 'string' && UINT.test(value) ? BigInt(value) : null
}

export function classifyWithdrawal(reply) {
  if (reply.response.error) {
    const message = String(reply.response.error.message ?? '')
    if (/out of gas|gas required exceeds allowance|exceeds block gas|intrinsic gas/i.test(message))
      return 'inconclusive_rpc_error'
    return /execution reverted|revert(ed)?\b/i.test(message) ? 'revert' : 'inconclusive_rpc_error'
  }
  return decodedUint(reply) === null ? 'inconclusive_result' : 'success'
}

export async function bisectExecutable({ low, high, probe, steps = MAX_BISECTION_STEPS }) {
  if (low <= 0n || low >= high || steps > MAX_BISECTION_STEPS || steps < 0)
    throw Error('ausd_bracket_invalid')
  const samples = []
  for (let i = 0; i < steps && high - low > 1n; i++) {
    const q = (low + high) / 2n
    const receipt = await probe(q)
    samples.push({ q: q.toString(), ...receipt })
    if (receipt.status === 'success') low = q
    else if (receipt.status === 'revert') high = q
    else break
  }
  return { lowerSuccessRaw: low.toString(), upperRevertRaw: high.toString(), samples }
}

export async function probeOriginPoint(cell, point, origin, rpc) {
  const pin = { blockHash: point.hash, requireCanonical: true }
  const calls = []
  const record = async (method, params) => {
    const reply = await rpc(origin, method, params)
    calls.push(reply)
    return reply
  }
  const block = await record('eth_getBlockByNumber', [
    `0x${BigInt(point.number).toString(16)}`,
    false,
  ])
  if (
    block.response.result?.hash?.toLowerCase() !== point.hash.toLowerCase() ||
    block.response.result?.number?.toLowerCase() !== `0x${BigInt(point.number).toString(16)}`
  )
    throw Error('ausd_pinned_block_not_canonical')
  const ethCall = async (to, data, from = cell.holder, gas = GAS) =>
    record('eth_call', [{ from, to, data, gas }, pin])
  const maxReply = await ethCall(
    cell.vault,
    encodeFunctionData({ abi: ABI, functionName: 'maxWithdraw', args: [cell.holder] }),
  )
  const cashReply = await ethCall(
    cell.asset,
    encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [cell.vault] }),
  )
  const maxWithdrawRaw = decodedUint(maxReply)?.toString() ?? null
  const underlyingCashRaw = decodedUint(cashReply)?.toString() ?? null
  const withdraw = async (q) => {
    const reply = await ethCall(
      cell.vault,
      encodeFunctionData({
        abi: ABI,
        functionName: 'withdraw',
        args: [q, cell.holder, cell.holder],
      }),
    )
    return { status: classifyWithdrawal(reply), reply }
  }
  const low = BigInt(cell.lowQ)
  const high = BigInt(cell.impairedQ)
  const lowProbe = await withdraw(low)
  const highProbe = await withdraw(high)
  let bracket = null
  if (lowProbe.status === 'success' && highProbe.status === 'revert')
    bracket = await bisectExecutable({ low, high, probe: withdraw })
  return {
    issueSequence: cell.issueSequence,
    point,
    origin: origin.host,
    vault: cell.vault,
    asset: cell.asset,
    holder: cell.holder,
    maxWithdrawRaw,
    underlyingCashRaw,
    lowerEndpoint: { q: cell.lowQ, status: lowProbe.status },
    upperEndpoint: { q: cell.impairedQ, status: highProbe.status },
    bracket,
    interpretation: bracket
      ? 'single_origin_bounded_simulated_callability_only'
      : 'no_executable_bracket',
    calls,
  }
}

/** Require semantic equality before publishing a two-origin size bracket. */
export function pairOriginObservations(first, second) {
  const sameTarget =
    first?.issueSequence === second?.issueSequence &&
    first?.point?.label === second?.point?.label &&
    first?.point?.number === second?.point?.number &&
    first?.point?.hash === second?.point?.hash &&
    first?.vault === second?.vault &&
    first?.asset === second?.asset &&
    first?.holder === second?.holder &&
    first?.origin !== second?.origin
  const samples = (row) =>
    row.bracket?.samples.map((sample) => ({ q: sample.q, status: sample.status })) ?? null
  if (
    !sameTarget ||
    first.maxWithdrawRaw !== second.maxWithdrawRaw ||
    first.underlyingCashRaw !== second.underlyingCashRaw ||
    first.lowerEndpoint?.q !== second.lowerEndpoint?.q ||
    first.lowerEndpoint?.status !== second.lowerEndpoint?.status ||
    first.upperEndpoint?.q !== second.upperEndpoint?.q ||
    first.upperEndpoint?.status !== second.upperEndpoint?.status ||
    JSON.stringify(samples(first)) !== JSON.stringify(samples(second)) ||
    first.bracket?.lowerSuccessRaw !== second.bracket?.lowerSuccessRaw ||
    first.bracket?.upperRevertRaw !== second.bracket?.upperRevertRaw
  )
    throw Error('ausd_origin_disagreement')
  const gettersComplete = first.maxWithdrawRaw !== null && first.underlyingCashRaw !== null
  return {
    issueSequence: first.issueSequence,
    point: first.point,
    origins: [first.origin, second.origin],
    status: !gettersComplete
      ? 'getter_incomplete'
      : first.bracket
        ? 'corroborated_bounded_simulated_callability_only'
        : 'no_executable_bracket',
    bracket:
      gettersComplete && first.bracket
        ? {
            lowerSuccessRaw: first.bracket.lowerSuccessRaw,
            upperRevertRaw: first.bracket.upperRevertRaw,
            samples: samples(first),
          }
        : null,
  }
}

export async function runProbe({ fetchImpl = fetch, nowMs = Date.now, issues, scores, urls } = {}) {
  const loadedIssues = issues ?? (await readV2Issues())
  const cells = selectCells(loadedIssues, scores ?? (await readV2Scores(loadedIssues)))
  const origins = selectOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const { rpc, budget } = makeRpc(fetchImpl, nowMs)
  const chain = []
  for (const origin of origins) {
    const reply = await rpc(origin, 'eth_chainId', [])
    if (!HEX_NUMBER.test(reply.response.result ?? '') || BigInt(reply.response.result) !== 1n)
      throw Error('ausd_wrong_chain')
    chain.push({ origin: origin.host, ...reply })
  }
  const observations = []
  const paired = []
  for (const cell of cells) {
    for (const point of cell.points) {
      const first = await probeOriginPoint(cell, point, origins[0], rpc)
      const second = await probeOriginPoint(cell, point, origins[1], rpc)
      observations.push(first, second)
      paired.push(pairOriginObservations(first, second))
    }
  }
  return {
    schema: 'carry_morpho_ausd_threshold_diagnostic_v1',
    generatedAtUtc: new Date(nowMs()).toISOString(),
    request: {
      issueSequences: ISSUE_IDS,
      case: 'holder_near_claim_90pct',
      points: ['baseline', 'h1'],
      gas: GAS,
      gasBasis: GAS_BASIS,
      maxBisectionSteps: MAX_BISECTION_STEPS,
    },
    budgets: {
      maxRpcCalls: MAX_RPC_CALLS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxTotalResponseBytes: MAX_TOTAL_RESPONSE_BYTES,
      maxRunMs: MAX_RUN_MS,
      actual: budget(),
    },
    chain,
    observations,
    paired,
    limitation:
      'eth_call success is not mined holder payout; maxWithdraw is a getter, not proof of executable withdrawal; six bisections give only a sampled bracket.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw Error('usage: node carry-morpho-ausd-threshold-probe.mjs')
  runProbe()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
}
