// Y: "YES, BUT". Each objection answered by a fact with its source, or by the census.
// Server-rendered: every figure here comes from getServerSideProps (the census summary)
// or from constants, so a crawler and a stranger read the same answers (SEO R1).

import React from 'react'
import NextLink from 'next/link'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { shortAddress, usd } from '@/components/Simulator/format'
import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'
import { OBJECTIONS, SOLIDITY_PIN, citeText, type CensusCase, type CensusSummary } from '@/lib/landing/objections'

import Details, { DetailLine } from './Details'
import { kicker, rule, ruleStrong, small, tabularNums } from './styles'

const CaseLine: React.FC<{ c: CensusCase; tone: 'recovered' | 'failed' }> = ({ c, tone }) => (
  <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
    <Text as="span" color={tone === 'recovered' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
      {tone === 'recovered' ? '●' : '✖'}
    </Text>{' '}
    {shortAddress(c.user)} · {c.collSymbol} · {usd(c.debtUsd)} debt · Aave closed {usd(c.aaveClosedUsd)} (measured);{' '}
    {tone === 'recovered'
      ? `price came back under the line ${c.minutesToFirstCure !== null ? `${c.minutesToFirstCure} min after the breach` : 'inside the window'}, so Membrane would have closed ${usd(c.membraneClosedUsd)} (simulator)`
      : `still over the line at ${CURE_WINDOW_HOURS}h, so Membrane would have closed ${usd(c.membraneClosedUsd)} then (simulator)`}
  </Text>
)

const DelayAnswer: React.FC<{ census: CensusSummary | null }> = ({ census }) => {
  if (!census) return <Text {...small}>Census: source pending.</Text>
  const band = Math.round(MAX_THRESHOLD_TO_DELAY * 100)
  const rows: { label: string; n: number; tone: 'good' | 'bad' }[] = [
    { label: 'recovered', n: census.recovered, tone: 'good' },
    { label: `sold at ${CURE_WINDOW_HOURS}h`, n: census.expired, tone: 'bad' },
    { label: `broke ${band}% band`, n: census.brokeBand, tone: 'bad' },
    { label: 'no window', n: census.atT0, tone: 'bad' },
    { label: 'data ended', n: census.gridEnd, tone: 'bad' },
  ]
  return (
    <Box display="grid" gap={0}>
      <Text {...small} {...tabularNums} mb={SPACING.xs}>
        {census.walked.toLocaleString('en-US')} walked, would have (simulator)
      </Text>
      {rows.map((r) => (
        <Box key={r.label} display="flex" justifyContent="space-between" gap={SPACING.md} borderTop={rule} py={SPACING.xs}>
          <Text {...small} color={SEMANTIC_COLORS.textPrimary}>
            <Text as="span" color={r.tone === 'good' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
              {r.tone === 'good' ? '●' : '✖'}
            </Text>{' '}
            {r.label}
          </Text>
          <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
            {r.n.toLocaleString('en-US')}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

const DelayDetails: React.FC<{ census: CensusSummary }> = ({ census }) => (
  <>
    <DetailLine>
      Aave accounts liquidated {census.window}. Membrane’s window walked minute by minute on the {census.walked.toLocaleString('en-US')} whose
      collateral has a price series (simulator). “No window”: already past the band at the first print, would have sold at once. “Data ended”:
      the price path ended mid-window and a sale is booked.
    </DetailLine>
    <DetailLine>
      Not walked: {census.unpricedAtT0.toLocaleString('en-US')} more on collateral with no price series, credited one repay to cap at the first print (simulator).
    </DetailLine>
    {census.recoveredExample && <CaseLine c={census.recoveredExample} tone="recovered" />}
    {census.failedExample && <CaseLine c={census.failedExample} tone="failed" />}
    <DetailLine>The delay buys time. Where the price did not come back, the sale would still have happened.</DetailLine>
  </>
)

export const ObjectionCards: React.FC<{ census: CensusSummary | null }> = ({ census }) => (
  <Box as="section" aria-labelledby="landing-objections" data-story="Y" display="grid" gap={SPACING.md}>
    <Text id="landing-objections" as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '22px', md: '28px' }} fontWeight={TYPOGRAPHY.normal}>
      Yes, but…
    </Text>
    <Box
      display="grid"
      gridTemplateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }}
      columnGap={SPACING.lg}
      rowGap={SPACING.lg}
    >
      {OBJECTIONS.map((o) => (
        <Box
          key={o.id}
          data-testid={`objection-${o.id}`}
          borderTop={ruleStrong}
          pt={SPACING.sm}
          display="grid"
          gap={SPACING.xs}
          alignContent="start"
          minW={0}
        >
          <Text as="h3" data-role="title" fontFamily={TYPOGRAPHY.fontDisplay} fontStyle="italic" fontSize="19px" fontWeight={TYPOGRAPHY.normal}>
            {o.question}
          </Text>
          {o.id === 'delay' ? (
            <DelayAnswer census={census} />
          ) : (
            <Text {...small} color={SEMANTIC_COLORS.textPrimary}>
              {o.answer}
            </Text>
          )}
          {o.pendingShort?.map((p) => (
            <Text key={p} {...small} data-testid="objection-pending">
              {p}
            </Text>
          ))}
          <Box display="flex" gap={SPACING.md} alignItems="center" flexWrap="wrap">
            <Text {...kicker}>
              <NextLink href={o.href} title={o.hrefLabel} style={{ textDecoration: 'underline' }}>
                Data →
              </NextLink>
            </Text>
          </Box>
          <Details testId={`objection-${o.id}-details`}>
            {o.id === 'delay' && census && <DelayDetails census={census} />}
            {o.facts.map((f) => (
              <DetailLine key={f.text}>
                {f.text}
                {(f.cites?.length || f.source) && (
                  <>
                    {' — '}
                    {[...(f.cites ?? []).map(citeText), ...(f.source ? [f.source] : [])].join(' · ')}
                  </>
                )}
              </DetailLine>
            ))}
            {o.pending?.map((p) => (
              <DetailLine key={p}>{p}</DetailLine>
            ))}
            {o.facts.some((f) => f.cites?.length) && <DetailLine>Contract lines: membrane-solidity master @ {SOLIDITY_PIN}</DetailLine>}
          </Details>
        </Box>
      ))}
    </Box>
  </Box>
)

export default ObjectionCards
