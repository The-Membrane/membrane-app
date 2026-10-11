import { encodeFunctionData, parseAbi, sha256, stringToHex, type Hex } from 'viem'

import { freezeSusde, SUSDE_JOINT_HISTORY_PIN } from './susdeJointHistoryPins'
import type {
  AcceptSusdeCurrentEvidence,
  SusdeCurrentSource,
  SusdeHolderCurrentEvidence,
} from './susdeHolderTimeProcess'

/** Source attestation is Sourcify exact-match plus reviewed primary source, not a fresh compile. */
export const SUSDE_CURRENT_SOURCE_AUTHORITY = freezeSusde({
  attestation: 'sourcify_exact_match_not_independent_compilation',
  deployment: 'direct_constructor_no_proxy',
  sourceFileSha256: '62c2d60fdb2faa9b04bba1505092a98420dabd0b9f75276fe3ba5de16f26fb9b',
  assetSourceFileSha256: 'b36d6ff0d97f1a798b8cf047181765497e2680c6e085efa7012ca5ea52b7f0ad',
  siloSourceFileSha256: 'dfb558ea5623027295501a9857ccc0e22d871effaf3a9be54742778dbfdfcb14',
  primarySources: {
    erc4626: '0610f62eeae3a7dee46c4c37cc80c59060fd56cea7fb1e00a950f1e6a2f981ac',
    stakedUSDe: '8f73f8fad58e6269934abd86d7a97460dddc6b371542d53e1f88da6207a46c95',
    stakedUSDeV2: '4dbde81d2860a27f20cad544c5e7bdb6edaef7ab441538b4bc222966b646e747',
  },
  activeEntitlement: 'previewRedeem_full_active_shares_floor_excludes_pending',
  maxWithdraw: 'equals_active_entitlement_not_execution_aware',
})
const ABI = parseAbi([
  'function balanceOf(address) view returns(uint256)',
  'function previewRedeem(uint256) view returns(uint256)',
  'function maxWithdraw(address) view returns(uint256)',
  'function cooldowns(address) view returns(uint104 cooldownEnd,uint256 underlyingAmount)',
  'function cooldownDuration() view returns(uint24)',
])
const MAX = (1n << 256n) - 1n
const MAX_BYTES = 128 * 1024
const MAX_AGE_MS = 30 * 60 * 1000
const MAX_GAP_MS = 8000
const ADDRESSES = SUSDE_JOINT_HISTORY_PIN.addresses
const RUNTIMES = SUSDE_JOINT_HISTORY_PIN.runtimeIdentities
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v: unknown, names: readonly string[]) =>
  record(v) && Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k))
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const code = (v: unknown): v is Hex =>
  typeof v === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(v) && v.length <= 100000
const word = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    )
  if (record(a) || record(b))
    return (
      record(a) &&
      record(b) &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    )
  return Object.is(a, b)
}
const digest = (v: unknown) => sha256(stringToHex(JSON.stringify(v))).slice(2)
function check(value: unknown): asserts value {
  if (!value) throw Error('susde_optional_evidence_invalid')
}
export type SusdeProtocolExpected = {
  owner: string
  requestedRaw: string
  source: SusdeCurrentSource
  activeSharesRaw: string
  activeEntitlementRaw: string
  maxWithdrawRaw: string
  pendingAssetsRaw: string
  storedCooldownEndUnix: string
  cooldownDurationSeconds: string
  /** Required same-owner exact-Q assay; independent of the older full-M claim. */
  initiationStatus: 'success' | 'evm_revert' | 'not_applicable'
  pendingClaimStatus: 'success' | 'evm_revert' | 'not_yet_eligible' | 'no_pending_claim'
}
type Header = { number: string; hash: string; timestamp: string }
export type SusdeProtocolTrace = {
  key: string
  method: string
  params: unknown[]
  result: string | Header
  startedAtUtc: string
  completedAtUtc: string
}
export type SusdeProtocolOriginObservation = {
  schema: 'susde_header_enclosed_current_native_v1'
  expected: SusdeProtocolExpected
  startedAtUtc: string
  readAtUtc: string
  traces: SusdeProtocolTrace[]
}
export type SusdeProtocolRequestClient = {
  request: (wire: { method: string; params: unknown[] }) => Promise<unknown>
}
const issuedOriginClients = new WeakMap<object, SusdeProtocolRequestClient>()
function validExpected(e: SusdeProtocolExpected, now: number) {
  return (
    keys(e, [
      'owner',
      'requestedRaw',
      'source',
      'activeSharesRaw',
      'activeEntitlementRaw',
      'maxWithdrawRaw',
      'pendingAssetsRaw',
      'storedCooldownEndUnix',
      'cooldownDurationSeconds',
      'initiationStatus',
      'pendingClaimStatus',
    ]) &&
    /^0x[0-9a-f]{40}$/.test(e.owner) &&
    e.owner !== '0x' + '0'.repeat(40) &&
    [
      e.requestedRaw,
      e.activeSharesRaw,
      e.activeEntitlementRaw,
      e.maxWithdrawRaw,
      e.pendingAssetsRaw,
      e.storedCooldownEndUnix,
      e.cooldownDurationSeconds,
    ].every(raw) &&
    e.requestedRaw !== '0' &&
    e.activeEntitlementRaw === e.maxWithdrawRaw &&
    (e.activeSharesRaw !== '0' || e.activeEntitlementRaw === '0') &&
    BigInt(e.pendingAssetsRaw) < 1n << 152n &&
    BigInt(e.storedCooldownEndUnix) < 1n << 104n &&
    BigInt(e.storedCooldownEndUnix) <= 8640000000n &&
    (e.pendingAssetsRaw === '0' || e.storedCooldownEndUnix !== '0') &&
    BigInt(e.cooldownDurationSeconds) < 1n << 24n &&
    ['success', 'evm_revert', 'not_applicable'].includes(e.initiationStatus) &&
    ['success', 'evm_revert', 'not_yet_eligible', 'no_pending_claim'].includes(
      e.pendingClaimStatus,
    ) &&
    (e.cooldownDurationSeconds === '0'
      ? e.initiationStatus === 'not_applicable'
      : e.initiationStatus !== 'not_applicable') &&
    keys(e.source, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']) &&
    e.source.chainId === 1 &&
    e.source.finalized === true &&
    raw(e.source.blockNumber) &&
    e.source.blockNumber !== '0' &&
    /^0x[0-9a-f]{64}$/.test(e.source.blockHash) &&
    utc(e.source.blockTime) &&
    Date.parse(e.source.blockTime) % 1000 === 0 &&
    Number.isSafeInteger(now) &&
    now >= Date.parse(e.source.blockTime) &&
    now - Date.parse(e.source.blockTime) <= MAX_AGE_MS
  )
}
export function susdeCurrentProtocolReadPlan(e: SusdeProtocolExpected) {
  const pin = { blockHash: e.source.blockHash, requireCanonical: true }
  const header = {
    method: 'eth_getBlockByNumber',
    params: [`0x${BigInt(e.source.blockNumber).toString(16)}`, false],
  }
  const call = (key: string, to: string, functionName: string, args: readonly unknown[] = []) => ({
    key,
    method: 'eth_call',
    params: [{ to, data: encodeFunctionData({ abi: ABI, functionName, args } as never) }, pin],
  })
  return [
    { key: 'opening_header', ...header },
    ...(['vault', 'asset', 'silo'] as const).map((k) => ({
      key: 'code_' + k,
      method: 'eth_getCode',
      params: [ADDRESSES[k], pin],
    })),
    call('activeSharesRaw', ADDRESSES.vault, 'balanceOf', [e.owner]),
    call('activeEntitlementRaw', ADDRESSES.vault, 'previewRedeem', [BigInt(e.activeSharesRaw)]),
    call('maxWithdrawRaw', ADDRESSES.vault, 'maxWithdraw', [e.owner]),
    call('vaultCashRaw', ADDRESSES.asset, 'balanceOf', [ADDRESSES.vault]),
    call('siloCashRaw', ADDRESSES.asset, 'balanceOf', [ADDRESSES.silo]),
    call('cooldowns', ADDRESSES.vault, 'cooldowns', [e.owner]),
    call('cooldownDurationSeconds', ADDRESSES.vault, 'cooldownDuration'),
    { key: 'closing_header', ...header },
  ]
}
function normalizedHeader(value: unknown): Header {
  check(
    record(value) &&
      typeof value.number === 'string' &&
      typeof value.timestamp === 'string' &&
      typeof value.hash === 'string',
  )
  return { number: value.number, hash: value.hash, timestamp: value.timestamp }
}
function replayOrigin(value: unknown, expected: SusdeProtocolExpected, asOfMs: number) {
  const o = structuredClone(value) as SusdeProtocolOriginObservation
  check(
    validExpected(expected, asOfMs) &&
      keys(o, ['schema', 'expected', 'startedAtUtc', 'readAtUtc', 'traces']) &&
      o.schema === 'susde_header_enclosed_current_native_v1' &&
      same(o.expected, expected),
  )
  check(
    utc(o.startedAtUtc) &&
      utc(o.readAtUtc) &&
      Date.parse(o.startedAtUtc) >= Date.parse(expected.source.blockTime) &&
      Date.parse(o.readAtUtc) <= asOfMs &&
      Date.parse(o.readAtUtc) - Date.parse(o.startedAtUtc) <= MAX_GAP_MS,
  )
  const plan = susdeCurrentProtocolReadPlan(expected)
  check(Array.isArray(o.traces) && o.traces.length === 12 && JSON.stringify(o).length <= MAX_BYTES)
  let previous = Date.parse(o.startedAtUtc)
  const facts: Record<string, string> = {}
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i],
      t = o.traces[i]
    check(
      keys(t, ['key', 'method', 'params', 'result', 'startedAtUtc', 'completedAtUtc']) &&
        t.key === p.key &&
        t.method === p.method &&
        same(t.params, p.params) &&
        utc(t.startedAtUtc) &&
        utc(t.completedAtUtc),
    )
    check(
      Date.parse(t.startedAtUtc) >= previous &&
        Date.parse(t.completedAtUtc) >= Date.parse(t.startedAtUtc) &&
        Date.parse(t.completedAtUtc) <= Date.parse(o.readAtUtc),
    )
    previous = Date.parse(t.completedAtUtc)
    if (p.method === 'eth_getBlockByNumber') {
      check(
        keys(t.result, ['number', 'hash', 'timestamp']) &&
          same(t.result, {
            number: `0x${BigInt(expected.source.blockNumber).toString(16)}`,
            hash: expected.source.blockHash,
            timestamp: `0x${BigInt(Date.parse(expected.source.blockTime) / 1000).toString(16)}`,
          }),
      )
    } else if (p.method === 'eth_getCode') {
      const key = p.key.slice(5) as keyof typeof RUNTIMES
      check(code(t.result) && sha256(t.result).slice(2) === RUNTIMES[key])
    } else if (p.key === 'cooldowns') {
      check(typeof t.result === 'string' && /^0x[0-9a-f]{128}$/.test(t.result))
      facts.storedCooldownEndUnix = BigInt('0x' + t.result.slice(2, 66)).toString()
      facts.pendingAssetsRaw = BigInt('0x' + t.result.slice(66)).toString()
    } else {
      check(word(t.result))
      facts[p.key] = BigInt(t.result).toString()
    }
  }
  for (const key of [
    'activeSharesRaw',
    'activeEntitlementRaw',
    'maxWithdrawRaw',
    'pendingAssetsRaw',
    'storedCooldownEndUnix',
    'cooldownDurationSeconds',
  ] as const)
    check(facts[key] === expected[key])
  return { observation: o, facts }
}
/** Twelve serial reads; no head lookup, retries, provider URLs, or provider error retention. */
export async function readSusdeCurrentProtocolOrigin(
  client: SusdeProtocolRequestClient,
  expected: SusdeProtocolExpected,
  options: { now?: () => number; deadlineMs?: number } = {},
) {
  try {
    const e = structuredClone(expected),
      now = options.now ?? Date.now,
      deadline = options.deadlineMs ?? MAX_GAP_MS,
      started = now(),
      wall = performance.now()
    check(
      Number.isSafeInteger(deadline) &&
        deadline > 0 &&
        deadline <= MAX_GAP_MS &&
        validExpected(e, started),
    )
    const traces: SusdeProtocolTrace[] = []
    for (const p of susdeCurrentProtocolReadPlan(e)) {
      const remaining = deadline - (performance.now() - wall)
      check(remaining > 0 && validExpected(e, now()))
      const begun = now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        client.request({ method: p.method, params: structuredClone(p.params) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('deadline')), remaining)
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer)
      })
      check(performance.now() - wall < deadline)
      const sanitized = p.method === 'eth_getBlockByNumber' ? normalizedHeader(result) : result
      check(typeof sanitized === 'string' || record(sanitized))
      if (p.method === 'eth_getCode')
        check(
          code(sanitized) &&
            sha256(sanitized).slice(2) === RUNTIMES[p.key.slice(5) as keyof typeof RUNTIMES],
        )
      else if (p.method === 'eth_call')
        check(
          p.key === 'cooldowns'
            ? typeof sanitized === 'string' && /^0x[0-9a-f]{128}$/.test(sanitized)
            : word(sanitized),
        )
      else
        check(
          same(sanitized, {
            number: `0x${BigInt(e.source.blockNumber).toString(16)}`,
            hash: e.source.blockHash,
            timestamp: `0x${BigInt(Date.parse(e.source.blockTime) / 1000).toString(16)}`,
          }),
        )
      traces.push({
        key: p.key,
        method: p.method,
        params: structuredClone(p.params),
        result: sanitized as string | Header,
        startedAtUtc: new Date(begun).toISOString(),
        completedAtUtc: new Date(now()).toISOString(),
      })
      // Stop before previewRedeem if the same-hash balance differs from the required assay.
      if (p.key === 'activeSharesRaw')
        check(word(result) && BigInt(result).toString() === e.activeSharesRaw)
    }
    const observation: SusdeProtocolOriginObservation = {
      schema: 'susde_header_enclosed_current_native_v1',
      expected: e,
      startedAtUtc: new Date(started).toISOString(),
      readAtUtc: new Date(now()).toISOString(),
      traces,
    }
    replayOrigin(observation, e, now())
    freezeSusde(observation)
    issuedOriginClients.set(observation, client)
    return observation
  } catch {
    return null
  }
}
type Origin = { origin: string; observation: SusdeProtocolOriginObservation }
export type SusdeCurrentProtocolCapacityEvidence = {
  schema: 'susde_lossless_current_protocol_capacity_v1'
  availableAtUtc: string
  sourceAuthority: typeof SUSDE_CURRENT_SOURCE_AUTHORITY
  runtimeCodes: Record<'vault' | 'asset' | 'silo', string>
  origins: {
    origin: string
    observation: Omit<SusdeProtocolOriginObservation, 'traces'> & {
      traces: (Omit<SusdeProtocolTrace, 'result'> & {
        result: SusdeProtocolTrace['result'] | { codeRef: string }
      })[]
    }
  }[]
}
function decodeEvidence(value: unknown) {
  const v = structuredClone(value) as SusdeCurrentProtocolCapacityEvidence
  check(
    keys(v, ['schema', 'availableAtUtc', 'sourceAuthority', 'runtimeCodes', 'origins']) &&
      v.schema === 'susde_lossless_current_protocol_capacity_v1' &&
      utc(v.availableAtUtc) &&
      same(v.sourceAuthority, SUSDE_CURRENT_SOURCE_AUTHORITY) &&
      keys(v.runtimeCodes, ['vault', 'asset', 'silo']) &&
      Object.values(v.runtimeCodes).every(code) &&
      Array.isArray(v.origins) &&
      v.origins.length === 2 &&
      JSON.stringify(v).length <= MAX_BYTES,
  )
  for (const entry of v.origins) {
    check(
      keys(entry, ['origin', 'observation']) &&
        typeof entry.origin === 'string' &&
        /^[a-z0-9.-]{1,253}$/.test(entry.origin) &&
        !entry.origin.includes('..') &&
        Array.isArray(entry.observation.traces),
    )
    for (const t of entry.observation.traces)
      if (t.key.startsWith('code_')) {
        const k = t.key.slice(5) as keyof typeof v.runtimeCodes
        check(
          keys(t.result, ['codeRef']) &&
            (t.result as { codeRef: string }).codeRef === k &&
            Object.hasOwn(v.runtimeCodes, k),
        )
        t.result = v.runtimeCodes[k]
      }
  }
  check(v.origins[0].origin !== v.origins[1].origin)
  return {
    compact: structuredClone(value) as SusdeCurrentProtocolCapacityEvidence,
    origins: v.origins as Origin[],
  }
}
/** Replays economic getter semantics. It does not authenticate a caller-supplied current witness. */
export function replaySusdeCurrentProtocolCapacityEvidence(
  value: unknown,
  expected: SusdeProtocolExpected,
  originNames: readonly string[],
  asOfMs: number,
): SusdeHolderCurrentEvidence | null {
  try {
    const v = decodeEvidence(value)
    check(
      originNames.length === 2 &&
        same(
          v.origins.map((x) => x.origin),
          originNames,
        ),
    )
    const a = replayOrigin(v.origins[0].observation, expected, asOfMs),
      b = replayOrigin(v.origins[1].observation, expected, asOfMs)
    check(same(a.facts, b.facts))
    const readAtUtc = new Date(
      Math.max(Date.parse(a.observation.readAtUtc), Date.parse(b.observation.readAtUtc)),
    ).toISOString()
    check(
      Date.parse(v.compact.availableAtUtc) >= Date.parse(readAtUtc) &&
        Date.parse(v.compact.availableAtUtc) <= asOfMs,
    )
    const captureReceiptSha256 = digest(v.compact)
    return freezeSusde({
      owner: expected.owner,
      source: structuredClone(expected.source),
      readAtUtc,
      captureReceiptSha256,
      addresses: structuredClone(ADDRESSES),
      runtimeIdentities: structuredClone(RUNTIMES),
      assetDecimals: 18,
      activeSharesRaw: expected.activeSharesRaw,
      activeEntitlementRaw: expected.activeEntitlementRaw,
      activeEntitlementMethod: 'preview_redeem_full_active_position',
      maxWithdrawRaw: expected.maxWithdrawRaw,
      pendingAssetsRaw: expected.pendingAssetsRaw,
      storedCooldownEndUnix: expected.storedCooldownEndUnix,
      cooldownDurationSeconds: expected.cooldownDurationSeconds,
      vaultCashRaw: a.facts.vaultCashRaw,
      siloCashRaw: a.facts.siloCashRaw,
      evidence: v.compact,
      ...(expected.initiationStatus === 'success'
        ? {
            successfulExactQInitiation: {
              requestedRaw: expected.requestedRaw,
              owner: expected.owner,
              source: structuredClone(expected.source),
              receiptSha256: digest({ expected, origins: v.origins.map((x) => x.origin) }),
            },
          }
        : {}),
    })
  } catch {
    return null
  }
}
/** Issuance requires native observations from distinct private client objects, never labels alone.
 * Client identity is not proof of independent operators; configured-origin policy is still required. */
export function issueSusdeCurrentProtocolCapacityEvidence(
  origins: readonly Origin[],
  expected: SusdeProtocolExpected,
  availableAtMs: number,
): SusdeCurrentProtocolCapacityEvidence | null {
  try {
    check(origins.length === 2 && origins.every((x) => issuedOriginClients.has(x.observation)))
    check(
      issuedOriginClients.get(origins[0].observation) !==
        issuedOriginClients.get(origins[1].observation),
    )
    const copied = structuredClone(origins),
      runtimeCodes = {} as Record<'vault' | 'asset' | 'silo', string>
    for (const entry of copied)
      for (const t of entry.observation.traces)
        if (t.key.startsWith('code_')) {
          const k = t.key.slice(5) as keyof typeof runtimeCodes
          check(typeof t.result === 'string' && (!runtimeCodes[k] || runtimeCodes[k] === t.result))
          runtimeCodes[k] = t.result
          ;(t as unknown as { result: unknown }).result = { codeRef: k }
        }
    const evidence = {
      schema: 'susde_lossless_current_protocol_capacity_v1' as const,
      availableAtUtc: new Date(availableAtMs).toISOString(),
      sourceAuthority: SUSDE_CURRENT_SOURCE_AUTHORITY,
      runtimeCodes,
      origins: copied as unknown as SusdeCurrentProtocolCapacityEvidence['origins'],
    }
    check(
      replaySusdeCurrentProtocolCapacityEvidence(
        evidence,
        expected,
        origins.map((x) => x.origin),
        availableAtMs,
      ),
    )
    return freezeSusde(evidence)
  } catch {
    return null
  }
}
/** Default denial remains: approval must cover the entire externally witnessed current object. */
export function mapSusdeCurrentProtocolCapacityToHolderCurrent(
  value: unknown,
  expected: SusdeProtocolExpected,
  origins: readonly string[],
  asOfMs: number,
  acceptCurrent: AcceptSusdeCurrentEvidence = () => false,
) {
  const current = replaySusdeCurrentProtocolCapacityEvidence(value, expected, origins, asOfMs)
  try {
    return current && acceptCurrent(freezeSusde(structuredClone(current))) === true ? current : null
  } catch {
    return null
  }
}
