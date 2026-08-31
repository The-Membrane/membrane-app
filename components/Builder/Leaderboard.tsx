// Leaderboard: two reference doctrines re-run against the drawn floors + this session's
// runs. Floors sort first, then net made; unranked practice seeds sit below the line.
// Proto: #board + paintBoard (:2294) + doctrineRows (:2286) + the explainer (:582).

import React, { useMemo } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MockStamp } from '@/components/demo'

import { InfoDetails } from './GauntletStage'
import { TINTS, tabular } from './styles'
import { doctrineRows, usd } from './utils'
import { Intent, RunResult, Scenario } from './types'

export interface LeaderboardProps {
  seedId: string
  scenarios: Scenario[]
  history: RunResult[]
  stBtc: number
  intent: Intent
}

export const Leaderboard: React.FC<LeaderboardProps> = ({ seedId, scenarios, history, stBtc, intent }) => {
  const rows = useMemo(() => {
    const all = doctrineRows(seedId, stBtc, intent, scenarios).concat(history).slice()
    all.sort(
      (a, b) => ((a.unranked ? 1 : 0) - (b.unranked ? 1 : 0)) || b.floors - a.floors || b.net - a.net,
    )
    return all
  }, [seedId, scenarios, history, stBtc, intent, history.length])

  const total = scenarios.length
  return (
    <>
      <InfoDetails title="Leaderboard" sr="How ranking works">
        Ranked by floors survived, then by what you actually made — yield banked minus the market value of the bitcoin you had to
        sell. Gross yield never ranks on its own: banking $1,070 while selling 0.7 BTC is a loss wearing a profit’s clothes, and
        floors gate everything so nobody out-earns a death. Only runs on the <b>daily seed</b> rank — everyone faces the same drawn
        floors, so the board is a fair fight. A run on any other seed still settles and still teaches, but it sits below the line as
        practice, unranked. The two reference rows are methods, not firms, and are illustrative lines rather than anyone’s track
        record. They disagree on purpose: one constrains how much you borrow and lets the venue mix be wide, the other constrains
        which venues you will touch and sizes up on the strength of that vetting. Both are re-run against the floors the loaded seed
        actually drew — through the same engine as your board — so their lines move with the challenge: a method that cleared eight
        floors on one seed can die on three the next.
      </InfoDetails>

      <Box mt={SPACING.base} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
        <Box display="grid" gridTemplateColumns={{ base: '28px 1fr 60px 76px', md: '34px 1.5fr 78px 96px 1fr' }} gap={SPACING.md} px={SPACING.md} py={SPACING.sm} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} bg={SEMANTIC_COLORS.bgTertiary} alignItems="center">
          {['#', 'Build', 'Floors', 'Net made'].map((h, i) => (
            <Text key={h} fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary} textAlign={i >= 2 ? 'right' : 'left'}>
              {h}
            </Text>
          ))}
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary} textAlign="right" display={{ base: 'none', md: 'block' }}>
            Banked − sold <MockStamp ml={SPACING.xs} />
          </Text>
        </Box>
        {rows.map((r, i) => (
          <Box key={r.who + i} display="grid" gridTemplateColumns={{ base: '28px 1fr 60px 76px', md: '34px 1.5fr 78px 96px 1fr' }} gap={SPACING.md} px={SPACING.md} py={SPACING.sm} borderBottom={i === rows.length - 1 ? 'none' : '1px solid'} borderColor={SEMANTIC_COLORS.borderSubtle} bg={r.mine ? TINTS.phosRow : 'transparent'} alignItems="center" fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px">
          <Text color={SEMANTIC_COLORS.textTertiary} {...tabular}>
            {r.unranked ? '—' : i + 1}
          </Text>
          <Box color={SEMANTIC_COLORS.textPrimary}>
            {r.who}
            <Text as="small" display="block" color={SEMANTIC_COLORS.textTertiary} fontSize="9.5px" letterSpacing="0.04em">
              {r.build}
            </Text>
          </Box>
          <Text {...tabular} textAlign="right" color={r.floors >= total ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}>
            {r.floors} / {total}
          </Text>
          <Text {...tabular} textAlign="right" color={r.net >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
            {(r.net >= 0 ? '+' : '') + usd(r.net)}
          </Text>
          <Text {...tabular} textAlign="right" color={SEMANTIC_COLORS.textTertiary} display={{ base: 'none', md: 'block' }}>
            {usd(r.banked || 0)} − {usd(r.lost || 0)} · {((r.btc || 0) * 100).toFixed(0)}% BTC
          </Text>
          </Box>
        ))}
      </Box>
    </>
  )
}

export default Leaderboard
