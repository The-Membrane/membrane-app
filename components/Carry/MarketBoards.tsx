import React, { useState } from 'react'
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

const ROUTE_NOTIONAL_USD = 10_000
const signedDollars = (value: number) =>
  `${value >= 0 ? '+' : '−'}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

const RouteMagnitude: React.FC<{ count: number; netPct: number; color: string }> = ({
  count,
  netPct,
  color,
}) => {
  const [showCount, setShowCount] = useState(false)
  return (
    <Button
      type="button"
      data-testid="route-magnitude"
      variant="unstyled"
      minW={0}
      h="auto"
      textAlign="right"
      whiteSpace="normal"
      onClick={() => setShowCount((current) => !current)}
      aria-label={
        showCount
          ? `${count} observed positions. Show dollars per $10,000.`
          : `${signedDollars((netPct / 100) * ROUTE_NOTIONAL_USD)} per year on $10,000. Show observed position count.`
      }
      _focusVisible={FOCUS_STYLES.ring}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={showCount ? SEMANTIC_COLORS.textPrimary : color}
      >
        {showCount
          ? `${count} observed`
          : `${signedDollars((netPct / 100) * ROUTE_NOTIONAL_USD)} / yr`}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary}>
        {showCount ? 'tap for $10k example' : 'on $10k · tap for count'}
      </Text>
    </Button>
  )
}

export interface MarketBoardsProps {
  onLoadBoard?: (b: Board) => void
  routesOnly?: boolean
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

export const MarketBoards: React.FC<MarketBoardsProps> = ({ onLoadBoard, routesOnly = false }) => (
  <Box>
    <SectionHeading
      index="02 /"
      title={routesOnly ? 'Measured routes on other protocols' : 'What the market is running'}
      note={
        routesOnly
          ? 'measured route spreads, including the losing routes'
          : 'real boards and real routes — including the losing ones'
      }
    />

    {/* Boards — top survivors */}
    {!routesOnly && (
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
                  <Text
                    fontFamily={TYPOGRAPHY.fontDisplay}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {b.nm}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="9.5px"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
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
                  <Text
                    as="span"
                    display="block"
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="9px"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
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
                <LoadBtn onClick={() => onLoadBoard?.(b)} />
              </Grid>
            )
          })}
        </Box>
        <Stamp>
          mock leaderboard — real boards come from the gauntlet and position history · ranked by
          floors survived, then net · net carry is on equity at the shown leverage
        </Stamp>
      </Card>
    )}

    {/* Historical route cohort on other protocols */}
    <Card mt={routesOnly ? 0 : SPACING.md} p={SPACING.base}>
      <Flex justify="space-between" align="baseline" gap={SPACING.md} flexWrap="wrap">
        {!routesOnly && <Eyebrow>Measured routes on other protocols</Eyebrow>}
        <MockStamp label="measured Aug 2026 · 1,245 positions, A+B evidence" />
      </Flex>
      <Box mt={SPACING.md}>
        {ROUTES.map((r, i) => {
          const { positive, width } = routeBar(r.net)
          const netColor = positive ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
          return (
            <Grid
              key={i}
              templateColumns={{ base: 'minmax(0, 1fr) 116px', md: '1.6fr 150px 1fr auto' }}
              gap={SPACING.md}
              alignItems="center"
              py={SPACING.sm}
              borderBottom={i === ROUTES.length - 1 ? 'none' : '1px solid'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
              fontSize="11px"
            >
              <Box fontFamily={TYPOGRAPHY.fontMono}>
                <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                  <Link
                    href={r.su}
                    isExternal
                    color="inherit"
                    _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}
                  >
                    {r.src}
                  </Link>{' '}
                  →{' '}
                  <Link
                    href={r.du}
                    isExternal
                    color="inherit"
                    _hover={{ color: SEMANTIC_COLORS.success, textDecoration: 'underline' }}
                  >
                    {r.dst}
                  </Link>
                </Text>
                {r.note && (
                  <Text as="span" color={SEMANTIC_COLORS.danger}>
                    {' '}
                    · {r.note}
                  </Text>
                )}
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="9px"
                  letterSpacing="0.12em"
                  textTransform="uppercase"
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  {r.proto}
                </Text>
              </Box>
              <RouteMagnitude count={r.pos} netPct={r.net} color={netColor} />
              {/* Diverging bar around a zero line */}
              <Box
                display={{ base: 'none', md: 'block' }}
                position="relative"
                h="7px"
                bg={SEMANTIC_COLORS.bgPrimary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
              >
                <Box
                  position="absolute"
                  left="50%"
                  top="-3px"
                  bottom="-3px"
                  w="1px"
                  bg={SEMANTIC_COLORS.borderStrong}
                />
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
        Aug 2026 route cohort, not a count of positions still open today · 12 of 25 priced routes
        shown · $10,000 examples apply August annualized spreads, not current yield or a forecast ·
        cohort capital was not measured · borrow venue attributed from route semantics · spreads are
        per dollar, not on leveraged equity
      </Stamp>
      <Stamp>
        median external net +0.60% / yr per dollar · the Balanced preset carries +19.5% on your
        equity at 3× — the difference is the loop
      </Stamp>
    </Card>
  </Box>
)

export default MarketBoards
