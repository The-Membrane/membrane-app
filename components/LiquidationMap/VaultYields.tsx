import React, { useEffect, useState } from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { Eyebrow } from '@/components/Evidence/atoms'

import { usd2 } from './liqmapLogic'
import type { VaultRow } from './marketsLogic'

// Where depositors earn: the largest Morpho curator vaults on Ethereum, net APY and
// size. The benchmark a Membrane curator or savings vault competes with. LIVE (V20).

export const VaultYields: React.FC = () => {
  const [rows, setRows] = useState<VaultRow[] | null>(null)
  const [at, setAt] = useState('')
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/vault-yields')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('read failed'))))
      .then((d: { vaults: VaultRow[]; readAt: string }) => {
        if (!live) return
        setRows(d.vaults)
        setAt(d.readAt)
      })
      .catch(() => live && setErr(true))
    return () => {
      live = false
    }
  }, [])
  return (
    <Card variant="default" p={SPACING_PATTERNS.cardPadding} overflowX="auto">
      <VStack align="stretch" spacing={SPACING.sm}>
        <Eyebrow>08 / Where depositors earn · largest curator vaults · live</Eyebrow>
        {err ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.dangerText}
          >
            Live read failed. Reload to retry.
          </Text>
        ) : !rows ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            Reading…
          </Text>
        ) : (
          <>
            <Box
              as="table"
              w="100%"
              minW="480px"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
            >
              <Box as="thead">
                <Box as="tr" color={SEMANTIC_COLORS.textTertiary}>
                  <Box as="th" textAlign="left" fontWeight="normal" py={SPACING.xs}>
                    VAULT
                  </Box>
                  <Box as="th" textAlign="left" fontWeight="normal">
                    ASSET
                  </Box>
                  <Box as="th" textAlign="right" fontWeight="normal">
                    NET APY
                  </Box>
                  <Box as="th" textAlign="right" fontWeight="normal">
                    SIZE
                  </Box>
                </Box>
              </Box>
              <Box as="tbody">
                {rows.map((v) => (
                  <Box
                    as="tr"
                    key={`${v.version}:${v.name}`}
                    borderTop="1px solid"
                    borderColor={SEMANTIC_COLORS.hairline}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    <Box as="td" py={SPACING.xs}>
                      {v.name}
                    </Box>
                    <Box as="td" color={SEMANTIC_COLORS.textSecondary}>
                      {v.asset}
                    </Box>
                    <Box as="td" textAlign="right">
                      {(v.netApy * 100).toFixed(2)}%
                    </Box>
                    <Box as="td" textAlign="right">
                      {usd2(v.tvlUsd)}
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              measured · Morpho public API, Ethereum vaults (V1 listed and V2), at least $10M · read{' '}
              {at.replace('T', ' ').slice(0, 16)} UTC · net of curator fee; APY, variable
            </Text>
          </>
        )}
      </VStack>
    </Card>
  )
}

export default VaultYields
