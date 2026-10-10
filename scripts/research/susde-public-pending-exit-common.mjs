// Public-only evidence for an ALREADY pending sUSDe cooldown. Never represents
// cooldown initiation as an exit, or an eth_call as mined USDe delivery.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

export const VAULT = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
export const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
export const SILO = '0x7fc7c91d556b400afa565013e3f32055a0713425'
export const ROUTE_KEY = 'USDe → Staked USDe [USDe]'
export const HORIZONS_HOURS = Object.freeze([1, 4, 24, 48, 168])
export const DEADLINE_HOURS = 2
export const HASH = /^0x[0-9a-f]{64}$/
export const ADDRESS = /^0x[0-9a-f]{40}$/
export const DECIMAL = /^(0|[1-9][0-9]*)$/
export const WORD = /^0x[0-9a-f]{64}$/
export const WITHDRAW_TOPIC = '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db'
export const MAX_RECORD_BYTES = 256 * 1024
const DISK_RESERVE = 1_073_741_824
const abi = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
  'function cooldownDuration() view returns (uint24)',
  'function cooldowns(address) view returns (uint104 cooldownEnd,uint256 underlyingAmount)',
  'function unstake(address)',
])
const tokenAbi = parseAbi(['function decimals() view returns (uint8)'])
export const sha = (value) => createHash('sha256').update(value).digest('hex')
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
export const utc = (value) => {
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value)
    throw Error('susde_clock_invalid')
  return ms
}
export const numberHex = (value) => `0x${BigInt(value).toString(16)}`
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const code = (value) => /^0x(?:[0-9a-f]{2})+$/.test(value ?? '')
const codeFingerprint = (value) => {
  if (!code(value)) throw Error('susde_contract_code_invalid')
  return {
    sha256: sha(Buffer.from(value.slice(2), 'hex')),
    byteLength: (value.length - 2) / 2,
  }
}
const validCodeFingerprint = (value) =>
  /^[0-9a-f]{64}$/.test(value?.sha256 ?? '') &&
  Number.isSafeInteger(value?.byteLength) &&
  value.byteLength > 0 &&
  value.byteLength <= 24_576
const compactHeader = (value) => {
  if (
    !/^0x[0-9a-f]+$/.test(value?.number ?? '') ||
    !HASH.test(value?.hash ?? '') ||
    !HASH.test(value?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/.test(value?.timestamp ?? '')
  )
    throw Error('susde_header_invalid')
  return {
    number: value.number,
    hash: value.hash,
    parentHash: value.parentHash,
    timestamp: value.timestamp,
  }
}
const word = (value) => {
  if (!WORD.test(value ?? '')) throw Error('susde_pinned_call_invalid')
  return BigInt(value)
}
const addressResult = (value) => {
  if (!WORD.test(value ?? '') || value.slice(2, 26) !== '0'.repeat(24))
    throw Error('susde_pinned_address_invalid')
  return `0x${value.slice(-40)}`
}
const unstakeData = (holder) => encodeFunctionData({ abi, functionName: 'unstake', args: [holder] })
const query = (method, params) => ({ method, params })
const expectedQueries = (anchor, holder) => {
  const pinned = pin(anchor.blockHash)
  const ethCall = (to, data) => query('eth_call', [{ to, data }, pinned])
  const header = query('eth_getBlockByNumber', [numberHex(anchor.blockNumber), false])
  return {
    header,
    again: header,
    vaultCode: query('eth_getCode', [VAULT, pinned]),
    assetCode: query('eth_getCode', [USDE, pinned]),
    siloCode: query('eth_getCode', [SILO, pinned]),
    ownerCode: query('eth_getCode', [holder, pinned]),
    asset: ethCall(VAULT, encodeFunctionData({ abi, functionName: 'asset' })),
    silo: ethCall(VAULT, encodeFunctionData({ abi, functionName: 'silo' })),
    decimals: ethCall(VAULT, '0x313ce567'),
    assetDecimals: ethCall(USDE, '0x313ce567'),
    duration: ethCall(VAULT, encodeFunctionData({ abi, functionName: 'cooldownDuration' })),
    cooldown: ethCall(
      VAULT,
      encodeFunctionData({ abi, functionName: 'cooldowns', args: [holder] }),
    ),
    unstake: query('eth_call', [{ to: VAULT, from: holder, data: unstakeData(holder) }, pinned]),
  }
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const bounded = (value) => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024
const explicitRevert = (error) =>
  Number.isSafeInteger(error?.code) && error?.message === 'execution reverted'

/** Recompute the published state solely from bounded, pinned, sanitized RPC evidence. */
export function derivePendingEvidence(evidence, anchor, holder) {
  if (!evidence || !bounded(evidence) || !ADDRESS.test(holder ?? ''))
    throw Error('susde_evidence_invalid')
  const expected = expectedQueries(anchor, holder)
  const value = (name) => {
    const entry = evidence.calls?.[name]
    if (!entry || !sameJson(entry.request, expected[name]) || !Object.hasOwn(entry, 'result'))
      throw Error('susde_evidence_invalid')
    return entry.result
  }
  const header = value('header')
  const vaultCode = value('vaultCode')
  const assetCode = value('assetCode')
  const siloCode = value('siloCode')
  const ownerCode = value('ownerCode')
  const asset = value('asset')
  const silo = value('silo')
  const decimals = value('decimals')
  const assetDecimals = value('assetDecimals')
  const duration = value('duration')
  const cooldown = value('cooldown')
  if (
    header?.hash !== anchor.blockHash ||
    BigInt(header.number ?? -1).toString() !== anchor.blockNumber ||
    new Date(Number(BigInt(header.timestamp)) * 1000).toISOString() !== anchor.blockAtUtc ||
    ![vaultCode, assetCode, siloCode].every(validCodeFingerprint) ||
    ownerCode !== '0x' ||
    !same(addressResult(asset), USDE) ||
    !same(addressResult(silo), SILO) ||
    word(decimals) !== 18n ||
    word(assetDecimals) !== 18n ||
    word(duration) === 0n ||
    word(duration) > 90n * 86400n ||
    !/^0x[0-9a-f]{128}$/.test(cooldown ?? '')
  )
    throw Error('susde_evidence_identity_invalid')
  const [end, pending] = decodeFunctionResult({ abi, functionName: 'cooldowns', data: cooldown })
  if (pending > 0n && end === 0n) throw Error('susde_evidence_cooldown_invalid')
  const eligible = pending > 0n && end <= BigInt(utc(anchor.blockAtUtc) / 1000)
  const attempt = evidence.calls.unstake
  let claim = pending === 0n ? 'no_pending' : eligible ? null : 'not_yet_eligible'
  if (eligible) {
    if (!attempt || !sameJson(attempt.request, expected.unstake))
      throw Error('susde_evidence_unstake_invalid')
    if (attempt.result === '0x' && !Object.hasOwn(attempt, 'error'))
      claim = 'simulated_unstake_success'
    else if (!Object.hasOwn(attempt, 'result') && explicitRevert(attempt.error))
      claim = 'unstake_revert_cause_unknown'
    else throw Error('susde_evidence_unstake_invalid')
  } else if (attempt !== null) throw Error('susde_evidence_unstake_unexpected')
  const again = value('again')
  if (!sameJson(again, header) || !sameJson(evidence.calls.again.request, expected.header))
    throw Error('susde_evidence_block_changed')
  if (Object.keys(evidence.calls).sort().join(',') !== Object.keys(expected).sort().join(','))
    throw Error('susde_evidence_call_set_invalid')
  return {
    holder,
    pendingAssetsRaw: pending.toString(),
    cooldownEndUtc: pending > 0n ? new Date(Number(end) * 1000).toISOString() : null,
    cooldownDurationSeconds: Number(word(duration)),
    claim,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
  }
}

export function validatePendingMeasurement(measurement, anchor, holder) {
  if (
    measurement?.holder !== holder ||
    measurement.blockHash !== anchor?.blockHash ||
    measurement.blockNumber !== anchor?.blockNumber ||
    measurement.readOnly !== true ||
    measurement.minedDeliveryProven !== false ||
    measurement.primaryProvider === measurement.secondaryProvider ||
    !Array.isArray(measurement.evidence) ||
    measurement.evidence.length !== 2 ||
    !bounded(measurement.evidence) ||
    measurement.evidence[0]?.provider !== measurement.primaryProvider ||
    measurement.evidence[1]?.provider !== measurement.secondaryProvider
  )
    throw Error('susde_measurement_proof_invalid')
  const {
    evidence,
    primaryProvider,
    secondaryProvider,
    readOnly,
    minedDeliveryProven,
    ...summary
  } = measurement
  for (const origin of evidence) {
    const derived = derivePendingEvidence(origin, anchor, holder)
    if (!sameJson(derived, summary)) throw Error('susde_measurement_summary_invalid')
  }
  for (const name of ['vaultCode', 'assetCode', 'siloCode']) {
    if (!sameJson(evidence[0].calls[name].result, evidence[1].calls[name].result))
      throw Error('susde_origin_code_disagreement')
  }
  if (!sameJson(evidence[0].calls.header.result, evidence[1].calls.header.result))
    throw Error('susde_origin_header_disagreement')
  return measurement
}

export function publicOriginPairs(urls, makeClients, now = Date.now) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 8)
    throw Error('susde_origins_invalid')
  const deadline = now() + 8 * 60_000
  const pairs = []
  for (let offset = 1; offset < urls.length && pairs.length < 24; offset++) {
    for (let index = 0; index < urls.length && pairs.length < 24; index++) {
      const clients = makeClients([urls[index], urls[(index + offset) % urls.length]])
      if (clients[0].provider === clients[1].provider) continue
      pairs.push(
        clients.map((client) => ({
          provider: client.provider,
          request: async (...args) => {
            if (now() >= deadline) throw Error('susde_rpc_budget_exhausted')
            return client.request(...args)
          },
          ...(typeof client.send === 'function'
            ? {
                send: async (...args) => {
                  if (now() >= deadline) throw Error('susde_rpc_budget_exhausted')
                  return client.send(...args)
                },
              }
            : {}),
        })),
      )
    }
  }
  if (!pairs.length) throw Error('susde_origins_unavailable')
  return pairs
}

/** Check one finalized header on two independent public origins. */
export async function finalizedAnchor(primary, secondary, now = () => new Date()) {
  const [chainA, chainB, a, b] = await Promise.all([
    primary.request('eth_chainId', []),
    secondary.request('eth_chainId', []),
    primary.request('eth_getBlockByNumber', ['finalized', false]),
    secondary.request('eth_getBlockByNumber', ['finalized', false]),
  ])
  if (chainA !== '0x1' || chainB !== '0x1') throw Error('susde_chain_invalid')
  const number = BigInt(a?.number ?? -1)
  if (!HASH.test(a?.hash ?? '') || !HASH.test(a?.parentHash ?? '') || number <= 0n)
    throw Error('susde_anchor_invalid')
  const at = new Date(Number(BigInt(a.timestamp)) * 1000).toISOString()
  const observedAtUtc = now().toISOString()
  if (utc(observedAtUtc) - utc(at) > 60 * 60_000 || utc(observedAtUtc) - utc(at) < -120_000)
    throw Error('susde_anchor_stale')
  const peer =
    BigInt(b?.number ?? -1) >= number
      ? await secondary.request('eth_getBlockByNumber', [a.number, false])
      : null
  if (
    !peer ||
    peer.hash !== a.hash ||
    peer.parentHash !== a.parentHash ||
    peer.timestamp !== a.timestamp ||
    !HASH.test(b?.hash ?? '')
  )
    throw Error('susde_anchor_disagreement')
  return {
    blockNumber: number.toString(),
    blockHash: a.hash,
    blockAtUtc: at,
    observedAtUtc,
    primaryProvider: primary.provider,
    secondaryProvider: secondary.provider,
  }
}

/** Same pinned block, identity, pending queue, and simulation on both origins. */
export async function measurePending(client, anchor, holder) {
  if (!ADDRESS.test(holder ?? '') || !HASH.test(anchor?.blockHash ?? ''))
    throw Error('susde_measurement_input_invalid')
  const expected = expectedQueries(anchor, holder)
  const calls = {}
  const capture = async (name) => {
    const request = expected[name]
    const raw = await client.request(request.method, request.params)
    calls[name] = {
      request,
      result: ['vaultCode', 'assetCode', 'siloCode'].includes(name)
        ? codeFingerprint(raw)
        : ['header', 'again'].includes(name)
          ? compactHeader(raw)
          : raw,
    }
  }
  await Promise.all(
    Object.keys(expected)
      .filter((name) => name !== 'again' && name !== 'unstake')
      .map(capture),
  )
  // Validate route, holder code and cooldown before deciding whether a claim is due.
  const cooldown = calls.cooldown.result
  if (!/^0x[0-9a-f]{128}$/.test(cooldown ?? '')) throw Error('susde_cooldown_invalid')
  const [end, pending] = decodeFunctionResult({ abi, functionName: 'cooldowns', data: cooldown })
  if (pending > 0n && end <= BigInt(utc(anchor.blockAtUtc) / 1000)) {
    const request = expected.unstake
    if (typeof client.send === 'function') {
      const response = await client.send({ jsonrpc: '2.0', id: 1, ...request })
      if (response?.jsonrpc !== '2.0' || response.id !== 1)
        throw Error('susde_rpc_envelope_invalid')
      if (Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error'))
        calls.unstake = { request, result: response.result }
      else if (!Object.hasOwn(response, 'result') && explicitRevert(response.error))
        calls.unstake = {
          request,
          error: { code: response.error.code, message: 'execution reverted' },
        }
      else throw Error('susde_rpc_unstake_unavailable')
    } else {
      try {
        calls.unstake = { request, result: await client.request(request.method, request.params) }
      } catch (error) {
        if (!explicitRevert(error)) throw error
        calls.unstake = { request, error: { code: error.code, message: 'execution reverted' } }
      }
    }
  } else calls.unstake = null
  await capture('again')
  const evidence = { provider: client.provider, calls }
  const summary = derivePendingEvidence(evidence, anchor, holder)
  return { ...summary, evidence }
}

export async function measureTwoOrigins(primary, secondary, anchor, holder) {
  const [a, b] = await Promise.all([
    measurePending(primary, anchor, holder),
    measurePending(secondary, anchor, holder),
  ])
  const { evidence: primaryEvidence, ...primarySummary } = a
  const { evidence: secondaryEvidence, ...secondarySummary } = b
  if (!sameJson(primarySummary, secondarySummary)) throw Error('susde_origin_state_disagreement')
  return validatePendingMeasurement(
    {
      ...primarySummary,
      primaryProvider: primary.provider,
      secondaryProvider: secondary.provider,
      readOnly: true,
      minedDeliveryProven: false,
      evidence: [primaryEvidence, secondaryEvidence],
    },
    anchor,
    holder,
  )
}

const filename = (n) => `${String(n).padStart(8, '0')}.json`
export async function readLedger(out) {
  let names
  try {
    names = (await readdir(out)).filter((x) => x.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const name of names) {
    if (name !== filename(rows.length + 1)) throw Error('susde_ledger_gap')
    const bytes = await readFile(join(out, name))
    if (bytes.length > MAX_RECORD_BYTES) throw Error('susde_ledger_record_large')
    const row = JSON.parse(bytes.toString('utf8'))
    const { sha256, ...body } = row
    if (
      bytes.toString('utf8') !== `${JSON.stringify(row)}\n` ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (rows.at(-1)?.sha256 ?? null) ||
      sha256 !== sha(JSON.stringify(body))
    )
      throw Error('susde_ledger_corrupt')
    rows.push(row)
  }
  return rows
}
export async function appendLedger(out, row, verify, stat = statfsSync) {
  await mkdir(out, { recursive: true })
  const rows = await verify(out)
  if (row.sequence !== rows.length + 1 || row.previousSha256 !== (rows.at(-1)?.sha256 ?? null))
    throw Error('susde_ledger_changed')
  const bytes = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw Error('susde_ledger_record_large')
  const free = stat(out)
  if (Number(free.bavail) * Number(free.bsize) < DISK_RESERVE + Buffer.byteLength(bytes))
    throw Error('susde_disk_reserve')
  const tmp = join(out, `.susde-${randomUUID()}.tmp`)
  try {
    const file = await open(tmp, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await link(tmp, join(out, filename(row.sequence)))
    const directory = await open(out, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(tmp, { force: true })
  }
  return { sequence: row.sequence, sha256: row.sha256 }
}
export function seal(body) {
  return { ...body, sha256: sha(JSON.stringify(body)) }
}
