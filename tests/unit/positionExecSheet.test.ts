// lib/position-exec/sheet.ts — the order slip's state machine: every state's stamp, button
// and named notice; the order of the gates; and the transaction reducer.

import { describe, expect, it } from 'vitest'

import type { Gate } from '@/lib/position-exec/gates'
import {
  MAX_READ_AGE_MS,
  TX_IDLE,
  readTooOld,
  sheetView,
  txReducer,
  walletChecks,
  type PrepState,
  type TxEvent,
  type TxState,
  type WalletState,
} from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'

const OWNER = '0x7AdA00000000000000000000000000000000d142'
const OTHER = '0x1111111111111111111111111111111111111111'

const OK_GATES: Gate[] = [
  { id: 'decimals', ok: true, text: 'USDC has 6 decimals' },
  { id: 'venue', ok: true, text: 'Reserve active, not paused' },
  { id: 'debt', ok: true, text: 'Variable-rate debt 5,000.00 USDC' },
  { id: 'balance', ok: true, text: 'Balance covers 460.00 USDC' },
]
const SIM_OK: SimResult = {
  ok: true,
  method: 'eth_simulateV1',
  gas: [55_570n, 156_843n],
  bufferedGas: 223_034n,
  maxFeePerGas: 10n ** 9n,
}
const SIM_REVERT: SimResult = {
  ok: false,
  method: 'eth_simulateV1',
  step: 1,
  reason: 'Reserve is paused (29)',
}

const ready = (o: Partial<Extract<PrepState, { status: 'ready' }>> = {}): PrepState => ({
  status: 'ready',
  gates: OK_GATES,
  sim: { status: 'done', result: SIM_OK },
  verb: 'Repay',
  what: '460 USDC',
  steps: 2,
  ...o,
})
const NO_WALLET: WalletState = { connected: false, address: null, chainId: null }
const OWNER_ON_1: WalletState = { connected: true, address: OWNER.toLowerCase(), chainId: 1 }

const run = (events: TxEvent[], from: TxState = TX_IDLE) => events.reduce(txReducer, from)

describe('the slip before a signature', () => {
  it('reads first: DRAFT, nothing to press', () => {
    const v = sheetView({ status: 'reading' }, OWNER_ON_1, TX_IDLE, OWNER)
    expect(v).toMatchObject({
      stamp: 'DRAFT',
      button: { kind: 'wait', label: 'Reading…', enabled: false },
      notice: null,
    })
  })
  it('names a failed re-read and offers to read again', () => {
    const v = sheetView(
      { status: 'error', message: 'Aave V3 re-read failed: HTTP 429' },
      OWNER_ON_1,
      TX_IDLE,
      OWNER,
    )
    expect(v.button).toEqual({ kind: 'retry', label: 'Read again', enabled: true })
    expect(v.notice).toBe('Aave V3 re-read failed: HTTP 429')
  })
  it('says why a lever no longer applies', () => {
    const v = sheetView(
      { status: 'gone', reason: 'This position is no longer open on Spark.' },
      OWNER_ON_1,
      TX_IDLE,
      OWNER,
    )
    expect(v.button.kind).toBe('close')
    expect(v.notice).toBe('This position is no longer open on Spark.')
  })
  it('with no wallet: the same rows, the button is Connect wallet (V20)', () => {
    const v = sheetView(ready(), NO_WALLET, TX_IDLE, OWNER)
    expect(v.button).toEqual({ kind: 'connect', label: 'Connect wallet', enabled: true })
    expect(v.notice).toBeNull()
    expect(v.checks.map((c) => c.id)).toEqual([
      'decimals',
      'venue',
      'debt',
      'balance',
      'wallet',
      'sim',
    ])
    expect(v.checks.find((c) => c.id === 'wallet')).toMatchObject({
      ok: false,
      text: 'Wallet not connected',
    })
  })
  it('another wallet never signs: Wrong wallet, and which one to connect', () => {
    const v = sheetView(ready(), { connected: true, address: OTHER, chainId: 1 }, TX_IDLE, OWNER)
    expect(v.button).toEqual({ kind: 'wait', label: 'Wrong wallet', enabled: false })
    expect(v.notice).toBe('Connect the wallet that holds this position (0x7AdA…d142)')
    expect(v.checks.map((c) => c.id)).not.toContain('chain')
  })
  it('matches the owner case-insensitively', () => {
    expect(
      sheetView(
        ready(),
        { connected: true, address: OWNER.toUpperCase().replace('0X', '0x'), chainId: 1 },
        TX_IDLE,
        OWNER,
      ).button.kind,
    ).toBe('sign')
  })
  it('on another chain: a switch to Ethereum', () => {
    const v = sheetView(
      ready(),
      { connected: true, address: OWNER, chainId: 31337 },
      TX_IDLE,
      OWNER,
    )
    expect(v.button).toEqual({ kind: 'switch', label: 'Switch to Ethereum', enabled: true })
    expect(v.notice).toBe('Wallet on chain 31337; this position is on Ethereum')
  })
  it('a venue or balance gate blocks before any wallet step, naming the figure', () => {
    const gates: Gate[] = [
      ...OK_GATES.slice(0, 3),
      { id: 'balance', ok: false, text: 'Balance 120.00 USDC, short of 460.00 USDC' },
    ]
    for (const w of [NO_WALLET, OWNER_ON_1, { connected: true, address: OTHER, chainId: 5 }]) {
      const v = sheetView(ready({ gates, sim: { status: 'skipped' } }), w, TX_IDLE, OWNER)
      expect(v.button).toEqual({ kind: 'wait', label: 'Repay unavailable', enabled: false })
      expect(v.notice).toBe('Balance 120.00 USDC, short of 460.00 USDC')
    }
    const paused: Gate[] = [OK_GATES[0], { id: 'venue', ok: false, text: 'Reserve is paused' }]
    expect(
      sheetView(
        ready({ gates: paused, verb: 'Add', sim: { status: 'skipped' } }),
        OWNER_ON_1,
        TX_IDLE,
        OWNER,
      ),
    ).toMatchObject({
      button: { label: 'Add unavailable', enabled: false },
      notice: 'Reserve is paused',
    })
  })
  it('waits for the simulation, then signs only when it passes', () => {
    expect(
      sheetView(ready({ sim: { status: 'running' } }), OWNER_ON_1, TX_IDLE, OWNER).button,
    ).toEqual({ kind: 'wait', label: 'Simulating…', enabled: false })
    const failed = sheetView(
      ready({ sim: { status: 'done', result: SIM_REVERT } }),
      OWNER_ON_1,
      TX_IDLE,
      OWNER,
    )
    expect(failed.button).toEqual({ kind: 'retry', label: 'Read again', enabled: true })
    expect(failed.notice).toBe('Step 2 would revert: Reserve is paused (29)')
    const down = sheetView(
      ready({ sim: { status: 'error', message: 'every RPC failed' } }),
      OWNER_ON_1,
      TX_IDLE,
      OWNER,
    )
    expect(down.notice).toBe('Simulation unavailable: every RPC failed')
    const ok = sheetView(ready(), OWNER_ON_1, TX_IDLE, OWNER)
    expect(ok).toMatchObject({
      stamp: 'DRAFT',
      button: { kind: 'sign', label: 'Repay 460 USDC', enabled: true },
      notice: null,
    })
    expect(ok.checks.at(-1)).toEqual({
      id: 'sim',
      ok: true,
      text: 'Simulation passes · eth_simulateV1',
    })
  })
  it('lists the wallet checks in the order they are fixed', () => {
    expect(walletChecks(OWNER_ON_1, OWNER).map((c) => [c.id, c.ok])).toEqual([
      ['wallet', true],
      ['owner', true],
      ['chain', true],
    ])
  })
})

describe('the slip during and after the signature', () => {
  it('SUBMITTED while the wallet asks, then PENDING n/N per signature', () => {
    const submitted = run([{ type: 'sign', total: 2 }])
    expect(sheetView(ready(), OWNER_ON_1, submitted, OWNER)).toMatchObject({
      stamp: 'SUBMITTED',
      button: { kind: 'wait', label: 'Confirm in your wallet', enabled: false },
    })
    const one = run([{ type: 'signed' }], submitted)
    expect(sheetView(ready(), OWNER_ON_1, one, OWNER)).toMatchObject({
      stamp: 'PENDING 1/2',
      button: { label: 'Pending 1/2', enabled: false },
    })
    // An atomic EIP-5792 batch is one signature for both calls.
    expect(
      run([{ type: 'sign', total: 2 }, { type: 'total', total: 1 }, { type: 'signed' }]),
    ).toEqual({ phase: 'pending', signed: 1, total: 1 })
    expect(run([{ type: 'total', total: 1 }], one)).toBe(one)
    // An atomic batch counted as one signature never shows 2/1.
    expect(run([{ type: 'sign', total: 1 }, { type: 'signed' }, { type: 'signed' }])).toEqual({
      phase: 'pending',
      signed: 2,
      total: 2,
    })
  })
  it('SETTLED with its hash, and the button closes', () => {
    const hash = `0x${'ab'.repeat(32)}` as const
    const s = run([{ type: 'sign', total: 1 }, { type: 'signed' }, { type: 'settled', hash }])
    expect(s).toEqual({ phase: 'settled', hash })
    expect(sheetView(ready(), OWNER_ON_1, s, OWNER)).toMatchObject({
      stamp: 'SETTLED',
      button: { kind: 'close', enabled: true },
    })
  })
  it('a mined revert is FAILED · GAS SPENT, with its hash', () => {
    const hash = `0x${'cd'.repeat(32)}` as const
    const s = run([
      { type: 'sign', total: 2 },
      { type: 'signed' },
      { type: 'signed' },
      {
        type: 'failed',
        message: 'Transaction reverted on step 2 of 2. Your position is unchanged.',
        minedRevert: true,
        hash,
      },
    ])
    expect(s).toMatchObject({ phase: 'failed', gasSpent: true, hash })
    expect(sheetView(ready(), OWNER_ON_1, s, OWNER)).toMatchObject({
      stamp: 'FAILED · GAS SPENT',
      button: { kind: 'retry', label: 'Read again' },
      notice: 'Transaction reverted on step 2 of 2. Your position is unchanged.',
    })
  })
  it('a failure before anything was sent is FAILED, no gas', () => {
    const s = run([
      { type: 'sign', total: 1 },
      { type: 'failed', message: 'Connector chain mismatch', minedRevert: false },
    ])
    expect(sheetView(ready(), OWNER_ON_1, s, OWNER).stamp).toBe('FAILED')
  })
  it('declined before any signature: the slip stands, signable again, and says so', () => {
    const s = run([{ type: 'sign', total: 2 }, { type: 'declined' }])
    expect(s).toEqual({ phase: 'idle', notice: 'Declined in your wallet' })
    expect(sheetView(ready(), OWNER_ON_1, s, OWNER)).toMatchObject({
      stamp: 'DRAFT',
      button: { kind: 'sign', enabled: true },
      notice: 'Declined in your wallet',
    })
  })
  it('declined after a step landed: FAILED · GAS SPENT, and the slip must be read again', () => {
    const s = run([{ type: 'sign', total: 2 }, { type: 'signed' }, { type: 'declined' }])
    expect(s).toMatchObject({
      phase: 'failed',
      gasSpent: true,
      message: 'Declined in your wallet after 1 step landed',
    })
    expect(sheetView(ready(), OWNER_ON_1, s, OWNER).button.kind).toBe('retry')
  })
  it('a switch: waits on the wallet, then back to the slip; a declined switch is named', () => {
    const switching = run([{ type: 'switch' }])
    expect(sheetView(ready(), { ...OWNER_ON_1, chainId: 10 }, switching, OWNER).button).toEqual({
      kind: 'wait',
      label: 'Switch in your wallet',
      enabled: false,
    })
    expect(run([{ type: 'switched' }], switching)).toEqual(TX_IDLE)
    const declined = run([{ type: 'declined' }], switching)
    expect(sheetView(ready(), { ...OWNER_ON_1, chainId: 10 }, declined, OWNER)).toMatchObject({
      button: { kind: 'switch', enabled: true },
      notice: 'Switch declined in your wallet',
    })
  })
  it('a slip read over 2 minutes ago reads again before it signs', () => {
    expect(MAX_READ_AGE_MS).toBe(120_000)
    expect(readTooOld(0, 120_000)).toBe(false)
    expect(readTooOld(0, 120_001)).toBe(true)
    const s = run([{ type: 'expired' }])
    expect(s).toEqual({
      phase: 'idle',
      notice: 'Read again now: the last read was over 2 minutes old',
    })
    expect(sheetView({ status: 'reading' }, OWNER_ON_1, s, OWNER).button.label).toBe('Reading…')
  })
  it('ignores events out of order', () => {
    expect(txReducer(TX_IDLE, { type: 'signed' })).toBe(TX_IDLE)
    const settled: TxState = { phase: 'settled', hash: '0x01' }
    expect(txReducer(settled, { type: 'sign', total: 1 })).toBe(settled)
    expect(txReducer(settled, { type: 'switch' })).toBe(settled)
    expect(txReducer(settled, { type: 'reset' })).toBe(TX_IDLE)
  })
})
