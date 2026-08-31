import React from 'react'
import NextLink from 'next/link'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'

import { DemoAwareCta } from '@/components/demo'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Stamp } from './atoms'
import { Preset } from './types'

export interface HeroProps {
  chainName: string
  amount: string
  onAmountChange: (v: string) => void
  presets: Preset[]
  selectedPreset: number
  onSelectPreset: (i: number) => void
  onOpenCarry: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
}

export const Hero: React.FC<HeroProps> = ({
  chainName,
  amount,
  onAmountChange,
  presets,
  selectedPreset,
  onSelectPreset,
  onOpenCarry,
  advancedOpen,
  onToggleAdvanced,
}) => (
  <Box>
    <Eyebrow>Carry</Eyebrow>
    <Text
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontSize={TYPOGRAPHY.h1}
      color={SEMANTIC_COLORS.textPrimary}
      letterSpacing="-0.01em"
      mt={SPACING.sm}
    >
      Borrow against dollars that keep earning.
    </Text>
    <Stamp>
      Carry borrows CDT and routes it through venues in the same motion — the root system of the network.
      Venue yield flows to lenders, which holds the loan’s cost down, and every closed route feeds the core
      that funds the borrowing side; neither side extracts from the other. Plain debt, minted to your wallet
      and deployed nowhere, is{' '}
      <NextLink href={`/${chainName}/borrow`} passHref legacyBehavior>
        <Text as="a" color={SEMANTIC_COLORS.success}>
          Borrow
        </Text>
      </NextLink>
      .
    </Stamp>

    <Card
      mt={SPACING.md}
      p={SPACING.lg}
      display="flex"
      flexWrap="wrap"
      alignItems="stretch"
      gap={SPACING.base}
    >
      {/* Amount */}
      <Box>
        <Eyebrow>Amount</Eyebrow>
        <Flex align="baseline" gap={SPACING.sm} mt={SPACING.xs}>
          <Input
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            inputMode="numeric"
            aria-label="Equity, USD"
            w="150px"
            borderRadius={0}
            bg={SEMANTIC_COLORS.bgTertiary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="22px"
            textAlign="right"
            px={SPACING.sm}
            py={SPACING.sm}
            _focus={FOCUS_STYLES.ring}
          />
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
            USD
          </Text>
        </Flex>
      </Box>

      {/* Presets */}
      <Flex role="radiogroup" aria-label="Risk preset" gap={SPACING.sm} flex={1} minW="300px">
        {presets.map((p, i) => (
          <Box
            key={p.id + i}
            as="button"
            type="button"
            role="radio"
            aria-checked={i === selectedPreset}
            textAlign="left"
            flex={1}
            display="grid"
            gap="3px"
            bg={i === selectedPreset ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
            border="1px solid"
            borderColor={i === selectedPreset ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
            borderRadius={0}
            color={SEMANTIC_COLORS.textPrimary}
            px={SPACING.md}
            py="10px"
            cursor="pointer"
            transition={TRANSITIONS.colors}
            _hover={{ borderColor: SEMANTIC_COLORS.success }}
            _focus={FOCUS_STYLES.ring}
            onClick={() => onSelectPreset(i)}
          >
            <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.small}>
              {p.nm}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.5}>
              {p.pd}
            </Text>
          </Box>
        ))}
      </Flex>

      {/* Open carry */}
      <DemoAwareCta
        onAction={onOpenCarry}
        alignSelf="center"
        bg={SEMANTIC_COLORS.success}
        color={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.success}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        letterSpacing="0.14em"
        textTransform="uppercase"
        px={SPACING.lg}
        py={SPACING.base}
        _hover={{ bg: SEMANTIC_COLORS.success }}
      >
        Open carry
      </DemoAwareCta>
    </Card>

    <Stamp>
      One decision. The preset picks collateral, leverage, and the venue mix together — they are the same
      risk axis — and the confirmation lists every choice it made for you.{' '}
      <Button
        as="span"
        variant="unstyled"
        display="inline"
        h="auto"
        minW={0}
        verticalAlign="baseline"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9px"
        letterSpacing="0.12em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.success}
        textDecoration="underline"
        cursor="pointer"
        ml={SPACING.sm}
        _focus={FOCUS_STYLES.ring}
        onClick={onToggleAdvanced}
      >
        {advancedOpen ? 'hide the pickers' : 'customize each piece instead'}
      </Button>
    </Stamp>
  </Box>
)

export default Hero
