// THE WATERFALL — who eats a loss, in order, on each design.
//
// Two stacks side by side. Each stack is drawn as hairline-bordered cells butted
// against each other, because the claim IS the order: the top cell absorbs first and
// the borrower's place in the column is the whole argument.
//
// Left = Membrane's verified cascade (Cdp._absorbBadDebt). Right = pooled lending,
// where the borrower is the first cell. Every line comes from facts.ts.

import { Box, SimpleGrid, HStack, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import BondCoverage, { Cite } from './BondCoverage'
import {
  MEMBRANE_WATERFALL,
  SUPPLY_SIDE_WATERFALL,
  WATERFALL_FLOOR,
  type WaterfallStep,
} from './facts'

/** The gold inline tag on step 1. Marks a layer that exists and holds nothing yet. */
const Tag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    textTransform="uppercase"
    letterSpacing="0.2em"
    color={SEMANTIC_COLORS.warning}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.warning}
    px={SPACING.sm}
    py="2px"
    whiteSpace="nowrap"
  >
    {children}
  </Text>
)

const StepCell: React.FC<{
  index: number
  step: WaterfallStep
  tone: 'default' | 'danger'
  tag?: string
}> = ({ index, step, tone, tag }) => (
  <Box
    px={SPACING_PATTERNS.cardPadding}
    py={SPACING_PATTERNS.cardPadding}
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    _last={{ borderBottom: 'none' }}
  >
    <VStack align="flex-start" spacing={SPACING.sm}>
      <HStack align="baseline" spacing={SPACING.md} flexWrap="wrap">
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textTertiary}
        >
          {String(index + 1).padStart(2, '0')}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.body}
          fontWeight={TYPOGRAPHY.medium}
          color={tone === 'danger' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
        >
          {step.label}
        </Text>
        {tag ? <Tag>{tag}</Tag> : null}
      </HStack>

      <Eyebrow color={tone === 'danger' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textSecondary}>
        {step.who}
      </Eyebrow>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textPrimary}
        lineHeight="1.7"
      >
        {step.how}
      </Text>

      <Cite>{step.cite}</Cite>
    </VStack>
  </Box>
)

const Column: React.FC<{
  title: string
  steps: WaterfallStep[]
  /** Index of the step drawn in danger — the borrower. */
  dangerIndex?: number
  tags?: Record<number, string>
  children?: React.ReactNode
}> = ({ title, steps, dangerIndex, tags, children }) => (
  <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
    <Text
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontSize={TYPOGRAPHY.h3}
      fontWeight={TYPOGRAPHY.semibold}
      color={SEMANTIC_COLORS.textPrimary}
    >
      {title}
    </Text>

    <Box
      as="ol"
      listStyleType="none"
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      bg={SEMANTIC_COLORS.bgSecondary}
    >
      {steps.map((s, i) => (
        <Box as="li" key={s.label}>
          <StepCell
            index={i}
            step={s}
            tone={i === dangerIndex ? 'danger' : 'default'}
            tag={tags?.[i]}
          />
        </Box>
      ))}
      {children}
    </Box>
  </VStack>
)

export const Waterfall: React.FC<{ num?: string }> = ({ num = '01' }) => (
  <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
    <Eyebrow>{num} / The waterfall</Eyebrow>

    <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING_PATTERNS.sectionGap}>
      <Column title="Membrane" steps={MEMBRANE_WATERFALL} tags={{ 0: 'empty at launch' }}>
        <VStack
          align="flex-start"
          spacing={SPACING.xs}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.success}
          pt={SPACING_PATTERNS.cardPadding}
        >
          {/* The fifth layer is the borrower, and the cascade stops above it. Drawn as a
              cell so the two columns contrast spatially: Pooled lending puts YOU at the
              top in blood; here you sit under four layers, in phosphor. */}
          <HStack spacing={SPACING.sm} align="baseline">
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              letterSpacing="0.28em"
              color={SEMANTIC_COLORS.success}
            >
              05
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.body}
              fontWeight={TYPOGRAPHY.medium}
              color={SEMANTIC_COLORS.success}
            >
              You
            </Text>
          </HStack>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            letterSpacing="0.28em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.success}
          >
            borrower
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.success}
            lineHeight="1.7"
          >
            {WATERFALL_FLOOR.line}
          </Text>
          <Cite>{WATERFALL_FLOOR.cite}</Cite>
        </VStack>
      </Column>

      <Column title="Pooled lending" steps={SUPPLY_SIDE_WATERFALL} dangerIndex={0} />
    </SimpleGrid>

    <BondCoverage />
  </VStack>
)

export default Waterfall
