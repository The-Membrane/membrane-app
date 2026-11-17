import React, { useEffect, useState } from 'react'
import { Box, SimpleGrid, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { Eyebrow } from '@/components/Evidence/atoms'

import { usd2 } from './liqmapLogic'

// Where each asset is cheapest to borrow right now (Aave V3, Spark, Compound v3 on
// Ethereum). Protocol-scoped and LIVE in demo and connected states (V20). The cash
// available sits next to every rate: a cheap quote with little cash is shown as thin.

type Quote = {
  venue: string
  borrowApr: number
  availableUsd: number
  utilization: number | null
  spread: number
}
type Doc = { readAt: string; assets: { asset: string; quotes: Quote[] }[] }

const pct = (v: number, dp = 2) => `${(v * 100).toFixed(dp)}%`
const THIN_USD = 25_000_000

export const BorrowBoard: React.FC = () => {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/borrow-rates')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('read failed'))))
      .then((d: Doc) => live && setDoc(d))
      .catch(() => live && setErr(true))
    return () => {
      live = false
    }
  }, [])

  return (
    <Card variant="default" p={SPACING_PATTERNS.cardPadding}>
      <VStack align="stretch" spacing={SPACING.sm}>
        <Eyebrow>06 / Cheapest place to borrow · Ethereum · live</Eyebrow>
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
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.base}>
              {doc.assets.map((a) => (
                <Box
                  key={a.asset}
                  borderTop="1px solid"
                  borderColor={SEMANTIC_COLORS.hairline}
                  pt={SPACING.sm}
                >
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {a.asset}
                  </Text>
                  {a.quotes.map((q, i) => {
                    const thin = q.availableUsd < THIN_USD
                    return (
                      <Box
                        key={q.venue}
                        display="grid"
                        gridTemplateColumns="1fr auto auto"
                        columnGap={SPACING.base}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        py={SPACING.xs}
                        color={
                          i === 0 ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary
                        }
                      >
                        <Text>{q.venue}</Text>
                        <Text
                          textAlign="right"
                          color={i === 0 ? SEMANTIC_COLORS.success : undefined}
                        >
                          {pct(q.borrowApr)}
                          {i > 0 ? ` (+${pct(q.spread)})` : ''}
                        </Text>
                        <Text
                          textAlign="right"
                          color={thin ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textTertiary}
                        >
                          {usd2(q.availableUsd)} cash{thin ? ' · thin' : ''}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              ))}
            </SimpleGrid>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              measured · variable borrow APR and cash available now · read{' '}
              {doc.readAt.replace('T', ' ').slice(0, 16)} UTC · a large borrow raises the rate it
              pays; collateral rules differ by venue
            </Text>
          </>
        )}
      </VStack>
    </Card>
  )
}

export default BorrowBoard
