import React, { useEffect, useState } from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { Eyebrow } from '@/components/Evidence/atoms'

import { usd2 } from './liqmapLogic'

// Instant exit cost for the largest loop collateral (wstETH, weETH): a sale into WETH
// split across Uniswap and Curve, against the oracle's fair value. LIVE (V20).

type Doc = {
  readAt: string
  lidoQueueUsd: number
  rows: {
    symbol: string
    venues: string[]
    sizes: { usd: number; lossPct: number; shares: number[] }[]
  }[]
}

export const UnwindCost: React.FC = () => {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/unwind')
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
        <Eyebrow>09 / Instant exit cost · loop collateral into WETH · live</Eyebrow>
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
            Quoting…
          </Text>
        ) : (
          <>
            <Box
              as="table"
              w="100%"
              minW="420px"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
            >
              <Box as="thead">
                <Box as="tr" color={SEMANTIC_COLORS.textTertiary}>
                  <Box as="th" textAlign="left" fontWeight="normal" py={SPACING.xs}>
                    SELL
                  </Box>
                  {doc.rows[0]?.sizes.map((s) => (
                    <Box as="th" key={s.usd} textAlign="right" fontWeight="normal">
                      {usd2(s.usd)}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box as="tbody">
                {doc.rows.map((r) => (
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
                    {r.sizes.map((s) => (
                      <Box
                        as="td"
                        key={s.usd}
                        textAlign="right"
                        color={s.lossPct > 0.01 ? SEMANTIC_COLORS.dangerText : undefined}
                      >
                        {(s.lossPct * 100).toFixed(2)}%
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            </Box>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              Loss vs the oracle&apos;s fair value, split greedily across Uniswap V3 and the main
              Curve pool. Aggregators and other venues can do somewhat better; past the pools&apos;
              depth the cheap exit is the withdrawal queue (Lido backlog now{' '}
              {usd2(doc.lidoQueueUsd)}, days to clear). measured · read{' '}
              {doc.readAt.replace('T', ' ').slice(0, 16)} UTC
            </Text>
          </>
        )}
      </VStack>
    </Card>
  )
}

export default UnwindCost
