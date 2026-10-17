// DESIGN STATES for the order slip (pages/dev/slip-states.tsx). Every state is built from
// a REAL read captured by scripts/position/capture-slip-fixtures.ts (slipFixtures.json):
// the page's own prepareLever and simulateLever on real mainnet borrowers. The slip's
// sheet is then computed by the real state machine (lib/position-exec/sheet.ts) and the
// real gates (gates.ts). Where a state cannot be found on chain today (a paused reserve,
// Spark stable-rate debt, a transaction outcome), the forced input is named in `forced`.
// Dev only: no wallet, nothing signed.

import type { LeverChainRead } from '@/lib/position-exec/read'
import {
  sheetView,
  txReducer,
  TX_IDLE,
  type PrepState,
  type SheetView,
  type TxEvent,
  type TxState,
  type WalletState,
} from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import { standingApproval } from '@/lib/position-exec/run'
import { fmtAmount } from '@/lib/position/format'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import type { ProtocolPosition } from '@/lib/position-sim/types'

import {
  gatesFor,
  joinNotice,
  standingNotice,
  withAmount,
  type LeverIntent,
  type PreparedLever,
} from '../leverExec'
import { PROTOCOL_SHORT, buildPositionView } from '../viewModel'
import raw from './slipFixtures.json'

type Hash = `0x${string}`

const revive = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$bigint' in (v as Record<string, unknown>)
    ? BigInt((v as { $bigint: string }).$bigint)
    : v

interface Capture {
  intent: LeverIntent
  prepared: Omit<PreparedLever, 'view' | 'custom' | 'solved'> & { position: ProtocolPosition }
  sim: SimResult | null
}
const FIX = JSON.parse(JSON.stringify(raw), revive) as {
  capturedAt: string
  ready: Capture
  short: Capture
  add: Capture
  spark: Capture
  txs: Hash[]
}

/** The captured read with its view rebuilt the way the page builds it. */
function load(c: Capture): { intent: LeverIntent; prepared: PreparedLever; sim: SimResult | null } {
  const { position, ...rest } = c.prepared
  return {
    intent: c.intent,
    prepared: {
      // Captured before round 5 kept these: the solved amount, not the reader's own.
      custom: false,
      solved: { amount: rest.row.amount, amountDecimals: rest.row.amountDecimals },
      ...rest,
      view: buildPositionView(position, TOUCH_TABLE),
    },
    sim: c.sim,
  }
}

export interface DesignState {
  key: string
  title: string
  /** What was forced to show the state; null when the state is the read as captured. */
  forced: string | null
  /** The wallet the sheet was computed for (a re-prepare at another amount reuses it). */
  wallet: WalletState
  tx: TxState
  intent: LeverIntent
  prepared: PreparedLever | null
  sim: SimResult | null
  sheet: SheetView
  txHash: Hash | null
  busy: boolean
}

const run = (events: TxEvent[]) => events.reduce(txReducer, TX_IDLE as TxState)

/** The state's prep for the machine, as the hook builds it. */
function prepOf(p: PreparedLever, sim: SimResult | null): PrepState {
  return {
    status: 'ready',
    gates: p.gates,
    sim: p.gates.every((g) => g.ok)
      ? sim
        ? { status: 'done', result: sim }
        : { status: 'running' }
      : { status: 'skipped' },
    verb: p.row.kind === 'repay' ? 'Repay' : 'Add',
    what: `${fmtAmount(p.row.amount, p.row.amountDecimals)} ${p.leg.symbol}`,
    steps: p.calls.length,
  }
}

/**
 * The harness's answer to the slip's amount field and its "use the room left": the same
 * captured read at the reader's amount (leverExec.withAmount: the rows, gates and calls
 * again). The captured simulation was of the solved amount, so it is not reused: the
 * slip shows "Simulating…" (the live slip simulates the new batch).
 */
export function reprepare(s: DesignState, value: number, decimals: number): DesignState {
  if (!s.prepared) return s
  const p = withAmount(s.prepared, s.intent, value, decimals, TOUCH_TABLE)
  return {
    ...s,
    prepared: p,
    sim: null,
    sheet: sheetView(prepOf(p, null), s.wallet, s.tx, s.intent.owner),
  }
}

function build(): DesignState[] {
  const ready = load(FIX.ready)
  const short = load(FIX.short)
  const add = load(FIX.add)
  const spark = load(FIX.spark)
  const owner = ready.intent.owner
  const ON_1: WalletState = { connected: true, address: owner, chainId: 1 }
  const [H1, H2, H3] = FIX.txs
  const venue = PROTOCOL_SHORT[ready.intent.protocol]

  const prep = prepOf
  const withRead = (p: PreparedLever, read: LeverChainRead, intent = ready.intent): PreparedLever => ({
    ...p,
    read,
    gates: gatesFor(intent, p.row, p.leg, p.amount, read),
  })
  const standing = standingNotice(
    standingApproval(ready.prepared.calls, 1),
    ready.prepared.leg.symbol,
    ready.prepared.read.decimals,
    venue,
    'repay',
  )

  const state = (
    key: string,
    title: string,
    o: {
      forced?: string | null
      base?: typeof ready
      prepared?: PreparedLever | null
      wallet?: WalletState
      tx?: TxEvent[]
      hash?: Hash | null
      reading?: boolean
    },
  ): DesignState => {
    const base = o.base ?? ready
    const p = o.prepared === undefined ? base.prepared : o.prepared
    const tx = run(o.tx ?? [])
    const prepState: PrepState = o.reading || !p ? { status: 'reading' } : prep(p, base.sim)
    const wallet = o.wallet ?? { ...ON_1, address: base.intent.owner }
    return {
      key,
      title,
      forced: o.forced ?? null,
      wallet,
      tx,
      intent: { ...base.intent, owner: base.intent.owner },
      prepared: o.reading ? null : p,
      sim: o.reading ? null : base.sim,
      sheet: sheetView(prepState, wallet, tx, base.intent.owner),
      txHash: o.hash ?? null,
      busy: tx.phase === 'submitted' || tx.phase === 'pending' || tx.phase === 'switching',
    }
  }

  const aaveVenue = ready.prepared.read.venue
  const sparkVenue = spark.prepared.read.venue
  const addVenue = add.prepared.read.venue
  return [
    state('reading', 'Reading', { reading: true }),
    state('ready', 'Ready: rows, approve then repay, simulated', {}),
    state('no-wallet', 'No wallet: Connect wallet (V20)', {
      wallet: { connected: false, address: null, chainId: null },
    }),
    state('wrong-wallet', 'Wrong wallet', {
      wallet: { connected: true, address: FIX.short.intent.owner, chainId: 1 },
      forced: 'the connected wallet is the "short" borrower, a real other address',
    }),
    state('wrong-chain', 'Wrong chain: Switch to Ethereum', {
      wallet: { ...ON_1, chainId: 31337 },
      forced: 'wallet chain 31337',
    }),
    state('balance', 'Insufficient balance', { base: short }),
    state('paused', 'Reserve paused', {
      prepared:
        aaveVenue.venue === 'aave'
          ? withRead(ready.prepared, {
              ...ready.prepared.read,
              venue: { ...aaveVenue, flags: { ...aaveVenue.flags, paused: true } },
            })
          : null,
      forced: 'the reserve paused bit; no Aave reserve is paused today',
    }),
    state('cap', 'Over the supply cap (top-up), with the room left to use', {
      base: add,
      prepared:
        addVenue.venue === 'aave'
          ? withRead(
              add.prepared,
              {
                ...add.prepared.read,
                balance: add.prepared.amount,
                // Room: half the amount, so the top-up is over the cap with room left.
                venue: { ...addVenue, capRoom: add.prepared.amount / 2n, supplied: undefined },
              },
              add.intent,
            )
          : null,
      forced:
        'cap room set to half the amount (the read had room, and no WETH: the balance is set to the amount); the cap is the read’s, supplied is cap − room',
    }),
    state('spark-stable', 'Spark stable-rate debt refused', {
      base: spark,
      prepared:
        sparkVenue.venue === 'aave'
          ? withRead(
              spark.prepared,
              {
                ...spark.prepared.read,
                balance: spark.prepared.amount,
                venue: { ...sparkVenue, variableDebt: 0n, stableDebt: sparkVenue.variableDebt },
              },
              spark.intent,
            )
          : null,
      forced:
        "the read's variable debt shown as stable-rate: no Spark stable debt exists today (stable debt tokens read totalSupply 0)",
    }),
    state('signing', 'Signing: confirm in your wallet', {
      tx: [
        { type: 'sign', total: 2 },
        { type: 'path', total: 2 },
      ],
    }),
    state('pending', 'Pending 1/2', {
      tx: [
        { type: 'sign', total: 2 },
        { type: 'path', total: 2 },
        { type: 'signed', hash: H1 },
      ],
      hash: H1,
      forced: "the hash is a real recent Aave repay, not this slip's",
    }),
    state('still-waiting', 'Pending past the timeout: still waiting', {
      tx: [
        { type: 'sign', total: 2 },
        { type: 'path', total: 2 },
        { type: 'signed', hash: H1 },
        { type: 'landed' },
        { type: 'signed', hash: H2 },
        { type: 'waiting' },
      ],
      hash: H2,
      forced: "the hash is a real recent Aave repay, not this slip's",
    }),
    state('settled', 'Settled', {
      tx: [
        { type: 'sign', total: 2 },
        { type: 'signed', hash: H1 },
        { type: 'signed', hash: H2 },
        { type: 'settled', hash: H2 },
      ],
      hash: H2,
      forced: "the hash is a real recent Aave repay, not this slip's",
    }),
    state('reverted', 'Reverted on chain', {
      tx: [
        { type: 'sign', total: 2 },
        { type: 'signed', hash: H1 },
        { type: 'landed' },
        { type: 'signed', hash: H3 },
        {
          type: 'failed',
          kind: 'reverted',
          message: joinNotice(
            'Step 2 of 2 reverted: Reserve is paused (29). Your position is unchanged',
            standing,
          ),
          gasSpent: true,
          hash: H3,
        },
      ],
      hash: H3,
      forced: 'the outcome and reason; the hash is a real recent Aave repay',
    }),
    state('replaced', 'Replaced in your wallet', {
      tx: [
        { type: 'sign', total: 1 },
        { type: 'signed', hash: H1 },
        {
          type: 'failed',
          kind: 'replaced',
          message: 'Replaced in your wallet: this repay did not happen',
          gasSpent: false,
          hash: H2,
        },
      ],
      hash: H2,
      forced: 'the outcome; the replacement hash is a real recent Aave repay',
    }),
    state('approval-standing', 'Approval still standing (declined after the approve landed)', {
      tx: [
        { type: 'sign', total: 2 },
        { type: 'signed', hash: H1 },
        { type: 'landed' },
        { type: 'declined', landed: 1, message: joinNotice('Declined in your wallet', standing) },
      ],
      forced: 'the outcome',
    }),
  ]
}

export const DESIGN_STATES: DesignState[] = build()
export const CAPTURED_AT = FIX.capturedAt

// ------------------------------------------------------------------ the walkthrough
// /dev/slip-states?walk=<key>: the states above, stepped through with the slip open, in
// the order a reader meets them. The main path is the signature that goes well; a branch
// leaves it where the flow can turn, and its Next goes where the real flow goes next.

/** The path that goes well, in order. */
export const WALK_MAIN = ['reading', 'ready', 'signing', 'pending', 'settled'] as const

/** Where the flow can turn, by the main-path state it turns from. */
export const WALK_BRANCHES: Readonly<Record<string, readonly string[]>> = {
  ready: ['no-wallet', 'wrong-chain'],
  pending: ['still-waiting', 'reverted', 'replaced'],
}

/**
 * Where a branch goes next in the real flow: a connect or a switch re-opens the same
 * slip (V20, intent-preserving), a slow receipt still settles, a retry reads again.
 */
const BRANCH_NEXT: Readonly<Record<string, string>> = {
  'no-wallet': 'ready',
  'wrong-chain': 'ready',
  'still-waiting': 'settled',
  reverted: 'reading',
  replaced: 'reading',
}

export interface WalkStep {
  key: string
  /** 1-based place on the main path, or null on a branch. */
  index: number | null
  /** The main-path state a branch turns from, or null on the main path. */
  from: string | null
  back: string | null
  next: string | null
  branches: readonly string[]
}

const MAIN: readonly string[] = WALK_MAIN

export function walkStep(key: string): WalkStep {
  const i = MAIN.indexOf(key)
  if (i >= 0) {
    return {
      key,
      index: i + 1,
      from: null,
      back: i > 0 ? MAIN[i - 1] : null,
      next: i < MAIN.length - 1 ? MAIN[i + 1] : null,
      branches: WALK_BRANCHES[key] ?? [],
    }
  }
  const from = Object.keys(WALK_BRANCHES).find((k) => WALK_BRANCHES[k].includes(key))
  if (!from) throw new Error(`walkStep: ${key} is not on the walkthrough`)
  return { key, index: null, from, back: from, next: BRANCH_NEXT[key] ?? null, branches: [] }
}
