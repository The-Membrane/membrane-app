import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'

import useDemoMode from '@/hooks/useDemoMode'
import useWallet from '@/hooks/useWallet'
import { migrateConfig } from '@/lib/migrate/addresses'
import {
  onchainSource,
  readiness,
  resolveDeploy,
  resolveMigration,
  runDeploy,
  runMigration,
  runRevoke,
  planOptsFor,
  borrowLtvWad,
  simulateDeploy,
  simulatePreSign,
  type ResolvedDeploy,
  type ResolvedMigration,
  type RunEvent,
} from '@/lib/migrate/exec'
import { buildDeployPlan, buildMigrationPlan } from '@/lib/migrate/plan'
import type { Address, MigrateSource, MigrationPlan } from '@/lib/migrate/types'

import { useMigrateHarness, type MigrateEnv } from './harness'

export type Phase =
  | { k: 'demo' }
  | { k: 'wrong-chain'; reason: string }
  | { k: 'no-deployment'; reason: string }
  | { k: 'blocked'; reason: string }
  | { k: 'reading' }
  | { k: 'ready' }
  | { k: 'trim'; reason: string }
  | { k: 'simulating' }
  | { k: 'simulated'; gas: bigint }
  | { k: 'sim-failed'; reason: string }
  | { k: 'signing'; id: string; index: number; total: number }
  | { k: 'submitted'; hash: `0x${string}`; id: string }
  | { k: 'settled'; hash: `0x${string}`; note?: string; revoke?: 'idle' | 'running' | 'done' | 'failed' }
  | { k: 'failed'; reason: string; hash: `0x${string}` | null }

/** Plain language for the custom errors a bundle can surface; the raw name stays in brackets. */
export function explainRevert(reason: string): string {
  const named: [RegExp, string][] = [
    [/InsolventAfterAction|PositionUnsolventPostOp/, 'Membrane would refuse to open the position at this LTV'],
    [/NotOperator/, 'the migration adapter is not allowed on your Membrane positions yet'],
    [/BorrowAboveCap/, 'the venue debt grew past the borrow cap you signed'],
    [/NotPegPaired|TransmuterNotWired/, 'Membrane on this chain cannot pay the borrow out in the debt asset'],
    [/User rejected|denied/i, 'the wallet prompt was rejected'],
  ]
  const hit = named.find(([re]) => re.test(reason))
  return hit ? `${hit[1]} (${reason.split('(')[0]})` : reason
}

const chainName = (id: number | undefined, label?: string) => label ?? (id === 1 ? 'Ethereum' : id === undefined ? 'no chain' : `chain ${id}`)

function useEnv(): MigrateEnv {
  const harness = useMigrateHarness()
  const demo = useDemoMode()
  const { chainId } = useAccount()
  const w = useWallet()
  if (harness) return harness
  const cfg = migrateConfig(chainId)
  return {
    isDemo: demo.isDemo,
    chainId,
    chainLabel: chainName(chainId, cfg?.label),
    address: w.address as Address | undefined,
    publicClient: (w.publicClient ?? undefined) as MigrateEnv['publicClient'],
    walletClient: (w.walletClient ?? undefined) as MigrateEnv['walletClient'],
    connect: demo.connect,
    isWalletConnected: demo.isWalletConnected,
  }
}

export interface MigrateFlow {
  env: MigrateEnv
  plan: MigrationPlan
  /** True once the rows come from the connected chain's own read. */
  readOnChain: { block: bigint; chainLabel: string } | null
  phase: Phase
  start: () => void
  revoke: () => void
  /** Prompts the run will actually ask for, given the standing grants read on-chain. */
  promptIds: string[] | null
  addresses: { label: string; address: string }[]
}

export function useMigrateFlow(kind: 'migrate' | 'deploy', position: MigrateSource): MigrateFlow {
  const env = useEnv()
  const basePlan = useMemo(() => (kind === 'migrate' ? buildMigrationPlan(position) : buildDeployPlan(position)), [kind, position])
  const cfg = migrateConfig(env.chainId)
  const [phase, setPhase] = useState<Phase>({ k: 'demo' })
  const [plan, setPlan] = useState<MigrationPlan>(basePlan)
  const [readOnChain, setReadOnChain] = useState<MigrateFlow['readOnChain']>(null)
  const [promptIds, setPromptIds] = useState<string[] | null>(null)
  const resolved = useRef<ResolvedMigration | ResolvedDeploy | null>(null)
  const running = useRef(false)

  // ---- gate + read + pre-signature simulation, re-run whenever the wallet/chain changes
  useEffect(() => {
    let cancelled = false
    resolved.current = null
    setPlan(basePlan)
    setReadOnChain(null)
    setPromptIds(null)
    if (env.isDemo) return setPhase({ k: 'demo' })
    if (basePlan.blocked) return setPhase({ k: 'blocked', reason: basePlan.blocked })
    if (!cfg) {
      return setPhase({ k: 'wrong-chain', reason: `Your wallet is on ${env.chainLabel}, where Membrane has no deployment. Switch to a chain with one.` })
    }
    const ready = readiness(cfg, env.chainLabel, kind === 'migrate' ? basePlan.venue : null)
    if (!ready.ok) return setPhase({ k: 'no-deployment', reason: ready.reason })
    if (!env.publicClient || !env.address) return setPhase({ k: 'reading' })
    const client = env.publicClient
    const owner = env.address
    setPhase({ k: 'reading' })
    ;(async () => {
      try {
        if (kind === 'migrate') {
          const r = await resolveMigration(client, cfg, position, basePlan.venue!, owner)
          if (cancelled) return
          if ('error' in r) return setPhase({ k: 'blocked', reason: r.error })
          resolved.current = r
          const p = buildMigrationPlan(onchainSource(position, r, cfg.label), planOptsFor(r))
          setPlan(p)
          setReadOnChain({ block: r.blockNumber, chainLabel: cfg.label })
          setPromptIds(
            p.signatures
              .filter((s) => !(s.id === 'operator' && r.operatorGranted) && !(s.id === 'morpho-auth' && r.morphoAuthorized))
              .map((s) => s.id),
          )
          if (!p.trim && borrowLtvWad(r) > r.maxLtvWad) {
            return setPhase({ k: 'trim', reason: `The borrow would open at ${(Number(borrowLtvWad(r)) / 1e16).toFixed(2)}%, over the ${(Number(r.maxLtvWad) / 1e16).toFixed(2)}% cap checked on-chain. Repay a little on the venue first.` })
          }
          if (p.trim) return setPhase({ k: 'trim', reason: p.trim.reason })
          if (env.holdBeforeSimulate) return setPhase({ k: 'ready' })
          setPhase({ k: 'simulating' })
          const sim = await simulatePreSign(client, cfg, r)
          if (cancelled) return
          if (!sim.ok) return setPhase({ k: 'sim-failed', reason: explainRevert(sim.reason) })
          setPlan(buildMigrationPlan(onchainSource(position, r, cfg.label), { ...planOptsFor(r), gasSteps: sim.steps }))
          setPhase({ k: 'simulated', gas: sim.bufferedGas })
        } else {
          const d = await resolveDeploy(client, cfg, position, owner, basePlan.membrane.ltv)
          if (cancelled) return
          if ('error' in d) return setPhase({ k: 'blocked', reason: d.error })
          resolved.current = d
          const deployed = deploySource(position, d)
          setPlan(buildDeployPlan(deployed, { onchainMaxLtv: Number(d.maxLtvOnchainWad) / 1e18 }))
          setReadOnChain({ block: d.blockNumber, chainLabel: cfg.label })
          setPromptIds([...(d.allowance < d.depositWei ? ['approve'] : []), 'deposit', 'borrow'])
          if (env.holdBeforeSimulate) return setPhase({ k: 'ready' })
          setPhase({ k: 'simulating' })
          const sim = await simulateDeploy(client, cfg, d)
          if (cancelled) return
          if (!sim.ok) return setPhase({ k: 'sim-failed', reason: explainRevert(sim.reason) })
          setPlan(buildDeployPlan(deployed, { onchainMaxLtv: Number(d.maxLtvOnchainWad) / 1e18, gasSteps: sim.steps }))
          setPhase({ k: 'simulated', gas: sim.bufferedGas })
        }
      } catch (err) {
        if (!cancelled) setPhase({ k: 'blocked', reason: `Reading ${cfg.label} failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [env.isDemo, env.chainId, env.address, env.publicClient, env.chainLabel, env.holdBeforeSimulate, cfg, basePlan, kind, position])

  const start = useCallback(() => {
    if (running.current || phase.k !== 'simulated' || !cfg || !env.publicClient || !env.walletClient || !resolved.current) return
    running.current = true
    const onEvent = (e: RunEvent) => {
      if (e.kind === 'prompt') setPhase({ k: 'signing', id: e.id, index: e.index, total: e.total })
      if (e.kind === 'submitted') setPhase({ k: 'submitted', hash: e.hash, id: e.id })
    }
    const go =
      kind === 'migrate'
        ? runMigration({ client: env.publicClient, wallet: env.walletClient, cfg, source: position, r: resolved.current as ResolvedMigration, onEvent })
        : runDeploy({ client: env.publicClient, wallet: env.walletClient, cfg, d: resolved.current as ResolvedDeploy, onEvent })
    go.then(
      (res) =>
        setPhase(
          res.ok && res.bundleHash
            ? {
                k: 'settled',
                hash: res.bundleHash,
                revoke: kind === 'migrate' ? 'idle' : undefined,
                note:
                  res.sourceDebtAfter !== undefined && res.sourceDebtAfter > 0n
                    ? `The venue still shows ${res.sourceDebtAfter.toString()} base units of debt (dust). Repay it on the venue.`
                    : kind === 'migrate'
                      ? 'The venue debt reads 0 after the repay.'
                      : undefined,
              }
            : { k: 'failed', reason: explainRevert(res.reason ?? 'failed'), hash: res.bundleHash },
        ),
      (err) => setPhase({ k: 'failed', reason: explainRevert(err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err)), hash: null }),
    ).finally(() => {
      running.current = false
    })
  }, [phase.k, cfg, env.publicClient, env.walletClient, kind, position])

  /** OPTIONAL after settle: revoke the standing grants (not counted in the prompts). */
  const revoke = useCallback(() => {
    if (phase.k !== 'settled' || phase.revoke !== 'idle' || !cfg || !env.publicClient || !env.walletClient || !env.address) return
    const venue = basePlan.venue ?? 'aave-v3'
    setPhase({ ...phase, revoke: 'running' })
    runRevoke({ client: env.publicClient, wallet: env.walletClient, cfg, owner: env.address, venue }).then(
      (r) => setPhase({ ...phase, revoke: r.ok ? 'done' : 'failed' }),
      () => setPhase({ ...phase, revoke: 'failed' }),
    )
  }, [phase, cfg, env.publicClient, env.walletClient, env.address, basePlan.venue])

  useEffect(() => {
    if (env.autoStart && phase.k === 'simulated') start()
  }, [env.autoStart, phase.k, start])

  const addresses = useMemo(() => {
    if (!cfg) return []
    const rows: { label: string; address: string | null }[] =
      kind === 'migrate'
        ? [
            { label: 'Bundler3', address: cfg.bundler3 },
            { label: 'GeneralAdapter1 (flash loan)', address: cfg.generalAdapter1 },
            { label: 'Aave V3 migration adapter', address: cfg.aaveV3Adapter },
            { label: 'Membrane migration adapter', address: cfg.membraneAdapter },
            { label: 'Membrane Cdp', address: cfg.cdp },
          ]
        : [{ label: 'Membrane Cdp', address: cfg.cdp }]
    return rows.map((r) => ({ label: r.label, address: r.address ?? 'not deployed' }))
  }, [cfg, kind])

  useEffect(() => {
    if (env.autoRevoke && phase.k === 'settled' && phase.revoke === 'idle') revoke()
  }, [env.autoRevoke, phase, revoke])

  return { env, plan, readOnChain, phase, start, revoke, promptIds, addresses }
}

/** The deploy prefill as it will land: the deposit (capped at the wallet) at Membrane's price. */
function deploySource(position: MigrateSource, d: ResolvedDeploy): MigrateSource {
  const scale = 10 ** d.collateralDecimals
  const amount = Number(d.depositWei) / scale
  const price = Number(d.membranePriceWad / 10n ** 12n) / 1e6
  const value = amount * price
  const borrow = Number(d.borrowCdt / 10n ** 18n)
  const c0 = position.collateral[0]
  return {
    ...position,
    collateral: [{ ...c0, amount, priceUsd: price, valueUsd: value }],
    totalCollateralUsd: value,
    totalDebtUsd: borrow,
    ltv: value > 0 ? borrow / value : 0,
  }
}
