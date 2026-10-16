// /[chain]/position, v0: the reader's own liquidation line on a real position, in the
// newspaper edition. Read-only — a pasted address or a connected wallet, no signature.
//
// Top to bottom: the gesture and read status; the hero (liquidation price in $ and its
// distance from now); the history surface; the action rows; the conditional Membrane
// line; the dense instrument panel. Every figure comes from an adapter read, the generated
// history table or a contract constant (DESIGN_RULES §4: no mockup numbers).

import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box } from '@chakra-ui/react'
import { useAccount } from 'wagmi'

import { SPACING } from '@/config/spacing'
import { NEWS } from '@/components/NewsEdition/tokens'
import useWallet from '@/hooks/useWallet'
import { isExecProtocol } from '@/lib/position-exec/read'
import { DEFAULT_HORIZON, type ActionRow } from '@/lib/position/reverseSolve'
import { TOUCH_TABLE, staleDays, type HorizonId } from '@/lib/position/touchHistory'

import { Actions } from './Actions'
import { AddressForm } from './AddressForm'
import { ForecastBlock } from './ForecastBlock'
import { Hero } from './Hero'
import { Instrument } from './Instrument'
import type { LeverIntent } from './leverExec'
import { LeverSheet } from './LeverSheet'
import { MarketHistory } from './MarketHistory'
import { MembraneLine } from './MembraneLine'
import { PositionPicker } from './PositionPicker'
import { Headline, Kicker, Mono, Rule, Section, Small } from './primitives'
import { ADAPTER_ORDER, useAdapterReads } from './useAdapterReads'
import { usePositionTarget } from './usePositionTarget'
import {
  MODELLED_FOOTER,
  PROTOCOL_SHORT,
  pageState,
  readStatus,
  statusSentence,
  type PageState,
  type PositionView,
  type ReadStatusItem,
} from './viewModel'

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** The table's age never changes while the page is open; nothing to subscribe to. */
const noSubscribe = () => () => {}
const clientStaleDays = () => staleDays(TOUCH_TABLE, Date.now())
const serverStaleDays = () => null

/** Before any read: what the page will read, so the gap in coverage is stated up front. */
const COVERAGE = `Reads ${ADAPTER_ORDER.filter((a) => a.id !== 'fluid')
  .map((a) => PROTOCOL_SHORT[a.id])
  .join(' / ')} on Ethereum · Fluid not supported yet`

// ------------------------------------------------------------------ states

const Reading: React.FC<{ address: string }> = ({ address }) => (
  // Holds the hero's height while the adapters answer (§9: reserve client-only space).
  <Box pt={SPACING.lg} minH={{ base: '200px', md: '230px' }} display="grid" alignContent="start" gap={SPACING.sm}>
    <Kicker tone="muted">Reading {shortAddr(address)}</Kicker>
    <Mono color={NEWS.ink2}>Each venue answers on its own; results appear as they land.</Mono>
  </Box>
)

const NoPositions: React.FC<{ address: string; items: ReadStatusItem[] }> = ({ address, items }) => {
  const read = items.filter((i) => i.state === 'empty' || i.state === 'ok').map((i) => i.label)
  const failed = items.filter((i) => i.state === 'error')
  const unsupported = items.filter((i) => i.state === 'unsupported').map((i) => i.label)
  return (
    <Section id="none">
      <Kicker tone="muted">{shortAddr(address)}</Kicker>
      <Headline as="h1">{read.length > 0 ? 'No open position found' : 'Could not read this address'}</Headline>
      {read.length > 0 && <Mono color={NEWS.ink2}>Nothing on {read.join(' / ')}.</Mono>}
      {unsupported.length > 0 && (
        <Mono color={NEWS.ink2}>{unsupported.join(' / ')} is not read yet: a position there would not show.</Mono>
      )}
      {failed.map((f) => (
        <Small key={f.protocol} color={NEWS.ink2} overflowWrap="anywhere">
          ✖ {f.label} failed: {f.message ?? 'no message'}
        </Small>
      ))}
    </Section>
  )
}

const Positions: React.FC<{
  views: PositionView[]
  selected: PositionView
  onSelect: (key: string) => void
  failures: ReadStatusItem[]
  address: string
  /** Days the forecast's data is past STALE, or null while fresh. */
  staleAge: number | null
  onLever: (intent: LeverIntent) => void
}> = ({ views, selected, onSelect, failures, address, staleAge, onLever }) => {
  // One horizon drives the forecast, the curve and the levers (FORECAST_VISUALS.md §3).
  const [horizon, setHorizon] = useState<HorizonId>(DEFAULT_HORIZON)
  const hasLine = selected.hero.kind !== 'no-debt'
  const openLever = (row: ActionRow) => {
    if (!isExecProtocol(selected.protocol)) return
    onLever({
      owner: address as `0x${string}`,
      positionKey: selected.key,
      protocol: selected.protocol,
      title: selected.title,
      kind: row.kind,
      targetPct: row.targetPct,
      level: row.level,
      horizon,
      stale: staleAge !== null && selected.forecast !== null,
      row,
      openedAt: Date.now(),
    })
  }
  return (
    <>
      {views.length > 1 && <PositionPicker views={views} selectedKey={selected.key} onSelect={onSelect} />}
      <Hero view={selected} />
      <ForecastBlock view={selected} horizon={horizon} onHorizon={setHorizon} stale={staleAge !== null} t={TOUCH_TABLE} />
      <Actions view={selected} horizon={horizon} address={address} staleDays={staleAge} onLever={openLever} />
      {/* With no debt there is no line for the window to sit on. */}
      {hasLine && <MembraneLine />}
      <Rule strong mt={SPACING.xl} />
      <Instrument view={selected} failures={failures} />
      {(hasLine || selected.assumption) && (
        <Box pt={SPACING.sm} display="grid" gap={SPACING.xs}>
          <Rule mb={SPACING.xs} />
          {selected.forecast && <Small>{selected.forecast.footer}</Small>}
          <Small>{MODELLED_FOOTER}</Small>
        </Box>
      )}
    </>
  )
}

/** Below the gesture: one body per page state. */
const Body: React.FC<{
  state: PageState
  address: `0x${string}` | null
  items: ReadStatusItem[]
  readId: string
  selected: PositionView | null
  onSelect: (key: string) => void
  staleAge: number | null
  onLever: (intent: LeverIntent) => void
}> = ({ state, address, items, readId, selected, onSelect, staleAge, onLever }) => {
  const stale = staleAge !== null
  if (state.kind === 'idle') return <MarketHistory t={TOUCH_TABLE} stale={stale} />
  if (!address) return null
  if (state.kind === 'reading') return <Reading address={address} />
  if (state.kind === 'none') {
    return (
      <>
        <NoPositions address={address} items={items} />
        <MarketHistory t={TOUCH_TABLE} stale={stale} />
      </>
    )
  }
  if (!selected) return null
  return (
    <Positions
      key={readId}
      views={state.views}
      selected={selected}
      onSelect={onSelect}
      failures={items.filter((i) => i.state === 'error' || (i.skipped?.length ?? 0) > 0)}
      address={address}
      staleAge={staleAge}
      onLever={onLever}
    />
  )
}

// ------------------------------------------------------------------ the page

export const PositionV0: React.FC = () => {
  const form = usePositionTarget()
  const address = form.target
  const results = useAdapterReads(address, form.nonce)
  // The picked position belongs to the read it was picked in; a new read starts at the
  // nearest line again without a reset effect.
  const [picked, setPicked] = useState<{ read: string; key: string } | null>(null)
  const readId = `${address ?? ''}#${form.nonce}`
  const selectedKey = picked && picked.read === readId ? picked.key : null
  const onSelect = useCallback((key: string) => setPicked({ read: readId, key }), [readId])
  // Days since the table's last observed hour when it is too old to quote, else null. Read
  // from the client clock AFTER hydration (the server snapshot is "not stale"), so a server
  // and a browser on different clocks never render different markup. Whole days: stable.
  const staleAge = useSyncExternalStore(noSubscribe, clientStaleDays, serverStaleDays)

  // THE ORDER SLIP lives here, above the keyed read, so a settled lever's re-read does not
  // unmount its receipt. V20: "Connect wallet" keeps the intent, and the same slip opens
  // again once the wallet connects, even if the reader closed it meanwhile.
  const [lever, setLever] = useState<LeverIntent | null>(null)
  const [awaitingConnect, setAwaitingConnect] = useState<LeverIntent | null>(null)
  const { isConnected } = useAccount()
  const { connect } = useWallet()
  useEffect(() => {
    if (!awaitingConnect || !isConnected) return
    setLever(awaitingConnect)
    setAwaitingConnect(null)
  }, [awaitingConnect, isConnected])
  const closeLever = useCallback(() => setLever(null), [])
  const connectForLever = useCallback(() => {
    if (lever) setAwaitingConnect(lever)
    connect()
  }, [lever, connect])

  const items = useMemo(() => readStatus(ADAPTER_ORDER, results), [results])
  const state = useMemo(() => pageState(address !== null, items, results, TOUCH_TABLE), [address, items, results])
  const views = state.kind === 'positions' ? state.views : []
  const selected = views.find((v) => v.key === selectedKey) ?? views[0] ?? null
  // After a settled lever: read the same address again, keeping the position picked.
  const { reread } = form
  const selectedKeyNow = selected?.key ?? null
  const onSettled = useCallback(
    (owner: `0x${string}`) => {
      // Re-read the position's OWNER, whatever the box holds now.
      if (address && owner.toLowerCase() === address.toLowerCase()) {
        if (selectedKeyNow) setPicked({ read: `${address}#${form.nonce + 1}`, key: selectedKeyNow })
        reread()
      } else form.submit(owner)
    },
    [address, form, reread, selectedKeyNow],
  )

  return (
    <Box className="news-edition" minH="100vh" data-testid="position-v0">
      <Box maxW="960px" mx="auto" px={{ base: SPACING.base, md: SPACING.lg }} pt={SPACING.lg} pb={SPACING['2xl']} minW={0}>
        <Box h="3px" bg={NEWS.ink} />
        <Box display="grid" gap={SPACING.sm} pt={SPACING.base} minW={0}>
          <Kicker>Your position</Kicker>
          <AddressForm
            value={form.input}
            onChange={form.setInput}
            onSubmit={form.submit}
            onWallet={form.onWallet}
            walletConnected={form.walletConnected}
            isReading={state.kind === 'reading'}
            error={form.error}
          />
          {/* Reserved at one line at every breakpoint, so the hero never jumps (§9). */}
          <Small minH="1.5em" aria-live="polite" overflowWrap="anywhere">
            {address ? `${shortAddr(address)} · ${statusSentence(items)}` : COVERAGE}
          </Small>
        </Box>
        <Rule mt={SPACING.base} />

        <Body
          state={state}
          address={address}
          items={items}
          readId={readId}
          selected={selected}
          onSelect={onSelect}
          staleAge={staleAge}
          onLever={setLever}
        />
      </Box>
      {lever && (
        <LeverSheet key={lever.openedAt} intent={lever} onClose={closeLever} onConnect={connectForLever} onSettled={onSettled} />
      )}
    </Box>
  )
}
