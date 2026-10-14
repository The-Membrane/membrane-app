// /[chain]/position, v0: the reader's own liquidation line on a real position, in the
// newspaper edition. Read-only — a pasted address or a connected wallet, no signature.
//
// Top to bottom: the gesture and read status; the hero (liquidation price in $ and its
// distance from now); the history surface; the action rows; the conditional Membrane
// line; the dense instrument panel. Every figure comes from an adapter read, the generated
// history table or a contract constant (DESIGN_RULES §4: no mockup numbers).

import React, { useCallback, useMemo, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS } from '@/components/NewsEdition/tokens'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'

import { Actions } from './Actions'
import { AddressForm } from './AddressForm'
import { Hero } from './Hero'
import { HistorySurface } from './HistorySurface'
import { Instrument } from './Instrument'
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
  type PositionView,
  type ReadStatusItem,
} from './viewModel'

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

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
}> = ({ views, selected, onSelect, failures }) => {
  const hasLine = selected.hero.kind !== 'no-debt'
  return (
    <>
      {views.length > 1 && <PositionPicker views={views} selectedKey={selected.key} onSelect={onSelect} />}
      <Hero view={selected} />
      <HistorySurface view={selected} />
      <Actions view={selected} />
      {/* With no debt there is no line for the window to sit on. */}
      {hasLine && <MembraneLine />}
      <Rule strong mt={SPACING.xl} />
      <Instrument view={selected} failures={failures} />
      {(hasLine || selected.assumption) && (
        <>
          <Rule mt={SPACING.lg} />
          <Small pt={SPACING.sm}>{MODELLED_FOOTER}</Small>
        </>
      )}
    </>
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
        </Box>
        <Rule mt={SPACING.base} />

        {state.kind === 'idle' && <MarketHistory t={TOUCH_TABLE} />}
        {state.kind === 'reading' && address && <Reading address={address} />}
        {state.kind === 'none' && address && (
          <>
            <NoPositions address={address} items={items} />
            <MarketHistory t={TOUCH_TABLE} />
          </>
        )}
        {state.kind === 'positions' && selected && (
          <Positions
            views={views}
            selected={selected}
            onSelect={onSelect}
            failures={items.filter((i) => i.state === 'error')}
          />
        )}
      </Box>
    </Box>
  )
}
