import React from 'react'
import { Box, Grid, Text, HStack } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { fmt, fmtAmount } from './utils'
import type { CollateralAsset } from './types'

export interface WalletStripProps {
  assets: CollateralAsset[]
  selectedIndex: number
  onSelect: (index: number) => void
  onOracleClick: (sym: string) => void
}

/**
 * Wallet-scoped collateral picker, ported from public/proto/borrow.html's
 * `.wal` grid (lines ~143, 233-243): the page only ever offers what this
 * wallet already holds.
 */
export const WalletStrip: React.FC<WalletStripProps> = ({ assets, selectedIndex, onSelect, onOracleClick }) => {
  return (
    <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }} gap={SPACING.md} mt={SPACING.base}>
      {assets.map((a, i) => {
        const selected = i === selectedIndex
        return (
          <Card
            key={a.sym}
            variant={selected ? 'elevated' : 'subtle'}
            interactive
            onClick={() => onSelect(i)}
            position="relative"
            borderColor={selected ? SEMANTIC_COLORS.success : undefined}
            bg={selected ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
            p={SPACING.md}
            textAlign="left"
          >
            {/* Selection is readable at a glance from the corner mark, since
                a 1px hairline color change alone is too quiet on parchment. */}
            {selected && (
              <Text
                as="span"
                position="absolute"
                top={SPACING.xs}
                right={SPACING.sm}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10px"
                color={SEMANTIC_COLORS.success}
                aria-hidden="true"
              >
                ✓
              </Text>
            )}
            <HStack spacing={SPACING.xs}>
              <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h4} color={SEMANTIC_COLORS.textPrimary}>
                {a.sym}
              </Text>
              <Box
                as="span"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10px"
                letterSpacing="0.14em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                px={SPACING.xs}
                cursor="help"
                transition={TRANSITIONS.colors}
                _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
                _focus={FOCUS_STYLES.ring}
                tabIndex={0}
                role="button"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation()
                  onOracleClick(a.sym)
                }}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  e.stopPropagation()
                  onOracleClick(a.sym)
                }}
              >
                oracle
              </Box>
            </HStack>

            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} mt={SPACING.xs}>
              in wallet: {fmtAmount(a.bal, a.dp)} · {fmt(a.bal * a.px)}
            </Text>

            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt="3px">
              earns {a.yld.toFixed(1)}% while posted · line at{' '}
              {(a.M * 100).toFixed(0)}%
            </Text>
          </Card>
        )
      })}
    </Grid>
  )
}

export default WalletStrip
