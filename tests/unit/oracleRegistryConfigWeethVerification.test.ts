// Config cards — F5 (weETH re-collect, bot data commit d88410c5, head 26,173,524).
//   PO-11 (d1d2ca4c) counted Blockscout's 200 as an answer only when it carries a boolean
//   `is_verified`. Blockscout answers an UNVERIFIED contract with a 200 that has no verification
//   field at all — only the code it holds (probed 2026-10-12, eth.blockscout.com/api/v2/
//   smart-contracts/0x2e346c302925148c4b01625398d40faf8961085e: keys conflicting_implementations,
//   creation_bytecode, creation_status, deployed_bytecode, implementations, proxy_type). So every
//   unverified implementation read "not read" on every run: weETH 1:0x8958cfe7…07f9:117 (L1SyncPool
//   0xd789… upgraded to 0x2e34…085e) was tagged verification_unread, a permanent false read gap.
//   A Blockscout 404 ({"message":"Not found"}: also what a plain EOA or a never-seen address gets)
//   is an address it does not know: not read (it was "not verified").
// AD-9 stays red either way; only the tag (NOT VERIFIED vs VERIFICATION LOOKUP FAILED) changes.
// Each test failed on the code before the fix unless it is marked (control). Synthetic fixtures;
// the response shapes they copy are the probed ones.

import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { neutral, verificationRule } from '@/lib/oracleRegistry/config/rules'
import * as verify from '@/scripts/oracle-registry/config/lib/verify.mjs'

// the L1SyncPool implementation set at 1:0x8958cfe7…07f9:117 (subjects.json weeth, 0xd789…a146)
const IMPL = '0x2e346c302925148c4b01625398d40faf8961085e'

// Blockscout's 200 for that implementation (unverified), bytecode cut to its first bytes
const BS_UNVERIFIED = {
  conflicting_implementations: null,
  creation_bytecode: '0x60a060405234801561001057600080fd5b50604051611f7d38',
  creation_status: 'success',
  deployed_bytecode: '0x6080604052600436106101b75760003560e01c80637d25a05e',
  implementations: [],
  proxy_type: null,
}
// Blockscout's 200 for a verified contract (weETH proxy 0xcd5f…b7ee), the verification fields
const BS_VERIFIED = {
  ...BS_UNVERIFIED,
  name: 'UUPSProxy',
  is_verified: true,
  is_fully_verified: true,
  is_partially_verified: false,
  verified_at: '2023-12-12T18:25:58.051937Z',
}
// Sourcify v2 for an unverified contract: 404 (body {"match":null,…}); for a verified one: 200
const SF_NOT_FOUND = { status: 404, body: { match: null, chainId: '1', address: IMPL } }

type Answer = { status: number; body?: unknown } | Error | 'not_json'
/** fetch answering Sourcify and Blockscout separately; an Error is thrown (network failure). */
const stub = (sourcify: Answer, blockscout: Answer) =>
  vi.stubGlobal('fetch', async (url: string) => {
    const a = String(url).includes('sourcify') ? sourcify : blockscout
    if (a instanceof Error) throw a
    if (a === 'not_json')
      return {
        status: 200,
        json: async () => {
          throw new Error('Unexpected token <')
        },
      }
    return { status: a.status, json: async () => a.body }
  })

describe('F5: Blockscout answers "not verified" with a 200 that has no is_verified — it is NOT verified, not "not read"', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('weETH 0x2e34…085e: an unverified implementation (no is_verified, only its bytecode) is NOT verified — AD-9 red, tagged unverified (was not read: verification_unread)', async () => {
    stub(SF_NOT_FOUND, { status: 200, body: BS_UNVERIFIED })
    const v = await verify.sourceVerified(IMPL)
    expect(v).toBe(false)
    const row = verificationRule(neutral(), IMPL, v)
    expect(row.severity).toBe('downgrade')
    expect(row.ruleIds).toContain('AD-9')
    expect(row.tags).toContain('unverified')
    expect(row.tags).not.toContain('verification_unread')
  })

  it('verifySources reports it NOT verified, and does not cache it (was counted "not read" in the run)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f5-verify-'))
    try {
      const f = join(dir, 'verification.json')
      const lines: string[] = []
      stub(SF_NOT_FOUND, { status: 200, body: BS_UNVERIFIED })
      // the JS default `log = () => {}` types the logger as taking no argument
      const verifySources = verify.verifySources as unknown as (
        a: string[],
        f: string,
        log: (l: string) => void,
      ) => Promise<Record<string, boolean | null>>
      const out = await verifySources([IMPL], f, (l) => void lines.push(l))
      expect(out[IMPL]).toBe(false)
      expect(lines.join('\n')).toContain('0/1 verified, 1 NOT verified, 0 not read')
      // only a VERIFIED answer is cached (PO-11): a later verification is still picked up
      expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a Blockscout 404 (an address it does not know, as for an EOA) is not read (was "not verified")', async () => {
    stub(SF_NOT_FOUND, { status: 404, body: { message: 'Not found' } })
    const v = await verify.sourceVerified(IMPL)
    expect(v).toBeNull()
    expect(verificationRule(neutral(), IMPL, v).tags).toContain('verification_unread')
  })

  it('(control) a verified contract is verified; an explicit is_verified false is not verified', async () => {
    stub(SF_NOT_FOUND, { status: 200, body: BS_VERIFIED })
    expect(await verify.sourceVerified(IMPL)).toBe(true)
    stub(SF_NOT_FOUND, { status: 200, body: { ...BS_UNVERIFIED, is_verified: false } })
    expect(await verify.sourceVerified(IMPL)).toBe(false)
  })

  it('(control) "not verified" needs BOTH services: Sourcify unread + Blockscout not verified is not read', async () => {
    stub({ status: 500 }, { status: 200, body: BS_UNVERIFIED })
    expect(await verify.sourceVerified(IMPL)).toBeNull()
    stub(new Error('ECONNRESET'), { status: 200, body: BS_UNVERIFIED })
    expect(await verify.sourceVerified(IMPL)).toBeNull()
  })

  it('(control) an error, a non-200 or a shape that does not show the code Blockscout holds stays not read', async () => {
    const unread: Answer[] = [
      new Error('aborted'),
      'not_json',
      { status: 500, body: null },
      { status: 429, body: null },
      { status: 422, body: { errors: [{ title: 'Invalid value' }] } },
      { status: 200, body: { message: 'Not found' } },
      { status: 200, body: {} },
      // a verification field that is not a boolean is not an answer
      { status: 200, body: { ...BS_UNVERIFIED, is_verified: null } },
      { status: 200, body: { ...BS_UNVERIFIED, is_verified: 'false' } },
      // a verification field we do not read, without is_verified: not an answer
      { status: 200, body: { ...BS_UNVERIFIED, is_fully_verified: false } },
      // no code held (none, empty, not hex, odd length): not an answer about a contract
      { status: 200, body: { ...BS_UNVERIFIED, deployed_bytecode: null } },
      { status: 200, body: { ...BS_UNVERIFIED, deployed_bytecode: '0x' } },
      { status: 200, body: { ...BS_UNVERIFIED, deployed_bytecode: 'not code' } },
      { status: 200, body: { ...BS_UNVERIFIED, deployed_bytecode: '0x608' } },
      { status: 200, body: { conflicting_implementations: null, implementations: [] } },
    ]
    for (const bs of unread) {
      stub(SF_NOT_FOUND, bs)
      expect(await verify.sourceVerified(IMPL), JSON.stringify(bs)).toBeNull()
    }
  })
})
