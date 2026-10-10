import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeErrorResult, encodeFunctionResult, sha256, stringToHex } from 'viem'
import {
  APY_USD_JOINT_NATIVE_ABI,
  APY_USD_JOINT_NATIVE_ANCHORS,
  APY_USD_JOINT_NATIVE_LIMITS,
  APY_USD_JOINT_NATIVE_SUBJECT,
  apyUsdJointNativeCurrentReadPlan,
  apyUsdJointNativeHistoryReadPlan,
  parseApyUsdJointNativeEvidenceJson,
  replayApyUsdJointNativeCurrent,
  replayApyUsdJointNativeHistoryPoint,
  type ApyUsdJointNativeCurrentBinding,
  type ApyUsdJointNativeCurrentWire,
  type ApyUsdJointNativeHistoryBinding,
  type ApyUsdJointNativeHistoryWire,
  type ApyUsdJointNativeRead,
  type ApyUsdJointNativeTrace,
} from '@/lib/carry/apyUsdJointNativeEvidence'

const ROOT = resolve(process.cwd(), 'data/research/venue-signals')
const CAPTURE = resolve(
  ROOT,
  'apyusd-current-liquid-cash-native-evidence-2026-10-08/originals-c2c0dfb5-be12-4368-a52f-f6a1c491c0c9/capture',
)
const OLD_CAPTURE = resolve(
  ROOT,
  'apyusd-full-owner-two-leg-native-evidence-2026-10-08/originals-801c0a42-a3c0-4292-a288-18b65e4d40ff/capture',
)
const OWNER = '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2'
const VESTING = '0x0d62b4cc02b4b51ed19ddf41d7a7979cf394c99f'
const SOURCE = {
  chainId: 1 as const,
  finalized: true as const,
  blockNumber: 26150788,
  blockHash: '0xbcf4f563592ecf5ff161a44eab753025ca4adfa682fe300a4eba5a75a2d5762e',
  blockTime: '2026-10-08T22:53:11.000Z',
}
const ACQUIRED = '2026-10-08T23:09:44.149Z'
const VAULT = APY_USD_JOINT_NATIVE_SUBJECT.destination,
  RECEIPT = APY_USD_JOINT_NATIVE_SUBJECT.receipt
const FULL_S = '391143432',
  FULL_G = '562976263',
  FULL_EA = '562413849',
  CASH = '164310986216896497035561351'
const ESCROW = '169162231456603977484'
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const hex = (n: number) => '0x' + n.toString(16)
const headerValue = (s: typeof SOURCE | ApyUsdJointNativeHistoryBinding['source']) => ({
  number: hex(s.blockNumber),
  hash: s.blockHash,
  timestamp: hex(Date.parse(s.blockTime) / 1000),
})
const result = (name: string, value: unknown) =>
  encodeFunctionResult({ abi: APY_USD_JOINT_NATIVE_ABI, functionName: name, result: value })
const errorData = (name: string, args: readonly unknown[]) =>
  encodeErrorResult({ abi: APY_USD_JOINT_NATIVE_ABI, errorName: name, args })
/** Actual archived runtime bytes, never replacement implementations or mock hash functions. */
const codeFixtures = Object.fromEntries(
  [
    ['vault_code', VAULT, '01-discovery-physical-9'],
    ['receipt_code', RECEIPT, '01-discovery-physical-10'],
    [
      'vault_implementation_code',
      '0xfd616567ecc1607f61073951a1e822f7315bb112',
      '01-discovery-physical-22',
    ],
    [
      'receipt_implementation_code',
      '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982',
      '02-current-physical-9',
    ],
    ['asset_code', APY_USD_JOINT_NATIVE_SUBJECT.asset, '01-discovery-physical-28'],
    ['vesting_code', VESTING, '02-current-physical-73'],
  ].map(([key, address, basename]) => {
    const request = JSON.parse(readFileSync(resolve(CAPTURE, basename + '-request.bin'), 'utf8'))
    const response = JSON.parse(readFileSync(resolve(CAPTURE, basename + '-response.bin'), 'utf8'))
    if (
      request.method !== 'eth_getCode' ||
      request.params[0] !== address ||
      response.id !== request.id ||
      typeof response.result !== 'string'
    )
      throw Error('invalid_archived_runtime_fixture')
    return [key, response.result]
  }),
)
const stockFrames = JSON.parse(
  readFileSync(resolve(OLD_CAPTURE, '04-native-receipt-history-frames.json'), 'utf8'),
).frames
type Change = { [key: string]: unknown }
function fixtureValue(key: string, changes: Change, s = SOURCE): unknown {
  if (Object.hasOwn(changes, key)) return changes[key]
  if (key in codeFixtures) return codeFixtures[key]
  if (key.startsWith('header_') || key.startsWith('phase_header_') || key === 'finalized')
    return headerValue(s)
  if (key === 'chain') return '0x1'
  if (key === 'vault_implementation_slot')
    return '0x' + '0'.repeat(24) + 'fd616567ecc1607f61073951a1e822f7315bb112'
  if (key === 'receipt_implementation_slot')
    return '0x' + '0'.repeat(24) + '54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
  const values: Record<string, [string, unknown]> = {
    vault_asset: ['asset', APY_USD_JOINT_NATIVE_SUBJECT.asset],
    receipt_asset: ['asset', APY_USD_JOINT_NATIVE_SUBJECT.asset],
    vault_receipt: ['receipt', RECEIPT],
    share_decimals: ['decimals', 18],
    asset_decimals: ['decimals', 18],
    vault_paused: ['paused', false],
    receipt_paused: ['paused', false],
    unlocking_fee: ['unlockingFee', 1000000000000000n],
    fee_curve: ['feeCurve', [0n, 34000000000000000n, 259200, 1728000, 1000000000000000000n]],
    vault_cash: ['balanceOf', BigInt(CASH)],
    receipt_cash: ['balanceOf', 12185144975262803935614883n],
    total_assets: ['totalAssets', 164310986216896497035561351n],
    total_supply: ['totalSupply', 100000000000000000000000000n],
    vesting_address: ['vesting', VESTING],
    vested_amount: ['vestedAmount', 0n],
    full_shares: ['balanceOf', BigInt(FULL_S)],
    owned_count: ['balanceOf', 1n],
    full_escrow_ea: ['previewRedeem', BigInt(FULL_EA)],
    full_gross_assets: ['convertToAssets', BigInt(FULL_G)],
    full_withdraw_shares: ['previewWithdraw', BigInt(FULL_S)],
    full_share_sim: ['withdrawForReceipt', [BigInt(FULL_S), 1141n]],
  }
  if (key === 'owner_code') return '0x'
  if (key.startsWith('candidate_owner_')) return result('ownerOf', OWNER)
  if (key.startsWith('receipt_tuple_'))
    return result('getReceipt', [BigInt(ESCROW), 0n, 1787499395, 1787758595])
  if (key.startsWith('receipt_preview_')) return result('previewClaim', BigInt(ESCROW))
  if (key.startsWith('receipt_claimable_')) return result('isClaimable', true)
  if (key.startsWith('receipt_claim_')) return result('claim', BigInt(ESCROW))
  if (!values[key]) throw Error('fixture_key_' + key)
  return result(...values[key])
}
function makeTrace(
  read: ApyUsdJointNativeRead,
  value: unknown,
  started: number,
): ApyUsdJointNativeTrace {
  const data =
    value && typeof value === 'object' && Object.hasOwn(value, 'error')
      ? (value as { error: { code: number; message: 'native_error'; data?: string } })
      : { result: value }
  return {
    ...clone(read),
    ...data,
    startedAtUtc: new Date(started).toISOString(),
    completedAtUtc: new Date(started + 1).toISOString(),
    requestBodySha256: sha256(stringToHex(JSON.stringify(read))).slice(2),
    responseBodySha256: sha256(stringToHex(JSON.stringify(data))).slice(2),
  }
}
function currentFixture(
  changes: Change = {},
  candidates = ['881'],
  fullSharesRaw = FULL_S,
  fullEscrowEaRaw = changes.full_escrow_ea === result('previewRedeem', 0n) ? '0' : FULL_EA,
) {
  const binding: ApyUsdJointNativeCurrentBinding = {
    routeKey: APY_USD_JOINT_NATIVE_SUBJECT.routeKey,
    destination: VAULT,
    asset: APY_USD_JOINT_NATIVE_SUBJECT.asset,
    owner: OWNER,
    candidateReceiptIds: candidates,
    source: SOURCE,
    acquiredAtUtc: ACQUIRED,
  }
  const owned = candidates.filter(
    (id) => fixtureValue('candidate_owner_' + id, changes) === result('ownerOf', OWNER),
  )
  const reads = [
    'base',
    'candidate_owners',
    'owned_receipts',
    'share_quote',
    'initiation_simulation',
    'vesting',
    'end',
  ].flatMap((stage) =>
    apyUsdJointNativeCurrentReadPlan(binding, {
      stage: stage as 'base',
      fullSharesRaw,
      fullEscrowEaRaw,
      ownedReceiptIds: owned,
      vestingAddress: VESTING,
    }),
  )
  const base = Date.parse(ACQUIRED) - 901
  const wire: ApyUsdJointNativeCurrentWire = {
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host) => ({
      host,
      acquiredAtUtc: ACQUIRED,
      phases: [
        {
          chainIdTrace: makeTrace(
            { key: 'chain', request: { method: 'eth_chainId', params: [] } },
            '0x1',
            base,
          ),
          finalizedTrace: makeTrace(
            {
              key: 'finalized',
              request: { method: 'eth_getBlockByNumber', params: ['finalized', false] },
            },
            headerValue(SOURCE),
            base + 2,
          ),
          headerBeforeTrace: makeTrace(
            {
              key: 'phase_header_before',
              request: { method: 'eth_getBlockByNumber', params: [hex(SOURCE.blockNumber), false] },
            },
            headerValue(SOURCE),
            base + 4,
          ),
          headerAfterTrace: makeTrace(
            {
              key: 'phase_header_after',
              request: { method: 'eth_getBlockByNumber', params: [hex(SOURCE.blockNumber), false] },
            },
            headerValue(SOURCE),
            base + 900,
          ),
          acquiredAtUtc: ACQUIRED,
        },
      ],
      traces: reads.map((r, i) => makeTrace(r, fixtureValue(r.key, changes), base + 10 + i * 2)),
    })),
  }
  return { binding, wire }
}
const nativeError = (data?: string) => ({
  error: { code: 3, message: 'native_error' as const, ...(data ? { data } : {}) },
})
function replay(changes: Change = {}) {
  const f = currentFixture(changes)
  return replayApyUsdJointNativeCurrent(f.wire, f.binding)
}
function alter(
  f: ReturnType<typeof currentFixture>,
  key: string,
  change: (t: ApyUsdJointNativeTrace) => void,
  peers = 2,
) {
  f.wire.origins.slice(0, peers).forEach((o) => change(o.traces.find((t) => t.key === key)!))
}
function historyFixture(index = 112) {
  const cur = replay(),
    anchor = APY_USD_JOINT_NATIVE_ANCHORS.find((a) => a.cashIndex === index)!,
    actual = stockFrames.find(
      (f: { factsByOrigin: { cashIndex: number }[] }) => f.factsByOrigin[0].cashIndex === index,
    ).factsByOrigin[0]
  const binding: ApyUsdJointNativeHistoryBinding = {
    cashIndex: index,
    source: anchor.source,
    currentSource: SOURCE,
    fullSharesRaw: FULL_S,
    currentRuntimeRegime: cur.current.runtimeRegime,
    vestingAddress: VESTING,
    vaultUnlockingFeeWad: '1000000000000000',
    owner: null,
    acquiredAtUtc: ACQUIRED,
  }
  const changes = {
    vault_cash: result('balanceOf', BigInt(anchor.cashRaw)),
    full_escrow_ea: result('previewRedeem', BigInt(actual.fullSharePreviewRedeem.value)),
    full_gross_assets: result('convertToAssets', BigInt(actual.fullShareConvertToAssets.value)),
  }
  const reads = apyUsdJointNativeHistoryReadPlan(binding),
    base = Date.parse(ACQUIRED) - (10 + (reads.length - 1) * 2 + 1)
  const wire: ApyUsdJointNativeHistoryWire = {
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host) => ({
      host,
      acquiredAtUtc: ACQUIRED,
      chainIdTrace: makeTrace(
        { key: 'chain', request: { method: 'eth_chainId', params: [] } },
        '0x1',
        base,
      ),
      traces: reads.map((r, i) =>
        makeTrace(r, fixtureValue(r.key, changes, anchor.source), base + 10 + i * 2),
      ),
    })),
  }
  return { binding, wire }
}

describe('APY joint native replay (unsigned synthetic envelopes, actual retained runtime bytes)', () => {
  it('keeps current full S, separate frozen receipt and cash stock; never grants acquisition authority', () => {
    const v = replay()
    expect(v.current.fullSharesRaw).toBe(FULL_S)
    expect(v.current.fullEscrowEaRaw).toBe(FULL_EA)
    expect(v.current.vaultCashRaw).toBe(CASH)
    expect(v.current.receiptInventory?.receipts[0].fullNetEaRaw).toBe(ESCROW)
    expect(v.current.receiptInventory?.complete).toBe(true)
    expect(v.authenticated).toBe(false)
    expect(v.nativeCommitmentAuthentication).toBe(false)
    expect(v.executionAuthority).toBe(false)
    expect(v.initiationAction).toBe('asset_denominated_withdrawForReceipt')
    expect(v.fullWithdrawalSharesRaw).toBe(FULL_S)
    expect(Object.isFrozen(v.current.receiptInventory?.receipts)).toBe(true)
  })
  it('requires exact full-S call arguments before accepting full-position quotes', () => {
    const f = currentFixture()
    alter(f, 'full_escrow_ea', (t) => {
      ;(t.request.params[0] as { data: string }).data += '00'
    })
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
  })
  it('uses asset-denominated withdrawal shares within native full S rather than a redeem return tuple', () => {
    expect(() =>
      replay({ full_withdraw_shares: result('previewWithdraw', BigInt(FULL_S) + 1n) }),
    ).toThrow()
    expect(() =>
      replay({ full_share_sim: result('withdrawForReceipt', [BigInt(FULL_EA), 1141n]) }),
    ).toThrow()
  })
  it('requires successful native escrow to fit the receipt uint208 asset field', () => {
    const cap = (1n << 208n) - 1n
    const make = (ea: bigint, sim: unknown) =>
      currentFixture(
        {
          unlocking_fee: result('unlockingFee', 0n),
          full_escrow_ea: result('previewRedeem', ea),
          full_gross_assets: result('convertToAssets', ea),
          vault_cash: result('balanceOf', ea),
          full_share_sim: sim,
        },
        ['881'],
        FULL_S,
        ea.toString(),
      )
    const valid = make(cap, result('withdrawForReceipt', [BigInt(FULL_S), 1141n]))
    expect(replayApyUsdJointNativeCurrent(valid.wire, valid.binding).current.fullEscrowEaRaw).toBe(
      cap.toString(),
    )
    const forged = make(cap + 1n, result('withdrawForReceipt', [BigInt(FULL_S), 1141n]))
    expect(() => replayApyUsdJointNativeCurrent(forged.wire, forged.binding)).toThrow(
      'full_share_simulation',
    )
    // Native SafeCastOverflowedUintDowncast(uint8,uint256); the codec grants no gate authority.
    const castError = encodeErrorResult({
      abi: [
        {
          type: 'error',
          name: 'SafeCastOverflowedUintDowncast',
          inputs: [
            { name: 'bits', type: 'uint8' },
            { name: 'value', type: 'uint256' },
          ],
        },
      ],
      errorName: 'SafeCastOverflowedUintDowncast',
      args: [208, cap + 1n],
    })
    const reverted = make(cap + 1n, nativeError(castError))
    expect(
      replayApyUsdJointNativeCurrent(reverted.wire, reverted.binding).current
        .shareInitiationSimulationStatus,
    ).toBe('unexplained_revert')
  })
  it('rejects minted IDs already proved to exist and accepts an explicitly nonexistent candidate ID', () => {
    expect(() =>
      replay({ full_share_sim: result('withdrawForReceipt', [BigInt(FULL_S), 881n]) }),
    ).toThrow()
    const other = currentFixture(
      { candidate_owner_1141: result('ownerOf', '0x' + '1'.repeat(40)) },
      ['881', '1141'],
    )
    expect(() => replayApyUsdJointNativeCurrent(other.wire, other.binding)).toThrow()
    const absent = currentFixture(
      { candidate_owner_1141: nativeError(errorData('ERC721NonexistentToken', [1141n])) },
      ['881', '1141'],
    )
    expect(
      replayApyUsdJointNativeCurrent(absent.wire, absent.binding).fullShareSimulationTokenIdRaw,
    ).toBe('1141')
  })
  it('checks gross-to-escrow ceil fee without applying the receipt fee twice', () => {
    expect(() =>
      replay({ full_escrow_ea: result('previewRedeem', BigInt(FULL_EA) + 1n) }),
    ).toThrow()
    expect(replay().current.receiptInventory?.receipts[0].escrowRaw).toBe(ESCROW)
  })
  it('rejects noncanonical ABI bytes, wrong units, runtime changes and wrong proxy slots', () => {
    for (const changes of [
      { vault_cash: result('balanceOf', 1n) + '00' },
      { asset_decimals: result('decimals', 6) },
      { vault_code: '0x6000' },
      { vault_implementation_slot: '0x' + '0'.repeat(64) },
    ])
      expect(() => replay(changes)).toThrow()
  })
  it('cannot join a decoded receipt belonging to another native owner', () => {
    const f = currentFixture({ candidate_owner_881: result('ownerOf', '0x' + '1'.repeat(40)) })
    const v = replayApyUsdJointNativeCurrent(f.wire, f.binding)
    expect(v.current.receiptInventory?.receipts).toEqual([])
    expect(v.current.receiptInventory?.complete).toBe(false)
  })
  it('accepts a natively nonexistent candidate only with its exact ID custom error', () => {
    const f = currentFixture({
      candidate_owner_881: nativeError(errorData('ERC721NonexistentToken', [881n])),
    })
    expect(replayApyUsdJointNativeCurrent(f.wire, f.binding).ownedReceiptIds).toEqual([])
    expect(() =>
      replay({ candidate_owner_881: nativeError(errorData('ERC721NonexistentToken', [882n])) }),
    ).toThrow()
  })
  it('rejects duplicate candidates, duplicate traces and an owned count below verified inventory', () => {
    expect(() => currentFixture({}, ['881', '881'])).toThrow()
    const f = currentFixture()
    f.wire.origins[0].traces.push(f.wire.origins[0].traces[0])
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
    expect(() => replay({ owned_count: result('balanceOf', 0n) })).toThrow()
  })
  it('counts zero-escrow native tickets without pretending they contain proceeds', () => {
    const v = replay({
      receipt_tuple_881: result('getReceipt', [0n, 0n, 0, 0]),
      receipt_preview_881: result('previewClaim', 0n),
      receipt_claimable_881: result('isClaimable', false),
      receipt_claim_881: nativeError(),
    })
    expect(v.current.receiptInventory?.nativeOwnedCountRaw).toBe('1')
    expect(v.current.receiptInventory?.receipts[0].escrowRaw).toBe('0')
    expect(v.current.receiptInventory?.complete).toBe(true)
  })
  it('retains a natively zero full-S quote without inventing a minted receipt', () => {
    const f = currentFixture(
      {
        full_shares: result('balanceOf', 0n),
        full_escrow_ea: result('previewRedeem', 0n),
        full_gross_assets: result('convertToAssets', 0n),
        full_withdraw_shares: result('previewWithdraw', 0n),
        full_share_sim: nativeError(),
      },
      ['881'],
      '0',
    )
    const v = replayApyUsdJointNativeCurrent(f.wire, f.binding)
    expect(v.current.fullSharesRaw).toBe('0')
    expect(v.current.fullShareInitiationSimulation).toBe(false)
    expect(v.fullShareSimulationTokenIdRaw).toBe(null)
    const fake = clone(f)
    fake.wire.origins.forEach((o) => {
      const t = o.traces.find((r) => r.key === 'full_gross_assets')!
      t.result = result('convertToAssets', 1n)
    })
    expect(() => replayApyUsdJointNativeCurrent(fake.wire, fake.binding)).toThrow()
    const mint = clone(f)
    mint.wire.origins.forEach((o) => {
      const t = o.traces.find((r) => r.key === 'full_share_sim')!
      delete t.error
      t.result = result('withdrawForReceipt', [0n, 0n])
    })
    expect(() => replayApyUsdJointNativeCurrent(mint.wire, mint.binding)).toThrow()
  })
  it('accepts all 64 owned NFTs within the bounded wire including large unexplained native errors', () => {
    const candidates = Array.from({ length: 64 }, (_, i) => String(i + 1)),
      changes: Change = { owned_count: result('balanceOf', 64n) }
    candidates.forEach((id) => {
      changes['receipt_claim_' + id] = nativeError('0x' + 'ab'.repeat(4096))
    })
    const f = currentFixture(changes, candidates)
    expect(Buffer.byteLength(JSON.stringify(f.wire))).toBeLessThan(
      APY_USD_JOINT_NATIVE_LIMITS.transportBytes,
    )
    expect(
      replayApyUsdJointNativeCurrent(f.wire, f.binding).current.receiptInventory?.receipts.length,
    ).toBe(64)
  })
  it('classifies only exact observed funding gate and keeps unexplained reverts censored', () => {
    const needed =
      BigInt(FULL_EA) + (BigInt(FULL_EA) * 1000000000000000n + 10n ** 18n - 1n) / 10n ** 18n
    const good = {
      vault_cash: result('balanceOf', 0n),
      full_share_sim: nativeError(errorData('ERC20InsufficientBalance', [VAULT, 0n, needed])),
    }
    expect(replay(good).current.shareInitiationSimulationStatus).toBe('native_funding_gate')
    for (const args of [
      [RECEIPT, 0n, needed],
      [VAULT, 1n, needed],
      [VAULT, 0n, needed + 1n],
    ])
      expect(
        replay({
          ...good,
          full_share_sim: nativeError(errorData('ERC20InsufficientBalance', args)),
        }).current.shareInitiationSimulationStatus,
      ).toBe('unexplained_revert')
    expect(replay({ full_share_sim: nativeError() }).current.shareInitiationSimulationStatus).toBe(
      'unexplained_revert',
    )
  })
  it('requires two origin agreement on native facts and error data', () => {
    const f = currentFixture()
    alter(
      f,
      'vault_cash',
      (t) => {
        t.result = result('balanceOf', 1n)
      },
      1,
    )
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
  })
  it('keeps distinct actual origin clocks and derives the paired availability from their maximum', () => {
    const f = currentFixture(),
      later = f.wire.origins[1]
    const move = (t: ApyUsdJointNativeTrace) => {
      t.startedAtUtc = new Date(Date.parse(t.startedAtUtc) + 1).toISOString()
      t.completedAtUtc = new Date(Date.parse(t.completedAtUtc) + 1).toISOString()
    }
    later.traces.forEach(move)
    later.phases.forEach((p) => {
      ;[p.chainIdTrace, p.finalizedTrace, p.headerBeforeTrace, p.headerAfterTrace].forEach(move)
      p.acquiredAtUtc = new Date(Date.parse(p.acquiredAtUtc) + 1).toISOString()
    })
    later.acquiredAtUtc = new Date(Date.parse(later.acquiredAtUtc) + 1).toISOString()
    f.binding.acquiredAtUtc = later.acquiredAtUtc
    expect(replayApyUsdJointNativeCurrent(f.wire, f.binding).current.readAtUtc).toBe(
      later.acquiredAtUtc,
    )
    f.binding.acquiredAtUtc = new Date(Date.parse(later.acquiredAtUtc) + 1).toISOString()
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
  })
  it('recognizes exact native time gate under the current global receipt policy', () => {
    const created = Date.parse(SOURCE.blockTime) / 1000 - 86400
    const changes = {
      receipt_tuple_881: result('getReceipt', [1000n, 34n, created, created + 259200]),
      receipt_preview_881: result('previewClaim', 966n),
      receipt_claimable_881: result('isClaimable', false),
      receipt_claim_881: nativeError(errorData('NotClaimable', [881n])),
    }
    expect(replay(changes).current.receiptInventory?.receipts[0].claimSimulationStatus).toBe(
      'native_time_gate',
    )
    expect(
      replay({ ...changes, receipt_claim_881: nativeError(errorData('NotClaimable', [882n])) })
        .current.receiptInventory?.receipts[0].claimSimulationStatus,
    ).toBe('unexplained_revert')
    expect(
      replay({ ...changes, receipt_paused: result('paused', true), full_share_sim: nativeError() })
        .current.receiptInventory?.receipts[0].claimSimulationStatus,
    ).toBe('unexplained_revert')
    expect(() =>
      replay({ ...changes, receipt_claimable_881: result('isClaimable', true) }),
    ).toThrow()
  })
  it('retains paused mature native receipt facts without inventing claimability or a successful mint', () => {
    const changes = {
      receipt_paused: result('paused', true),
      receipt_claimable_881: result('isClaimable', false),
      receipt_claim_881: nativeError('0xd93c0665'),
      full_share_sim: nativeError('0xd93c0665'),
    }
    const v = replay(changes)
    expect(v.current.receiptPaused).toBe(true)
    expect(v.current.receiptInventory?.receipts[0].claimSimulationStatus).toBe('unexplained_revert')
    expect(v.current.fullShareInitiationSimulation).toBe(false)
    expect(() =>
      replay({ ...changes, full_share_sim: result('withdrawForReceipt', [BigInt(FULL_S), 1141n]) }),
    ).toThrow()
  })
  it('rejects current clocks, finalized witnesses, source headers or phase joins that do not match', () => {
    const f = currentFixture()
    f.wire.origins[0].phases[0].finalizedTrace.result = headerValue({
      ...SOURCE,
      blockNumber: SOURCE.blockNumber - 1,
    })
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
    const g = currentFixture()
    alter(g, 'vault_cash', (t) => {
      t.startedAtUtc = new Date(Date.parse(ACQUIRED) + 1).toISOString()
    })
    expect(() => replayApyUsdJointNativeCurrent(g.wire, g.binding)).toThrow()
    const h = currentFixture()
    h.binding.acquiredAtUtc = new Date(Date.parse(SOURCE.blockTime) + 1800001).toISOString()
    expect(() => replayApyUsdJointNativeCurrent(h.wire, h.binding)).toThrow()
  })
  it('rejects accessors without invoking them; allows repeated plain aliases but rejects cycles', () => {
    const f = currentFixture()
    let calls = 0
    Object.defineProperty(f.wire.origins[0].traces[0], 'result', {
      enumerable: true,
      get: () => {
        calls++
        return null
      },
    })
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
    expect(calls).toBe(0)
    const g = currentFixture()
    g.wire.origins[1].traces[0].request = g.wire.origins[0].traces[0].request
    expect(replayApyUsdJointNativeCurrent(g.wire, g.binding).current.fullSharesRaw).toBe(FULL_S)
    ;(g.wire as unknown as { cycle: unknown }).cycle = g.wire
    expect(() => replayApyUsdJointNativeCurrent(g.wire, g.binding)).toThrow()
  })
  it('retains immutable eight-anchor cash/full-S quotes without historical holder ownership', () => {
    for (const a of APY_USD_JOINT_NATIVE_ANCHORS) {
      const f = historyFixture(a.cashIndex),
        v = replayApyUsdJointNativeHistoryPoint(f.wire, f.binding)
      expect(v.vaultCashRaw).toBe(a.cashRaw)
      expect(v.fullSharesRaw).toBe(FULL_S)
      expect(v.owner).toBe(null)
      expect(v.historicalOwnership).toBe(false)
      expect(v.authenticated).toBe(false)
      expect(f.wire.origins[0].traces.length).toBe(27)
    }
  })
  it('rejects scaled historical S, changed cash, ownership assertion and changed runtime regime', () => {
    const f = historyFixture()
    f.binding.fullSharesRaw = String(BigInt(FULL_S) + 1n)
    expect(() => replayApyUsdJointNativeHistoryPoint(f.wire, f.binding)).toThrow()
    const g = historyFixture()
    g.wire.origins.forEach((o) => {
      o.traces.find((t) => t.key === 'vault_cash')!.result = result('balanceOf', 1n)
    })
    expect(() => replayApyUsdJointNativeHistoryPoint(g.wire, g.binding)).toThrow()
    const h = historyFixture()
    ;(h.binding as unknown as { owner: string }).owner = OWNER
    expect(() => replayApyUsdJointNativeHistoryPoint(h.wire, h.binding)).toThrow()
    const i = historyFixture()
    i.binding.currentRuntimeRegime = 'a'.repeat(64)
    expect(() => replayApyUsdJointNativeHistoryPoint(i.wire, i.binding)).toThrow()
  })
  it('censors native historical quote errors instead of filling a decoded estimate', () => {
    const f = historyFixture()
    f.wire.origins.forEach((o) => {
      const t = o.traces.find((t) => t.key === 'full_escrow_ea')!
      delete t.result
      t.error = nativeError().error
    })
    expect(replayApyUsdJointNativeHistoryPoint(f.wire, f.binding).fullEscrowEaRaw).toBe(null)
  })
  it('reuses actual historical acquisition clocks before a newer current block without restamping them', () => {
    const f = historyFixture(),
      earlier = Date.parse(SOURCE.blockTime) - 60000,
      delta = Date.parse(f.binding.acquiredAtUtc) - earlier
    f.wire.origins.forEach((o) => {
      o.acquiredAtUtc = new Date(earlier).toISOString()
      ;[o.chainIdTrace, ...o.traces].forEach((t) => {
        t.startedAtUtc = new Date(Date.parse(t.startedAtUtc) - delta).toISOString()
        t.completedAtUtc = new Date(Date.parse(t.completedAtUtc) - delta).toISOString()
      })
    })
    f.binding.acquiredAtUtc = new Date(earlier).toISOString()
    expect(replayApyUsdJointNativeHistoryPoint(f.wire, f.binding).acquiredAtUtc).toBe(
      f.binding.acquiredAtUtc,
    )
    const row = f.wire.origins[0].traces.at(-1)!
    delete row.result
    row.error = nativeError().error
    expect(() => replayApyUsdJointNativeHistoryPoint(f.wire, f.binding)).toThrow()
  })
  it('bounds wire bytes and rejects duplicate decoded JSON keys or malformed commitments', () => {
    expect(() => parseApyUsdJointNativeEvidenceJson('{"origins":[],"origins":[]}')).toThrow()
    expect(() =>
      parseApyUsdJointNativeEvidenceJson(
        ' '.repeat(APY_USD_JOINT_NATIVE_LIMITS.transportBytes + 1),
      ),
    ).toThrow()
    const f = currentFixture()
    alter(f, 'vault_cash', (t) => {
      t.responseBodySha256 = 'bad'
    })
    expect(() => replayApyUsdJointNativeCurrent(f.wire, f.binding)).toThrow()
  })
})
