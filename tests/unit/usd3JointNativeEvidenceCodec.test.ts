import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  encodeUsd3JointNativeHistoryEvidence as encode,
  decodeUsd3JointNativeHistoryEvidence as decode,
  parseUsd3JointNativeEvidenceJson as parse,
  USD3_JOINT_NATIVE_EVIDENCE_LIMITS as limits,
  type Usd3JointNativeHistoryEvidenceTransport as Transport,
  type Usd3JointNativeTrace as Trace,
} from '@/lib/carry/usd3JointNativeEvidenceCodec'

const abi = parseAbi([
  'function previewRedeem(uint256) view returns (uint256)',
  'function availableWithdrawLimit(address) view returns (uint256)',
])
const path = new URL(
  '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/01-native-historical-capture.json',
  import.meta.url,
)
const original = () => JSON.parse(readFileSync(path, 'utf8'))
let fixtureBase: Transport | null = null
const fixture = () => structuredClone((fixtureBase ??= encode(original())))
const trace = (v: Transport, key: string, origin = 0, anchor = 0) =>
  v.origins[origin].anchors[anchor].find((t) => t.key === key)!
const result = (t: Trace, value: unknown) => {
  t.response = { jsonrpc: '2.0', id: t.request.id, result: value }
}
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0')
const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex')

describe('USD3 browser-safe historical claims codec', () => {
  it('encodes the real independently archived original below 512KiB and reconstructs native point facts without granting authority', () => {
    const raw = original(),
      compact = encode(raw),
      replay = decode(JSON.stringify(compact))
    const archived = JSON.parse(
      readFileSync(
        new URL(
          '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/02-replayed-native-points.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    expect(new TextEncoder().encode(JSON.stringify(compact)).length).toBeLessThanOrEqual(
      limits.transportBytes,
    )
    expect(Object.keys(compact.codeDictionary)).toHaveLength(4)
    expect(compact.origins.map((o) => o.host)).toEqual([
      'eth-mainnet.g.alchemy.com',
      'rpc.ankr.com',
    ])
    expect(
      compact.origins.every(
        (o) => o.anchors.length === 4 && o.anchors.every((a) => a.length === 17),
      ),
    ).toBe(true)
    expect(replay.points).toEqual(archived.points)
    expect(replay.acquiredAtUtc).toBe(raw.availableAtUtc)
    expect(replay.startedAtUtc).toBe(raw.startedAtUtc)
    expect(compact.provenance.originalBodySha256).toBe(raw.sha256)
    expect(compact.provenance.originalPlanSha256).toBe(raw.planSha256)
    expect(compact.authenticated).toBe(false)
    expect(compact.originalAuthority).toBe(false)
    expect(replay.authoritativeNativeCapture).toBe(false)
    expect(replay.authenticated).toBe(false)
    expect(replay.owner).toBeNull()
    expect(replay.historicalOwnership).toBe(false)
    expect(Object.isFrozen(compact.origins[0].anchors[0][0])).toBe(true)
    expect(JSON.stringify(compact)).not.toContain('rawBodyBase64')
    expect(JSON.stringify(compact)).not.toContain('settlement')
    expect(JSON.stringify(compact)).not.toContain('http')
    expect(JSON.stringify(compact)).not.toContain('/Users/')
    expect(trace(compact, 'header_before').startedAtUtc).toBe(
      raw.ledger.find(
        (r: { physicalId: number }) => r.physicalId === raw.origins[0].anchors[0][0].physicalId,
      ).startedAtUtc,
    )
  })
  it('permits a structurally consistent bound address/full S claim while denying all original authority', () => {
    const v = fixture(),
      subject = '0x1234567890123456789012345678901234567890'
    v.subject.sharesRaw = '2345678'
    v.subject.withdrawalLimitSubject = subject
    expect(() => decode(v)).toThrow(/native_request/)
    for (const o of v.origins)
      for (const anchor of o.anchors) {
        const ea = anchor.find((t) => t.key === 'native_ea')!,
          limit = anchor.find((t) => t.key === 'withdrawal_limit')!
        ;(ea.request.params[0] as { data: string }).data = encodeFunctionData({
          abi,
          functionName: 'previewRedeem',
          args: [2345678n],
        })
        ;(limit.request.params[0] as { data: string }).data = encodeFunctionData({
          abi,
          functionName: 'availableWithdrawLimit',
          args: [subject],
        })
        result(ea, encodeFunctionResult({ abi, functionName: 'previewRedeem', result: 2345695n }))
      }
    const replay = decode(v)
    expect(
      replay.points.every(
        (p) =>
          p.withdrawalLimitSubject === subject &&
          p.hypotheticalSharesRaw === '2345678' &&
          p.nativeEaRaw === '2345695',
      ),
    ).toBe(true)
    expect(replay.authenticated).toBe(false)
    expect(replay.originalAuthority).toBe(false)
    expect(replay.authoritativeNativeCapture).toBe(false)
    expect(replay.owner).toBeNull()
    expect(replay.ownerCommitmentQualification).toBe(false)
  })
  it('keeps unsupported native C null and refuses disagreement, success disguise or errors on essential getters', () => {
    const v = fixture()
    for (const o of v.origins) {
      const t = o.anchors[0].find((t) => t.key === 'withdrawal_limit')!
      t.response = {
        jsonrpc: '2.0',
        id: t.request.id,
        error: { code: -32000, message: 'native_withdrawal_limit_unavailable' },
      }
    }
    expect(decode(v).points[0].availableWithdrawLimitRaw).toBeNull()
    expect(decode(v).points[0].nativeQuoteStatus).toBe(
      'censored_native_withdrawal_limit_unavailable',
    )
    result(trace(v, 'withdrawal_limit', 1), word(0n))
    expect(() => decode(v)).toThrow(/origin_consensus/)
    const essential = fixture(),
      t = trace(essential, 'native_ea')
    t.response = {
      jsonrpc: '2.0',
      id: t.request.id,
      error: { code: -32000, message: 'native_withdrawal_limit_unavailable' },
    }
    expect(() => decode(essential)).toThrow(/getter_error/)
  })
  it('rejects tampered anchors, methods, owner claims, S, units, origin identity, runtime references and end headers', () => {
    const edits: ((v: Transport) => void)[] = [
      (v) => {
        v.anchors[0].source.blockHash = '0x' + '1'.repeat(64)
      },
      (v) => {
        trace(v, 'native_ea').request.method = 'eth_estimateGas'
      },
      (v) => {
        ;(v as unknown as { owner: string }).owner = v.subject.destination
      },
      (v) => {
        ;(v as unknown as { historicalOwnership: boolean }).historicalOwnership = true
      },
      (v) => {
        ;(v as unknown as { authenticated: boolean }).authenticated = true
      },
      (v) => {
        v.subject.sharesRaw = '2'
      },
      (v) => {
        v.subject.withdrawalLimitSubject = v.subject.destination
      },
      (v) => {
        ;(v.subject as unknown as { shareDecimals: number }).shareDecimals = 18
      },
      (v) => {
        v.origins[1].host = v.origins[0].host
      },
      (v) => {
        v.codeDictionary.proxy_code = '0x6001'
      },
      (v) => {
        result(trace(v, 'proxy_code'), { codeRef: 'asset_code' })
      },
      (v) => {
        result(trace(v, 'header_after'), {
          number: '0x1',
          hash: v.anchors[0].source.blockHash,
          timestamp: '0x1',
        })
      },
      (v) => {
        result(trace(v, 'implementation_slot'), word(0n))
      },
      (v) => {
        result(trace(v, 'shutdown'), word(2n))
      },
      (v) => {
        result(trace(v, 'share_decimals'), word(18n))
      },
      (v) => {
        result(trace(v, 'total_assets', 1), word(1n))
      },
    ]
    for (const edit of edits) {
      const v = fixture()
      edit(v)
      expect(() => decode(v)).toThrow()
    }
  })
  it('rejects malformed word/address/digest, zero or overflowing S and response ids', () => {
    for (const s of ['0', '01', '-1', (1n << 256n).toString()]) {
      const v = fixture()
      v.subject.sharesRaw = s
      expect(() => decode(v)).toThrow(/subject/)
    }
    for (const x of ['0x1', word(1n) + '00', '0x' + 'F'.repeat(64)]) {
      const v = fixture()
      result(trace(v, 'native_ea'), x)
      expect(() => decode(v)).toThrow(/canonical_word/)
    }
    const v = fixture()
    v.provenance.originalBodySha256 = 'caller-approved'
    expect(() => decode(v)).toThrow(/provenance/)
    const id = fixture()
    trace(id, 'nav').response.id = 999
    expect(() => decode(id)).toThrow(/response_id/)
  })
  it('checks real read/completion/acquisition ordering, stage deadline and late captures', () => {
    for (const edit of [
      (v: Transport) => {
        v.acquiredAtUtc = v.anchors[0].source.blockTime
      },
      (v: Transport) => {
        v.acquiredAtUtc = new Date(Date.parse(v.startedAtUtc) + 120001).toISOString()
      },
      (v: Transport) => {
        v.acquiredAtUtc = new Date(Date.parse(v.acquiredAtUtc) + 251).toISOString()
      },
      (v: Transport) => {
        trace(v, 'native_ea').completedAtUtc = v.startedAtUtc
      },
      (v: Transport) => {
        trace(v, 'native_ea').startedAtUtc = v.acquiredAtUtc
      },
    ]) {
      const v = fixture()
      edit(v)
      expect(() => decode(v)).toThrow()
    }
  })
  it('rejects duplicate JSON keys, accessors, sparse arrays, extras and transport/runtime overflow before use', () => {
    expect(() => parse('{"x":{"a":1,"\\u0061":2}}')).toThrow(/duplicate_json_key/)
    expect(() => decode(' '.repeat(limits.transportBytes + 1))).toThrow(/json_bytes/)
    const sparse = fixture()
    delete sparse.origins[0].anchors[0][3]
    expect(() => decode(sparse)).toThrow()
    const extra = fixture() as Transport & { callerApproval?: boolean }
    extra.callerApproval = true
    expect(() => decode(extra)).toThrow(/keys/)
    const dictionary = fixture()
    dictionary.codeDictionary.extra = '0x60'
    expect(() => decode(dictionary)).toThrow(/keys/)
    const huge = fixture()
    huge.codeDictionary.proxy_code = '0x' + '60'.repeat(65537)
    expect(() => decode(huge)).toThrow()
    let touched = false
    const getter = fixture()
    Object.defineProperty(getter, 'subject', {
      enumerable: true,
      get() {
        touched = true
        return {}
      },
    })
    expect(() => decode(getter)).toThrow(/accessor/)
    expect(touched).toBe(false)
  })
  it('encoder rejects altered original bytes/commitments, duplicate raw keys, failed status and strips private error messages', () => {
    const changed = original()
    changed.ledger[0].status = 'failed'
    expect(() => encode(changed)).toThrow(/capture_self_seal/)
    const failed = original()
    failed.ledger[0].status = 'failed'
    failed.terminalCommitments[0].rowSha256 = hash(failed.ledger[0])
    const { sha256: _seal, ...body } = failed
    failed.sha256 = hash(body)
    expect(() => encode(failed)).toThrow(/physical_row/)
    const duplicate = original(),
      row = duplicate.ledger[0]
    const duplicatedBody = Buffer.from('{"jsonrpc":"2.0","id":1,"id":1,"result":"0x1"}')
    row.rawBodyBase64 = duplicatedBody.toString('base64')
    row.bodyBytes = duplicatedBody.length
    row.bodySha256 = hash(duplicatedBody.toString())
    duplicate.terminalCommitments = duplicate.ledger.map((r: unknown) => ({
      physicalId: (r as { physicalId: number }).physicalId,
      rowSha256: hash(r),
    }))
    const { sha256: _duplicateSeal, ...duplicatedCapture } = duplicate
    duplicate.sha256 = hash(duplicatedCapture)
    expect(() => encode(duplicate)).toThrow(/duplicate_json_key/)
    const raw = original()
    for (const r of raw.ledger) {
      if (
        r.request.method !== 'eth_call' ||
        !r.request.params[0].data.startsWith(
          encodeFunctionData({
            abi,
            functionName: 'availableWithdrawLimit',
            args: [raw.plan.withdrawalLimitSubject],
          }).slice(0, 10),
        )
      )
        continue
      const bytes = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: r.request.id,
          error: {
            code: -32000,
            message: 'https://rpc.ankr.com/private-secret',
            data: '/Users/private',
          },
        }),
      )
      r.rawBodyBase64 = bytes.toString('base64')
      r.bodyBytes = bytes.length
      r.bodySha256 = hash(bytes.toString())
    }
    raw.terminalCommitments = raw.ledger.map((r: unknown) => ({
      physicalId: (r as { physicalId: number }).physicalId,
      rowSha256: hash(r),
    }))
    const { sha256: _old, ...rest } = raw
    raw.sha256 = hash(rest)
    const compact = encode(raw)
    expect(JSON.stringify(compact)).not.toContain('private-secret')
    expect(JSON.stringify(compact)).not.toContain('/Users/private')
    expect(decode(compact).points.every((p) => p.availableWithdrawLimitRaw === null)).toBe(true)
  })
})
