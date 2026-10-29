import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  HStack,
  Input,
  SimpleGrid,
  Text,
  VStack,
  Wrap,
  WrapItem,
} from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { ASSET_COLORS } from '@/config/chartTheme'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { Caveats, Eyebrow, Stat } from '@/components/Evidence/atoms'
import { DemoBanner } from '@/components/demo'

import useDemoMode from '@/hooks/useDemoMode'

import { LAYERS, layerBands, topAssets, usd2, type Layer, type LayersDoc } from './liqmapLogic'
import { BAND_NAMES } from './xrayLogic'
import type { Breaches } from './marketsLogic'
import { MarketsSheet } from './MarketsSheet'
import { BorrowBoard } from './BorrowBoard'
import { StressReplay, type StressDoc } from './StressReplay'
import { CarryAtRates, CrashHistory, RulesCheck, WhatIfSimulator } from './XrayExtras'

// Liquidation map + Position X-ray (board Q26-TERMINAL-MAP). Protocol-scoped blocks
// (the map) are a measured snapshot in both states; the X-ray is wallet-scoped and
// runs on a demo fixture until a wallet is connected or an address is entered.

const LAYER_LABEL: Record<Layer, string> = {
  price: 'Price risk',
  pair: 'Ratio loops',
  stable: 'Stablecoin',
}
const LAYER_COLOR: Record<Layer, string> = {
  price: ASSET_COLORS[0],
  pair: ASSET_COLORS[1],
  stable: ASSET_COLORS[2],
}
const LAYER_EXPLAIN: Record<Layer, string> = {
  price: 'Liquidated when collateral prices fall (e.g. ETH backing USDC debt).',
  pair: 'Volatile debt against correlated collateral, mostly staked ETH backing borrowed ETH. Liquidated by the ratio, not the ETH price.',
  stable: 'Stablecoin collateral and debt. Liquidated by a depeg the oracle sees.',
}

type XrayResponse = {
  readAt: string
  marketBlock: number
  riskType: Layer
  healthFactor: number | null
  distance: number | null
  band: string | null
  liquidationPrice: number | null
  oraclePrice: number | null
  mainCollateral: string
  collateralUsd: number
  debtUsd: number
  eMode: number
  sameBand: { debtUsd: number; positions: number; asOf?: string } | null
  reserves: {
    symbol: string
    priceUsd: number
    collateralUsd: number
    debtUsd: number
    lt: number
    stable: boolean
  }[]
  history?: (Breaches & { source: string; curve?: { d: number; share: number }[] }) | null
  carry?: { carryGapPerYear: number | null; daysToHf1: number | null } | null
  error?: string
}

// Demo fixture: a synthetic weETH/WETH loop (not a real account).
const DEMO_XRAY: XrayResponse = {
  readAt: '',
  marketBlock: 0,
  riskType: 'pair',
  healthFactor: 1.032,
  distance: 0.031,
  band: '2-3.5%',
  liquidationPrice: null,
  oraclePrice: null,
  mainCollateral: 'weETH',
  collateralUsd: 86_700,
  debtUsd: 79_800,
  eMode: 1,
  sameBand: null,
  reserves: [
    { symbol: 'weETH', priceUsd: 2567, collateralUsd: 86_700, debtUsd: 0, lt: 0.95, stable: false },
    { symbol: 'WETH', priceUsd: 2319, collateralUsd: 0, debtUsd: 79_800, lt: 0, stable: false },
  ],
}

const pct = (v: number | null, dp = 1) => (v === null ? '—' : `${(v * 100).toFixed(dp)}%`)
const hhmm = (iso: string) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '')

const Pill: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <Button
    size="sm"
    variant="outline"
    borderRadius={0}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    color={active ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
    borderColor={active ? SEMANTIC_COLORS.hairlineStrong : SEMANTIC_COLORS.hairline}
    transition={TRANSITIONS.colorAndBorder}
    _hover={HOVER_EFFECTS.borderHighlight}
    _active={ACTIVE_EFFECTS.dim}
    _focus={FOCUS_STYLES.ring}
    onClick={onClick}
    aria-pressed={active}
  >
    {children}
  </Button>
)

const BandChart: React.FC<{ bands: Record<Layer, number[]>; layers: Layer[] }> = ({
  bands,
  layers,
}) => {
  const totals = BAND_NAMES.map((_, i) => layers.reduce((a, L) => a + bands[L][i], 0))
  const max = Math.max(...totals, 1)
  return (
    <VStack
      align="stretch"
      spacing={SPACING.md}
      w="100%"
      role="img"
      aria-label="Debt by distance to liquidation"
    >
      {BAND_NAMES.map((name, i) => (
        <VStack key={name} align="stretch" spacing={SPACING.xs}>
          <HStack justify="space-between">
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {name} from liquidation
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {usd2(totals[i])}
            </Text>
          </HStack>
          <HStack spacing={SPACING.none} h="10px" w="100%" bg={SEMANTIC_COLORS.bgTertiary}>
            {layers.map((L) => (
              <Box key={L} h="100%" w={`${(bands[L][i] / max) * 100}%`} bg={LAYER_COLOR[L]} />
            ))}
          </HStack>
        </VStack>
      ))}
    </VStack>
  )
}

export const LiquidationMap: React.FC<{ doc: LayersDoc | null; stress?: StressDoc | null }> = ({
  doc,
  stress = null,
}) => {
  const { isDemo, address } = useDemoMode()
  const [view, setView] = useState<'all' | Layer>('price')
  const [chain, setChain] = useState<string>('all')
  const [input, setInput] = useState('')
  const [xray, setXray] = useState<XrayResponse | null>(null)
  const [xrayErr, setXrayErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const chains = useMemo(() => (chain === 'all' ? undefined : [chain]), [chain])
  const bands = useMemo(() => (doc ? layerBands(doc, chains) : null), [doc, chains])
  const assets = useMemo(() => (doc ? topAssets(doc, 10, chains) : []), [doc, chains])
  const totals = useMemo(
    () =>
      (bands
        ? Object.fromEntries(LAYERS.map((L) => [L, bands[L].reduce((a, x) => a + x, 0)]))
        : null) as Record<Layer, number> | null,
    [bands],
  )
  const eth = doc?.chains.find((c) => c.chain === 'ethereum')

  const runXray = useCallback(async (addr: string) => {
    setLoading(true)
    setXrayErr(null)
    try {
      const r = await fetch(`/api/xray/${addr}`)
      const body = (await r.json()) as XrayResponse
      if (!r.ok) throw new Error(body.error ?? 'read failed')
      setXray(body)
    } catch (e) {
      setXray(null)
      setXrayErr(e instanceof Error ? e.message : 'read failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isDemo && address) {
      setInput(address)
      runXray(address)
    }
  }, [isDemo, address, runXray])

  const shown = xray ?? (isDemo ? DEMO_XRAY : null)
  const validInput = /^0x[0-9a-fA-F]{40}$/.test(input.trim())

  return (
    <VStack
      align="stretch"
      spacing={SPACING_PATTERNS.sectionGap}
      w="100%"
      maxW="1100px"
      mx="auto"
      px={SPACING.base}
      py={SPACING.lg}
    >
      <VStack align="flex-start" spacing={SPACING.sm}>
        <Eyebrow>01 / Liquidation map · Aave V3 · 7 chains</Eyebrow>
        <Text
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h1}
          fontWeight={TYPOGRAPHY.bold}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Where the liquidations sit
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.body}
          fontStyle="italic"
          color={SEMANTIC_COLORS.textSecondary}
        >
          Debt within 10% of liquidation, split by what actually triggers it.
        </Text>
        {eth ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            measured · full scan of{' '}
            {doc!.chains.reduce((a, c) => a + c.borrowers, 0).toLocaleString('en-US')} borrowers ·
            read {hhmm(eth.readAt)} · snapshot
          </Text>
        ) : null}
      </VStack>

      {!doc || !bands || !totals ? (
        <Card variant="default">
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Snapshot unavailable.
          </Text>
        </Card>
      ) : (
        <>
          <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
            <Stat label="Within 10%" value={usd2(totals.price + totals.pair + totals.stable)} />
            {LAYERS.map((L) => (
              <Stat key={L} label={LAYER_LABEL[L]} value={usd2(totals[L])} tone="muted" />
            ))}
          </SimpleGrid>

          <Card variant="default" p={SPACING_PATTERNS.cardPadding}>
            <VStack align="stretch" spacing={SPACING.base}>
              <Wrap spacing={SPACING.sm}>
                {(['price', 'pair', 'stable', 'all'] as const).map((v) => (
                  <WrapItem key={v}>
                    <Pill active={view === v} onClick={() => setView(v)}>
                      {v === 'all' ? 'All layers' : LAYER_LABEL[v]}
                    </Pill>
                  </WrapItem>
                ))}
              </Wrap>
              <Wrap spacing={SPACING.sm}>
                {['all', ...doc.chains.map((c) => c.chain)].map((c) => (
                  <WrapItem key={c}>
                    <Pill active={chain === c} onClick={() => setChain(c)}>
                      {c}
                    </Pill>
                  </WrapItem>
                ))}
              </Wrap>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {view === 'all'
                  ? 'Each layer has its own trigger; on one scale the loops dwarf price risk.'
                  : LAYER_EXPLAIN[view]}
              </Text>
              <BandChart bands={bands} layers={view === 'all' ? LAYERS : [view]} />
              {view === 'all' ? (
                <HStack spacing={SPACING.base} flexWrap="wrap">
                  {LAYERS.map((L) => (
                    <HStack key={L} spacing={SPACING.xs}>
                      <Box w="8px" h="8px" bg={LAYER_COLOR[L]} />
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        {LAYER_LABEL[L]}
                      </Text>
                    </HStack>
                  ))}
                </HStack>
              ) : null}
            </VStack>
          </Card>

          <Card variant="default" p={SPACING_PATTERNS.cardPadding} overflowX="auto">
            <Eyebrow>02 / Largest collateral groups</Eyebrow>
            <Box
              as="table"
              minW="640px"
              w="100%"
              mt={SPACING.md}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
            >
              <Box as="thead">
                <Box as="tr" color={SEMANTIC_COLORS.textTertiary}>
                  <Box as="th" textAlign="left" py={SPACING.xs}>
                    COLLATERAL
                  </Box>
                  <Box as="th" textAlign="left">
                    LAYER
                  </Box>
                  {BAND_NAMES.map((b) => (
                    <Box as="th" key={b} textAlign="right">
                      {b}
                    </Box>
                  ))}
                  <Box as="th" textAlign="right">
                    POSITIONS
                  </Box>
                </Box>
              </Box>
              <Box as="tbody">
                {assets.map((a) => (
                  <Box
                    as="tr"
                    key={`${a.layer}:${a.asset}`}
                    borderTop="1px solid"
                    borderColor={SEMANTIC_COLORS.hairline}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    <Box as="td" py={SPACING.xs}>
                      {a.asset}
                    </Box>
                    <Box as="td" color={SEMANTIC_COLORS.textSecondary}>
                      {LAYER_LABEL[a.layer]}
                    </Box>
                    {a.debtUsd.map((v, i) => (
                      <Box as="td" key={i} textAlign="right">
                        {v ? usd2(v) : '—'}
                      </Box>
                    ))}
                    <Box as="td" textAlign="right">
                      {a.n.reduce((x, y) => x + y, 0)}
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Card>

          {eth?.pairCarryUsd ? (
            <Card variant="default" p={SPACING_PATTERNS.cardPadding}>
              <VStack align="stretch" spacing={SPACING.sm}>
                <Eyebrow>03 / Ratio loops on Ethereum: is the rate eating them?</Eyebrow>
                <Text
                  fontFamily={TYPOGRAPHY.fontDisplay}
                  fontSize={TYPOGRAPHY.body}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {eth.totalUsd.pair
                    ? Math.floor((eth.pairCarryUsd.hfRises / eth.totalUsd.pair) * 100)
                    : 0}
                  % of the {usd2(eth.totalUsd.pair)} in loops gains health at today&apos;s rates:
                  the staking yield is above the ETH borrow rate.
                </Text>
                <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.base}>
                  <Stat label="Within 30 days" value={usd2(eth.pairCarryUsd.le30d)} tone="muted" />
                  <Stat label="30–90 days" value={usd2(eth.pairCarryUsd['30to90d'])} tone="muted" />
                  <Stat
                    label="90–365 days"
                    value={usd2(eth.pairCarryUsd['90to365d'])}
                    tone="muted"
                  />
                  <Stat label="Over 1 year" value={usd2(eth.pairCarryUsd.gt1y)} tone="muted" />
                </SimpleGrid>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                >
                  Time to liquidation if today&apos;s rates held. Arithmetic on measured rates, not
                  a forecast.
                </Text>
              </VStack>
            </Card>
          ) : null}
        </>
      )}

      <VStack align="stretch" spacing={SPACING.base}>
        <Eyebrow>04 / Position X-ray · Aave V3 Ethereum · live</Eyebrow>
        <HStack
          spacing={SPACING.sm}
          as="form"
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault()
            if (validInput) runXray(input.trim())
          }}
        >
          <Input
            aria-label="Aave account address"
            placeholder="0x… any Aave V3 Ethereum account"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.hairline}
            transition={TRANSITIONS.colorAndBorder}
            _focus={FOCUS_STYLES.ring}
            minH="44px"
          />
          <Button
            type="submit"
            colorScheme="phosphor"
            borderRadius={0}
            minH="44px"
            isDisabled={!validInput}
            isLoading={loading}
            fontFamily={TYPOGRAPHY.fontMono}
            _focus={FOCUS_STYLES.ring}
          >
            X-ray
          </Button>
        </HStack>
        {xrayErr ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.dangerText}
            role="alert"
          >
            {xrayErr}
          </Text>
        ) : null}
        {!xray && isDemo ? <DemoBanner note="example loop · enter any address or connect" /> : null}
        {shown ? (
          <Card variant="elevated" p={SPACING_PATTERNS.cardPadding}>
            <VStack align="stretch" spacing={SPACING.base}>
              <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.base}>
                <Stat label="Risk type" value={LAYER_LABEL[shown.riskType]} />
                <Stat
                  label="Health factor"
                  value={shown.healthFactor === null ? 'no debt' : shown.healthFactor.toFixed(3)}
                  tone={
                    shown.healthFactor !== null && shown.healthFactor < 1.05 ? 'bad' : 'default'
                  }
                />
                <Stat
                  label="Distance"
                  value={
                    shown.healthFactor !== null && shown.healthFactor < 1
                      ? 'past the line'
                      : pct(shown.distance)
                  }
                  sub={shown.band ?? undefined}
                />
                <Stat
                  label={shown.riskType === 'price' ? 'Liquidation price' : 'Trigger'}
                  value={
                    shown.riskType === 'price' && shown.liquidationPrice !== null
                      ? `$${Number(shown.liquidationPrice.toPrecision(5)).toLocaleString('en-US')}`
                      : shown.riskType === 'pair'
                        ? `${shown.mainCollateral} ratio`
                        : 'depeg'
                  }
                  sub={shown.riskType === 'price' ? `${shown.mainCollateral} oracle` : undefined}
                />
              </SimpleGrid>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {shown.riskType === 'price'
                  ? `A ${pct(shown.distance)} fall in every non-stable price, stables fixed, reaches health factor 1.`
                  : shown.riskType === 'pair'
                    ? `${shown.mainCollateral} must lose ${pct(shown.distance)} against the debt asset. On Ethereum Aave prices staked ETH by its exchange rate, so a market depeg does not do this; slashing or rate accrual does.`
                    : `The collateral must lose ${pct(shown.distance)} against the debt in the oracle.`}
              </Text>
              {shown.sameBand ? (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Same band, same collateral: {usd2(shown.sameBand.debtUsd)} across{' '}
                  {shown.sameBand.positions} positions (snapshot).
                </Text>
              ) : null}
              <Box as="table" w="100%" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs}>
                <Box as="tbody">
                  {shown.reserves.map((r) => (
                    <Box
                      as="tr"
                      key={r.symbol}
                      borderTop="1px solid"
                      borderColor={SEMANTIC_COLORS.hairline}
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      <Box as="td" py={SPACING.xs}>
                        {r.symbol}
                      </Box>
                      <Box as="td" textAlign="right">
                        {r.collateralUsd ? `${usd2(r.collateralUsd)} collateral` : ''}
                      </Box>
                      <Box as="td" textAlign="right">
                        {r.debtUsd ? `${usd2(r.debtUsd)} debt` : ''}
                      </Box>
                      <Box as="td" textAlign="right" color={SEMANTIC_COLORS.textSecondary}>
                        {r.collateralUsd ? `LT ${pct(r.lt, 1)}` : ''}
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
              <RulesCheck
                healthFactor={shown.healthFactor}
                distance={shown.distance}
                past7d={shown.history?.['7d'] ?? null}
                curve={shown.riskType === 'price' ? (shown.history?.curve ?? null) : null}
                reserves={shown.reserves}
              />
              <CrashHistory history={shown.history ?? null} distance={shown.distance} />
              <CarryAtRates carry={shown.carry ?? null} />
              {shown.debtUsd > 0 ? (
                <WhatIfSimulator
                  reserves={shown.reserves}
                  main={shown.mainCollateral}
                  ratioOnly={shown.riskType === 'pair'}
                />
              ) : null}
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
              >
                {xray
                  ? `measured · Aave V3 Pool and oracle · read ${hhmm(xray.readAt)} · block ${xray.marketBlock}`
                  : 'demo fixture · synthetic loop, not a real account'}
              </Text>
            </VStack>
          </Card>
        ) : null}
      </VStack>

      <MarketsSheet />

      <BorrowBoard />

      <StressReplay doc={stress} />

      <Caveats
        items={[
          'Snapshot of known Aave V3 borrowers with debt of at least $100; not a live feed.',
          'Price layer assumes every non-stable price falls together, stables fixed.',
          'Loops and stablecoin positions are banded by the collateral-only move (1 − 1/HF).',
          'Distances are oracle distances. Aave liquidates on its oracle, which can differ from the market.',
          'No number here is a forecast.',
        ]}
      />
    </VStack>
  )
}

export default LiquidationMap
