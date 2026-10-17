// /[chain]/position, v0: the reader's own liquidation line on a real position, in the
// newspaper edition. Read-only — a pasted address or a connected wallet, no signature.
//
// Top to bottom: the gesture and read status; the hero (liquidation price in $ and its
// distance from now); the history surface; the action rows; the conditional Membrane
// line; the dense instrument panel. Every figure comes from an adapter read, the generated
// history table or a contract constant (DESIGN_RULES §4: no mockup numbers).

import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Button } from '@chakra-ui/react'
import { useRouter } from 'next/router'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { DEFAULT_HORIZON } from '@/lib/position/reverseSolve'
import { TOUCH_TABLE, dataAgeLine, staleDays, type HorizonId } from '@/lib/position/touchHistory'

import { Actions } from './Actions'
import { AddressForm } from './AddressForm'
import { ForecastBlock, TIME_CAPTION } from './ForecastBlock'
import { Hero } from './Hero'
import { Instrument } from './Instrument'
import { LenderBlock } from './LenderBlock'
import { MarketHistory } from './MarketHistory'
import { MembraneLine } from './MembraneLine'
import { PositionPicker } from './PositionPicker'
import { TimeToTouchChart } from './TimeToTouchChart'
import { TouchGridChart } from './TouchGridChart'
import { Headline, Kicker, Mono, Rule, Section, Small } from './primitives'
import { CAPS, TYPE } from './typeScale'
import { ADAPTER_ORDER, useAdapterReads } from './useAdapterReads'
import { usePositionTarget } from './usePositionTarget'
import {
  MODELLED_FOOTER,
  PROTOCOL_SHORT,
  noneCopy,
  pageState,
  partialDiscovery,
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
/** The data's age in words, client clock only (the server renders none). */
const clientAgeLine = () => dataAgeLine(TOUCH_TABLE, Date.now())
const serverAgeLine = () => null

/** Before any read: what the page will read, so the gap in coverage is stated up front. */
const COVERAGE = `Reads ${ADAPTER_ORDER.filter((a) => a.id !== 'fluid')
  .map((a) => PROTOCOL_SHORT[a.id])
  .join(' / ')} on Ethereum · Fluid not supported yet`

// ------------------------------------------------------------------ states

/**
 * A venue whose read passed its deadline, or failed, is named with a retry — never left
 * "reading…". Retrying re-reads that venue alone for the same address.
 */
const BusyVenues: React.FC<{ items: ReadStatusItem[]; onRetry: (p: ReadStatusItem['protocol']) => void }> = ({
  items,
  onRetry,
}) => {
  const failed = items.filter((i) => i.state === 'error')
  if (failed.length === 0) return null
  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      {failed.map((f) => (
        <Box key={f.protocol} display="flex" flexWrap="wrap" alignItems="center" columnGap={SPACING.sm} minW={0}>
          <Small color={NEWS.ink2} overflowWrap="anywhere">
            ✖ {f.timedOut ? `couldn't read ${f.label}: public RPC busy` : `${f.label} failed`}
          </Small>
          <Button
            type="button"
            variant="unstyled"
            onClick={() => onRetry(f.protocol)}
            h="44px"
            minW={0}
            px={0}
            color={NEWS.accent}
            fontFamily={NEWS_FONT.mono}
            fontSize={TYPE.label}
            fontWeight={700}
            {...CAPS}
            textDecoration="underline"
            textUnderlineOffset="3px"
            transition={TRANSITIONS.colors}
            _hover={{ color: NEWS.ink }}
            aria-label={`Try reading ${f.label} again`}
          >
            Try again
          </Button>
        </Box>
      ))}
    </Box>
  )
}

const Reading: React.FC<{ address: string; two: boolean }> = ({ address, two }) => (
  // Holds the hero's height while the adapters answer (§9: reserve client-only space), and
  // the chart's frame in its place, so the visual never arrives into an empty page.
  <Box pt={SPACING.lg} minH={{ base: '200px', md: '230px' }} display="grid" alignContent="start" gap={SPACING.sm}>
    <Kicker tone="muted">Reading {shortAddr(address)}</Kicker>
    <Mono color={NEWS.ink2}>Each venue answers on its own; results appear as they land.</Mono>
    {two ? <TimeToTouchChart state={{ kind: 'reading' }} caption={TIME_CAPTION} /> : <TouchGridChart state={{ kind: 'reading' }} />}
  </Box>
)

const NoPositions: React.FC<{ address: string; items: ReadStatusItem[] }> = ({ address, items }) => {
  const copy = noneCopy(items)
  const failed = items.filter((i) => i.state === 'error')
  const unsupported = items.filter((i) => i.state === 'unsupported').map((i) => i.label)
  return (
    <Section id="none">
      <Kicker tone="muted">{shortAddr(address)}</Kicker>
      <Headline as="h1">{copy.headline}</Headline>
      {copy.nothingOn.length > 0 && <Mono color={NEWS.ink2}>Nothing on {copy.nothingOn.join(' / ')}.</Mono>}
      {copy.partial.map((line) => (
        <Mono key={line} color={NEWS.ink2} overflowWrap="anywhere">
          {line}
        </Mono>
      ))}
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
  dust: number
  two: boolean
  ageLine: string | null
}> = ({ views, selected, onSelect, failures, address, staleAge, dust, two, ageLine }) => {
  // One horizon drives the headline figure, the depth curve and the levers (7 days); the
  // time chart shows every time up to it, so there are no horizon tabs to page through.
  const horizon: HorizonId = DEFAULT_HORIZON
  const hasLine = selected.hero.kind !== 'no-debt'
  return (
    <>
      {(views.length > 1 || dust > 0) && <PositionPicker views={views} selectedKey={selected.key} onSelect={onSelect} dust={dust} />}
      <Hero view={selected} />
      <ForecastBlock view={selected} horizon={horizon} stale={staleAge !== null} t={TOUCH_TABLE} two={two} ageLine={ageLine} />
      {/* A lender has no line: rewards, risks and withdrawal capacity take its place. */}
      {selected.position.status === 'supply-only' && selected.position.lendMarket && (
        <LenderBlock key={selected.key} position={selected.position} />
      )}
      <Actions view={selected} horizon={horizon} address={address} staleDays={staleAge} />
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
  two: boolean
  ageLine: string | null
}> = ({ state, address, items, readId, selected, onSelect, staleAge, two, ageLine }) => {
  const stale = staleAge !== null
  if (state.kind === 'idle') return <MarketHistory t={TOUCH_TABLE} stale={stale} two={two} ageLine={ageLine} />
  if (!address) return null
  if (state.kind === 'reading') return <Reading address={address} two={two} />
  if (state.kind === 'none') {
    return (
      <>
        <NoPositions address={address} items={items} />
        <MarketHistory t={TOUCH_TABLE} stale={stale} two={two} ageLine={ageLine} />
      </>
    )
  }
  if (!selected) return null
  return (
    <Positions
      key={readId}
      views={state.views}
      dust={state.dust}
      selected={selected}
      onSelect={onSelect}
      failures={items.filter((i) => i.state === 'error' || (i.skipped?.length ?? 0) > 0 || partialDiscovery(i))}
      address={address}
      staleAge={staleAge}
      two={two}
      ageLine={ageLine}
    />
  )
}

// ------------------------------------------------------------------ the page

export const PositionV0: React.FC = () => {
  const form = usePositionTarget()
  const address = form.target
  const { results, retry } = useAdapterReads(address, form.nonce)
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
  const ageLine = useSyncExternalStore(noSubscribe, clientAgeLine, serverAgeLine)
  // ?charts=two keeps the round-3 pair (time curve + depth curve) for comparison.
  const two = useRouter().query.charts === 'two'

  const items = useMemo(() => readStatus(ADAPTER_ORDER, results), [results])
  const state = useMemo(() => pageState(address !== null, items, results, TOUCH_TABLE), [address, items, results])
  const views = state.kind === 'positions' ? state.views : []
  const selected = views.find((v) => v.key === selectedKey) ?? views[0] ?? null

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
          {address && <BusyVenues items={items} onRetry={retry} />}
        </Box>
        <Rule mt={SPACING.base} />

        <Body state={state} address={address} items={items} readId={readId} selected={selected} onSelect={onSelect} staleAge={staleAge} two={two} ageLine={ageLine} />
      </Box>
    </Box>
  )
}
