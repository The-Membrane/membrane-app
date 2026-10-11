import { describe, expect, it } from 'vitest'
import { resolveUsd3JointTrustedProfile } from '@/lib/carry/usd3JointTrustedProfile'

const route = 'USDC → USD3 [USDC]',
  vault = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
  asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
describe('app-owned USD3 historical metadata', () => {
  it('resolves one private frozen instance for the exact allowlisted route', () => {
    const p = resolveUsd3JointTrustedProfile(route, vault, asset)!
    expect(p).not.toBeNull()
    expect(resolveUsd3JointTrustedProfile(route, vault, asset)).toBe(p)
    expect(p.anchors.map((a) => a.cashIndex)).toEqual([115, 116, 117, 118])
    expect(p.runtimePins.map((p) => p.address)).toEqual([
      vault,
      '0xd1f1c3f485063712873285bf4ef25ab068f13893',
      '0xd377919fa87120584b21279a491f82d5265a139c',
      asset,
    ])
    expect(p.subject.assetDecimals).toBe(6)
    expect(p.subject.shareDecimals).toBe(6)
    expect(Object.isFrozen(p)).toBe(true)
    expect(Object.isFrozen(p.anchors[0].source)).toBe(true)
    expect(Object.isFrozen(p.runtimePins[0])).toBe(true)
    expect(p.sourceImplementationEquivalence).toBe(false)
    expect(p).not.toHaveProperty('originalAuthority')
    expect(p).not.toHaveProperty('authenticated')
  })
  it('does not accept caller labels, unrelated assets, mixed-case aliases or profile registration', () => {
    expect(resolveUsd3JointTrustedProfile('caller-reviewed', vault, asset)).toBeNull()
    expect(resolveUsd3JointTrustedProfile(route, vault, vault)).toBeNull()
    expect(resolveUsd3JointTrustedProfile(route, asset, asset)).toBeNull()
    expect(resolveUsd3JointTrustedProfile(route, vault.toUpperCase(), asset)).toBeNull()
  })
})
