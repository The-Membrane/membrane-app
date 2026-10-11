import React, { useEffect, useState } from 'react'
import { Box, Button, Flex, Grid, Link, Text, Tooltip } from '@chakra-ui/react'

import { MockStamp } from '@/components/demo'
import { Card } from '@/components/ui/Card'
import { DEFAULT_CHAIN } from '@/config/chains'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { describeRouteReading } from '@/lib/carry/liveRouteFreshness'
import { dailySpreadForRoute } from '@/lib/carry/dailyRouteRows'
import { dailyCapitalForRoute } from '@/lib/carry/dailyRouteCapital'

import { Eyebrow, SectionHeading, Stamp } from './atoms'
import { BOARDS, ROUTES } from './fixtures'
// Frozen b/y columns from the same August unified_routes rows as ROUTES.net.
// Do not substitute route_costs.json: its PT-wrapper yield conflicts with the
// unified row shown in this table.
import historicalRouteLegs from './historical-route-legs.json'
import routeCapital from './route-capital.json'
import { routeBar } from './utils'
import { Board } from './types'
import DecisionWorksheet from './DecisionWorksheet'
import CuratorScenario from './CuratorScenario'
import UsdePilotStrip, { type UsdePilot } from './UsdePilotStrip'

const capitalByRoute = new Map(routeCapital.routes.map((row) => [row.route, row]))
// JSON imports widen pairs to number[]; carryRoutes.test.ts checks all 25 pairs.
const historicalLegs = historicalRouteLegs as unknown as Record<string, [number, number]>
const localAsOf = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
const readingAge = (seconds: number) => {
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}
type ReadingTime = { observedAt: string; ageSeconds: number; stale: boolean }
const readingStamp = (reading: Pick<ReadingTime, 'observedAt'>, nowMs: number) => {
  const { ageSeconds, stale } = describeRouteReading(reading.observedAt, nowMs)
  return `${stale ? 'Stale · last measured' : 'Measured'} ${localAsOf(reading.observedAt)} · ${readingAge(ageSeconds)}`
}
type LiveRoutePilot = {
  usdePilot: UsdePilot
  destinationVaultTvl:
    | ({
        totalAssetsGho: number
        vaultCashGho?: number
        withdrawalsPaused?: boolean
      } & ReadingTime)
    | null
  matchedCapital:
    | ({
        matchedGho: number
        completeWalletCount: number
      } & ReadingTime)
    | null
  latestUsdeMatchedCapital:
    | ({
        matchedUsde: string
        completeWalletCount: number
      } & ReadingTime)
    | null
  prospectiveOverlap:
    | ({
        matchedGho: number
        candidateWalletCount: number
        fromBlock: number
        throughBlock: number
      } & ReadingTime)
    | null
  holderStock:
    | ({
        holderStockGho: number
        holderCount: number
        nonzeroHolderCount: number
      } & ReadingTime)
    | null
  exactAaveSpread:
    | ({
        borrowApy: number
        yieldApy: number
        spread: number
      } & ReadingTime)
    | null
  latestUsdeExactSpread:
    | ({
        borrowApy: number
        yieldApy: number
        spread: number
      } & ReadingTime)
    | null
}
const compactUsd = (value: number) =>
  value >= 1_000_000
    ? `$${(value / 1_000_000).toFixed(2)}M`
    : value >= 1_000
      ? `$${Math.round(value / 1_000)}k`
      : `$${Math.round(value)}`

export interface MarketBoardsProps {
  onLoadBoard?: (b: Board) => void
  routesOnly?: boolean
  chainName?: string
}

const LoadBtn: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button
    borderRadius={0}
    bg="transparent"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    color={SEMANTIC_COLORS.textPrimary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="12px"
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

export const MarketBoards: React.FC<MarketBoardsProps> = ({
  onLoadBoard,
  routesOnly = false,
  chainName = DEFAULT_CHAIN,
}) => {
  const [livePilot, setLivePilot] = useState<LiveRoutePilot | null>(null)
  const [pilotError, setPilotError] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      fetch('/api/carry/live-routes', { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`Route reading ${response.status}`)
          return response.json()
        })
        .then((data: LiveRoutePilot) => {
          setLivePilot(data)
          setPilotError(false)
        })
        .catch(() => {
          if (!controller.signal.aborted) setPilotError(true)
          // Keep the last visible reading on a transient fetch failure.
        })
    }
    refresh()
    // Chain readings refresh daily; an hourly saved-row check is sufficient
    // to pick up a successful recorder run without frequent API polling.
    const timer = window.setInterval(refresh, 60 * 60 * 1000)
    const clock = window.setInterval(() => setNowMs(Date.now()), 60 * 1000)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(clock)
      controller.abort()
    }
  }, [])

  return (
    <Box>
      <SectionHeading
        index="02 /"
        title={routesOnly ? 'Measured routes on other protocols' : 'What the market is running'}
        note={
          routesOnly ? (
            <Text as="span" fontSize={TYPOGRAPHY.xs}>
              all priced August route categories, including losing routes
            </Text>
          ) : (
            'real boards and real routes — including the losing ones'
          )
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
                  fontSize="12px"
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
                      fontSize="12px"
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
                      fontSize="12px"
                      color={SEMANTIC_COLORS.textTertiary}
                    >
                      on equity
                    </Text>
                  </Text>
                  <Text
                    display={{ base: 'none', md: 'block' }}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="12px"
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
        <Flex
          mb={SPACING.md}
          p={SPACING.md}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          justify="space-between"
          align="center"
          gap={SPACING.md}
          flexWrap="wrap"
        >
          <Box>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              letterSpacing="0.08em"
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textSecondary}
            >
              Daily route pilot · Aave V3 GHO → sGHO
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Vault size, observed-wallet capital and the rate leg answer different questions.
            </Text>
            {pilotError && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                Refresh unavailable · last measurements shown if recorded
              </Text>
            )}
          </Box>
          <Flex gap={SPACING.md} align="baseline" flexWrap="wrap">
            <Box>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="16px"
                color={SEMANTIC_COLORS.textPrimary}
              >
                {livePilot?.destinationVaultTvl
                  ? `${Math.round(livePilot.destinationVaultTvl.totalAssetsGho).toLocaleString()} GHO`
                  : livePilot
                    ? 'No reading yet'
                    : pilotError
                      ? 'Reading offline'
                      : 'Loading reading…'}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
              >
                sGHO vault TVL · all depositors · GHO units
              </Text>
              {livePilot?.destinationVaultTvl && (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  {readingStamp(livePilot.destinationVaultTvl, nowMs)}
                </Text>
              )}
            </Box>
            <Box>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="16px"
                color={SEMANTIC_COLORS.textPrimary}
              >
                {livePilot?.matchedCapital
                  ? `${Math.round(livePilot.matchedCapital.matchedGho).toLocaleString()} GHO`
                  : livePilot
                    ? 'Not yet verified'
                    : pilotError
                      ? 'Reading offline'
                      : 'Loading reading…'}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
              >
                debt-and-holding overlap · August-observed wallets only
              </Text>
              {livePilot?.matchedCapital && (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  {readingStamp(livePilot.matchedCapital, nowMs)}
                </Text>
              )}
            </Box>
            <Box>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="16px"
                color={SEMANTIC_COLORS.textPrimary}
              >
                {livePilot?.prospectiveOverlap
                  ? `${livePilot.prospectiveOverlap.matchedGho.toLocaleString('en-US', { maximumFractionDigits: 2 })} GHO`
                  : livePilot
                    ? 'No priced sample yet'
                    : pilotError
                      ? 'Reading offline'
                      : 'Loading reading…'}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
              >
                post-watch borrower overlap · not route TVL
              </Text>
              {livePilot?.prospectiveOverlap ? (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  {livePilot.prospectiveOverlap.candidateWalletCount} event-observed borrowers ·
                  blocks {livePilot.prospectiveOverlap.fromBlock.toLocaleString()}–
                  {livePilot.prospectiveOverlap.throughBlock.toLocaleString()} ·{' '}
                  {readingStamp(livePilot.prospectiveOverlap, nowMs)}
                </Text>
              ) : (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  no published measurement is not zero
                </Text>
              )}
            </Box>
            <Box>
              {livePilot?.exactAaveSpread ? (
                <Tooltip
                  placement="top-end"
                  hasArrow
                  bg={SEMANTIC_COLORS.bgSecondary}
                  color={SEMANTIC_COLORS.textPrimary}
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.borderStrong}
                  p={SPACING.sm}
                  label={
                    <Box fontFamily={TYPOGRAPHY.fontMono} fontSize="12px">
                      <Text>
                        7-day sGHO share growth:{' '}
                        {(livePilot.exactAaveSpread.yieldApy * 100).toFixed(2)}% APY
                      </Text>
                      <Text>
                        Aave GHO borrow cost: −
                        {(livePilot.exactAaveSpread.borrowApy * 100).toFixed(2)}% APY
                      </Text>
                      <Text mt={SPACING.xs} color={SEMANTIC_COLORS.textTertiary}>
                        Finalized block · {localAsOf(livePilot.exactAaveSpread.observedAt)}
                      </Text>
                    </Box>
                  }
                >
                  <Box
                    as="button"
                    type="button"
                    cursor="help"
                    textDecoration="underline"
                    textDecorationStyle="dotted"
                    textUnderlineOffset="3px"
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="16px"
                    color={
                      livePilot.exactAaveSpread.spread >= 0
                        ? SEMANTIC_COLORS.success
                        : SEMANTIC_COLORS.danger
                    }
                    _focusVisible={{
                      outline: '1px solid',
                      outlineColor: SEMANTIC_COLORS.textPrimary,
                    }}
                  >
                    {livePilot.exactAaveSpread.spread >= 0 ? '+' : ''}
                    {(livePilot.exactAaveSpread.spread * 100).toFixed(2)}%
                  </Box>
                </Tooltip>
              ) : (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="16px"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {livePilot
                    ? 'No reading yet'
                    : pilotError
                      ? 'Reading offline'
                      : 'Loading reading…'}
                </Text>
              )}
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
              >
                current borrow vs trailing yield · not cohort return
              </Text>
              {livePilot?.exactAaveSpread && (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  {readingStamp(livePilot.exactAaveSpread, nowMs)}
                </Text>
              )}
            </Box>
          </Flex>
        </Flex>
        <UsdePilotStrip pilot={livePilot?.usdePilot ?? null} nowMs={nowMs} />
        {routesOnly && (
          <DecisionWorksheet
            chainName={chainName}
            reading={livePilot?.exactAaveSpread ?? null}
            readingLabel={
              livePilot?.exactAaveSpread ? readingStamp(livePilot.exactAaveSpread, nowMs) : null
            }
            cashReading={
              livePilot?.destinationVaultTvl &&
              typeof livePilot.destinationVaultTvl.vaultCashGho === 'number' &&
              Number.isFinite(livePilot.destinationVaultTvl.vaultCashGho) &&
              typeof livePilot.destinationVaultTvl.withdrawalsPaused === 'boolean'
                ? {
                    vaultCashGho: livePilot.destinationVaultTvl.vaultCashGho,
                    totalAssetsGho: livePilot.destinationVaultTvl.totalAssetsGho,
                    withdrawalsPaused: livePilot.destinationVaultTvl.withdrawalsPaused,
                    observedAt: livePilot.destinationVaultTvl.observedAt,
                  }
                : null
            }
            cashLabel={
              livePilot?.destinationVaultTvl &&
              typeof livePilot.destinationVaultTvl.vaultCashGho === 'number' &&
              Number.isFinite(livePilot.destinationVaultTvl.vaultCashGho) &&
              typeof livePilot.destinationVaultTvl.withdrawalsPaused === 'boolean'
                ? readingStamp(livePilot.destinationVaultTvl, nowMs)
                : null
            }
          />
        )}
        {routesOnly && (
          <CuratorScenario
            rateReading={livePilot?.exactAaveSpread ?? null}
            inventoryReading={
              livePilot?.destinationVaultTvl &&
              typeof livePilot.destinationVaultTvl.vaultCashGho === 'number' &&
              Number.isFinite(livePilot.destinationVaultTvl.vaultCashGho) &&
              typeof livePilot.destinationVaultTvl.withdrawalsPaused === 'boolean'
                ? {
                    vaultCashGho: livePilot.destinationVaultTvl.vaultCashGho,
                    totalAssetsGho: livePilot.destinationVaultTvl.totalAssetsGho,
                    withdrawalsPaused: livePilot.destinationVaultTvl.withdrawalsPaused,
                    observedAt: livePilot.destinationVaultTvl.observedAt,
                  }
                : null
            }
            nowMs={nowMs}
          />
        )}
        <Flex justify="space-between" align="baseline" gap={SPACING.md} flexWrap="wrap">
          {!routesOnly && <Eyebrow>Measured routes on other protocols</Eyebrow>}
          <MockStamp
            label="Aug 2026 · 819 priced of 1,245 A+B observations"
            fontSize={TYPOGRAPHY.xs}
            letterSpacing="0.08em"
          />
        </Flex>
        <Text
          mt={SPACING.xs}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Percent = sampled spread · dollars = capped August priced-subset proxy, not total or live
          TVL.
        </Text>
        <Box
          mt={SPACING.md}
          maxH="520px"
          overflowY="auto"
          overscrollBehavior="contain"
          role="region"
          aria-label="Measured carry routes"
          tabIndex={0}
          _focusVisible={{ outline: '1px solid', outlineColor: SEMANTIC_COLORS.textSecondary }}
        >
          {ROUTES.map((r, i) => {
            const { positive, width } = routeBar(r.net)
            const netColor = positive ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger
            const legs = r.routeKey ? historicalLegs[r.routeKey] : undefined
            const capital = r.routeKey ? capitalByRoute.get(r.routeKey) : undefined
            const daily = dailySpreadForRoute(r.routeKey, livePilot, nowMs)
            const dailyCapital = dailyCapitalForRoute(r.routeKey, livePilot, nowMs)
            const capitalLabel =
              capital?.cohortHeldCapitalUsdApprox != null
                ? `≈${compactUsd(capital.cohortHeldCapitalUsdApprox)}`
                : 'Unpriced'
            const capitalCoverage = capital
              ? `${capital.pricedOpenGroups}/${capital.matchedGroups} covered`
              : 'No matched snapshot'
            return (
              <Grid
                key={i}
                data-testid="measured-route-row"
                templateColumns={{ base: 'minmax(0, 1fr) auto', md: '1.6fr 100px 1fr 130px' }}
                gap={SPACING.md}
                alignItems="center"
                px={SPACING.sm}
                py={SPACING.sm}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderBottom={i === ROUTES.length - 1 ? '1px solid' : 'none'}
                boxShadow="none"
                transition="box-shadow 150ms ease, border-color 150ms ease"
                _hover={{ boxShadow: 'md' }}
                _active={{ borderColor: SEMANTIC_COLORS.success, boxShadow: 'sm' }}
                fontSize={TYPOGRAPHY.xs}
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
                    fontSize={TYPOGRAPHY.xs}
                    letterSpacing="0.06em"
                    textTransform="uppercase"
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {r.proto}
                    {r.destinations && r.destinations > 1 ? ` · ${r.destinations} vaults` : ''}
                  </Text>
                </Box>
                <Box display={{ base: 'none', md: 'block' }} textAlign="right">
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    {capitalLabel}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    {capitalCoverage}
                  </Text>
                </Box>
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
                <Box minW={0} textAlign="right" whiteSpace="normal">
                  <Tooltip
                    placement="top-end"
                    hasArrow
                    bg={SEMANTIC_COLORS.bgSecondary}
                    color={SEMANTIC_COLORS.textPrimary}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderStrong}
                    p={SPACING.sm}
                    label={
                      <Box fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" whiteSpace="normal">
                        {legs ? (
                          <>
                            <Flex justify="space-between" gap={SPACING.md}>
                              <Text>Destination yield</Text>
                              <Text color={SEMANTIC_COLORS.textPrimary}>{legs[1].toFixed(2)}%</Text>
                            </Flex>
                            <Flex justify="space-between" gap={SPACING.md}>
                              <Text>Borrow cost</Text>
                              <Text color={SEMANTIC_COLORS.textPrimary}>
                                −{legs[0].toFixed(2)}%
                              </Text>
                            </Flex>
                            <Text mt={SPACING.xs} color={SEMANTIC_COLORS.textTertiary}>
                              Aug 2026 sample · mixed rate bases · not current
                            </Text>
                          </>
                        ) : (
                          <Text>Leg breakdown was not saved for this August sample.</Text>
                        )}
                      </Box>
                    }
                  >
                    <Box
                      as="button"
                      type="button"
                      aria-label={`August sampled spread ${(positive ? '+' : '') + r.net.toFixed(2)} percent; hover or focus for borrow cost and yield`}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize="16px"
                      color={netColor}
                      cursor="help"
                      textDecoration="underline"
                      textDecorationStyle="dotted"
                      textUnderlineOffset="3px"
                      _focusVisible={{
                        outline: '1px solid',
                        outlineColor: SEMANTIC_COLORS.textPrimary,
                      }}
                    >
                      {(positive ? '+' : '') + r.net.toFixed(2)}%
                    </Box>
                  </Tooltip>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    overflowWrap="anywhere"
                  >
                    {r.destinations && r.destinations > 1
                      ? 'reference-vault rate'
                      : `${r.pos} observed · Aug 2026`}
                  </Text>
                  {r.destinations && r.destinations > 1 && (
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.textTertiary}
                      overflowWrap="anywhere"
                    >
                      {r.pos} observed · Aug 2026
                    </Text>
                  )}
                </Box>
                <Box
                  data-testid="mobile-route-capital"
                  display={{ base: 'block', md: 'none' }}
                  gridColumn="1 / -1"
                  minW={0}
                  pt={SPACING.xs}
                  borderTop="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                >
                  <Flex justify="space-between" align="baseline" gap={SPACING.sm} flexWrap="wrap">
                    <Text color={SEMANTIC_COLORS.textTertiary}>Aug cohort capital</Text>
                    <Text color={SEMANTIC_COLORS.textPrimary}>{capitalLabel}</Text>
                  </Flex>
                  <Text color={SEMANTIC_COLORS.textTertiary}>
                    {capital
                      ? `${capital.pricedOpenGroups}/${capital.matchedGroups} priced`
                      : 'No matched snapshot'}
                  </Text>
                </Box>
                {daily && (
                  <Flex
                    data-testid="daily-route-spread"
                    gridColumn="1 / -1"
                    minW={0}
                    pt={SPACING.xs}
                    borderTop="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    justify="space-between"
                    align="center"
                    gap={SPACING.sm}
                    flexWrap="wrap"
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                  >
                    <Box minW={0}>
                      <Text color={SEMANTIC_COLORS.info}>
                        Daily exact-leg rate · separate from August
                      </Text>
                      <Text color={SEMANTIC_COLORS.textTertiary} overflowWrap="anywhere">
                        {daily.reading
                          ? `${daily.kind === 'gho' ? 'Aave GHO / sGHO' : 'Aave USDe / sUSDe'} · ${readingStamp(daily.reading, nowMs)}`
                          : 'No daily rate reading yet · August values above are unchanged'}
                      </Text>
                    </Box>
                    {daily.reading && (
                      <Tooltip
                        placement="top-end"
                        hasArrow
                        bg={SEMANTIC_COLORS.bgSecondary}
                        color={SEMANTIC_COLORS.textPrimary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderStrong}
                        p={SPACING.sm}
                        label={
                          <Box fontFamily={TYPOGRAPHY.fontMono} fontSize="12px">
                            <Text>
                              Trailing 7-day destination share growth:{' '}
                              {(daily.reading.yieldApy * 100).toFixed(2)}% annualized
                            </Text>
                            <Text>
                              Aave variable borrow cost: −
                              {(daily.reading.borrowApy * 100).toFixed(2)}% APY
                            </Text>
                            <Text mt={SPACING.xs} color={SEMANTIC_COLORS.textTertiary}>
                              Exact-leg model · not realized cohort return or route TVL
                            </Text>
                          </Box>
                        }
                      >
                        <Box
                          as="button"
                          type="button"
                          aria-label={`Daily exact-leg spread ${(daily.reading.spread * 100).toFixed(2)} percentage points; ${daily.stale ? 'stale; ' : ''}yield ${(daily.reading.yieldApy * 100).toFixed(2)} percent annualized, borrow cost ${(daily.reading.borrowApy * 100).toFixed(2)} percent APY; ${readingStamp(daily.reading, nowMs)}`}
                          flexShrink={0}
                          cursor="help"
                          textDecoration="underline"
                          textDecorationStyle="dotted"
                          textUnderlineOffset="3px"
                          color={daily.stale ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.info}
                          _focusVisible={{
                            outline: '1px solid',
                            outlineColor: SEMANTIC_COLORS.textPrimary,
                          }}
                        >
                          {daily.reading.spread > 0 ? '+' : ''}
                          {(daily.reading.spread * 100).toFixed(2)} pp
                        </Box>
                      </Tooltip>
                    )}
                  </Flex>
                )}
                {dailyCapital && (
                  <Flex
                    data-testid="daily-route-capital"
                    gridColumn="1 / -1"
                    minW={0}
                    pt={SPACING.xs}
                    borderTop="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    justify="space-between"
                    align="baseline"
                    gap={SPACING.sm}
                    flexWrap="wrap"
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                  >
                    <Box minW={0}>
                      <Tooltip
                        placement="top-end"
                        hasArrow
                        bg={SEMANTIC_COLORS.bgSecondary}
                        color={SEMANTIC_COLORS.textPrimary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderStrong}
                        p={SPACING.sm}
                        label={
                          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px">
                            Same-wallet debt and destination holdings overlap; fungible balances do
                            not prove borrowed tokens funded the destination. This is not
                            route-attributed TVL. Zero among the fixed wallets does not mean zero
                            users.
                          </Text>
                        }
                      >
                        <Box
                          as="button"
                          type="button"
                          cursor="help"
                          textAlign="left"
                          color={SEMANTIC_COLORS.textSecondary}
                          textDecoration="underline"
                          textDecorationStyle="dotted"
                          textUnderlineOffset="3px"
                          overflowWrap="anywhere"
                          aria-label={`Fixed August-wallet debt/holding overlap for ${dailyCapital.walletCount} wallets; same-wallet proxy, not route-attributed TVL. Zero among these wallets does not mean zero users. Hover or focus for explanation.`}
                          _focusVisible={{
                            outline: '1px solid',
                            outlineColor: SEMANTIC_COLORS.textPrimary,
                          }}
                        >
                          Fixed August-wallet debt/holding overlap
                        </Box>
                      </Tooltip>
                      <Text color={SEMANTIC_COLORS.textTertiary} overflowWrap="anywhere">
                        {dailyCapital.reading
                          ? readingStamp(dailyCapital.reading, nowMs)
                          : 'No daily overlap reading · August dollar proxy above is unchanged'}
                      </Text>
                    </Box>
                    {dailyCapital.amount !== null && (
                      <Text
                        color={SEMANTIC_COLORS.textPrimary}
                        overflowWrap="anywhere"
                        flexShrink={0}
                      >
                        {dailyCapital.amount} ({dailyCapital.walletCount} wallets)
                      </Text>
                    )}
                  </Flex>
                )}
              </Grid>
            )
          })}
        </Box>
        <Text
          mt={SPACING.sm}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          lineHeight={1.7}
          color={SEMANTIC_COLORS.textTertiary}
        >
          Aug 2026 route cohort, not a count of positions still open today · {ROUTES.length} of 25
          priced route labels shown; 168 other labels remain unpriced · percent spreads sample
          August borrow costs and destination yields, not realized returns or forecasts · labels can
          combine multiple vaults · capital is a capped August snapshot proxy from priced
          owner-vault holdings, not live TVL; replacement deposits can overstate carry remaining ·
          missing holdings are unknown, not zero · spreads are per dollar, not on leveraged equity
        </Text>
        <Text
          mt={SPACING.sm}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          lineHeight={1.7}
          color={SEMANTIC_COLORS.textTertiary}
        >
          median external net +0.60% / yr per dollar · the Balanced preset carries +19.5% on your
          equity at 3× — the difference is the loop
        </Text>
      </Card>
    </Box>
  )
}

export default MarketBoards
