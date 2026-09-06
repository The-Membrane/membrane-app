import React from 'react'
import { Box, Grid, HStack, Text, Tooltip, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { DemoAwareCta, MockStamp } from '@/components/demo'

import { ShopOption } from './types'
import { SHOP_OPTIONS } from './fixtures'
import { buildListRequest } from './utils'
import { useExecutionSheet } from './hooks/useExecutionSheet'

const InfoTip: React.FC<{ tip: string }> = ({ tip }) => (
  <Tooltip
    label={tip}
    placement="top"
    bg={SEMANTIC_COLORS.bgSecondary}
    color={SEMANTIC_COLORS.textSecondary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    borderRadius={0}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    p={SPACING.sm}
    hasArrow={false}
  >
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      w="13px"
      h="13px"
      ml={SPACING.xs}
      fontSize="10px"
      color={SEMANTIC_COLORS.textSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      cursor="help"
      tabIndex={0}
      _focus={FOCUS_STYLES.ring}
    >
      i
    </Box>
  </Tooltip>
)

const ShopCard: React.FC<{ option: ShopOption }> = ({ option }) => {
  const { open } = useExecutionSheet()

  return (
    <Card variant="default" as="article" display="grid" gap={SPACING.sm}>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h4} color={SEMANTIC_COLORS.textPrimary}>
        {option.sym}
      </Text>

      <HStack justify="space-between" fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
        <HStack spacing={0}>
          <Text as="span">1-in-1000 8h move</Text>
          <InfoTip
            tip={`Measured, not modelled: the worst 0.1% of rolling 8-hour price windows for this asset, 2019–2026 (${option.windowCount.toLocaleString()} windows). Compare it to the 5.41% the cure window absorbs at max draw.`}
          />
        </HStack>
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
          &minus;{option.p999.toFixed(2)}%
        </Text>
      </HStack>

      <HStack justify="space-between" fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
        <HStack spacing={0}>
          <Text as="span">market size</Text>
          <InfoTip
            tip={`Circulating supply × price, read on-chain at the scan block (${option.src}). This bounds how much could ever migrate here; it is not demand.`}
          />
        </HStack>
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}>
          {option.mcap}
        </Text>
      </HStack>

      <HStack justify="space-between" fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
        <HStack spacing={0}>
          <Text as="span">projected revenue</Text>
          <InfoTip
            tip="A band because it is borrow demand, which nobody controls. Low end: this asset borrows at the utilisation of the weakest listed comparable. High end: borrowing hits the cap your stake sets. Your fee share of both, at current fee rates."
          />
        </HStack>
        <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.info} fontFamily={TYPOGRAPHY.fontMono}>
          {option.band} / yr
        </Text>
      </HStack>

      {/* Outline, one step below the hero's solid CTA (hierarchy: one
          dominant action per page). */}
      <DemoAwareCta
        onAction={() => open(buildListRequest(option.sym))}
        bg="transparent"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        color={SEMANTIC_COLORS.textPrimary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        textTransform="uppercase"
        letterSpacing="0.14em"
        transition={TRANSITIONS.colors}
        _hover={{ bg: 'transparent', color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
      >
        Stake to list
      </DemoAwareCta>
    </Card>
  )
}

/** Sect 05 "List a new collateral" — the permissionless listing shop window (proto :227-236, 307-334). */
export const ShopWindow: React.FC = () => {
  return (
    <VStack align="stretch" spacing={SPACING.md}>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} maxW="72ch" lineHeight={1.7}>
        Listing is permissionless: stake a junior tranche on an asset and it onboards at 40% LTV, with borrow
        capacity capped to your stake. Your capital is the underwriting — there is no vote and no committee,
        which is why the lock is long and stated up front.
      </Text>

      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }} gap={SPACING.md}>
        {SHOP_OPTIONS.map((option) => (
          <ShopCard key={option.sym} option={option} />
        ))}
      </Grid>

      <Box>
        <MockStamp label="mock" />
      </Box>
    </VStack>
  )
}

export default ShopWindow
