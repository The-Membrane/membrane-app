import React from 'react'
import { Box, Link, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { CardView, ChangeItem } from '@/lib/oracleRegistry/apiTypes'

import { displayLabel, etherscanTx, fmtUtc, PROVIDER_LABEL } from './viewModel'

// Config changes for this asset's oracles, newest first: governance logs (CAPO caps, PT
// discount rates, market oracle sources, upgrades, Chronicle read grants) and any
// parameter that differs between two collected snapshots.

export const ChangesList: React.FC<{
  changes: ChangeItem[]
  cards: CardView[]
  days: number | null
}> = ({ changes, cards, days }) => {
  const byId = new Map(cards.map((c) => [c.id, c]))
  return (
    <Box as="section" aria-labelledby="oracle-changes" mt={SPACING.xl}>
      <Text
        id="oracle-changes"
        as="h2"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h3}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Config changes
        <Text
          as="span"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textTertiary}
          ml={SPACING.sm}
        >
          {days ? `${days}d` : ''} · {changes.length}
        </Text>
      </Text>
      {changes.length === 0 ? (
        <Text
          mt={SPACING.sm}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          none recorded{days ? ` in ${days} days` : ''}
        </Text>
      ) : (
        <Box as="ol" listStyleType="none" m={0} mt={SPACING.sm} p={0}>
          {changes.map((c) => {
            const entries = c.entryIds.map((id) => byId.get(id)).filter((x): x is CardView => !!x)
            return (
              <Box
                as="li"
                key={c.id}
                display="grid"
                gridTemplateColumns={{ base: '1fr', md: '96px 220px 1fr auto' }}
                columnGap={SPACING.base}
                rowGap="2px"
                py={SPACING.sm}
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
              >
                <Text color={SEMANTIC_COLORS.textTertiary}>
                  {c.origin === 'diff' && c.fromTs
                    ? `≤ ${fmtUtc(c.ts).slice(0, 10)}`
                    : fmtUtc(c.ts).slice(0, 10)}
                </Text>
                <Text color={SEMANTIC_COLORS.textSecondary} noOfLines={2}>
                  {entries.length
                    ? entries
                        .map((e) => `${PROVIDER_LABEL[e.provider]} · ${displayLabel(e)}`)
                        .join(' / ')
                    : c.entryIds.join(', ')}
                </Text>
                <Text color={SEMANTIC_COLORS.textPrimary}>
                  {c.title}
                  <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
                    {' '}
                    · {c.detail}
                  </Text>
                </Text>
                <Text color={SEMANTIC_COLORS.textTertiary} whiteSpace="nowrap">
                  {c.tx ? (
                    <Link
                      href={etherscanTx(c.tx)}
                      isExternal
                      color={SEMANTIC_COLORS.textSecondary}
                      _hover={{ color: SEMANTIC_COLORS.primary }}
                      _focusVisible={FOCUS_STYLES.ring}
                    >
                      block {c.block.toLocaleString('en-US')} ↗
                    </Link>
                  ) : c.origin === 'diff' && c.fromBlock != null ? (
                    `blocks ${c.fromBlock.toLocaleString('en-US')}–${c.block.toLocaleString('en-US')}`
                  ) : (
                    `block ${c.block.toLocaleString('en-US')}`
                  )}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

export default ChangesList
