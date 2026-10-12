// The detail of one keyed node: what happened, the dollars, the times, and the key that
// reproduces it. Follows the current inputs (the selection is re-resolved every compute).

import React from 'react'
import { Box, HStack, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { GlyphMark, Panel, SectionHead, StressStamp, TONE_COLOR } from './atoms'
import {
  TWIN_MARK,
  detailRows,
  leafView,
  outcomeTitle,
  type DetailRow,
  type ResolvedSelection,
} from './viewModel'

const KEY_ROWS = new Set(['scenario', 'cell key', 'code'])

/** One labelled figure. */
const Fact: React.FC<{ f: DetailRow }> = ({ f }) => (
  <Box minW={0}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.label}
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
    >
      {f.label}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={f.tone ? TONE_COLOR[f.tone] : SEMANTIC_COLORS.textPrimary}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
      wordBreak="break-word"
    >
      {f.value}
    </Text>
  </Box>
)

const FACT_COLUMNS = { base: 2, sm: 3, xl: 4 }

export const LeafDetail: React.FC<{ sel: ResolvedSelection }> = ({ sel }) => {
  const r = sel.result
  const leaf = leafView(r, sel.missing ?? undefined)
  const rows = r ? detailRows(r, sel.stock, sel.twin) : []
  const facts = rows.filter((x) => !KEY_ROWS.has(x.label) && x.group !== 'twin')
  const keys = rows.filter((x) => KEY_ROWS.has(x.label))
  // The incumbent twin (†, modelled): its own block, so it never reads as Membrane's.
  const twinFacts = rows.filter((x) => x.group === 'twin' && !x.wide)
  const twinNotes = rows.filter((x) => x.group === 'twin' && x.wide)
  return (
    // Not a live region: the whole panel was one, so every recompute re-read every fact.
    <Panel accent={TONE_COLOR[leaf.tone]}>
      <SectionHead
        title="Node detail"
        kicker={`${sel.title}${sel.sub ? ` · ${sel.sub}` : ''}`}
        right={<span />}
      />
      <HStack spacing={SPACING.sm} align="center" mb={SPACING.md}>
        <GlyphMark glyph={leaf.glyph} tone={leaf.tone} size={TYPOGRAPHY.h3} title={leaf.title} />
        {/* Mono: the title carries a dollar figure ("Collateral sold: $1,400"). */}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.h4}
          lineHeight={1.3}
          color={SEMANTIC_COLORS.textPrimary}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {r ? outcomeTitle(r) : `Not modelled: ${sel.missing ?? 'no result'}`}
        </Text>
      </HStack>
      {facts.length > 0 && (
        <SimpleGrid columns={FACT_COLUMNS} spacingX={SPACING.md} spacingY={SPACING.sm}>
          {facts.map((f) => (
            <Fact key={f.label} f={f} />
          ))}
        </SimpleGrid>
      )}
      {twinFacts.length > 0 && sel.twin && (
        <Box
          mt={SPACING.md}
          pt={SPACING.sm}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            letterSpacing="0.2em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Incumbent twin {TWIN_MARK} · {sel.twin.rules.name} · modelled
          </Text>
          <SimpleGrid columns={FACT_COLUMNS} spacingX={SPACING.md} spacingY={SPACING.sm}>
            {twinFacts.map((f) => (
              <Fact key={f.label} f={f} />
            ))}
          </SimpleGrid>
          {twinNotes.map((n) => (
            <Text
              key={n.label}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={SEMANTIC_COLORS.textTertiary}
              lineHeight={1.5}
              mt={SPACING.sm}
            >
              {n.value}
            </Text>
          ))}
        </Box>
      )}
      {keys.length > 0 && (
        <Box
          mt={SPACING.md}
          pt={SPACING.sm}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          display="grid"
          gap={SPACING.xs}
        >
          {keys.map((k) => (
            <HStack key={k.label} spacing={SPACING.sm} align="baseline">
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                letterSpacing="0.2em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
                minW="72px"
              >
                {k.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textSecondary}
                wordBreak="break-all"
                userSelect="all"
              >
                {k.value}
              </Text>
            </HStack>
          ))}
        </Box>
      )}
      <Box mt={SPACING.md}>
        <StressStamp full />
      </Box>
    </Panel>
  )
}
