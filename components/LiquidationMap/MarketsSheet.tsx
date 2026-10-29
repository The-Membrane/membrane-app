import React, { useEffect, useState } from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { Eyebrow } from '@/components/Evidence/atoms'

import { usd2 } from './liqmapLogic'

// Market sheet for Aave V3 Ethereum: oracle feed type and gap to spot, feed age,
// what can be withdrawn now, utilization and the distance to the rate kink.
// Protocol-scoped and LIVE in demo and connected states alike (V20).

type Row = {
  symbol: string
  feedKind: string
  gapPct: number | null
  feedAgeS: number | null
  suppliedUsd: number
  withdrawableUsd: number
  utilization: number | null
  supplyApr: number
  borrowApr: number
  kink: number | null
  rateAt95: number | null
  borrowsToKinkUsd: number | null
}
type Carry = {
  collateral: string
  borrow: string
  yieldApr: number
  borrowApr: number
  spread: number
  at3x: number
  at5x: number
}
type Doc = { readAt: string; block: number; rows: Row[]; carry?: Carry[]; carryWindowDays?: number }

const pct = (v: number | null, dp = 1) => (v === null ? '—' : `${(v * 100).toFixed(dp)}%`)
const age = (s: number | null) =>
  s === null ? '—' : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`

const th = { as: 'th' as const, py: SPACING.xs, textAlign: 'right' as const, fontWeight: 'normal' }

export const MarketsSheet: React.FC = () => {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/aave-markets')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('read failed'))))
      .then((d: Doc) => live && setDoc(d))
      .catch(() => live && setErr(true))
    return () => {
      live = false
    }
  }, [])

  return (
    <Card variant="default" p={SPACING_PATTERNS.cardPadding} overflowX="auto">
      <VStack align="stretch" spacing={SPACING.sm}>
        <Eyebrow>05 / Aave V3 Ethereum markets · oracle, exit and rate kink · live</Eyebrow>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Withdrawable = cash in the pool now; a larger exit waits for repayments. Past the kink the
          borrow rate climbs on its steep slope.
        </Text>
        {err ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.dangerText}
          >
            Live read failed. Reload to retry.
          </Text>
        ) : !doc ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            Reading the chain…
          </Text>
        ) : (
          <>
            <Box as="table" w="100%" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs}>
              <Box as="thead">
                <Box as="tr" color={SEMANTIC_COLORS.textTertiary}>
                  <Box {...th} textAlign="left">
                    ASSET
                  </Box>
                  <Box {...th} textAlign="left">
                    ORACLE
                  </Box>
                  <Box {...th}>VS SPOT</Box>
                  <Box {...th}>FEED AGE</Box>
                  <Box {...th}>SUPPLIED</Box>
                  <Box {...th}>WITHDRAWABLE</Box>
                  <Box {...th}>UTIL</Box>
                  <Box {...th}>KINK</Box>
                  <Box {...th}>BORROW</Box>
                  <Box {...th}>AT 95%</Box>
                  <Box {...th}>TO KINK</Box>
                </Box>
              </Box>
              <Box as="tbody">
                {doc.rows.slice(0, 15).map((r) => {
                  const hot =
                    r.utilization !== null && r.kink !== null && r.utilization >= r.kink - 0.02
                  return (
                    <Box
                      as="tr"
                      key={r.symbol}
                      borderTop="1px solid"
                      borderColor={SEMANTIC_COLORS.hairline}
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      <Box as="td" py={SPACING.xs}>
                        {r.symbol}
                      </Box>
                      <Box as="td" color={SEMANTIC_COLORS.textSecondary}>
                        {r.feedKind}
                      </Box>
                      <Box as="td" textAlign="right">
                        {pct(r.gapPct, 2)}
                      </Box>
                      <Box as="td" textAlign="right">
                        {age(r.feedAgeS)}
                      </Box>
                      <Box as="td" textAlign="right">
                        {usd2(r.suppliedUsd)}
                      </Box>
                      <Box as="td" textAlign="right">
                        {usd2(r.withdrawableUsd)}
                      </Box>
                      <Box
                        as="td"
                        textAlign="right"
                        color={hot ? SEMANTIC_COLORS.warning : undefined}
                      >
                        {pct(r.utilization)}
                      </Box>
                      <Box as="td" textAlign="right" color={SEMANTIC_COLORS.textSecondary}>
                        {pct(r.kink, 0)}
                      </Box>
                      <Box as="td" textAlign="right">
                        {pct(r.borrowApr, 2)}
                      </Box>
                      <Box as="td" textAlign="right" color={SEMANTIC_COLORS.textSecondary}>
                        {pct(r.rateAt95, 1)}
                      </Box>
                      <Box as="td" textAlign="right">
                        {r.borrowsToKinkUsd === null
                          ? '—'
                          : r.borrowsToKinkUsd === 0
                            ? 'past'
                            : usd2(r.borrowsToKinkUsd)}
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            </Box>
            {doc.carry && doc.carry.length ? (
              <Box pt={SPACING.base}>
                <Eyebrow>Loop carry today · yield minus borrow</Eyebrow>
                <Box
                  as="table"
                  w="100%"
                  mt={SPACING.sm}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                >
                  <Box as="thead">
                    <Box as="tr" color={SEMANTIC_COLORS.textTertiary}>
                      <Box {...th} textAlign="left">
                        LOOP
                      </Box>
                      <Box {...th}>YIELD {doc.carryWindowDays}D</Box>
                      <Box {...th}>BORROW</Box>
                      <Box {...th}>SPREAD</Box>
                      <Box {...th}>AT 3X</Box>
                      <Box {...th}>AT 5X</Box>
                    </Box>
                  </Box>
                  <Box as="tbody">
                    {doc.carry.map((c) => (
                      <Box
                        as="tr"
                        key={c.collateral}
                        borderTop="1px solid"
                        borderColor={SEMANTIC_COLORS.hairline}
                        color={SEMANTIC_COLORS.textPrimary}
                      >
                        <Box as="td" py={SPACING.xs}>
                          {c.collateral} / {c.borrow}
                        </Box>
                        <Box as="td" textAlign="right">
                          {pct(c.yieldApr, 2)}
                        </Box>
                        <Box as="td" textAlign="right">
                          {pct(c.borrowApr, 2)}
                        </Box>
                        <Box
                          as="td"
                          textAlign="right"
                          color={
                            c.spread < 0 ? SEMANTIC_COLORS.dangerText : SEMANTIC_COLORS.success
                          }
                        >
                          {c.spread >= 0 ? '+' : ''}
                          {pct(c.spread, 2)}
                        </Box>
                        <Box as="td" textAlign="right">
                          {pct(c.at3x, 1)}
                        </Box>
                        <Box as="td" textAlign="right">
                          {pct(c.at5x, 1)}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                  mt={SPACING.xs}
                >
                  Yield = {doc.carryWindowDays}-day growth of the collateral&apos;s oracle ratio to
                  the borrowed asset, plus supply APR. Return on equity at 3x / 5x leverage before
                  fees and swap costs. A negative spread means leverage lowers the return. Trailing,
                  not a forecast.
                </Text>
              </Box>
            ) : null}
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              measured · Aave V3 Pool, oracle feeds and rate strategies; Binance spot · read{' '}
              {doc.readAt.replace('T', ' ').slice(0, 16)} UTC · block {doc.block} · &ldquo;to
              kink&rdquo; = new borrows that reach it
            </Text>
          </>
        )}
      </VStack>
    </Card>
  )
}

export default MarketsSheet
