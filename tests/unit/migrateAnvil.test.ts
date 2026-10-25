// Q41 end to end on a local anvil: the app's own reads, simulation and runner against the
// contracts/migrator DeployLocal stack (real Cdp + Transmuter, real Morpho Blue, real Bundler3 /
// GeneralAdapter1 / AaveV3MigrationAdapter, Aave pool double, MembraneBundlerAdapter).
//
// Opt-in: start the stack with contracts/migrator/local-anvil.sh, then
//   MIGRATE_ANVIL_RPC=http://127.0.0.1:8545 npx vitest run tests/unit/migrateAnvil.test.ts
// Without the env var every test is skipped. Each test runs inside evm_snapshot / evm_revert.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, parseAbi, type Abi, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { anvil } from '@/config/evm/chains'
import local from '@/contracts/migrator/deployments/local.json'
import { cdpOperatorAbi } from '@/lib/migrate/abis'
import { migrateConfig } from '@/lib/migrate/addresses'
import { deployPathFor, readLeftovers, runMigrationBatch, type SendBatch, borrowLtvWad, readiness, resolveDeploy, resolveMigration, runDeploy, runMigration, runRevoke, simulateDeploy, simulatePreSign, type ResolvedDeploy, type ResolvedMigration, type RunEvent } from '@/lib/migrate/exec'
import { morphoAbi, permitTokenAbi } from '@/lib/migrate/abis'
import { sendBatch7702 } from '@/lib/migrate/sendBatch7702'
import { buildDeployPlan } from '@/lib/migrate/plan'
import { demoBorrowerPosition } from '@/lib/position-sim/demoBorrower'
import type { MigrateSource } from '@/lib/migrate/types'

const RPC = process.env.MIGRATE_ANVIL_RPC
const run = RPC ? describe : describe.skip

// anvil default keys (public test keys)
const KEY_AAVE = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' // #2
const KEY_MORPHO = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' // #3
const KEY_HOT = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' // #4

const chain = { ...anvil, rpcUrls: { default: { http: [RPC ?? 'http://127.0.0.1:8545'] } } }
const aaveDebtAbi = parseAbi(['function variableDebt(address asset, address user) view returns (uint256)', 'function aTokenOf(address asset) view returns (address)'])
const oracleAbi = parseAbi(['function setPrice(bytes32 a, uint256 p)'])

run('migrate on local anvil', () => {
  const client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient
  const cfg = migrateConfig(31337)!
  let snap: `0x${string}`
  beforeEach(async () => {
    snap = (await client.request({ method: 'evm_snapshot' as never })) as `0x${string}`
  })
  afterEach(async () => {
    await client.request({ method: 'evm_revert' as never, params: [snap] as never })
  })

  const source = (protocol: MigrateSource['protocol']): MigrateSource => ({ ...demoBorrowerPosition(), protocol })

  async function migrate(key: `0x${string}`, protocol: MigrateSource['protocol']) {
    const account = privateKeyToAccount(key)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const venue = protocol === 'morpho-blue' ? 'morpho-blue' : 'aave-v3'
    const r = (await resolveMigration(client, cfg, source(protocol), venue, account.address)) as ResolvedMigration
    expect('error' in r).toBe(false)
    const pre = await simulatePreSign(client, cfg, r)
    const events: RunEvent[] = []
    const result = pre.ok ? await runMigration({ client, wallet, cfg, source: source(protocol), r, onEvent: (e) => events.push(e) }) : null
    return { account, wallet, r, pre, result, events }
  }

  it('the chain is ready for Aave and Morpho', () => {
    expect(readiness(cfg, 'Anvil (local)', 'aave-v3').ok).toBe(true)
    expect(readiness(cfg, 'Anvil (local)', 'morpho-blue').ok).toBe(true)
    expect(readiness(migrateConfig(1), 'Ethereum', 'aave-v3')).toMatchObject({ ok: false })
  })

  it('Aave: simulate, 4 prompts (grant only after the signed bundle simulates), settle, no allowance left, optional revoke', async () => {
    const { account, wallet, r, pre, result, events } = await migrate(KEY_AAVE, 'aave-v3')
    expect(pre.ok).toBe(true)
    if (pre.ok) expect(pre.steps.map((x) => x.id)).toEqual(['operator', 'bundle']) // gas per step
    expect(result?.ok).toBe(true)
    expect(result?.sourceDebtAfter).toBe(0n) // L-2
    const order = events.filter((e) => e.kind === 'prompt' || e.kind === 'simulated').map((e) => (e.kind === 'prompt' ? e.id : 'SIM'))
    expect(order).toEqual(['atoken-permit', 'proceeds-permit', 'SIM', 'operator', 'bundle'])
    const usdc = local.usdc as `0x${string}`
    expect(await client.readContract({ address: cfg.aavePool!, abi: aaveDebtAbi, functionName: 'variableDebt', args: [usdc, account.address] })).toBe(0n)
    const pid = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'userPositionIds', args: [account.address, 0n] })
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionDebt', args: [pid] })).toBe(r.borrowCdt)
    // exact permits: nothing left approved (M-2)
    const aToken = await client.readContract({ address: cfg.aavePool!, abi: aaveDebtAbi, functionName: 'aTokenOf', args: [local.weth as `0x${string}`] })
    expect(await client.readContract({ address: usdc, abi: permitTokenAbi, functionName: 'allowance', args: [account.address, cfg.membraneAdapter!] })).toBe(0n)
    expect(await client.readContract({ address: aToken, abi: permitTokenAbi, functionName: 'allowance', args: [account.address, cfg.generalAdapter1!] })).toBe(0n)
    // the optional revoke
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [account.address, cfg.membraneAdapter!] })).toBe(true)
    expect((await runRevoke({ client, wallet, cfg, owner: account.address, venue: 'aave-v3' })).ok).toBe(true)
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [account.address, cfg.membraneAdapter!] })).toBe(false)
  })

  it('the cap is read on-chain: live max LTV − 3pp − 0.5pp', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    expect(r.maxLtvOnchainWad).toBe(80n * 10n ** 16n)
    expect(r.maxLtvWad).toBe(765n * 10n ** 15n)
    expect(r.venueTokenAmount).toBe(r.collateralWei) // exact aTokens
  })

  it('a price drop after the plan: the fresh read at run time stops before any prompt', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    expect(borrowLtvWad(r) <= r.maxLtvWad).toBe(true)
    const owner0 = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    const admin = createWalletClient({ account: owner0, chain, transport: http(RPC) })
    const h = await admin.writeContract({ address: local.oracle as `0x${string}`, abi: oracleAbi, functionName: 'setPrice', args: [`0x${Buffer.from('WETH').toString('hex').padEnd(64, '0')}`, 1500n * 10n ** 18n] })
    await client.waitForTransactionReceipt({ hash: h })
    const events: RunEvent[] = []
    const res = await runMigration({ client, wallet, cfg, source: source('aave-v3'), r, onEvent: (e) => events.push(e) })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/LtvAboveCap/)
    expect(events.filter((e) => e.kind === 'prompt')).toHaveLength(0)
  })

  it('Morpho: simulate, 4 prompts, settle', async () => {
    const { pre, result, events } = await migrate(KEY_MORPHO, 'morpho-blue')
    expect(pre.ok).toBe(true)
    expect(result?.ok).toBe(true)
    expect(events.filter((e) => e.kind === 'prompt').map((e) => (e as { id: string }).id)).toEqual(['morpho-auth', 'proceeds-permit', 'operator', 'bundle'])
    expect(result?.sourceDebtAfter).toBe(0n)
    // the Morpho authorization is permanent until revoked; the optional revoke clears both grants
    const { account, wallet } = await (async () => {
      const account = privateKeyToAccount(KEY_MORPHO)
      return { account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) }
    })()
    expect(await client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'isAuthorized', args: [account.address, cfg.generalAdapter1!] })).toBe(true)
    expect((await runRevoke({ client, wallet, cfg, owner: account.address, venue: 'morpho-blue' })).ok).toBe(true)
    expect(await client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'isAuthorized', args: [account.address, cfg.generalAdapter1!] })).toBe(false)
  })

  it('82% LTV: the pre-signature simulation fails before any prompt', async () => {
    const { pre, result } = await migrate(KEY_HOT, 'aave-v3')
    expect(pre.ok).toBe(false)
    if (!pre.ok) expect(pre.reason).toMatch(/InsolventAfterAction/)
    expect(result).toBeNull()
  })

  it('deploy fresh: replay collateral capped at the wallet, at the replay LTV, 3 prompts', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const src = source('aave-v3')
    const plan = buildDeployPlan(src)
    const d = (await resolveDeploy(client, cfg, src, account.address, plan.membrane.ltv)) as ResolvedDeploy
    expect('error' in d).toBe(false)
    expect(d.depositWei).toBe(d.walletWei) // 10 WETH in the wallet < 281 WETH in the replay
    expect((await simulateDeploy(client, cfg, d)).ok).toBe(true)
    const events: RunEvent[] = []
    const res = await runDeploy({ client, wallet, cfg, d, onEvent: (e) => events.push(e) })
    expect(res.ok).toBe(true)
    expect(events.filter((e) => e.kind === 'prompt').map((e) => (e as { id: string }).id)).toEqual(['approve', 'deposit', 'borrow'])
    const pid = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'userPositionIds', args: [account.address, 0n] })
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionDebt', args: [pid] })).toBe(d.borrowCdt)
  })

  // ---------------------------------------------------------------- EIP-5792 batch, emulated by EIP-7702
  // anvil has no wallet_sendCalls; the owner's EOA delegates to BatchExecutor and runs the exact
  // batch in ONE transaction — what a 7702 smart-account wallet does behind wallet_sendCalls.
  const send = sendBatch7702(local.batchExecutor as `0x${string}`)

  it('Aave batch: one prompt, settles, nothing left granted or approved', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    const events: RunEvent[] = []
    const res = await runMigrationBatch({ client, wallet, cfg, source: source('aave-v3'), r, onEvent: (e) => events.push(e), send })
    expect(res.ok).toBe(true)
    expect(res.sourceDebtAfter).toBe(0n)
    expect(events.filter((e) => e.kind === 'prompt')).toHaveLength(1)
    const pid = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'userPositionIds', args: [account.address, 0n] })
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionDebt', args: [pid] })).toBe(r.borrowCdt)
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [account.address, cfg.membraneAdapter!] })).toBe(false)
    expect(await client.readContract({ address: local.usdc as `0x${string}`, abi: permitTokenAbi, functionName: 'allowance', args: [account.address, cfg.membraneAdapter!] })).toBe(0n)
  })

  it('review item 3: an allowance the owner had before the batch is restored, not zeroed', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const usdc = local.usdc as `0x${string}`
    const a = await wallet.writeContract({ address: usdc, abi: permitTokenAbi, functionName: 'approve', args: [cfg.membraneAdapter!, 777n] })
    await client.waitForTransactionReceipt({ hash: a })
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    expect(r.prevProceedsAllowance).toBe(777n)
    const res = await runMigrationBatch({ client, wallet, cfg, source: source('aave-v3'), r, send })
    expect(res.ok).toBe(true)
    expect(res.leftovers).toEqual([])
    expect(await client.readContract({ address: usdc, abi: permitTokenAbi, functionName: 'allowance', args: [account.address, cfg.membraneAdapter!] })).toBe(777n)
  })

  it('review item 1: a wallet that runs part of the batch — the read-back lists what is left, and revoke clears it', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    // a misbehaving wallet: the first three calls (approvals + grant) one by one, then "failed"
    const partial: SendBatch = async ({ calls, chain: c }) => {
      let hash: `0x${string}` = '0x'
      for (const x of calls.slice(0, 3)) {
        hash = await wallet.writeContract({ account, chain: c, address: x.to, abi: x.abi as Abi, functionName: x.functionName, args: x.args as never })
        await client.waitForTransactionReceipt({ hash })
      }
      return { hash, ok: false }
    }
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    const res = await runMigrationBatch({ client, wallet, cfg, source: source('aave-v3'), r, send: partial })
    expect(res.ok).toBe(false)
    expect(res.leftovers?.map((l) => l.id)).toEqual(['operator', 'venue-allowance', 'proceeds-allowance'])
    const rv = await runRevoke({ client, wallet, cfg, owner: account.address, venue: 'aave-v3', r })
    expect(rv.ok).toBe(true)
    expect(await readLeftovers(client, cfg, r)).toEqual([])
  })

  it('review item 2: a batch for another chain id is refused before any prompt', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    await expect(runMigrationBatch({ client, wallet, cfg: { ...cfg, chainId: 1 }, source: source('aave-v3'), r, send })).rejects.toThrow(/chain 31337.*chain 1/)
    expect(await readLeftovers(client, cfg, r)).toEqual([])
  })

  it('Morpho batch: one prompt, the Morpho authorization is revoked inside it', async () => {
    const account = privateKeyToAccount(KEY_MORPHO)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const r = (await resolveMigration(client, cfg, source('morpho-blue'), 'morpho-blue', account.address)) as ResolvedMigration
    const res = await runMigrationBatch({ client, wallet, cfg, source: source('morpho-blue'), r, send })
    expect(res.ok).toBe(true)
    expect(await client.readContract({ address: cfg.morpho!, abi: morphoAbi, functionName: 'isAuthorized', args: [account.address, cfg.generalAdapter1!] })).toBe(false)
  })

  it('82% batch: the batch simulation fails before the prompt', async () => {
    const account = privateKeyToAccount(KEY_HOT)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const r = (await resolveMigration(client, cfg, source('aave-v3'), 'aave-v3', account.address)) as ResolvedMigration
    const events: RunEvent[] = []
    const res = await runMigrationBatch({ client, wallet, cfg, source: source('aave-v3'), r, onEvent: (e) => events.push(e), send })
    expect(res.ok).toBe(false)
    expect(events.filter((e) => e.kind === 'prompt')).toHaveLength(0)
  })

  it('deploy fresh via CdpRouter batch: one prompt, router grant not left standing', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const src = source('aave-v3')
    const d = (await resolveDeploy(client, cfg, src, account.address, buildDeployPlan(src).membrane.ltv)) as ResolvedDeploy
    const path = deployPathFor(d, true)
    expect(path).toBe('batch-router')
    expect((await simulateDeploy(client, cfg, d, path)).ok).toBe(true)
    const events: RunEvent[] = []
    const res = await runDeploy({ client, wallet, cfg, d, path, onEvent: (e) => events.push(e), send })
    expect(res.ok).toBe(true)
    expect(events.filter((e) => e.kind === 'prompt')).toHaveLength(1)
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [account.address, cfg.cdpRouter!] })).toBe(false)
  })

  it('deploy fresh via CdpRouter with its grant standing: approve + 1 tx', async () => {
    const account = privateKeyToAccount(KEY_AAVE)
    const wallet = createWalletClient({ account, chain, transport: http(RPC) })
    const g = await wallet.writeContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'setPositionOperator', args: [cfg.cdpRouter!, true] })
    await client.waitForTransactionReceipt({ hash: g })
    const src = source('aave-v3')
    const d = (await resolveDeploy(client, cfg, src, account.address, buildDeployPlan(src).membrane.ltv)) as ResolvedDeploy
    const path = deployPathFor(d, false)
    expect(path).toBe('router')
    const events: RunEvent[] = []
    const res = await runDeploy({ client, wallet, cfg, d, path, onEvent: (e) => events.push(e) })
    expect(res.ok).toBe(true)
    expect(events.filter((e) => e.kind === 'prompt').map((e) => (e as { id: string }).id)).toEqual(['approve', 'router'])
  })
})
