// THE INSTRUMENT PANEL — the borrower tool suite (owner direction 2026-10-27, Q26-S1).
//
// The landing used to sell one tool, the liquidation delay. This band sells the set a
// borrower uses to run leverage well, and shows each tool as itself (ui-design-audit
// principle 4): the real HealthBar on a demo position that is at risk, so the real
// at-risk notice and its past-data line render; and that same position as a price
// ladder, so the alert, the line and the no-timer price read as three places on one
// axis instead of a paragraph.
//
// HONESTY. Every tool carries its status (facts.ts TOOL_STATUS_LABEL), verified on this
// branch: live, preview (built, demo position until launch), in the contracts, or coming.
// Sizing is approved and not built, so it renders as an empty frame with no figure.
// No probability and no confidence figure appear anywhere in this band.
//
// DEMO-FIRST (CLAUDE.md V20): fully populated with no wallet. The positions are fixtures
// and every one is stamped "demo position · not yours".

import { Box, Grid, HStack, Link, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import NextLink from 'next/link'
import React, { useMemo } from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { HealthBar } from '@/components/Position/HealthBar'
import { MockStamp } from '@/components/demo'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { fmtPrice } from '@/lib/positionAlerts/format'

import { TOOL_STATUS_LABEL, TOOLKIT, type Tool, type ToolStatus } from './facts'
import { toolkitDemo, type RungId } from './toolkitModel'

/**
 * Status reads before its word (principle 3): live is a solid phosphor frame, preview a
 * teal one, in-the-contracts a bone one, coming a dashed faint one.
 */
const STATUS_STYLE: Record<ToolStatus, { color: string; borderStyle: 'solid' | 'dashed' }> = {
  live: { color: SEMANTIC_COLORS.success, borderStyle: 'solid' },
  preview: { color: SEMANTIC_COLORS.info, borderStyle: 'solid' },
  contracts: { color: SEMANTIC_COLORS.textPrimary, borderStyle: 'solid' },
  coming: { color: SEMANTIC_COLORS.textTertiary, borderStyle: 'dashed' },
}

const StatusTag: React.FC<{ status: ToolStatus }> = ({ status }) => {
  const s = STATUS_STYLE[status]
  return (
    <Box
      as="span"
      display="inline-block"
      px={SPACING.sm}
      py={SPACING.xs}
      border="1px"
      borderStyle={s.borderStyle}
      borderColor={s.color}
      borderRadius={0}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.label}
      letterSpacing="0.28em"
      textTransform="uppercase"
      color={s.color}
      whiteSpace="nowrap"
      data-status={status}
    >
      {TOOL_STATUS_LABEL[status]}
    </Box>
  )
}

const ToolLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <Link
    as={NextLink}
    href={href}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    color={SEMANTIC_COLORS.success}
    textDecoration="underline"
    textUnderlineOffset="3px"
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.textPrimary }}
    _focusVisible={FOCUS_STYLES.ring}
    minH="44px"
    display="inline-flex"
    alignItems="center"
  >
    {children} →
  </Link>
)

/** Name + status on one row, the mechanism line under it. */
const ToolHead: React.FC<{ tool: Tool }> = ({ tool }) => (
  <VStack align="stretch" spacing={SPACING.sm}>
    <HStack justify="space-between" align="center" spacing={SPACING.sm} flexWrap="wrap">
      <Text
        as="h3"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h3}
        fontWeight={TYPOGRAPHY.semibold}
        color={SEMANTIC_COLORS.textPrimary}
        lineHeight="1.25"
      >
        {tool.name}
      </Text>
      <StatusTag status={tool.status} />
    </HStack>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.small}
      color={SEMANTIC_COLORS.textPrimary}
      lineHeight="1.6"
    >
      {tool.line}
    </Text>
  </VStack>
)

/** The single stamp line (Quiet rule) and the one link. */
const ToolFoot: React.FC<{ tool: Tool; chainName: string }> = ({ tool, chainName }) => (
  <VStack align="stretch" spacing={SPACING.xs} mt="auto">
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textTertiary}
      lineHeight="1.5"
      title={tool.cite}
    >
      Rests on: {tool.restsOn}
    </Text>
    {tool.href && tool.linkLabel && (
      <Box>
        <ToolLink href={`/${chainName}${tool.href}`}>{tool.linkLabel}</ToolLink>
      </Box>
    )}
  </VStack>
)

const RUNG_COLOR: Record<RungId, string> = {
  'at-risk': SEMANTIC_COLORS.warning,
  now: SEMANTIC_COLORS.textPrimary,
  line: SEMANTIC_COLORS.danger,
  immediate: SEMANTIC_COLORS.danger,
}

/**
 * The demo position as a vertical price ladder: one hairline rail, one tick per rung,
 * prices in mono on the right. The rail turns blood below the line, so the zone where the
 * reader acts now reads as a zone before any label is read.
 */
const PriceLadder: React.FC<{ demo: ReturnType<typeof toolkitDemo> }> = ({ demo }) => (
  <Box
    as="ol"
    listStyleType="none"
    position="relative"
    pl={SPACING.base}
    aria-label="Demo position price ladder"
  >
    {demo.rungs.map((r) => {
      const belowLine = r.id === 'line' || r.id === 'immediate'
      const isNow = r.id === 'now'
      return (
        <Box
          as="li"
          key={r.id}
          position="relative"
          display="flex"
          justifyContent="space-between"
          alignItems="baseline"
          gap={SPACING.sm}
          py={SPACING.sm}
          borderLeft="1px solid"
          borderColor={belowLine ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.borderStrong}
          pl={SPACING.md}
          data-rung={r.id}
        >
          {/* Tick: the position is a solid bar across the rail, every other rung a hairline. */}
          <Box
            position="absolute"
            left={isNow ? '-7px' : '-4px'}
            top="50%"
            w={isNow ? '14px' : '8px'}
            h={isNow ? '2px' : '1px'}
            bg={RUNG_COLOR[r.id]}
            aria-hidden
          />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={isNow ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
            fontWeight={isNow ? TYPOGRAPHY.medium : TYPOGRAPHY.normal}
          >
            {r.label}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={RUNG_COLOR[r.id]}
            fontWeight={isNow ? TYPOGRAPHY.bold : TYPOGRAPHY.medium}
            whiteSpace="nowrap"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {fmtPrice(r.priceUsd)}
          </Text>
        </Box>
      )
    })}
  </Box>
)

/** Sizing is not built: its frame, with every cell empty. The shape is the promise. */
const SizingFrame: React.FC = () => (
  <Box
    as="table"
    w="100%"
    border="1px dashed"
    borderColor={SEMANTIC_COLORS.borderMedium}
    sx={{ borderCollapse: 'collapse' }}
    aria-label="Leverage sizing, not built yet"
  >
    <Box as="thead">
      <Box as="tr">
        {['horizon', ...TOOLKIT.sizingFrame.columns].map((c) => (
          <Box
            as="th"
            key={c}
            textAlign="left"
            px={SPACING.sm}
            py={SPACING.xs}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            fontWeight={TYPOGRAPHY.normal}
            letterSpacing="0.28em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textTertiary}
            borderBottom="1px dashed"
            borderColor={SEMANTIC_COLORS.borderMedium}
          >
            {c}
          </Box>
        ))}
      </Box>
    </Box>
    <Box as="tbody">
      {TOOLKIT.sizingFrame.horizons.map((h) => (
        <Box as="tr" key={h}>
          <Box
            as="td"
            px={SPACING.sm}
            py={SPACING.xs}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            {h}
          </Box>
          {TOOLKIT.sizingFrame.columns.map((c) => (
            <Box
              as="td"
              key={c}
              px={SPACING.sm}
              py={SPACING.xs}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              —
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  </Box>
)

export const Toolkit: React.FC<{ num?: string }> = ({ num = '01' }) => {
  const { chainName } = useChainRoute()
  const demo = useMemo(() => toolkitDemo(), [])

  return (
    <VStack
      as="section"
      align="stretch"
      spacing={SPACING_PATTERNS.sectionGap}
      aria-labelledby="toolkit-title"
      data-testid="landing-toolkit"
    >
      <VStack align="flex-start" spacing={SPACING.sm}>
        <Eyebrow>
          {num} / {TOOLKIT.eyebrow}
        </Eyebrow>
        <Text
          as="h2"
          id="toolkit-title"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h2}
          fontWeight={TYPOGRAPHY.semibold}
          color={SEMANTIC_COLORS.textPrimary}
          lineHeight="1.25"
        >
          {TOOLKIT.title}
        </Text>
      </VStack>

      {/* The two objects: the bar with its alert, and the same position as prices. */}
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 7fr) minmax(0, 5fr)' }}
        gap={SPACING_PATTERNS.sectionGap}
      >
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing} minW={0}>
          <ToolHead tool={TOOLKIT.health} />
          <Box sx={{ '& #healthbar': { marginBottom: 0 } }}>
            <HealthBar snapshot={demo.snapshot} stamp={TOOLKIT.demoStamp} />
          </Box>
          <ToolFoot tool={TOOLKIT.health} chainName={chainName} />
        </VStack>

        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing} minW={0}>
          <ToolHead tool={TOOLKIT.timer} />
          <Card variant="default" p={{ base: SPACING.base, md: SPACING.lg }}>
            <VStack align="stretch" spacing={SPACING.md}>
              <HStack justify="space-between" align="baseline" flexWrap="wrap">
                <Eyebrow>Same position, as prices</Eyebrow>
                <MockStamp label={TOOLKIT.demoStamp} />
              </HStack>
              <PriceLadder demo={demo} />
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight="1.6"
                data-testid="toolkit-timer-explainer"
              >
                {demo.explainer}
              </Text>
            </VStack>
          </Card>
          <ToolFoot tool={TOOLKIT.timer} chainName={chainName} />
        </VStack>
      </Grid>

      {/* The index: every other tool, one card each, status first. */}
      <SimpleGrid columns={{ base: 1, md: 2, xl: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
        {TOOLKIT.index.map((tool) => (
          <Card
            key={tool.id}
            variant={tool.status === 'coming' ? 'subtle' : 'default'}
            p={SPACING_PATTERNS.cardPadding}
            borderStyle={tool.status === 'coming' ? 'dashed' : 'solid'}
            data-tool={tool.id}
          >
            <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing} h="100%">
              <ToolHead tool={tool} />
              {tool.id === 'sizing' && <SizingFrame />}
              <ToolFoot tool={tool} chainName={chainName} />
            </VStack>
          </Card>
        ))}
      </SimpleGrid>
    </VStack>
  )
}

export default Toolkit
