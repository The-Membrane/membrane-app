// Q41 end to end on a local anvil: the app's own reads, simulation and runner against the
// contracts/migrator DeployLocal stack (real Cdp + Transmuter, real Morpho Blue, real Bundler3 /
// GeneralAdapter1 / AaveV3MigrationAdapter, Aave pool double, MembraneBundlerAdapter).
//
// Opt-in: start the stack with contracts/migrator/local-anvil.sh, then
//   MIGRATE_ANVIL_RPC=http://127.0.0.1:8545 npx vitest run tests/unit/migrateAnvil.test.ts
// Without the env var every test is skipped. Each test runs inside evm_snapshot / evm_revert.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, parseAbi, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { anvil } from '@/config/evm/chains'
import local from '@/contracts/migrator/deployments/local.json'
import { cdpOperatorAbi } from '@/lib/migrate/abis'
import { migrateConfig } from '@/lib/migrate/addresses'
import { readiness, resolveMigration, runMigration, simulatePreSign, type ResolvedMigration, type RunEvent } from '@/lib/migrate/exec'
import { demoBorrowerPosition } from '@/lib/position-sim/demoBorrower'
import type { MigrateSource } from '@/lib/migrate/types'

const RPC = process.env.MIGRATE_ANVIL_RPC
const run = RPC ? describe : describe.skip

// anvil default keys (public test keys)
const KEY_AAVE = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' // #2
const KEY_MORPHO = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' // #3
const KEY_HOT = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' // #4

const chain = { ...anvil, rpcUrls: { default: { http: [RPC ?? 'http://127.0.0.1:8545'] } } }
const aaveDebtAbi = parseAbi(['function variableDebt(address asset, address user) view returns (uint256)'])

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
    const result = pre.ok ? await runMigration({ client, wallet, cfg, r, onEvent: (e) => events.push(e) }) : null
    return { account, r, pre, result, events }
  }

  it('the chain is ready for Aave and Morpho', () => {
    expect(readiness(cfg, 'Anvil (local)', 'aave-v3').ok).toBe(true)
    expect(readiness(cfg, 'Anvil (local)', 'morpho-blue').ok).toBe(true)
    expect(readiness(migrateConfig(1), 'Ethereum', 'aave-v3')).toMatchObject({ ok: false })
  })

  it('Aave: simulate, 4 prompts, settle; Membrane debt == exactly what Aave was owed', async () => {
    const { account, r, pre, result, events } = await migrate(KEY_AAVE, 'aave-v3')
    expect(pre.ok).toBe(true)
    expect(result?.ok).toBe(true)
    const prompts = events.filter((e) => e.kind === 'prompt').map((e) => (e as { id: string }).id)
    expect(prompts).toEqual(['operator', 'atoken-permit', 'proceeds-permit', 'bundle'])
    expect(await client.readContract({ address: cfg.aavePool!, abi: aaveDebtAbi, functionName: 'variableDebt', args: [local.usdc as `0x${string}`, account.address] })).toBe(0n)
    const pid = await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'userPositionIds', args: [account.address, 0n] })
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionDebt', args: [pid] })).toBe(r.debtWei)
    // a second migration would skip the operator grant
    expect(await client.readContract({ address: cfg.cdp!, abi: cdpOperatorAbi, functionName: 'positionOperator', args: [account.address, cfg.membraneAdapter!] })).toBe(true)
  })

  it('Morpho: simulate, 4 prompts, settle', async () => {
    const { pre, result, events } = await migrate(KEY_MORPHO, 'morpho-blue')
    expect(pre.ok).toBe(true)
    expect(result?.ok).toBe(true)
    expect(events.filter((e) => e.kind === 'prompt').map((e) => (e as { id: string }).id)).toEqual(['operator', 'morpho-auth', 'proceeds-permit', 'bundle'])
  })

  it('82% LTV: the pre-signature simulation fails before any prompt', async () => {
    const { pre, result } = await migrate(KEY_HOT, 'aave-v3')
    expect(pre.ok).toBe(false)
    if (!pre.ok) expect(pre.reason).toMatch(/InsolventAfterAction/)
    expect(result).toBeNull()
  })
})
