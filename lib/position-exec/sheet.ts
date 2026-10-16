/**
 * THE SHEET'S STATE MACHINE. Pure: the re-read, the wallet and the transaction in; the
 * stamp, the checks, the one button and the named notice out. No React, so
 * tests/unit/positionExecSheet.test.ts walks every state.
 *
 * The rows ("If you repay 460 USDC", the new line, the new chance) never depend on the
 * wallet: they show in every state. Only the button changes:
 *
 *   reading            Reading…                         disabled
 *   read failed        Read again                       the error, named
 *   lever gone         Close                            why it no longer applies
 *   venue / balance    <Verb> unavailable               the first failing gate, named
 *   no wallet          Connect wallet                   V20: the sheet re-opens after connect
 *   other wallet       Wrong wallet                     "Connect the wallet that holds this
 *                                                       position (0x…)": one address never
 *                                                       acts on another's position
 *   other chain        Switch to Ethereum               useSwitchChain
 *   simulating         Simulating…                      disabled
 *   would revert       Read again                       the step and its reason
 *   ready              Repay 460 USDC                   signs; a read over 2 minutes old
 *                                                       is read and simulated again first
 *   submitted          Confirm in your wallet           stamp SUBMITTED
 *   pending            Pending n/N                      stamp PENDING n/N
 *   still waiting      Dismiss (after the explorer)     stamp PENDING n/N · STILL WAITING; a
 *                                                       slow receipt is never a failure
 *   replaced           Read again                       stamp REPLACED: it did not happen
 *   settled            Close                            stamp SETTLED, the tx link
 *   failed             Read again                       stamp FAILED (· GAS SPENT when a
 *                                                       call was mined)
 *
 * The stamps are the ledger slip's (owner ruling T31): DRAFT → SUBMITTED → PENDING n/N →
 * SETTLED, or FAILED · GAS SPENT.
 */

import type { Gate } from './gates'
import type { SimResult } from './simulate'

export const ETHEREUM_CHAIN_ID = 1

export interface WalletState {
  connected: boolean
  address: string | null
  chainId: number | null
}

type Hash = `0x${string}`

export type TxState =
  /** `notice`: why the last attempt stopped before any call was sent (declined, switch failed). */
  | { phase: 'idle'; notice?: string }
  | { phase: 'switching' }
  | { phase: 'submitted'; signed: number; total: number }
  | {
      phase: 'pending'
      signed: number
      total: number
      /** The latest call's hash; null for an atomic batch until it lands. */
      hash: Hash | null
      /** viem stopped waiting and the watch goes on: the call can still land. */
      waiting: boolean
      /** The reader opened the explorer while waiting, so may dismiss the slip. */
      checked: boolean
    }
  | { phase: 'settled'; hash: Hash }
  | {
      phase: 'failed'
      /** reverted: mined and reverted; replaced: the wallet replaced or cancelled it; stopped: anything else. */
      kind: 'reverted' | 'replaced' | 'stopped'
      message: string
      gasSpent: boolean
      hash: Hash | null
    }

export type TxEvent =
  | { type: 'switch' }
  | { type: 'switched' }
  | { type: 'sign'; total: number }
  /** The runner chose its path: this many signatures (1 for an atomic batch). */
  | { type: 'path'; total: number }
  | { type: 'signed'; hash: Hash | null }
  /** viem's wait timed out; the watch continues on the same hash or batch. */
  | { type: 'waiting' }
  /** A call landed: no longer waiting on it. */
  | { type: 'landed' }
  /** The reader opened the explorer while waiting. */
  | { type: 'checked' }
  | { type: 'settled'; hash: Hash }
  /** Declined in the wallet after `landed` calls had landed; `message` names what stands. */
  | { type: 'declined'; landed: number; message?: string }
  | {
      type: 'failed'
      kind: 'reverted' | 'replaced' | 'stopped'
      message: string
      gasSpent: boolean
      hash?: Hash | null
    }
  | { type: 'reset' }
  /** The read was too old to sign on: the slip reads again first. */
  | { type: 'expired' }
  /** A fresh read landed: an idle notice about the old one no longer applies. */
  | { type: 'fresh' }

export const TX_IDLE: TxState = { phase: 'idle' }

/**
 * A slip signs only what it read recently: past this age (counted from the read's BLOCK
 * time) a click on the sign button reads and simulates again instead, and the reader
 * signs the fresh slip.
 */
export const MAX_READ_AGE_MS = 120_000

export const readTooOld = (readAtMs: number, nowMs: number): boolean =>
  nowMs - readAtMs > MAX_READ_AGE_MS

export function txReducer(s: TxState, e: TxEvent): TxState {
  switch (e.type) {
    case 'reset':
      return TX_IDLE
    case 'expired':
      return s.phase === 'idle'
        ? { phase: 'idle', notice: 'Reading again: the last read was over 2 minutes old' }
        : s
    case 'fresh':
      return s.phase === 'idle' && s.notice ? TX_IDLE : s
    case 'switch':
      return s.phase === 'idle' ? { phase: 'switching' } : s
    case 'switched':
      return s.phase === 'switching' ? TX_IDLE : s
    case 'sign':
      return s.phase === 'idle' ? { phase: 'submitted', signed: 0, total: Math.max(1, e.total) } : s
    case 'path':
      return s.phase === 'submitted' && s.signed === 0 ? { ...s, total: Math.max(1, e.total) } : s
    case 'signed': {
      if (s.phase !== 'submitted' && s.phase !== 'pending') return s
      const signed = s.signed + 1
      return {
        phase: 'pending',
        signed,
        total: Math.max(s.total, signed),
        hash: e.hash,
        waiting: false,
        checked: false,
      }
    }
    case 'waiting':
      return s.phase === 'pending' ? { ...s, waiting: true } : s
    case 'landed':
      return s.phase === 'pending' ? { ...s, waiting: false, checked: false } : s
    case 'checked':
      return s.phase === 'pending' && s.waiting ? { ...s, checked: true } : s
    case 'settled':
      return { phase: 'settled', hash: e.hash }
    case 'declined': {
      if (s.phase === 'switching')
        return { phase: 'idle', notice: 'Switch declined in your wallet' }
      // Declined before anything landed: nothing happened, the slip stands.
      if (e.landed === 0) return { phase: 'idle', notice: 'Declined in your wallet' }
      return {
        phase: 'failed',
        kind: 'stopped',
        message:
          e.message ??
          `Declined in your wallet after ${e.landed} step${e.landed === 1 ? '' : 's'} landed`,
        gasSpent: true,
        hash: null,
      }
    }
    case 'failed':
      if (s.phase === 'switching') return { phase: 'idle', notice: `Switch failed: ${e.message}` }
      return {
        phase: 'failed',
        kind: e.kind,
        message: e.message,
        gasSpent: e.gasSpent,
        hash: e.hash ?? null,
      }
  }
}

export type SimState =
  | { status: 'skipped' }
  | { status: 'running' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: SimResult }

export type PrepState =
  | { status: 'reading' }
  | { status: 'error'; message: string }
  | { status: 'gone'; reason: string }
  | {
      status: 'ready'
      gates: Gate[]
      sim: SimState
      /** "Repay" / "Add" */
      verb: string
      /** "460 USDC" */
      what: string
      /** The batch's length, for PENDING n/N. */
      steps: number
    }

export interface Check {
  id: string
  /** null while it is still being decided. */
  ok: boolean | null
  text: string
}

export type ButtonKind = 'connect' | 'switch' | 'sign' | 'retry' | 'close' | 'wait' | 'dismiss'

export interface SheetView {
  stamp: string
  checks: Check[]
  button: { kind: ButtonKind; label: string; enabled: boolean }
  /** The first thing in the way, named; null when nothing is. */
  notice: string | null
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The wallet's three gates, in the order they can be fixed. */
export function walletChecks(w: WalletState, owner: string): Check[] {
  if (!w.connected || !w.address) return [{ id: 'wallet', ok: false, text: 'Wallet not connected' }]
  const checks: Check[] = [{ id: 'wallet', ok: true, text: `Wallet ${short(w.address)}` }]
  if (!sameAddress(w.address, owner)) {
    checks.push({
      id: 'owner',
      ok: false,
      text: `Connect the wallet that holds this position (${short(owner)})`,
    })
    return checks
  }
  checks.push({ id: 'owner', ok: true, text: 'This wallet holds the position' })
  checks.push(
    w.chainId === ETHEREUM_CHAIN_ID
      ? { id: 'chain', ok: true, text: 'Wallet on Ethereum' }
      : {
          id: 'chain',
          ok: false,
          text: `Wallet on chain ${w.chainId ?? 'unknown'}; this position is on Ethereum`,
        },
  )
  return checks
}

function simCheck(sim: SimState): Check | null {
  switch (sim.status) {
    case 'skipped':
      return null
    case 'running':
      return { id: 'sim', ok: null, text: 'Simulating…' }
    case 'error':
      return { id: 'sim', ok: false, text: `Simulation unavailable: ${sim.message}` }
    case 'done':
      return sim.result.ok
        ? { id: 'sim', ok: true, text: `Simulation passes · ${sim.result.method}` }
        : {
            id: 'sim',
            ok: false,
            text: `Step ${sim.result.step + 1} would revert: ${sim.result.reason}`,
          }
  }
}

function stampOf(tx: TxState): string {
  switch (tx.phase) {
    case 'settled':
      return 'SETTLED'
    case 'failed':
      return tx.kind === 'replaced' ? 'REPLACED' : tx.gasSpent ? 'FAILED · GAS SPENT' : 'FAILED'
    case 'pending':
      return `PENDING ${tx.signed}/${tx.total}${tx.waiting ? ' · STILL WAITING' : ''}`
    case 'submitted':
      return 'SUBMITTED'
    default:
      return 'DRAFT'
  }
}

export function sheetView(
  prep: PrepState,
  wallet: WalletState,
  tx: TxState,
  owner: string,
): SheetView {
  const stamp = stampOf(tx)
  const venueChecks: Check[] =
    prep.status === 'ready' ? prep.gates.map((g) => ({ id: g.id, ok: g.ok, text: g.text })) : []
  const wChecks = walletChecks(wallet, owner)
  const sim = prep.status === 'ready' ? simCheck(prep.sim) : null
  const checks = [...venueChecks, ...wChecks, ...(sim ? [sim] : [])]
  const view = (button: SheetView['button'], notice: string | null): SheetView => ({
    stamp,
    checks,
    button,
    notice,
  })

  // A transaction in flight or finished owns the slip.
  if (tx.phase === 'settled') return view({ kind: 'close', label: 'Close', enabled: true }, null)
  if (tx.phase === 'failed')
    return view({ kind: 'retry', label: 'Read again', enabled: true }, tx.message)
  if (tx.phase === 'submitted')
    return view({ kind: 'wait', label: 'Confirm in your wallet', enabled: false }, null)
  if (tx.phase === 'pending' && tx.waiting) {
    // Not a failure: the call can still land, so the slip offers no second signature. It
    // can be dismissed only after the reader has looked the transaction up.
    return view(
      tx.checked
        ? { kind: 'dismiss', label: 'Dismiss: I checked the explorer', enabled: true }
        : { kind: 'wait', label: 'Still waiting · open the explorer to dismiss', enabled: false },
      'Not confirmed yet. Still watching it; do not sign this again.',
    )
  }
  if (tx.phase === 'pending')
    return view({ kind: 'wait', label: `Pending ${tx.signed}/${tx.total}`, enabled: false }, null)
  if (tx.phase === 'switching')
    return view({ kind: 'wait', label: 'Switch in your wallet', enabled: false }, null)

  if (prep.status === 'reading')
    return view({ kind: 'wait', label: 'Reading…', enabled: false }, null)
  if (prep.status === 'error')
    return view({ kind: 'retry', label: 'Read again', enabled: true }, prep.message)
  if (prep.status === 'gone')
    return view({ kind: 'close', label: 'Close', enabled: true }, prep.reason)

  const blocked = prep.gates.find((g) => !g.ok)
  if (blocked)
    return view({ kind: 'wait', label: `${prep.verb} unavailable`, enabled: false }, blocked.text)

  const declined = tx.phase === 'idle' ? (tx.notice ?? null) : null
  const wallet0 = wChecks.find((c) => c.ok === false)
  if (wallet0?.id === 'wallet')
    return view({ kind: 'connect', label: 'Connect wallet', enabled: true }, null)
  if (wallet0?.id === 'owner')
    return view({ kind: 'wait', label: 'Wrong wallet', enabled: false }, wallet0.text)
  if (wallet0?.id === 'chain')
    return view(
      { kind: 'switch', label: 'Switch to Ethereum', enabled: true },
      declined ?? wallet0.text,
    )

  if (prep.sim.status === 'running' || prep.sim.status === 'skipped') {
    return view({ kind: 'wait', label: 'Simulating…', enabled: false }, null)
  }
  if (prep.sim.status === 'error')
    return view({ kind: 'retry', label: 'Read again', enabled: true }, sim?.text ?? null)
  if (!prep.sim.result.ok)
    return view({ kind: 'retry', label: 'Read again', enabled: true }, sim?.text ?? null)

  return view({ kind: 'sign', label: `${prep.verb} ${prep.what}`, enabled: true }, declined)
}
