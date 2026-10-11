import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import {
  susdeCurrentProtocolReadPlan,
  type SusdeProtocolExpected,
} from '@/lib/carry/susdeCurrentProtocolCapacity'
// Real runtime bytes from the 88-read native sUSDe capture. Getter states below are SYNTHETIC.
const genuineCapture = JSON.parse(
  readFileSync(
    'data/research/venue-signals/susde-joint-native-history-2026-10-08T00-10.json',
    'utf8',
  ),
)
const capturedCodes = genuineCapture.capture.hosts[0].traces[0]
  .filter((t: { request: { method: string } }) => t.request.method === 'eth_getCode')
  .map((t: { result: string }) => t.result)
export const SUSDE_SYNTHETIC_NOW = Date.parse('2026-10-08T01:00:00.000Z')
export function syntheticSusdeExpected(now = SUSDE_SYNTHETIC_NOW): SusdeProtocolExpected {
  return {
    owner: '0x0000000000000000000000000000000000000001',
    requestedRaw: '1000000',
    source: {
      chainId: 1,
      blockNumber: '26111000',
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(Math.floor(now / 1000) * 1000 - 60000).toISOString(),
      finalized: true,
    },
    activeSharesRaw: '5000000',
    activeEntitlementRaw: '5500000',
    maxWithdrawRaw: '5500000',
    pendingAssetsRaw: '2500000',
    storedCooldownEndUnix: String(Math.floor(now / 1000) - 120),
    cooldownDurationSeconds: '86400',
    initiationStatus: 'success',
    pendingClaimStatus: 'success',
  }
}
export function syntheticSusdeClient(
  expected = syntheticSusdeExpected(),
  change?: (key: string, value: unknown) => unknown,
) {
  const plan = susdeCurrentProtocolReadPlan(expected),
    results: Record<string, unknown> = {
      opening_header: {
        number: `0x${BigInt(expected.source.blockNumber).toString(16)}`,
        hash: expected.source.blockHash,
        timestamp: `0x${BigInt(Date.parse(expected.source.blockTime) / 1000).toString(16)}`,
      },
      code_vault: capturedCodes[0],
      code_asset: capturedCodes[1],
      code_silo: capturedCodes[2],
      vaultCashRaw: '9000000',
      siloCashRaw: '3000000',
    }
  results.closing_header = results.opening_header
  for (const key of [
    'activeSharesRaw',
    'activeEntitlementRaw',
    'maxWithdrawRaw',
    'cooldownDurationSeconds',
  ] as const)
    results[key] = expected[key]
  for (const key of [
    'activeSharesRaw',
    'activeEntitlementRaw',
    'maxWithdrawRaw',
    'vaultCashRaw',
    'siloCashRaw',
    'cooldownDurationSeconds',
  ])
    results[key] =
      '0x' +
      BigInt(results[key] as string)
        .toString(16)
        .padStart(64, '0')
  results.cooldowns =
    '0x' +
    BigInt(expected.storedCooldownEndUnix).toString(16).padStart(64, '0') +
    BigInt(expected.pendingAssetsRaw).toString(16).padStart(64, '0')
  let active = 0,
    maxActive = 0
  const request = vi.fn(async (wire: { method: string; params: unknown[] }) => {
    active++
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    active--
    const spec = plan.find(
      (p) => p.method === wire.method && JSON.stringify(p.params) === JSON.stringify(wire.params),
    )
    if (!spec) throw Error('unexpected synthetic read')
    const key =
      wire.method === 'eth_getBlockByNumber' && request.mock.calls.length === 12
        ? 'closing_header'
        : spec.key
    return change ? change(key, results[key]) : results[key]
  })
  return { request, getMaxActive: () => maxActive }
}
