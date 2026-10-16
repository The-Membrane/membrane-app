// The order slip's engine: the re-read and re-solve, the simulation, the chain switch and
// the signature, wired to wagmi. Every decision about what the slip shows and which button
// it offers is lib/position-exec/sheet.ts (pure, unit-tested); this hook only feeds it.
//
// Reads and the simulation go through the page's own read-only mainnet client
// (lib/position-sim/rpc.ts). The wallet is used for two things only: switching to
// Ethereum, and signing the batch the slip shows, from the position's owner, on chain 1.

import { useCallback, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, useConfig, useSwitchChain } from 'wagmi'
import { getAccount, getWalletClient } from 'wagmi/actions'

import { getAtomicStatus } from '@/services/chain/atomicBatch'
import { runEvmCalls, TxRevertedError } from '@/services/chain/txRunner'
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
import { simulateLever, type SimResult } from '@/lib/position-exec/simulate'
import { fmtAmount } from '@/lib/position/format'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import { ADAPTERS, runAdapter } from '@/lib/position-sim/adapters'
import { getMainnetClient } from '@/lib/position-sim/rpc'

import { prepareLever, type LeverIntent, type Prepared, type PreparedLever } from './leverExec'

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
  sign: () => void
  switchChain: () => void
  retry: () => void
}

export function useLeverExec(intent: LeverIntent, onSettled: () => void): LeverExec {
  const config = useConfig()
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [attempt, setAttempt] = useState(0)
  const [tx, dispatch] = useReducer(txReducer, TX_IDLE)
  // One wallet request at a time: a second click lands before React re-renders the button.
  const inFlight = useRef(false)

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
    if (readTooOld(prep.dataUpdatedAt, Date.now())) {
      dispatch({ type: 'expired' })
      setAttempt((a) => a + 1)
      return
    }
    inFlight.current = true
    dispatch({ type: 'sign', total: ready.calls.length })
    try {
      let walletClient: Awaited<ReturnType<typeof getWalletClient>>
      try {
        // Asserts the connector is on chain 1 and holds the owner's account.
        walletClient = await getWalletClient(config, {
          chainId: ETHEREUM_CHAIN_ID,
          account: intent.owner,
        })
        // An atomic EIP-5792 batch is one signature for every call (txRunner's top rung).
        if (
          ready.calls.length > 1 &&
          (await getAtomicStatus(walletClient, ETHEREUM_CHAIN_ID)) !== 'unsupported'
        ) {
          dispatch({ type: 'total', total: 1 })
        }
      } catch (err) {
        dispatch({ type: 'failed', message: revertReason(err), minedRevert: false })
        return
      }
      const res = await runEvmCalls({
        msgs: ready.calls,
        address: intent.owner,
        walletClient,
        publicClient: getMainnetClient(),
        onApproved: () => dispatch({ type: 'signed' }),
      })
      dispatch({ type: 'settled', hash: res.transactionHash as `0x${string}` })
      onSettled()
    } catch (err) {
      if (isUserRejection(err)) dispatch({ type: 'declined' })
      else if (err instanceof TxRevertedError) {
        dispatch({
          type: 'failed',
          message: err.message,
          minedRevert: true,
          hash: err.transactionHash as `0x${string}`,
        })
      } else
        dispatch({
          type: 'failed',
          message: namedRevert(revertReason(err), venueOf(intent.protocol)),
          minedRevert: false,
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
          ? { type: 'declined' }
          : { type: 'failed', message: revertReason(err), minedRevert: false },
      )
    } finally {
      inFlight.current = false
    }
  }, [switchChainAsync])

  const retry = useCallback(() => {
    dispatch({ type: 'reset' })
    setAttempt((a) => a + 1)
  }, [])

  return {
    prepared: prep.data ?? null,
    sim: simResult,
    sheet,
    txHash: tx.phase === 'settled' || tx.phase === 'failed' ? tx.hash : null,
    busy: tx.phase === 'submitted' || tx.phase === 'pending' || tx.phase === 'switching',
    sign: () => void sign(),
    switchChain: () => void switchChain(),
    retry,
  }
}
