import React, { memo, useState } from 'react'
import NextLink from 'next/link'
import { Box, Flex, Grid, Link, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { useChainRoute } from '@/hooks/useChainRoute'

import { ActionLink, Credit, Deck, Figure, Headline, Kicker, Module, Withheld } from './newsAtoms'
import { CAPS, DASH, HATCH, LEAD_MIN_H, TABULAR, TARGET } from './newsStyle'
import {
  DEFAULT_SIZE,
  demandView,
  exitsView,
  leadView,
  OPP_COPY,
  RATES_SHOWN,
  ratesView,
  SIZES,
  sizeLabel,
  type ExitRow,
  type LeadView,
  type RatesView,
} from './opportunitiesView'
import { useNetApyList, useRecorderSummaries, useStratsDemand } from './useTodayData'

// THE OPPORTUNITIES BODY (calm): where a deposit pays most at the reader's size, whether
// the recorded exits hold that size, and how much carry capital is tracked. Every module
// is finding → evidence → action; words and figures come from opportunitiesView.ts.

const LABEL_CELL = {
  fontFamily: NEWS_FONT.mono,
  fontSize: TYPOGRAPHY.label,
  lineHeight: '16px',
  color: NEWS.muted,
  fontWeight: TYPOGRAPHY.normal,
  ...CAPS,
}
const VALUE_CELL = { fontFamily: NEWS_FONT.mono, fontSize: '13px', lineHeight: '16px', color: NEWS.ink }

/** The size presets: the lever that re-solves the rates and the exits. */
function SizeLever({ size, onSize }: { size: number; onSize: (n: number) => void }) {
  return (
    <Flex as="div" role="group" aria-label="Deposit size" columnGap={SPACING.xs} wrap="wrap">
      {SIZES.map((n) => {
        const on = n === size
        return (
          <Box
            key={n}
            as="button"
            type="button"
            aria-pressed={on}
            onClick={() => onSize(n)}
            minW={TARGET}
            minH={TARGET}
            px={SPACING.sm}
            fontFamily={NEWS_FONT.mono}
            fontSize="13px"
            fontWeight={on ? TYPOGRAPHY.bold : TYPOGRAPHY.normal}
            color={on ? NEWS.ink : NEWS.muted}
            borderBottom={`2px solid ${on ? NEWS.ink : 'transparent'}`}
            transition={TRANSITIONS.colors}
            _hover={{ color: NEWS.ink }}
            sx={TABULAR}
          >
            {sizeLabel(n)}
          </Box>
        )
      })}
    </Flex>
  )
}

function Lead({
  v,
  kicker,
  size,
  onSize,
}: {
  v: LeadView
  kicker: string
  size: number
  onSize: (n: number) => void
}) {
  return (
    <Box
      minH={LEAD_MIN_H}
      pt={SPACING.lg}
      pb={SPACING.sm}
      bgImage={v.hatched ? HATCH : undefined}
      aria-busy={v.state === 'loading'}
      data-module="lead"
      data-module-state={v.state}
    >
      <Kicker>{kicker}</Kicker>
      {v.withheld ? (
        <Withheld>{v.withheld}</Withheld>
      ) : (
        <Headline id="opportunities-head">
          {v.headline ? (
            <>
              {v.headline.lead} <Figure>{v.headline.figure}</Figure> {v.headline.tail}
            </>
          ) : (
            DASH
          )}
        </Headline>
      )}
      {/* The one $ figure: what the size would earn at that rate. Money is moss, with ●. */}
      <Flex align="baseline" columnGap={SPACING.sm} wrap="wrap" minH="48px" pt={SPACING.xs}>
        <Text
          as="span"
          fontSize="40px"
          lineHeight="44px"
          color={v.hero ? NEWS.up : NEWS.muted}
          whiteSpace="nowrap"
          {...NEWS_FIGURE.display}
        >
          {v.hero && (
            <Box as="span" aria-hidden="true" fontSize="22px" mr="0.25em" verticalAlign="middle">
              ●
            </Box>
          )}
          {v.hero ? v.hero.figure : v.withheld ? '' : DASH}
        </Text>
        {v.hero && (
          <Text as="span" fontFamily={NEWS_FONT.mono} fontSize="13px" lineHeight="16px" color={NEWS.ink2}>
            {v.hero.unit}
          </Text>
        )}
      </Flex>
      <Box pt={SPACING.xs}>
        <SizeLever size={size} onSize={onSize} />
      </Box>
      <Flex minH={TARGET} align="center" justify="space-between" columnGap={SPACING.base} wrap="wrap">
        <Box flex="1 1 auto" minW={0}>
          <Credit align="left">{v.credit ?? (v.state === 'loading' ? DASH : '')}</Credit>
        </Box>
        {v.href && <ActionLink href={v.href}>{OPP_COPY.openVenue}</ActionLink>}
      </Flex>
    </Box>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <Box as="th" scope="col" textAlign={align} py={SPACING.sm} pl={align === 'right' ? SPACING.sm : 0} sx={LABEL_CELL}>
      {children}
    </Box>
  )
}

function Td({
  children,
  align = 'left',
  pad = align === 'right',
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  /** Space before the cell: right-aligned figures, and a text column after one. */
  pad?: boolean
}) {
  return (
    <Box
      as="td"
      textAlign={align}
      py={SPACING.sm}
      pl={pad ? SPACING.sm : 0}
      verticalAlign="top"
      borderBottom={`1px solid ${NEWS.rule}`}
      sx={{ ...VALUE_CELL, ...TABULAR }}
    >
      {children}
    </Box>
  )
}

function VenueName({ label, href }: { label: string; href: string | null }) {
  if (!href) return <>{label}</>
  return (
    <Link
      as={NextLink}
      href={href}
      display="inline-flex"
      alignItems="center"
      minH={TARGET}
      my="-14px"
      color={NEWS.ink}
      textDecoration="underline"
      textUnderlineOffset="3px"
      _hover={{ color: NEWS.accent }}
    >
      {label} →
    </Link>
  )
}

function Rates({ v }: { v: RatesView }) {
  const loading = v.state === 'loading'
  return (
    <Module label="Venue rates" hatched={v.hatched}>
      <Kicker>{OPP_COPY.ratesKicker}</Kicker>
      <Box as="table" w="100%" sx={{ borderCollapse: 'collapse' }} data-module="rates" data-module-state={v.state}>
        <Box as="thead">
          <Box as="tr" borderBottom={`1px solid ${NEWS.ruleStrong}`}>
            <Th>{OPP_COPY.venue}</Th>
            <Th align="right">{v.aprHead}</Th>
            <Th align="right">{OPP_COPY.borrowNow}</Th>
          </Box>
        </Box>
        <Box as="tbody">
          {loading &&
            Array.from({ length: RATES_SHOWN }, (_, i) => (
              <Box as="tr" key={i}>
                <Td>{DASH}</Td>
                <Td align="right">{DASH}</Td>
                <Td align="right">{DASH}</Td>
              </Box>
            ))}
          {v.state === 'error' && (
            <Box as="tr">
              <Td>
                <Box as="span" aria-hidden="true" mr="0.4em">
                  ░
                </Box>
                {OPP_COPY.ratesUnavailable}
              </Td>
              <Td align="right">{''}</Td>
              <Td align="right">{''}</Td>
            </Box>
          )}
          {v.rows.map((r) => (
            <Box as="tr" key={r.key}>
              <Td>
                <VenueName label={r.label} href={r.href} />
              </Td>
              <Td align="right">
                {r.apr}
                {r.rewards && (
                  <Text as="span" display="block" fontSize={TYPOGRAPHY.label} color={NEWS.muted}>
                    {r.rewards}
                  </Text>
                )}
              </Td>
              <Td align="right">{r.borrow}</Td>
            </Box>
          ))}
        </Box>
      </Box>
      <Box pt={SPACING.sm}>
        <Credit>{OPP_COPY.ratesCredit}</Credit>
        {v.excluded && <Credit>{v.excluded}</Credit>}
      </Box>
    </Module>
  )
}

function ExitCells({ r }: { r: ExitRow }) {
  if (r.state === 'loading') {
    return (
      <>
        <Td align="right">{DASH}</Td>
        <Td pad>{DASH}</Td>
        <Td align="right">{DASH}</Td>
      </>
    )
  }
  if (r.state === 'error') {
    return (
      <>
        <Td align="right">{OPP_COPY.unavailable}</Td>
        <Td pad>{''}</Td>
        <Td align="right">{''}</Td>
      </>
    )
  }
  return (
    <>
      <Td align="right">{r.figure ?? OPP_COPY.notRead}</Td>
      <Td pad>{r.how ?? ''}</Td>
      <Td align="right">
        {r.stale && (
          <Box as="span" aria-hidden="true" mr="0.3em">
            ░
          </Box>
        )}
        {r.age ?? DASH}
      </Td>
    </>
  )
}

function Exits({ size, nowMs }: { size: number; nowMs: number }) {
  const { chainName } = useChainRoute()
  const summaries = useRecorderSummaries()
  const v = exitsView({ summaries, sizeUsd: size, chain: chainName, nowMs })
  return (
    <Module label="Venue exits" hatched={v.hatched}>
      <Kicker>{OPP_COPY.exitsKicker}</Kicker>
      <Box data-module="exits" data-module-state={v.state}>
        {v.withheld ? <Withheld>{v.withheld}</Withheld> : <Headline>{v.headline ?? DASH}</Headline>}
        <Box minH="20px">{v.deck && <Deck>{v.deck}</Deck>}</Box>
      </Box>
      <Box as="table" w="100%" mt={SPACING.xs} sx={{ borderCollapse: 'collapse' }}>
        <Box as="thead">
          <Box as="tr" borderBottom={`1px solid ${NEWS.ruleStrong}`}>
            <Th>{OPP_COPY.venue}</Th>
            <Th align="right">{OPP_COPY.exitNow}</Th>
            <Box as="th" scope="col" textAlign="left" py={SPACING.sm} pl={SPACING.sm} sx={LABEL_CELL}>
              {OPP_COPY.how}
            </Box>
            <Th align="right">{OPP_COPY.age}</Th>
          </Box>
        </Box>
        <Box as="tbody">
          {v.rows.map((r) => (
            <Box as="tr" key={r.venue} bgImage={r.stale ? HATCH : undefined}>
              <Td>
                <VenueName label={r.label} href={r.href} />
              </Td>
              <ExitCells r={r} />
            </Box>
          ))}
        </Box>
      </Box>
      <Flex justify="space-between" align="center" columnGap={SPACING.base} wrap="wrap" pt={SPACING.xs}>
        <ActionLink href={`/${chainName}/radar`}>{OPP_COPY.stress}</ActionLink>
        <Credit>{OPP_COPY.exitsCredit}</Credit>
      </Flex>
    </Module>
  )
}

function Demand({ nowMs }: { nowMs: number }) {
  const { chainName } = useChainRoute()
  const strats = useStratsDemand()
  const v = demandView({ strats, nowMs })
  return (
    <Module label="Tracked carry capital" hatched={v.hatched}>
      <Kicker>{OPP_COPY.demandKicker}</Kicker>
      <Box data-module="demand" data-module-state={v.state}>
        {v.withheld ? (
          <Withheld slot={false}>{v.withheld}</Withheld>
        ) : (
          <Headline slot={false}>{v.line ?? DASH}</Headline>
        )}
      </Box>
      <Flex justify="space-between" align="center" columnGap={SPACING.base} wrap="wrap">
        <ActionLink href={`/${chainName}/strats`}>{OPP_COPY.wallets}</ActionLink>
        <Credit>{v.age ?? ''}</Credit>
      </Flex>
    </Module>
  )
}

export interface OpportunitiesProps {
  /** The kicker over the lead (regimeHome: "Opportunities"). */
  kicker: string
  nowMs: number
  /** The anchor id, when this body is the page's section (not inside the jump). */
  id?: string
}

export const Opportunities = memo(function Opportunities({ kicker, nowMs, id }: OpportunitiesProps) {
  const { chainName } = useChainRoute()
  const [size, setSize] = useState<number>(DEFAULT_SIZE)
  const netApy = useNetApyList(size)
  const lead = leadView({ netApy, sizeUsd: size, chain: chainName, nowMs })
  const rates = ratesView({ netApy, chain: chainName, nowMs, sizeUsd: size })

  return (
    <Box
      as="section"
      id={id}
      aria-labelledby="opportunities-head"
      data-news-section="opportunities"
      data-body="opportunities"
    >
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 5fr) minmax(0, 7fr)' }}
        columnGap={SPACING.xl}
      >
        <Lead v={lead} kicker={kicker} size={size} onSize={setSize} />
        <Box
          pt={{ base: 0, lg: SPACING.lg }}
          pl={{ base: 0, lg: SPACING.xl }}
          borderLeft={{ base: 'none', lg: `1px solid ${NEWS.rule}` }}
          minW={0}
        >
          <Rates v={rates} />
        </Box>
      </Grid>
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 7fr) minmax(0, 5fr)' }}
        columnGap={SPACING.xl}
      >
        <Exits size={size} nowMs={nowMs} />
        <Box
          pl={{ base: 0, lg: SPACING.xl }}
          borderLeft={{ base: 'none', lg: `1px solid ${NEWS.rule}` }}
          minW={0}
        >
          <Demand nowMs={nowMs} />
        </Box>
      </Grid>
    </Box>
  )
})

export default Opportunities
