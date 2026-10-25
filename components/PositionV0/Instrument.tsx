// BELOW THE FOLD, DENSE (DESIGN_RULES §5): the legs, health factor, LTV against the
// liquidation LTV, the modelling assumption and where every number was read.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { discoveryNote } from '@/lib/position-sim/adapters/types'
import { fmtAmount, fmtUsd, fmtUtc } from '@/lib/position/format'
import { priceDecimals } from '@/lib/position/liquidation'

import { Kicker, Mono, Section, Small } from './primitives'
import { CAPS, TYPE, BODY_MD } from './typeScale'
import { partialDiscovery, type PositionView, type ReadStatusItem } from './viewModel'

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '∞')
const amountDecimals = (amount: number) => (amount >= 1000 ? 2 : amount >= 1 ? 4 : 6)

const CELL = {
  fontFamily: NEWS_FONT.mono,
  fontSize: { base: TYPE.label, md: BODY_MD },
  py: '6px',
  px: '6px',
} as const
const HEAD = {
  ...CELL,
  ...CAPS,
  fontSize: TYPE.label,
  fontWeight: 700,
  color: NEWS.muted,
  textAlign: 'right' as const,
}

const Pair: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <Box display="grid" gap="2px" minW={0}>
    <Small {...CAPS}>{k}</Small>
    <Mono>{v}</Mono>
  </Box>
)

interface LegRow {
  side: 'Collateral' | 'Debt' | 'Supplied'
  address: string
  symbol: string
  amount: number
  price: number
  value: number
  last: string
}

export const Instrument: React.FC<{ view: PositionView; failures: ReadStatusItem[] }> = ({
  view,
  failures,
}) => {
  const p = view.position
  const m = view.metrics
  const rows: LegRow[] = [
    ...p.collateral.map((c) => ({
      side: 'Collateral' as const,
      address: c.address,
      symbol: c.symbol,
      amount: c.amount,
      price: c.priceUsd,
      value: c.valueUsd,
      last: `LT ${pct(c.liquidationThreshold)}`,
    })),
    ...p.debt.map((d) => ({
      side: 'Debt' as const,
      address: d.address,
      symbol: d.symbol,
      amount: d.amount,
      price: d.priceUsd,
      value: d.valueUsd,
      last: d.borrowApr === null ? 'APR not read' : `APR ${pct(d.borrowApr, 2)}`,
    })),
    // Lent into the market: not collateral, so no threshold and no line.
    ...(p.supplied ?? []).map((x) => ({
      side: 'Supplied' as const,
      address: x.address,
      symbol: x.symbol,
      amount: x.amount,
      price: x.priceUsd,
      value: x.valueUsd,
      last: 'lent, not collateral',
    })),
  ]
  const hfProtocol = Number.isFinite(p.healthFactor) ? p.healthFactor.toFixed(3) : '∞ (no debt)'

  return (
    // Folded to one line; opens in place. The figures are below the fold by design (§5).
    <Box
      as="details"
      data-news-section="instrument"
      id="instrument"
      minW={0}
      sx={{ '&[open] > summary .chev': { transform: 'rotate(90deg)' } }}
    >
      <Box
        as="summary"
        minH="44px"
        display="flex"
        alignItems="center"
        gap={SPACING.sm}
        cursor="pointer"
        listStyleType="none"
        borderBottom={`1px solid ${NEWS.rule}`}
        sx={{ '&::-webkit-details-marker': { display: 'none' } }}
      >
        <Kicker as="span">Position details</Kicker>
        <Text
          as="span"
          className="chev"
          color={NEWS.accent}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.label}
          aria-hidden="true"
        >
          →
        </Text>
      </Box>
      <Section id="instrument-body" pt={SPACING.md}>
        <Box
          display="grid"
          gridTemplateColumns={{ base: '1fr 1fr', md: 'repeat(4, 1fr)' }}
          gap={SPACING.base}
          minW={0}
        >
          <Pair k="Health factor" v={hfProtocol} />
          <Pair k="LTV / liquidation LTV" v={`${pct(p.ltv)} / ${pct(p.liquidationLtv)}`} />
          <Pair k="Collateral" v={fmtUsd(m.collateralUsd)} />
          <Pair k="Debt" v={fmtUsd(m.debtUsd)} />
        </Box>

        <Box as="table" w="100%" sx={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <Box as="thead">
            <Box as="tr" borderBottom={`1px solid ${NEWS.ruleStrong}`}>
              <Text as="th" {...HEAD} textAlign="left" pl={0}>
                Leg
              </Text>
              <Text as="th" {...HEAD}>
                Amount
              </Text>
              <Text as="th" {...HEAD}>
                Oracle $
              </Text>
              <Text as="th" {...HEAD} pr={0}>
                Value
              </Text>
            </Box>
          </Box>
          <Box as="tbody">
            {rows.map((r) => (
              <Box as="tr" key={`${r.side}-${r.address}`} borderBottom={`1px solid ${NEWS.rule}`}>
                <Text as="td" {...CELL} pl={0} color={NEWS.ink} overflowWrap="anywhere">
                  {r.symbol}
                  <Text as="span" display="block" fontSize={TYPE.label} color={NEWS.muted}>
                    {r.side} · {r.last}
                  </Text>
                </Text>
                <Text
                  as="td"
                  {...CELL}
                  textAlign="right"
                  color={NEWS.ink}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtAmount(r.amount, amountDecimals(r.amount))}
                </Text>
                <Text
                  as="td"
                  {...CELL}
                  textAlign="right"
                  color={NEWS.ink}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtUsd(r.price, Math.min(4, priceDecimals(r.price) + 2))}
                </Text>
                <Text
                  as="td"
                  {...CELL}
                  pr={0}
                  textAlign="right"
                  color={NEWS.ink}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtUsd(r.value)}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>

        <Box display="grid" gap={SPACING.xs}>
          {view.assumption && <Small>† modelled: {view.assumption}.</Small>}
          {!view.mapped.split.ok && (
            <Small color={NEWS.ink2}>
              ✖ Thresholds could not be split per asset: {view.mapped.split.reason}. Legs give
              health factor {view.mapped.split.legsHealthFactor.toFixed(3)};{' '}
              {view.label.split(' · ')[0]} reports{' '}
              {view.mapped.split.protocolHealthFactor.toFixed(3)}.
            </Small>
          )}
          <Small>
            Prices: {view.priceSource} · read {fmtUtc(p.provenance.at)} · {p.provenance.label} ·{' '}
            {p.provenance.block !== undefined ? `block ${p.provenance.block}` : 'no block number recorded'}
          </Small>
          {p.provenance.detail && (
            <Box as="details">
              <Small
                as="summary"
                cursor="pointer"
                minH="44px"
                display="flex"
                alignItems="center"
                color={NEWS.accent}
              >
                How this was read
              </Small>
              <Small overflowWrap="anywhere">{p.provenance.detail}</Small>
            </Box>
          )}
          {failures.map((f) =>
            f.state === 'error' ? (
              <Small key={f.protocol} color={NEWS.ink2} overflowWrap="anywhere">
                ✖ {f.label} failed: {f.message ?? 'no message'}
              </Small>
            ) : (
              <React.Fragment key={f.protocol}>
                {(f.skipped ?? []).map((s) => (
                  <Small key={`${f.protocol}:${s.market}`} color={NEWS.ink2} overflowWrap="anywhere">
                    ✖ {f.label}: {s.market} skipped: {s.reason}
                  </Small>
                ))}
                {f.discovery && partialDiscovery(f) && (
                  <Small color={NEWS.ink2} overflowWrap="anywhere">
                    ✖ {f.label}: {discoveryNote(f.discovery)}.
                  </Small>
                )}
              </React.Fragment>
            ),
          )}
        </Box>
      </Section>
    </Box>
  )
}
