import React, { useId, useState } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { CardView, ChangeItem } from '@/lib/oracleRegistry/apiTypes'

import { BasisBar } from './BasisBar'
import { MechanismPanel } from './MechanismPanel'
import { Sparkline } from './Sparkline'
import {
  CLASS_LABEL,
  COLOUR_META,
  colourLabel,
  describeCard,
  displayLabel,
  fmtBps,
  fmtUsd,
  freshnessLine,
  historyStat,
  nativeLine,
  PROVIDER_LABEL,
} from './viewModel'

// One small card per oracle, data.chain.link-style: provider + class, label, USD price,
// deviation vs the asset consensus (glyph + colour + signed bps), the 30-day sparkline over
// the consensus line, age + heartbeat, and the mechanism behind a toggle.

const BORDER_STYLE: Record<CardView['colour'], 'solid' | 'dashed' | 'dotted'> = {
  green: 'solid',
  red: 'solid',
  gold: 'solid',
  stale: 'dashed',
  unavailable: 'dotted',
}

const Chip: React.FC<{ children: React.ReactNode; strong?: boolean }> = ({ children, strong }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    color={strong ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textTertiary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    px="5px"
    py="1px"
    whiteSpace="nowrap"
  >
    {children}
  </Text>
)

export type OracleCardProps = {
  card: CardView
  historyTs: readonly number[]
  consensusSeries: readonly (number | null)[]
  changes: ChangeItem[]
  /** Why a market member is not in this median (viewModel.voteNote); null when it votes. */
  voteNote?: string | null
}

export const OracleCard: React.FC<OracleCardProps> = ({
  card,
  historyTs,
  consensusSeries,
  changes,
  voteNote = null,
}) => {
  const [open, setOpen] = useState(false)
  const panelId = `mech-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const meta = COLOUR_META[card.colour]
  const native = nativeLine(card)
  const fresh = freshnessLine(card)
  const stat = card.history ? historyStat(card.history.summary) : null

  return (
    <Card
      as="article"
      p={SPACING.md}
      borderLeftWidth="3px"
      borderLeftStyle={BORDER_STYLE[card.colour]}
      borderLeftColor={meta.token}
      display="flex"
      flexDirection="column"
      gap={SPACING.sm}
      minW={0}
      aria-label={describeCard(card)}
      data-colour={card.colour}
    >
      <HStack justify="space-between" align="center" spacing={SPACING.sm}>
        <HStack spacing="6px" minW={0}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            letterSpacing="0.2em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
            noOfLines={1}
          >
            {PROVIDER_LABEL[card.provider]}
          </Text>
          <Chip>{CLASS_LABEL[card.class]}</Chip>
          {card.tone === 'basis' && <Chip strong>basis</Chip>}
        </HStack>
        <Text
          as="span"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          lineHeight={1}
          color={meta.token}
          title={colourLabel(card.colour, card.tone)}
          aria-hidden="true"
        >
          {meta.glyph}
        </Text>
      </HStack>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textPrimary}
        lineHeight={1.35}
        noOfLines={2}
        minH="32px"
        title={card.label}
      >
        {displayLabel(card)}
      </Text>

      <Box>
        <HStack justify="space-between" align="baseline" spacing={SPACING.sm}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h3}
            fontWeight={TYPOGRAPHY.medium}
            color={
              card.colour === 'stale' ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary
            }
            whiteSpace="nowrap"
          >
            {fmtUsd(card.usd)}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={meta.token}
            whiteSpace="nowrap"
          >
            {meta.glyph} {fmtBps(card.deviationBps)}
          </Text>
        </HStack>
        <HStack justify="space-between" spacing={SPACING.sm}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textTertiary}
            noOfLines={1}
          >
            {native ?? (card.usd == null && card.price == null ? 'no reading' : 'USD feed')}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textTertiary}
            whiteSpace="nowrap"
          >
            {colourLabel(card.colour, card.tone)}
          </Text>
        </HStack>
      </Box>

      {card.history ? (
        <Sparkline
          usd={card.history.usd}
          consensus={consensusSeries}
          colours={card.history.colours}
          ts={historyTs}
          label={
            stat?.measured
              ? `30-day history: ${stat.out} outside the band, largest deviation ${stat.max}`
              : '30-day history: no hour could be measured (stale, or no consensus to compare with)'
          }
        />
      ) : (
        <Box
          h="61px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          border="1px dashed"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textTertiary}
          >
            {card.historyPlanned === 'none_public' ? 'no public history' : 'history not collected'}
          </Text>
        </Box>
      )}

      {card.basis && <BasisBar basis={card.basis} bandBps={card.bandBps} colour={card.colour} />}

      <Box
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        color={SEMANTIC_COLORS.textTertiary}
        display="grid"
        gridTemplateColumns="auto 1fr"
        columnGap={SPACING.sm}
        rowGap="1px"
      >
        <Text as="span" letterSpacing="0.14em">
          AGE
        </Text>
        <Text
          as="span"
          textAlign="right"
          color={card.freshness.state === 'stale' ? SEMANTIC_COLORS.textPrimary : undefined}
        >
          {fresh.age} · {fresh.limit}
        </Text>
        {stat && (
          <>
            <Text as="span" letterSpacing="0.14em">
              30D OUT
            </Text>
            <Text as="span" textAlign="right">
              {stat.measured ? `${stat.out} · max ${stat.max}` : stat.out}
            </Text>
          </>
        )}
        {voteNote && (
          <>
            <Text as="span" letterSpacing="0.14em">
              VOTE
            </Text>
            <Text as="span" textAlign="right">
              not counted · {voteNote}
            </Text>
          </>
        )}
      </Box>

      <Box
        as="button"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        textAlign="left"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        letterSpacing="0.2em"
        textTransform="uppercase"
        color={open ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.sm}
        mt="auto"
        bg="transparent"
        transition={TRANSITIONS.colors}
        _hover={{ color: SEMANTIC_COLORS.primary }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        {open ? '▾' : '▸'} Mechanism
        {changes.length ? ` · ${changes.length} change${changes.length > 1 ? 's' : ''}` : ''}
      </Box>
      {open && <MechanismPanel card={card} changes={changes} id={panelId} />}
    </Card>
  )
}

export default OracleCard
