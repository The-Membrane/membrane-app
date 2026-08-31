import React from 'react'
import { Box, Button, Flex, Grid, Link, Text } from '@chakra-ui/react'

import { MockStamp } from '@/components/demo'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, SectionHeading, Stamp } from './atoms'
import { BOARDS, ROUTES } from './fixtures'
import { routeBar } from './utils'
import { Board } from './types'

export interface MarketBoardsProps {
  onLoadBoard: (b: Board) => void
}

const LoadBtn: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button
    borderRadius={0}
    bg="transparent"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    color={SEMANTIC_COLORS.textPrimary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9.5px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    px="11px"
    py="6px"
    h="auto"
    _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
    _focus={FOCUS_STYLES.ring}
    transition={TRANSITIONS.colors}
    onClick={onClick}
  >
    Load this board
  </Button>
)

export const MarketBoards: React.FC<MarketBoardsProps> = ({ onLoadBoard }) => (
  <Box>
    <SectionHeading index="02 /" title="What the market is running" note="real boards and real routes — including the losing ones" />

    {/* Boards — top survivors */}
    <Card p={SPACING.base}>
      <Eyebrow>Boards — top survivors</Eyebrow>
      <MockStamp ml={SPACING.sm} />
      <Box mt={SPACING.md}>
        {BOARDS.map((b) => {
          const carry = (b.lev * b.yld).toFixed(1)
          const netColor = b.dead ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success
          return (
            <Grid
              key={b.rk}
              templateColumns={{ base: '24px 1fr auto', md: '30px 1.5fr 110px 1.1fr auto' }}
              gap={SPACING.md}
              alignItems="center"
              px={SPACING.md}
              py="10px"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              borderBottom={b.rk === BOARDS.length ? '1px solid' : 'none'}
              bg={SEMANTIC_COLORS.bgSecondary}
              fontSize="11.5px"
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textTertiary}>
                {b.rk}
              </Text>
              <Box>
                <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
                  {b.nm}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                  {b.coll} · {b.lev}× · {b.venues}
                </Text>
              </Box>
              <Text
                display={{ base: 'none', md: 'block' }}
                fontFamily={TYPOGRAPHY.fontMono}
                color={netColor}
                textAlign="right"
                whiteSpace="nowrap"
              >
                {(b.dead ? '−' : '+') + carry}% / yr
                <Text as="span" display="block" fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary}>
                  on equity
                </Text>
              </Text>
              <Text
                display={{ base: 'none', md: 'block' }}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10px"
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.5}
              >
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                  {b.surv}
                </Text>{' '}
                · {b.cov}
              </Text>
              <LoadBtn onClick={() => onLoadBoard(b)} />
            </Grid>
          )
        })}
      </Box>
      <Stamp>
        mock leaderboard — real boards come from the gauntlet and position history · ranked by floors survived,
        then net · net carry is on equity at the shown leverage
      </Stamp>
    </Card>

    {/* Live routes on other protocols */}
    <Card mt={SPACING.md} p={SPACING.base}>
      <Flex justify="space-between" align="baseline" gap={SPACING.md} flexWrap="wrap">
        <Eyebrow>Live routes on other protocols</Eyebrow>
        <MockStamp label="measured Aug 2026 · 1,245 positions, A+B evidence" />
      </Flex>
      <Box mt={SPACING.md}>
        {ROUTES.map((r, i) => {
          const { positive, width } = routeBar(r.net)
          const netColor = positive ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
          return (
            <Grid
              key={i}
              templateColumns={{ base: '1fr auto', md: '1.6fr 64px 1fr auto' }}
              gap={SPACING.md}
              alignItems="center"
              py={SPACING.sm}
              borderBottom={i === ROUTES.length - 1 ? 'none' : '1px solid'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
              fontSize="11px"
            >
              <Box fontFamily={TYPOGRAPHY.fontMono}>
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                  <Link href={r.su} isExternal color="inherit" _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}>
                    {r.src}
                  </Link>{' '}
                  →{' '}
                  <Link href={r.du} isExternal color="inherit" _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}>
                    {r.dst}
                  </Link>
                </Text>
                {r.note && (
                  <Text as="span" color={SEMANTIC_COLORS.danger}>
                    {' '}
                    · {r.note}
                  </Text>
                )}
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.12em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
                  {r.proto}
                </Text>
              </Box>
              <Text display={{ base: 'none', md: 'block' }} fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textTertiary} textAlign="right">
                {r.pos} pos
              </Text>
              {/* Diverging bar around a zero line */}
              <Box display={{ base: 'none', md: 'block' }} position="relative" h="7px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                <Box position="absolute" left="50%" top="-3px" bottom="-3px" w="1px" bg={SEMANTIC_COLORS.borderStrong} />
                <Box
                  position="absolute"
                  top={0}
                  bottom={0}
                  bg={netColor}
                  opacity={r.big ? 1 : 0.75}
                  w={`${width}%`}
                  {...(positive ? { left: '50%' } : { right: '50%' })}
                />
              </Box>
              <Box textAlign="right" whiteSpace="nowrap">
                <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={netColor}>
                  {(positive ? '+' : '') + r.net.toFixed(2)}%
                </Text>
              </Box>
            </Grid>
          )
        })}
      </Box>
      <Stamp>
        12 of 25 priced routes shown · borrow venue attributed from route semantics · routes are per-dollar
        spreads; boards above are on your equity at leverage — do not compare the raw numbers
      </Stamp>
      <Stamp>
        median external net +0.60% / yr per dollar · the Balanced preset carries +19.5% on your equity at 3× —
        the difference is the loop
      </Stamp>
    </Card>
  </Box>
)

export default MarketBoards
