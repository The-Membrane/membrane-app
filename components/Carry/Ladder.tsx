import React from 'react'
import NextLink from 'next/link'
import { Box, Flex, Grid, Input, Text } from '@chakra-ui/react'

import { DemoAwareCta } from '@/components/demo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Stamp } from './atoms'
import { COLL, LEV } from './fixtures'
import { ladderStamp, rungMetrics } from './utils'

export interface LadderProps {
  chainName: string
  selColl: number
  rung: number
  onSelectRung: (i: number) => void
  amount: string
  onAmountChange: (v: string) => void
  /** Open the confirm sheet for a given rung index. */
  onOpenRung: (rungIndex: number) => void
}

export const Ladder: React.FC<LadderProps> = ({
  chainName,
  selColl,
  rung,
  onSelectRung,
  amount,
  onAmountChange,
  onOpenRung,
}) => {
  const c = COLL[selColl]

  return (
    <Box>
      <Flex align="baseline" gap={SPACING.md} flexWrap="wrap" mt={SPACING.xl} mb={SPACING.sm}>
        <Eyebrow>02 /</Eyebrow>
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary} letterSpacing="-0.01em">
          Leverage, carry, and survival
        </Text>
        <Flex align="baseline" gap={SPACING.sm} ml="auto" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textSecondary}>
          Equity
          <Input
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            inputMode="numeric"
            aria-label="Equity amount, USD"
            w="90px"
            borderRadius={0}
            bg={SEMANTIC_COLORS.bgTertiary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            textAlign="right"
            px="7px"
            py={SPACING.xs}
            _focus={FOCUS_STYLES.ring}
          />
          USD
        </Flex>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary} w="100%">
          net carry is on your equity, at today’s rates · survival is against the measured 1-in-1000 8-hour move
        </Text>
      </Flex>

      <Box mt={SPACING.base}>
        {LEV.map((L, i) => {
          const m = rungMetrics(c, L)
          const on = i === rung
          const tagColor = m.danger ? SEMANTIC_COLORS.warning : on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary
          return (
            <Grid
              key={L}
              templateColumns={{ base: '52px 1fr', md: '66px 1.1fr 1.4fr auto auto' }}
              gap={SPACING.base}
              alignItems="center"
              px={on ? '12px' : SPACING.md}
              py="13px"
              cursor="pointer"
              bg={on ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              borderBottom={i === LEV.length - 1 ? '1px solid' : 'none'}
              borderLeft={on ? '3px solid' : '1px solid'}
              borderLeftColor={on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
              transition={TRANSITIONS.colors}
              _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
              onClick={() => onSelectRung(i)}
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="19px" color={SEMANTIC_COLORS.textPrimary}>
                {L}×
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.success}>
                +{m.carry.toFixed(1)}% / yr
                <Text as="span" display="block" fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                  on equity · {(m.ltv * 100).toFixed(0)}% LTV
                </Text>
              </Text>
              {/* Survival bar: 1-in-1000 move vs room, with a max-move marker */}
              <Box display="grid" gap={SPACING.xs} gridColumn={{ base: '1 / -1', md: 'auto' }}>
                <Box position="relative" h="7px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                  <Box position="absolute" left={0} top={0} bottom={0} bg={SEMANTIC_COLORS.info} w={`${m.roomUsed.toFixed(1)}%`} />
                  <Box position="absolute" top="-3px" bottom="-3px" w="2px" bg={SEMANTIC_COLORS.warning} left="100%" />
                </Box>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                  the 1-in-1000 move uses {m.roomUsed.toFixed(0)}% of your room — {m.cover.toFixed(0)}× covered
                </Text>
              </Box>
              <Text
                display={{ base: 'none', md: 'block' }}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="9px"
                letterSpacing="0.18em"
                textTransform="uppercase"
                color={tagColor}
                border="1px solid"
                borderColor={m.danger ? SEMANTIC_COLORS.warning : on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
                px="8px"
                py="3px"
                justifySelf="start"
              >
                {m.danger ? 'thin' : 'measured'}
              </Text>
              {/* Wrapper stops the click from also re-selecting the rung (proto's rungGo stopPropagation). */}
              <Box onClick={(e) => e.stopPropagation()} justifySelf="end">
                <DemoAwareCta
                  onAction={() => onOpenRung(i)}
                  bg={SEMANTIC_COLORS.success}
                  color={SEMANTIC_COLORS.bgPrimary}
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.success}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="9.5px"
                  letterSpacing="0.14em"
                  textTransform="uppercase"
                  px="11px"
                  py="6px"
                  h="auto"
                  _hover={{ bg: SEMANTIC_COLORS.success }}
                >
                  Open carry
                </DemoAwareCta>
              </Box>
            </Grid>
          )
        })}
      </Box>

      <Stamp>{ladderStamp(c)}</Stamp>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="74ch"
        lineHeight={1.7}
        mt={SPACING.md}
      >
        Carry-venue yield flows to lenders — that is what holds the loan’s cost down, at today’s rates. The
        survival column is measured against six years of 8-hour moves, not against a feeling. Venue mixes are
        edited on the{' '}
        <NextLink href={`/${chainName}/builder`} passHref legacyBehavior>
          <Text as="a" color={SEMANTIC_COLORS.success}>
            Builder board
          </Text>
        </NextLink>{' '}
        — the same three slots, with the gauntlet to test them.
      </Text>
    </Box>
  )
}

export default Ladder
