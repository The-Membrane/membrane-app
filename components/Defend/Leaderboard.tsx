import React from 'react'
import { Box, Text, Tooltip } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MockStamp } from '@/components/demo'

import { ROWS } from './fixtures'
import { Eyebrow, SectionHeading, Stamp } from './Primitives'
import { LeaderboardRow } from './types'

const RegStrip: React.FC<{ regs: number[] }> = ({ regs }) => (
  <Box display="flex" gap="3px" alignItems="flex-end" h="20px">
    {regs.map((v, i) => (
      <Box
        key={i}
        w="12px"
        h={`${Math.min(18, Math.abs(v) * 4)}px`}
        bg={v < 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.info}
      />
    ))}
  </Box>
)

const Row: React.FC<{ r: LeaderboardRow }> = ({ r }) => (
  <Box
    display="grid"
    gridTemplateColumns="34px 1.3fr 1fr auto auto"
    gap={SPACING.md}
    alignItems="center"
    px={SPACING.md}
    py={SPACING.sm}
    fontSize="11.5px"
    bg={r.house ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    borderBottom={0}
    borderLeft={r.you ? '3px solid' : '1px solid'}
    borderLeftColor={r.you ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
    _last={{ borderBottom: '1px solid', borderBottomColor: SEMANTIC_COLORS.borderSubtle }}
  >
    <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textTertiary}>
      {r.rk}
    </Text>
    <Box>
      <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
        {r.nm}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
        {r.who}
        {r.house ? ' · house policy' : ''}
      </Text>
    </Box>
    <RegStrip regs={r.regs} />
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.small}
      textAlign="right"
      color={r.edge >= 3 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textPrimary}
    >
      +{r.edge.toFixed(2)}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9.5px"
      textAlign="right"
      color={SEMANTIC_COLORS.textTertiary}
    >
      {r.att != null ? `${r.att} attempts` : '—'}
    </Text>
  </Box>
)

const INFO =
  'Edge = capital efficiency captured (interest per unit volume) minus an asymmetric bad-debt ' +
  'penalty — bad debt hurts more than volume helps. Averaged over 1,000 randomized draws, so luck ' +
  'washes out: this grades process, never a single run’s P&L. Penalty coefficient is an open decision.'

export const Leaderboard: React.FC = () => (
  <>
    <SectionHeading
      index="02"
      title="Leaderboard"
      note={
        <Box as="span" display="inline-flex" alignItems="center" gap="6px">
          <Eyebrow as="span" letterSpacing={0} textTransform="none" fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary}>
            avg edge over 1,000 sims · house policies pinned
          </Eyebrow>
          <Tooltip label={INFO} placement="bottom" hasArrow bg={SEMANTIC_COLORS.bgSecondary} color={SEMANTIC_COLORS.textSecondary} maxW="280px" borderRadius={0} fontSize={TYPOGRAPHY.xs}>
            <Box
              as="span"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              w="14px"
              h="14px"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              color={SEMANTIC_COLORS.textSecondary}
              fontSize="9px"
              cursor="help"
              tabIndex={0}
            >
              i
            </Box>
          </Tooltip>
        </Box>
      }
    />
    <Box mt={SPACING.md}>
      {ROWS.map((r) => (
        <Row key={r.rk} r={r} />
      ))}
    </Box>
    <Stamp>
      regime strip per row: edge by hidden regime — calm · vol spike · depth shock · cascade. Red =
      negative in that regime. <MockStamp ml={SPACING.sm} />
    </Stamp>
  </>
)

export default Leaderboard
