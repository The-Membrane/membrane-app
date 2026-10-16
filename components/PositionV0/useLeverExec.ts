// The order slip's engine: the re-read and re-solve, the simulation, the chain switch and
// the signature, wired to wagmi. Every decision about what the slip shows and which button
// it offers is lib/position-exec/sheet.ts (pure, unit-tested); this hook only feeds it.
//
// Reads and the simulation go through the page's own read-only mainnet client
// (lib/position-sim/rpc.ts). The wallet is used for two things only: switching to
// Ethereum, and signing the batch the slip shows, from the position's owner, on chain 1.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, useConfig, useSwitchChain } from 'wagmi'
import { getAccount, getWalletClient } from 'wagmi/actions'

import { getAtomicStatus } from '@/services/chain/atomicBatch'
import { isUserRejection, namedRevert, revertReason } from '@/lib/position-exec/revert'
import {
  ETHEREUM_CHAIN_ID,
  TX_IDLE,
  readTooOld,
  sameAddress,
  sheetView,
  txReducer,
  type PrepState,
  type SheetView,
  type SimState,
} from '@/lib/position-exec/sheet'
import {
  runLever,
  RunStopped,
  standingApproval,
  type RunPublic,
  type RunWallet,
} from '@/lib/position-exec/run'
import { simulateLever, type SimResult } from '@/lib/position-exec/simulate'
import { fmtAmount } from '@/lib/position/format'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import { ADAPTERS, runAdapter } from '@/lib/position-sim/adapters'
import { getMainnetClient } from '@/lib/position-sim/rpc'

import {
  joinNotice,
  prepareLever,
  replayReason,
  standingNotice,
  type LeverIntent,
  type Prepared,
  type PreparedLever,
} from './leverExec'
import { PROTOCOL_SHORT } from './viewModel'

const venueOf = (p: LeverIntent['protocol']): 'aave' | 'compound' | 'morpho' =>
  p === 'compound-v3' ? 'compound' : p === 'morpho-blue' ? 'morpho' : 'aave'

const readAdapter = (protocol: LeverIntent['protocol'], owner: `0x${string}`) => {
  const adapter = ADAPTERS.find((a) => a.id === protocol)
  if (!adapter) throw new Error(`no reader for ${protocol}`)
  return runAdapter(adapter, owner)
}

const QUERY = {
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 0,
  refetchOnWindowFocus: false,
} as const

export interface LeverExec {
  prepared: Prepared | null
  sim: SimResult | null
  sheet: SheetView
  /** The hash a settled, or a mined-and-reverted, transaction left. */
  txHash: `0x${string}` | null
  /** A wallet request is open: the slip cannot be closed under it. */
  busy: boolean
  /** The reader opened the explorer while a transaction is still waiting. */
  checked: () => void
  sign: () => void
  switchChain: () => void
  retry: () => void
}

export function useLeverExec(
  intent: LeverIntent,
  onSettled: (owner: `0x${string}`) => void,
): LeverExec {
  const config = useConfig()
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [attempt, setAttempt] = useState(0)
  const [tx, dispatch] = useReducer(txReducer, TX_IDLE)
  // One wallet request at a time: a second click lands before React re-renders the button.
  const inFlight = useRef(false)
  // The watch on a slow transaction stops when the slip is gone.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const prep = useQuery({
    queryKey: ['position-lever', intent.openedAt, attempt],
    queryFn: () =>
      prepareLever(intent, { readAdapter, client: getMainnetClient(), table: TOUCH_TABLE }),
    ...QUERY,
  })
  const ready: PreparedLever | null = prep.data?.kind === 'ready' ? prep.data : null
  const gatesPass = ready !== null && ready.gates.every((g) => g.ok)

  const sim = useQuery({
    queryKey: ['position-lever-sim', intent.openedAt, attempt],
    queryFn: () => simulateLever(getMainnetClient(), intent.owner, ready!.calls),
    enabled: gatesPass,
    ...QUERY,
  })

  const simResult: SimResult | null = useMemo(
    () =>
      sim.data
        ? sim.data.ok
          ? sim.data
          : { ...sim.data, reason: namedRevert(sim.data.reason, venueOf(intent.protocol)) }
        : null,
    [sim.data, intent.protocol],
  )
  const simState: SimState = !gatesPass
    ? { status: 'skipped' }
    : sim.isError
      ? { status: 'error', message: (sim.error as Error).message }
      : simResult
        ? { status: 'done', result: simResult }
        : { status: 'running' }

  const prepState: PrepState = prep.isError
    ? { status: 'error', message: (prep.error as Error).message }
    : !prep.data
      ? { status: 'reading' }
      : prep.data.kind === 'gone'
        ? { status: 'gone', reason: prep.data.reason }
        : {
            status: 'ready',
            gates: prep.data.gates,
            sim: simState,
            verb: prep.data.row.kind === 'repay' ? 'Repay' : 'Add',
            what: `${fmtAmount(prep.data.row.amount, prep.data.row.amountDecimals)} ${prep.data.leg.symbol}`,
            steps: prep.data.calls.length,
          }

  const sheet = sheetView(
    prepState,
    { connected: isConnected, address: address ?? null, chainId: chainId ?? null },
    tx,
    intent.owner,
  )

  const sign = useCallback(async () => {
    if (inFlight.current || !ready || !simResult?.ok || sheet.button.kind !== 'sign') return
    // Checked again against wagmi's own state at the moment of the click, not the last render.
    const now = getAccount(config)
    if (!sameAddress(now.address, intent.owner) || now.chainId !== ETHEREUM_CHAIN_ID) return
    // A stale slip is read and simulated again; the reader signs the fresh one.
    if (readTooOld(ready.blockTime ?? prep.dataUpdatedAt, Date.now())) {
      dispatch({ type: 'expired' })
      setAttempt((a) => a + 1)
      return
    }
    inFlight.current = true
    const calls = ready.calls
    const venue = PROTOCOL_SHORT[intent.protocol]
    const standing = (landed: number) =>
      standingNotice(
        standingApproval(calls, landed),
        ready.leg.symbol,
        ready.read.decimals,
        venue,
        ready.row.kind,
      )
    dispatch({ type: 'sign', total: calls.length })
    let landed = 0
    try {
      // Asserts the connector is on chain 1 and holds the owner's account.
      const walletClient = await getWalletClient(config, {
        chainId: ETHEREUM_CHAIN_ID,
        account: intent.owner,
      })
      const atomicStatus =
        calls.length > 1 ? await getAtomicStatus(walletClient, ETHEREUM_CHAIN_ID) : 'unsupported'
      const out = await runLever({
        calls,
        owner: intent.owner,
        wallet: walletClient as unknown as RunWallet,
        client: getMainnetClient() as unknown as RunPublic,
        atomicStatus,
        alive: () => alive.current,
        emit: (e) => {
          if (e.type === 'path') dispatch({ type: 'path', total: e.total })
          else if (e.type === 'signed') dispatch({ type: 'signed', hash: e.hash })
          else if (e.type === 'waiting') dispatch({ type: 'waiting' })
          else {
            landed = e.index + 1
            dispatch({ type: 'landed' })
          }
        },
      })
      if (out.kind === 'settled') {
        dispatch({ type: 'settled', hash: out.hash })
        onSettled(intent.owner)
      } else if (out.kind === 'replaced') {
        dispatch({
          type: 'failed',
          kind: 'replaced',
          message: joinNotice(
            `Replaced in your wallet: this ${ready.row.kind === 'repay' ? 'repay' : 'top-up'} did not happen`,
            standing(out.landed),
          ),
          gasSpent: out.landed > 0,
          hash: out.hash,
        })
      } else {
        const reason = out.hash
          ? await replayReason(calls[out.index], intent.owner, venueOf(intent.protocol))
          : null
        dispatch({
          type: 'failed',
          kind: 'reverted',
          message: joinNotice(
            `Step ${out.index + 1} of ${calls.length} reverted${reason ? `: ${reason}` : ''}. Your position is unchanged`,
            standing(out.landed),
          ),
          gasSpent: out.gasSpent,
          hash: out.hash,
        })
      }
    } catch (err) {
      const cause = err instanceof RunStopped ? err.cause : err
      const done = err instanceof RunStopped ? err.landed : landed
      if (isUserRejection(cause))
        dispatch({
          type: 'declined',
          landed: done,
          message: joinNotice('Declined in your wallet', standing(done)),
        })
      else
        dispatch({
          type: 'failed',
          kind: 'stopped',
          message: joinNotice(
            namedRevert(revertReason(cause), venueOf(intent.protocol)),
            standing(done),
          ),
          gasSpent: done > 0,
        })
    } finally {
      inFlight.current = false
    }
  }, [config, intent, ready, simResult, sheet.button.kind, onSettled, prep.dataUpdatedAt])

  const switchChain = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    dispatch({ type: 'switch' })
    try {
      await switchChainAsync({ chainId: ETHEREUM_CHAIN_ID })
      dispatch({ type: 'switched' })
    } catch (err) {
      dispatch(
        isUserRejection(err)
          ? { type: 'declined', landed: 0 }
          : { type: 'failed', kind: 'stopped', message: revertReason(err), gasSpent: false },
      )
    } finally {
      inFlight.current = false
    }
  }, [switchChainAsync])

  const retry = useCallback(() => {
    dispatch({ type: 'reset' })
    setAttempt((a) => a + 1)
  }, [])

  // A fresh read clears a notice about the previous one.
  useEffect(() => {
    if (prep.dataUpdatedAt) dispatch({ type: 'fresh' })
  }, [prep.dataUpdatedAt])

  const pendingHash = tx.phase === 'pending' ? tx.hash : null
  return {
    prepared: prep.data ?? null,
    sim: simResult,
    sheet,
    txHash: tx.phase === 'settled' || tx.phase === 'failed' ? tx.hash : pendingHash,
    busy: tx.phase === 'submitted' || tx.phase === 'pending' || tx.phase === 'switching',
    checked: () => dispatch({ type: 'checked' }),
    sign: () => void sign(),
    switchChain: () => void switchChain(),
    retry,
  }
}
