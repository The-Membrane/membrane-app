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

import { credit, kicker, rule, ruleStrong, small, tabularNums } from './styles'

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
  if (!census) return <Text {...small}>Census unavailable on this load · source pending.</Text>
  const band = Math.round(MAX_THRESHOLD_TO_DELAY * 100)
  const rows: { label: string; n: number; tone: 'good' | 'bad' }[] = [
    { label: 'price came back inside the window; would never have sold', n: census.recovered, tone: 'good' },
    { label: `still over the line at ${CURE_WINDOW_HOURS}h; would have sold then`, n: census.expired, tone: 'bad' },
    { label: `fell through the ${band}% band; would have sold that minute`, n: census.brokeBand, tone: 'bad' },
    { label: 'already past the band at the first print; no window, would have sold at once', n: census.atT0, tone: 'bad' },
    { label: 'price data ended mid-window; a sale is booked', n: census.gridEnd, tone: 'bad' },
  ]
  return (
    <Box display="grid" gap={SPACING.xs}>
      <Text {...small}>
        Aave accounts liquidated {census.window}. Membrane’s window walked minute by minute on the{' '}
        {census.walked.toLocaleString('en-US')} whose collateral has a price series (simulator):
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
      <Text {...small} {...tabularNums} data-testid="census-unpriced">
        Not walked: {census.unpricedAtT0.toLocaleString('en-US')} more on collateral with no price series, credited one repay to cap at the first print (simulator).
      </Text>
      {census.recoveredExample && <CaseLine c={census.recoveredExample} tone="recovered" />}
      {census.failedExample && <CaseLine c={census.failedExample} tone="failed" />}
      <Text {...small}>The delay buys time. Where the price did not come back, the sale would still have happened.</Text>
    </Box>
  )
}

export const ObjectionCards: React.FC<{ census: CensusSummary | null }> = ({ census }) => (
  <Box as="section" aria-labelledby="landing-objections" display="grid" gap={SPACING.md}>
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
          gap={SPACING.sm}
          alignContent="start"
          minW={0}
          gridColumn={o.id === 'delay' ? { md: '1 / -1', xl: 'span 2' } : undefined}
        >
          <Text as="h3" fontFamily={TYPOGRAPHY.fontDisplay} fontStyle="italic" fontSize="19px" fontWeight={TYPOGRAPHY.normal}>
            {o.question}
          </Text>
          {o.id === 'delay' ? (
            <DelayAnswer census={census} />
          ) : (
            o.facts.map((f) => (
              <Box key={f.text}>
                <Text {...small} color={SEMANTIC_COLORS.textPrimary}>
                  {f.text}
                </Text>
                {(f.cites?.length || f.source) && (
                  <Text {...credit} textAlign="left">
                    {[...(f.cites ?? []).map(citeText), ...(f.source ? [f.source] : [])].join(' · ')}
                  </Text>
                )}
              </Box>
            ))
          )}
          {o.pending?.map((p) => (
            <Text key={p} {...small} color={SEMANTIC_COLORS.textSecondary} data-testid="objection-pending">
              — {p}
            </Text>
          ))}
          {o.facts.some((f) => f.cites?.length) && (
            <Text {...credit} textAlign="left" data-testid="objection-pin">
              contract lines: membrane-solidity master @ {SOLIDITY_PIN}
            </Text>
          )}
          <Text {...kicker}>
            <NextLink href={o.href} style={{ textDecoration: 'underline' }}>
              Data: {o.hrefLabel} →
            </NextLink>
          </Text>
        </Box>
      ))}
    </Box>
  </Box>
)

export default ObjectionCards
