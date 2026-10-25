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
  runMigrationBatch,
  runRevoke,
  batchCallsFor,
  simulateBatch,
  detectAtomic,
  deployPathFor,
  type DeployPath,
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
  | { k: 'wrong-chain'; reason: string; detail?: string }
  | { k: 'no-deployment'; reason: string; detail?: string }
  | { k: 'blocked'; reason: string; detail?: string }
  | { k: 'reading' }
  | { k: 'ready' }
  | { k: 'trim'; reason: string; detail?: string }
  | { k: 'simulating' }
  | { k: 'simulated'; gas: bigint }
  | { k: 'sim-failed'; reason: string; detail?: string }
  | { k: 'signing'; id: string; index: number; total: number }
  | { k: 'submitted'; hash: `0x${string}`; id: string }
  | { k: 'settled'; hash: `0x${string}`; note?: string; revoke?: 'idle' | 'running' | 'done' | 'failed' }
  | { k: 'failed'; reason: string; detail?: string; hash: `0x${string}` | null }

/** ≤ 12 words: the custom error in plain language, with its name. Unknown reasons are cut to 12
 *  words; the full text goes to Details via the phase's `detail`. */
export function explainRevert(reason: string): string {
  const named: [RegExp, string][] = [
    [/InsolventAfterAction|PositionUnsolventPostOp/, 'Membrane refuses this LTV. Repay a little first.'],
    [/LtvAboveCap/, 'Over the on-chain LTV cap. Repay a little first.'],
    [/NotOperator/, 'Adapter not granted yet.'],
    [/PayoutMismatch/, 'Membrane payout differed; nothing moved.'],
    [/NotPegPaired|TransmuterNotWired/, 'Membrane here can’t pay out USDC.'],
    [/User rejected|denied/i, 'Wallet prompt rejected.'],
  ]
  const hit = named.find(([re]) => re.test(reason))
  if (hit) return hit[1]
  const words = reason.split(/\s+/).filter(Boolean)
  return words.length <= 12 ? reason : `${words.slice(0, 11).join(' ')}…`
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
  const deployPath = useRef<DeployPath>('direct')
  // EIP-5792: ask the wallet once per wallet/chain; a harness may pin it
  const [atomic, setAtomic] = useState<boolean | null>(null)
  useEffect(() => {
    let off = false
    setAtomic(null)
    if (env.atomic !== undefined) {
      setAtomic(env.atomic)
      return
    }
    if (env.isDemo || !env.walletClient) {
      setAtomic(false)
      return
    }
    detectAtomic(env.walletClient, env.chainId).then((a) => !off && setAtomic(a))
    return () => {
      off = true
    }
  }, [env.atomic, env.isDemo, env.walletClient, env.chainId])
  const running = useRef(false)

  // ---- gate + read + pre-signature simulation, re-run whenever the wallet/chain changes
  useEffect(() => {
    let cancelled = false
    resolved.current = null
    setPlan(basePlan)
    setReadOnChain(null)
    setPromptIds(null)
    if (env.isDemo) return setPhase({ k: 'demo' })
    if (basePlan.blocked) return setPhase({ k: 'blocked', reason: basePlan.blockedShort ?? basePlan.blocked, detail: basePlan.blocked })
    if (!cfg) {
      return setPhase({
        k: 'wrong-chain',
        reason: `Wallet on ${env.chainLabel}. Switch to a Membrane network.`,
        detail: `Your wallet is on ${env.chainLabel}, where Membrane has no deployment.`,
      })
    }
    const ready = readiness(cfg, env.chainLabel, kind === 'migrate' ? basePlan.venue : null)
    if (!ready.ok) {
      return setPhase({ k: 'no-deployment', reason: cfg.chainId === 1 ? 'Not on mainnet yet' : 'No Membrane here yet', detail: ready.reason })
    }
    if (!env.publicClient || !env.address || atomic === null) return setPhase({ k: 'reading' })
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
          const p = buildMigrationPlan(onchainSource(position, r, cfg.label), { ...planOptsFor(r), atomic })
          setPlan(p)
          setReadOnChain({ block: r.blockNumber, chainLabel: cfg.label })
          setPromptIds(
            atomic
              ? ['batch']
              : p.signatures
                  .filter((s) => !(s.id === 'operator' && r.operatorGranted) && !(s.id === 'morpho-auth' && r.morphoAuthorized))
                  .map((s) => s.id),
          )
          if (!p.trim && borrowLtvWad(r) > r.maxLtvWad) {
            return setPhase({
              k: 'trim',
              reason: 'Over the on-chain LTV cap. Repay a little first.',
              detail: `The borrow would open at ${(Number(borrowLtvWad(r)) / 1e16).toFixed(2)}%, over the ${(Number(r.maxLtvWad) / 1e16).toFixed(2)}% cap the adapter checks on-chain.`,
            })
          }
          if (p.trim) return setPhase({ k: 'trim', reason: p.trim.short, detail: p.trim.reason })
          if (env.holdBeforeSimulate) return setPhase({ k: 'ready' })
          setPhase({ k: 'simulating' })
          const sim = atomic ? await simulateBatch(client, owner, batchCallsFor(cfg, r)) : await simulatePreSign(client, cfg, r)
          if (cancelled) return
          if (!sim.ok) return setPhase({ k: 'sim-failed', reason: explainRevert(sim.reason), detail: sim.reason })
          setPlan(buildMigrationPlan(onchainSource(position, r, cfg.label), { ...planOptsFor(r), atomic, gasSteps: sim.steps }))
          setPhase({ k: 'simulated', gas: sim.bufferedGas })
        } else {
          const d = await resolveDeploy(client, cfg, position, owner, basePlan.membrane.ltv)
          if (cancelled) return
          if ('error' in d) return setPhase({ k: 'blocked', reason: d.error })
          resolved.current = d
          const deployed = deploySource(position, d)
          const path = deployPathFor(d, atomic)
          deployPath.current = path
          setPlan(buildDeployPlan(deployed, { onchainMaxLtv: Number(d.maxLtvOnchainWad) / 1e18, deployPath: path }))
          setReadOnChain({ block: d.blockNumber, chainLabel: cfg.label })
          setPromptIds(
            path === 'batch-router'
              ? ['batch']
              : path === 'router'
                ? [...(d.routerAllowance < d.depositWei ? ['approve'] : []), 'router']
                : [...(d.allowance < d.depositWei ? ['approve'] : []), 'deposit', 'borrow'],
          )
          if (env.holdBeforeSimulate) return setPhase({ k: 'ready' })
          setPhase({ k: 'simulating' })
          const sim = await simulateDeploy(client, cfg, d, path)
          if (cancelled) return
          if (!sim.ok) return setPhase({ k: 'sim-failed', reason: explainRevert(sim.reason), detail: sim.reason })
          setPlan(buildDeployPlan(deployed, { onchainMaxLtv: Number(d.maxLtvOnchainWad) / 1e18, deployPath: path, gasSteps: sim.steps }))
          setPhase({ k: 'simulated', gas: sim.bufferedGas })
        }
      } catch (err) {
        if (!cancelled) setPhase({ k: 'blocked', reason: `Reading ${cfg.label} failed. Try again.`, detail: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [env.isDemo, env.chainId, env.address, env.publicClient, env.chainLabel, env.holdBeforeSimulate, atomic, cfg, basePlan, kind, position])

  const start = useCallback(() => {
    if (running.current || phase.k !== 'simulated' || !cfg || !env.publicClient || !env.walletClient || !resolved.current) return
    running.current = true
    const onEvent = (e: RunEvent) => {
      if (e.kind === 'prompt') setPhase({ k: 'signing', id: e.id, index: e.index, total: e.total })
      if (e.kind === 'submitted') setPhase({ k: 'submitted', hash: e.hash, id: e.id })
    }
    const go =
      kind === 'migrate'
        ? atomic
          ? runMigrationBatch({ client: env.publicClient, wallet: env.walletClient, cfg, source: position, r: resolved.current as ResolvedMigration, onEvent, send: env.sendBatch })
          : runMigration({ client: env.publicClient, wallet: env.walletClient, cfg, source: position, r: resolved.current as ResolvedMigration, onEvent })
        : runDeploy({ client: env.publicClient, wallet: env.walletClient, cfg, d: resolved.current as ResolvedDeploy, path: deployPath.current, onEvent, send: env.sendBatch })
    go.then(
      (res) =>
        setPhase(
          res.ok && res.bundleHash
            ? {
                k: 'settled',
                hash: res.bundleHash,
                // the atomic batch revokes its own grants; nothing is left to revoke
                revoke: kind === 'migrate' && !atomic ? 'idle' : undefined,
                note:
                  res.sourceDebtAfter !== undefined && res.sourceDebtAfter > 0n
                    ? `Venue dust debt left: ${res.sourceDebtAfter.toString()} units. Repay it there.`
                    : undefined,
              }
            : { k: 'failed', reason: explainRevert(res.reason ?? 'failed'), detail: res.reason, hash: res.bundleHash },
        ),
      (err) => {
        const msg = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err)
        setPhase({ k: 'failed', reason: explainRevert(msg), detail: msg, hash: null })
      },
    ).finally(() => {
      running.current = false
    })
  }, [phase.k, cfg, env.publicClient, env.walletClient, env.sendBatch, kind, position, atomic])

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
