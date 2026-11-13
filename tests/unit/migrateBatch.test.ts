// Q41 owner-approved item 1 & 2: EIP-5792 capability detection, the one-prompt batch (grant AND
// revoke inside it), the fallback to the per-prompt flow, and the deploy-fresh path choice.

import { describe, expect, it } from 'vitest'
import { createWalletClient, custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { migrateConfig, type MigrateChainConfig } from '@/lib/migrate/addresses'
import { batchCallsFor, batchSettlement, chainFor, deployPathFor, detectAtomic, sendBatch5792, type ResolvedDeploy, type ResolvedMigration } from '@/lib/migrate/exec'
import { buildDeployPlan, buildMigrationPlan } from '@/lib/migrate/plan'
import { demoBorrowerPosition } from '@/lib/position-sim/demoBorrower'

const account = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')

function walletAnswering(answer: () => unknown) {
  return createWalletClient({
    account,
    transport: custom({
      async request({ method }) {
        if (method === 'wallet_getCapabilities') return answer()
        throw new Error(`unexpected ${method}`)
      },
    }),
  })
}

describe('detectAtomic (wallet_getCapabilities)', () => {
  const at = (status: string) => () => ({ '0x7a69': { atomic: { status } } })
  it('supported → one prompt', async () => {
    expect(await detectAtomic(walletAnswering(at('supported')), 31337)).toBe(true)
  })
  it("'ready' (an account upgrade the wallet would ask for first) → fallback", async () => {
    expect(await detectAtomic(walletAnswering(at('ready')), 31337)).toBe(false)
  })
  it('unsupported, no entry, or an RPC error → fallback', async () => {
    expect(await detectAtomic(walletAnswering(at('unsupported')), 31337)).toBe(false)
    expect(await detectAtomic(walletAnswering(() => ({})), 31337)).toBe(false)
    expect(
      await detectAtomic(
        walletAnswering(() => {
          throw new Error('Method not found')
        }),
        31337,
      ),
    ).toBe(false)
  })
  it('legacy atomicBatch.supported shape → one prompt', async () => {
    expect(await detectAtomic(walletAnswering(() => ({ '0x7a69': { atomicBatch: { supported: true } } })), 31337)).toBe(true)
  })
  it('no wallet → fallback', async () => {
    expect(await detectAtomic(undefined, 31337)).toBe(false)
  })
})

const cfg = migrateConfig(31337) as MigrateChainConfig
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
const resolved = (over: Partial<ResolvedMigration> = {}): ResolvedMigration => ({
  venue: 'aave-v3',
  owner: account.address,
  debtToken: cfg.pairedAsset!,
  debtDecimals: 6,
  collateralToken: cfg.tokens.WETH,
  denom: Object.values(cfg.denoms)[0],
  debtWei: 12_000_000_000n,
  collateralWei: 10n * 10n ** 18n,
  flashAmount: 12_002_400_000n,
  borrowCdt: 12_002_400_000n * 10n ** 12n,
  maxLtvWad: 765n * 10n ** 15n,
  maxLtvOnchainWad: 8n * 10n ** 17n,
  venueToken: A(0xa7),
  venueTokenAmount: 10n * 10n ** 18n,
  morphoParams: cfg.morphoMarket,
  operatorGranted: false,
  morphoAuthorized: false,
  prevVenueAllowance: 0n,
  prevProceedsAllowance: 0n,
  blockTime: 0n,
  blockNumber: 1n,
  collateralDecimals: 18,
  membranePriceWad: 2000n * 10n ** 18n,
  ...over,
})

describe('batchCallsFor — one prompt, nothing left standing', () => {
  it('Aave: exact approvals, grant, multicall, revoke — in that order', () => {
    const calls = batchCallsFor(cfg, resolved())
    expect(calls.map((c) => c.id)).toEqual(['atoken-approve', 'proceeds-approve', 'operator', 'bundle', 'revoke-operator', 'restore-atoken', 'restore-proceeds'])
    expect(calls[0]).toMatchObject({ to: A(0xa7), functionName: 'approve', args: [cfg.generalAdapter1, 10n * 10n ** 18n] })
    expect(calls[1]).toMatchObject({ to: cfg.pairedAsset, functionName: 'approve', args: [cfg.membraneAdapter, 12_002_400_000n] })
    expect(calls[2]).toMatchObject({ to: cfg.cdp, functionName: 'setPositionOperator', args: [cfg.membraneAdapter, true] })
    expect(calls[4]).toMatchObject({ to: cfg.cdp, functionName: 'setPositionOperator', args: [cfg.membraneAdapter, false] })
    // the multicall carries no permit calls: flash loan + sweep only
    const bundle = (calls[3].args[0] as { to: string }[])
    expect(bundle).toHaveLength(2)
    expect(bundle[0].to).toBe(cfg.generalAdapter1)
  })
  it('Morpho: authorization first and revoked last', () => {
    const calls = batchCallsFor(cfg, resolved({ venue: 'morpho-blue', venueToken: null, venueTokenAmount: 0n }))
    expect(calls.map((c) => c.id)).toEqual(['morpho-auth', 'proceeds-approve', 'operator', 'bundle', 'revoke-operator', 'revoke-morpho', 'restore-proceeds'])
    expect(calls[0]).toMatchObject({ functionName: 'setAuthorization', args: [cfg.generalAdapter1, true] })
    expect(calls[5]).toMatchObject({ functionName: 'setAuthorization', args: [cfg.generalAdapter1, false] })
  })
  it('a grant the owner already had is neither re-granted nor revoked', () => {
    const calls = batchCallsFor(cfg, resolved({ operatorGranted: true }))
    expect(calls.map((c) => c.id)).toEqual(['atoken-approve', 'proceeds-approve', 'bundle', 'restore-atoken', 'restore-proceeds'])
  })
  it('review item 3: the batch ends by restoring the allowances the owner had before', () => {
    const calls = batchCallsFor(cfg, resolved({ prevVenueAllowance: 7n, prevProceedsAllowance: 5_000_000n }))
    expect(calls.at(-2)).toMatchObject({ to: A(0xa7), functionName: 'approve', args: [cfg.generalAdapter1, 7n] })
    expect(calls.at(-1)).toMatchObject({ to: cfg.pairedAsset, functionName: 'approve', args: [cfg.membraneAdapter, 5_000_000n] })
  })
})

describe('batchSettlement — review item 1', () => {
  const rc = (status: string) => ({ status, transactionHash: '0xaa' as `0x${string}` })
  it('atomic + success + every receipt success → settled', () => {
    expect(batchSettlement({ atomic: true, status: 'success', receipts: [rc('success')] }).ok).toBe(true)
  })
  it('status success but not atomic → NOT settled', () => {
    expect(batchSettlement({ atomic: false, status: 'success', receipts: [rc('success'), rc('success')] }).ok).toBe(false)
    expect(batchSettlement({ status: 'success', receipts: [rc('success')] }).ok).toBe(false)
  })
  it('one reverted receipt (a partial batch) → NOT settled', () => {
    expect(batchSettlement({ atomic: true, status: 'success', receipts: [rc('success'), rc('reverted')] }).ok).toBe(false)
  })
  it("legacy 'CONFIRMED' counts only when the receipts confirm it", () => {
    expect(batchSettlement({ atomic: true, status: 'CONFIRMED', receipts: [rc('0x1')] }).ok).toBe(true)
    expect(batchSettlement({ atomic: true, status: 'CONFIRMED', receipts: [] }).ok).toBe(false)
    expect(batchSettlement({ atomic: true, status: 'CONFIRMED' }).ok).toBe(false)
    expect(batchSettlement({ atomic: true, status: 'CONFIRMED', receipts: [rc('0x0')] }).ok).toBe(false)
  })
  it('failure status → NOT settled even with success receipts', () => {
    expect(batchSettlement({ atomic: true, status: 'failure', receipts: [rc('success')] }).ok).toBe(false)
  })
})

describe('sendBatch5792 — review item 2 (chain)', () => {
  function wallet5792(chainIdHex: string, status: Record<string, unknown>) {
    const seen: { method: string; params: unknown }[] = []
    const w = createWalletClient({
      account,
      transport: custom({
        async request({ method, params }) {
          seen.push({ method, params })
          if (method === 'eth_chainId') return chainIdHex
          if (method === 'wallet_sendCalls') return { id: '0xbatch' }
          if (method === 'wallet_getCallsStatus') return { version: '2.0.0', id: '0xbatch', chainId: chainIdHex, ...status }
          throw new Error(`unexpected ${method}`)
        },
      }),
    })
    return { w, seen }
  }
  const calls = () => batchCallsFor(cfg, resolved())
  const okStatus = { atomic: true, status: 200, receipts: [{ status: '0x1', transactionHash: `0x${'ab'.repeat(32)}`, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x1', gasUsed: '0x1', logs: [] }] }
  it('refuses before any prompt when the wallet is on another chain', async () => {
    const { w, seen } = wallet5792('0x1', okStatus)
    await expect(sendBatch5792({ client: undefined as never, wallet: w, owner: account.address, calls: calls(), chain: chainFor(cfg) })).rejects.toThrow(/chain 1.*chain 31337/)
    expect(seen.some((x) => x.method === 'wallet_sendCalls')).toBe(false)
  })
  it('sends for the config chain id and settles on an atomic, all-success status', async () => {
    const { w, seen } = wallet5792('0x7a69', okStatus)
    const res = await sendBatch5792({ client: undefined as never, wallet: w, owner: account.address, calls: calls(), chain: chainFor(cfg) })
    expect(res.ok).toBe(true)
    const sent = seen.find((x) => x.method === 'wallet_sendCalls')!.params as { chainId: string; atomicRequired: boolean }[]
    expect(sent[0].chainId).toBe('0x7a69')
    expect(sent[0].atomicRequired).toBe(true)
  })
  it('a non-atomic success from the wallet is reported as NOT settled', async () => {
    const { w } = wallet5792('0x7a69', { ...okStatus, atomic: false })
    const res = await sendBatch5792({ client: undefined as never, wallet: w, owner: account.address, calls: calls(), chain: chainFor(cfg) })
    expect(res.ok).toBe(false)
  })
})

describe('the sheet shows the detected path', () => {
  it('atomic → one step; fallback → the four prompts', () => {
    const src = demoBorrowerPosition()
    expect(buildMigrationPlan(src, { atomic: true }).signatures.map((s) => s.id)).toEqual(['batch'])
    expect(buildMigrationPlan(src).signatures.map((s) => s.id)).toEqual(['atoken-permit', 'proceeds-permit', 'operator', 'bundle'])
  })
})

describe('deployPathFor', () => {
  const d = (routerOperator: boolean | null) => ({ routerOperator }) as ResolvedDeploy
  it('batching wallet + router → one-prompt router batch', () => expect(deployPathFor(d(false), true)).toBe('batch-router'))
  it('router grant standing → router (approve + 1 tx)', () => expect(deployPathFor(d(true), false)).toBe('router'))
  it('no standing router grant → direct (the router would need its own grant: same 3 prompts + a standing grant)', () =>
    expect(deployPathFor(d(false), false)).toBe('direct'))
  it('no router on the chain → direct, even when batching', () => expect(deployPathFor(d(null), true)).toBe('direct'))
  it('deploy steps follow the path', () => {
    const src = demoBorrowerPosition()
    expect(buildDeployPlan(src, { deployPath: 'batch-router' }).signatures.map((s) => s.id)).toEqual(['batch'])
    expect(buildDeployPlan(src, { deployPath: 'router' }).signatures.map((s) => s.id)).toEqual(['approve', 'router'])
    expect(buildDeployPlan(src).signatures.map((s) => s.id)).toEqual(['approve', 'deposit', 'borrow'])
  })
})
