import React from 'react'
import { Box, Flex, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { AssetViewResponse, ColourCounts } from '@/lib/oracleRegistry/apiTypes'

import {
  ageAt,
  BASIS_FILTERS,
  BASIS_META,
  bandLabel,
  basisTallyLine,
  type BasisFilter,
  calmInkAt,
  type CardFilter,
  COLOUR_META,
  COLOUR_ORDER,
  type ColourMeta,
  colourToken,
  consensusHero,
  displayLabel,
  fmtBps,
  fmtDuration,
  fmtUsd,
  fmtUtc,
  lastFeedUpdate,
  PROVIDER_LABEL,
  STALE_HATCH_GLYPH,
} from './viewModel'

// The hero number: the asset's consensus (median of its fresh market feeds), with the
// facts that qualify it on one line, and the colour counts — which double as filters. Basis
// cards above / below market are tallied apart (they are not outliers) and filter the same way.
// R5 (2026-10-12: the 44px price printed in full ink however old the snapshot was). DESIGN_RULES
// §4, stale data: "Hatch it, never colour it green." "Suppress the headline while inputs are
// stale." "Show input ages in the dateline." Once the members that formed the median are past
// their own limits at the reader's clock (consensusStaleAt), the headline reads "stale" in muted
// ink, the price moves hatched onto the qualifier line, and the dateline keeps the ages.
// (review/S5, 2026-10-12: three holes in R5.)
//   1. Under the "stale" headline the counts still printed a green "● N within band". §2: "One
//      state owns the screen." "Calm is ink only." §4: "Hatch it, never colour it green." While
//      calm is in ink (calmInkAt: stale, no consensus or no clock) the ● takes muted ink, and
//      OracleRegistry passes the same flag to every card, strip, basis bar and tab mark.
//   2. The hatch was a background fill with padding behind the figure. §6: "No card fills, no
//      chips behind figures." The hatch is now the stale glyph before the figure (░, §2 "Every
//      colour carries a glyph: ● ▲ ✖ ░"), muted ink, nothing drawn behind it.
//   3. `now` is the page clock: the server's at first render (§9 "reserve space for every
//      client-only element (clock …)" — the hero and the dateline ages render the same on the
//      server and on hydration, so nothing shifts), the reader's after mount.

const Stat: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <HStack spacing="6px" align="baseline">
    <Text
      as="span"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
    >
      {k}
    </Text>
    <Text
      as="span"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textSecondary}
    >
      {v}
    </Text>
  </HStack>
)

const FilterButton: React.FC<{
  meta: ColourMeta
  n: number
  active: boolean
  onClick: () => void
}> = ({ meta, n, active, onClick }) => (
  <Box
    as="button"
    type="button"
    aria-pressed={active}
    disabled={!n && !active}
    onClick={onClick}
    display="inline-flex"
    alignItems="center"
    gap="6px"
    px={SPACING.sm}
    py="3px"
    border="1px solid"
    borderColor={active ? meta.token : SEMANTIC_COLORS.borderSubtle}
    bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="11px"
    color={n ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textTertiary}
    opacity={n || active ? 1 : 0.6}
    cursor={n || active ? 'pointer' : 'default'}
    transition={TRANSITIONS.colors}
    _hover={n ? { borderColor: SEMANTIC_COLORS.borderStrong } : undefined}
    _focusVisible={FOCUS_STYLES.ring}
  >
    <Text as="span" color={meta.token} aria-hidden="true">
      {meta.glyph}
    </Text>
    <Text as="span">{n}</Text>
    <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
      {meta.label}
    </Text>
  </Box>
)

export const ConsensusHeader: React.FC<{
  view: AssetViewResponse
  counts: ColourCounts
  /** Basis cards outside the band — not in `counts` (not outliers), tallied apart. */
  basis: Record<BasisFilter, number>
  now: number | null
  filter: CardFilter | null
  onFilter: (f: CardFilter | null) => void
}> = ({ view, counts, basis, now, filter, onFilter }) => {
  const c = view.consensus
  const ok = c.status === 'ok'
  const members = view.cards.filter((x) => x.role === 'member').length
  const reference = c.reference ? view.cards.find((x) => x.id === c.reference?.id) : undefined
  const snapAge = view.snapshot && now != null ? ageAt(view.snapshot.ts, now) : null
  const hero = consensusHero(view, now)
  const calmInk = calmInkAt(view, now)
  const lastUpdate = ok ? lastFeedUpdate(view.cards, view.snapshot?.ts) : null
  const hasBasis = view.cards.some((x) => x.tone === 'basis')

  return (
    <Box
      mt={SPACING.lg}
      pb={SPACING.base}
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        letterSpacing="0.28em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.textSecondary}
      >
        Consensus · {view.asset.symbol}
      </Text>
      <Flex align="baseline" gap={SPACING.base} wrap="wrap" mt={SPACING.xs}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={{ base: '32px', md: '44px' }}
          lineHeight={1.1}
          fontWeight={TYPOGRAPHY.medium}
          color={hero.muted ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary}
          aria-label={hero.aria}
        >
          {hero.text}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          {hero.hatchedPrice && (
            <>
              <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                <Text as="span" aria-hidden="true">
                  {STALE_HATCH_GLYPH}
                </Text>{' '}
                {hero.hatchedPrice}
              </Text>{' '}
              when read ·{' '}
            </>
          )}
          {ok
            ? `median of ${c.memberIds.length} market feed${c.memberIds.length === 1 ? '' : 's'} (${members} listed)`
            : c.reason === 'members_disagree'
              ? `its ${c.memberIds.length} fresh market feeds disagree by ${fmtBps(c.spreadBps).replace('+', '')}: no third feed to say which is right`
              : `${c.memberIds.length || (c.reference ? 1 : 0)} of ${c.minMembers} fresh market feeds needed`}
        </Text>
      </Flex>
      {!ok && c.reference && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
          mt="2px"
        >
          reference {fmtUsd(c.reference.usd)} ·{' '}
          {reference
            ? `${PROVIDER_LABEL[reference.provider]} · ${displayLabel(reference)}`
            : c.reference.id}{' '}
          · cards stay uncoloured
        </Text>
      )}

      <Flex gap={{ base: SPACING.sm, md: SPACING.base }} wrap="wrap" mt={SPACING.sm}>
        <Stat k="Spread" v={c.spreadBps != null ? fmtBps(c.spreadBps).replace('+', '') : '—'} />
        <Stat k="Band" v={bandLabel(view.band)} />
        {lastUpdate != null && (
          <Stat
            k="Last update"
            v={now != null ? `${fmtDuration(ageAt(lastUpdate, now))} ago` : fmtUtc(lastUpdate)}
          />
        )}
        {view.snapshot ? (
          <>
            <Stat k="Block" v={view.snapshot.block.toLocaleString('en-US')} />
            <Stat
              k="Read"
              v={`${fmtUtc(view.snapshot.ts)}${snapAge != null ? ` · ${fmtDuration(snapAge)} ago` : ''}`}
            />
          </>
        ) : (
          <Stat k="Read" v="no snapshot collected" />
        )}
      </Flex>

      <HStack
        spacing={SPACING.xs}
        mt={SPACING.md}
        flexWrap="wrap"
        role="group"
        aria-label="Filter cards by state"
      >
        {COLOUR_ORDER.map((colour) => (
          <FilterButton
            key={colour}
            meta={{ ...COLOUR_META[colour], token: colourToken(colour, calmInk) }}
            n={counts[colour]}
            active={filter === colour}
            onClick={() => onFilter(filter === colour ? null : colour)}
          />
        ))}
        {hasBasis && (
          <HStack
            spacing={SPACING.xs}
            pl={SPACING.sm}
            role="group"
            aria-label={basisTallyLine(basis)}
          >
            <Text
              as="span"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="10px"
              letterSpacing="0.2em"
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textTertiary}
              aria-hidden="true"
            >
              basis
            </Text>
            {BASIS_FILTERS.map((side) => (
              <FilterButton
                key={side}
                meta={BASIS_META[side]}
                n={basis[side]}
                active={filter === side}
                onClick={() => onFilter(filter === side ? null : side)}
              />
            ))}
          </HStack>
        )}
        <HStack spacing="6px" pl={SPACING.sm} aria-hidden="true">
          <Box w="16px" h="0" borderTop="1.5px solid" borderColor={SEMANTIC_COLORS.textPrimary} />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textTertiary}
          >
            feed
          </Text>
          <Box w="16px" h="0" borderTop="1px dashed" borderColor={SEMANTIC_COLORS.textTertiary} />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={SEMANTIC_COLORS.textTertiary}
          >
            consensus
          </Text>
        </HStack>
      </HStack>
    </Box>
  )
}

export default ConsensusHeader
