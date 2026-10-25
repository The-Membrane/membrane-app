// §07's detail view: tap an oracle-vs-market card and its market signals open in a sheet
// (a side sheet on desktop, a full-width sheet from the bottom on a phone). Chakra's
// Drawer gives the dialog role, the focus trap, Esc to close and focus back to the card.
//
// Owner, 2026-10-18 (design s3/s4): "Curator feed · market signals — N of 4 signals on
// for this market": signal · now · track record, then the actions. The rows are built in
// signalsView.ts from the API response only. The actions are design only on this branch:
// each says what it would do and who can do it, and none signs or subscribes anything.

import React, { useRef } from 'react'
import {
  Box,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerHeader,
  DrawerOverlay,
  Grid,
  Text,
  useBreakpointValue,
} from '@chakra-ui/react'

import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import type { OracleGapMarketView, OracleGapResponse } from '@/lib/curatorFeed/service'

import { LABEL, Mono } from './atoms'
import { marketSignals, SIGNAL_ACTIONS, type SignalRow, type SignalState } from './signalsView'

export const SIGNALS_SHEET_ID = 'oracle-gap-signals'

/** Every state carries a glyph (DESIGN_RULES §2): colour is never the only cue. */
const MARK: Record<SignalState, { glyph: string; word: string; color: string }> = {
  on: { glyph: '●', word: 'on', color: NEWS.danger },
  off: { glyph: '○', word: 'off', color: SEMANTIC_COLORS.textSecondary },
  unread: { glyph: '░', word: 'not read now', color: SEMANTIC_COLORS.textSecondary },
  none: { glyph: '–', word: 'does not apply', color: SEMANTIC_COLORS.textTertiary },
  withheld: { glyph: '–', word: 'not shown', color: SEMANTIC_COLORS.textTertiary },
}

/** Signal · now · track record. One grid on desktop; on a phone each row stacks, with
 *  the column names inline. */
const COLS = {
  base: '16px minmax(0, 1fr)',
  md: '16px minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr)',
}

const ColName: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text {...LABEL} color={SEMANTIC_COLORS.textTertiary} display={{ base: 'block', md: 'none' }}>
    {children}
  </Text>
)

const Row: React.FC<{ row: SignalRow }> = ({ row }) => {
  const mark = MARK[row.state]
  const quiet = row.state === 'withheld' || row.state === 'none'
  return (
    <Grid
      role="row"
      data-signal={row.id}
      data-state={row.state}
      templateColumns={COLS}
      columnGap={SPACING.sm}
      rowGap={SPACING.xs}
      py={SPACING.md}
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Box role="cell" pt="2px" color={mark.color} fontSize="11px" lineHeight="16px">
        <span aria-hidden="true">{mark.glyph}</span>
        <Box as="span" srOnly>
          {mark.word}
        </Box>
      </Box>
      <Box role="rowheader" minW={0}>
        <Mono
          size="13px"
          color={quiet ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary}
        >
          {row.name}
        </Mono>
        <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
          {row.kind}
        </Mono>
      </Box>
      <Box role="cell" minW={0} gridColumn={{ base: '2', md: 'auto' }}>
        <ColName>Now</ColName>
        <Mono
          size={quiet ? '11px' : '13px'}
          color={
            row.state === 'on'
              ? NEWS.danger
              : quiet
                ? SEMANTIC_COLORS.textSecondary
                : SEMANTIC_COLORS.textPrimary
          }
        >
          {row.now}
        </Mono>
        {row.nowSub && (
          <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
            {row.nowSub}
          </Mono>
        )}
      </Box>
      <Box role="cell" minW={0} gridColumn={{ base: '2', md: 'auto' }} title={row.recordTitle}>
        <ColName>Track record</ColName>
        <Mono size="11px" color={SEMANTIC_COLORS.textPrimary}>
          {row.record}
        </Mono>
        {row.recordSub && (
          <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
            {row.recordSub}
          </Mono>
        )}
      </Box>
    </Grid>
  )
}

/** A design-only action: a real button (focusable, announced) marked unavailable, with
 *  what it would do and who can do it beside it. */
const DesignOnlyAction: React.FC<{ id: string; label: string; note: string }> = ({
  id,
  label,
  note,
}) => (
  <Box minW={0}>
    <Box
      as="button"
      type="button"
      aria-disabled="true"
      aria-describedby={`${SIGNALS_SHEET_ID}-${id}`}
      w="100%"
      minH="44px"
      px={SPACING.sm}
      border="1px solid"
      borderRadius={0}
      borderColor={SEMANTIC_COLORS.borderStrong}
      color={SEMANTIC_COLORS.textPrimary}
      bg="transparent"
      fontFamily={NEWS_FONT.mono}
      fontSize="12px"
      cursor="not-allowed"
      transition={TRANSITIONS.colors}
      _focusVisible={FOCUS_STYLES.ring}
    >
      {label}
    </Box>
    <Box id={`${SIGNALS_SHEET_ID}-${id}`} mt={SPACING.xs}>
      <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
        Design only · {note}
      </Mono>
    </Box>
  </Box>
)

export const SignalsSheet: React.FC<{
  m: OracleGapMarketView | undefined
  title: string
  r: OracleGapResponse
  onClose: () => void
  /** The card title that opened the sheet: focus goes back to it on close, however the
   *  card was opened (a tap on its body leaves focus nowhere). */
  finalFocusRef?: React.RefObject<HTMLElement>
}> = ({ m: open, title: openTitle, r, onClose, finalFocusRef }) => {
  const placement =
    useBreakpointValue<'bottom' | 'right'>({ base: 'bottom', md: 'right' }, { ssr: false }) ??
    'right'
  // While the sheet animates out, m is already gone: keep showing the last market.
  const last = useRef<{ m: OracleGapMarketView; title: string } | null>(null)
  if (open) last.current = { m: open, title: openTitle }
  const isOpen = !!open
  const m = open ?? last.current?.m
  const title = open ? openTitle : (last.current?.title ?? openTitle)
  const s = m ? marketSignals(m, r) : undefined
  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      placement={placement}
      returnFocusOnClose
      finalFocusRef={finalFocusRef}
    >
      <DrawerOverlay />
      <DrawerContent
        data-news-tokens
        bg={NEWS.paper}
        color={NEWS.ink}
        borderRadius={0}
        borderLeft={{ base: 'none', md: '1px solid' }}
        borderTop={{ base: '1px solid', md: 'none' }}
        borderColor={SEMANTIC_COLORS.borderStrong}
        maxW={{ base: '100vw', md: '720px' }}
        w="100%"
        maxH={{ base: '92vh', md: '100vh' }}
      >
        {/* The header is Chakra's DrawerHeader, so the dialog is labelled by it. */}
        <DrawerHeader
          px={{ base: SPACING.base, md: SPACING.lg }}
          pt={SPACING.lg}
          pb={0}
          fontWeight="normal"
        >
          {/* The double rule runs full width; the close button sits in the row under it,
              inset beside the eyebrow (never on the rule), with a 44px target. */}
          <Box
            borderTop="3px double"
            borderColor={SEMANTIC_COLORS.borderStrong}
            pt={SPACING.xs}
            display="flex"
            alignItems="flex-start"
            gap={SPACING.sm}
          >
            <Box flex="1" minW={0} pt={SPACING.xs}>
              <Text {...LABEL} color={SEMANTIC_COLORS.textSecondary}>
                Curator feed · market signals
              </Text>
              <Mono size="11px" color={SEMANTIC_COLORS.textSecondary}>
                {title}
              </Mono>
            </Box>
            <DrawerCloseButton
              aria-label="Close market signals"
              position="static"
              flexShrink={0}
              borderRadius={0}
              w="44px"
              h="44px"
              _focusVisible={FOCUS_STYLES.ring}
            />
          </Box>
          {s && (
            <Text
              as="h2"
              fontFamily={NEWS_FONT.display}
              fontWeight={700}
              fontSize={{ base: '22px', md: '28px' }}
              lineHeight={1.15}
              mt={SPACING.sm}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {s.headline}
            </Text>
          )}
        </DrawerHeader>
        <DrawerBody px={{ base: SPACING.base, md: SPACING.lg }} pt={0} pb={SPACING.lg}>
          {m && s && (
            <Box id={SIGNALS_SHEET_ID} data-signals>
              <Box role="table" aria-label={`Market signals for ${title}`} mt={SPACING.base}>
                <Grid
                  role="row"
                  templateColumns={COLS}
                  columnGap={SPACING.sm}
                  pb={SPACING.xs}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderStrong}
                  display={{ base: 'none', md: 'grid' }}
                >
                  <Box role="columnheader">
                    <Box as="span" srOnly>
                      State
                    </Box>
                  </Box>
                  {['Signal', 'Now', 'Track record'].map((h) => (
                    <Text
                      key={h}
                      role="columnheader"
                      {...LABEL}
                      color={SEMANTIC_COLORS.textTertiary}
                    >
                      {h}
                    </Text>
                  ))}
                </Grid>
                {s.rows.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </Box>
              <Grid
                templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }}
                gap={SPACING.sm}
                mt={SPACING.lg}
                role="group"
                aria-label="Actions (design only)"
              >
                {SIGNAL_ACTIONS.map((a) => (
                  <DesignOnlyAction key={a.id} id={a.id} label={a.label} note={a.note} />
                ))}
              </Grid>
              <Box
                mt={SPACING.base}
                pt={SPACING.sm}
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Mono size="11px" color={SEMANTIC_COLORS.textTertiary}>
                  Track records are retrospective; each names its test. Peer moves: the curator
                  feed&apos;s cap cuts and removals on this collateral.
                </Mono>
              </Box>
            </Box>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
