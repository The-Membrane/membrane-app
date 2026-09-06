import React, { useMemo, useRef, useState } from 'react'
import { Box, Button, HStack, Input, Select, Slider, SliderFilledTrack, SliderThumb, SliderTrack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import NextLink from 'next/link'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SectionHeading, Stamp } from '@/components/Carry/atoms'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'
import { exportElementAsImage } from '@/services/shareableCard'
import venueConfig from '@/tools/venue-recorder.config.json'

import {
  buildReceiptStatement,
  calibrationReadout,
  fmtStatementUsd,
  metricForKind,
  type Calibration,
  type ReceiptMetric,
} from './receiptLogic'
import { ReceiptShareCard } from './ReceiptShareCard'

// CALLED-IT RECEIPTS — a user signs a probability call on a venue outcome with
// their wallet; our recorder scores it against what actually happened; the
// scored, dated receipt is theirs to share. Calibration/process only — no
// leaderboard by wins, no returns, confidence only from realized outcomes
// (BADASS_RULESET §7 / §9.3).

type VenueEntry = { name: string; kind: string; enabled?: boolean }
const VENUES = (venueConfig.venues as VenueEntry[]).filter((v) => v.enabled)

type Receipt = {
  id: string
  venue: string
  metric: ReceiptMetric
  statement: string
  band_low: number
  band_high: number
  probability_pct: number
  horizon_hours: number
  made_at: string
  realized: number | null
  scored_at: string | null
  hit: boolean | null
}
type ReceiptsResponse = { address: string; receipts: Receipt[]; calibration: Calibration }

const state = (r: Receipt): 'OPEN' | 'HIT' | 'MISS' =>
  r.scored_at === null ? 'OPEN' : r.hit ? 'HIT' : 'MISS'

const STATE_COLOR: Record<'OPEN' | 'HIT' | 'MISS', string> = {
  OPEN: SEMANTIC_COLORS.textSecondary,
  HIT: SEMANTIC_COLORS.success,
  MISS: SEMANTIC_COLORS.danger,
}

export const Receipts: React.FC = () => {
  const { address, isWalletConnected, connect, walletClient } = useWallet()
  const { chainName } = useChainRoute()

  const [venueName, setVenueName] = useState(VENUES[0]?.name ?? '')
  const [bandLow, setBandLow] = useState('')
  const [bandHigh, setBandHigh] = useState('')
  const [horizonDays, setHorizonDays] = useState(3)
  const [confidence, setConfidence] = useState(70)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const venue = VENUES.find((v) => v.name === venueName) ?? VENUES[0]
  const metric = venue ? (metricForKind(venue.kind) as ReceiptMetric | null) : null

  const low = Number(bandLow)
  const high = Number(bandHigh)
  const bandOk = Number.isFinite(low) && Number.isFinite(high) && low > 0 && high > 0 && low < high

  // Live statement preview (illustrative made_at = now). The actually-signed
  // statement uses the made_at captured at the instant of signing.
  const preview = useMemo(() => {
    if (!venue || !metric) return ''
    return buildReceiptStatement({
      venue: venue.name,
      metric,
      bandLow: bandOk ? low : 0,
      bandHigh: bandOk ? high : 0,
      probabilityPct: confidence,
      horizonHours: horizonDays * 24,
      madeAt: new Date().toISOString(),
    })
  }, [venue, metric, bandOk, low, high, confidence, horizonDays])

  const { data, refetch } = useQuery<ReceiptsResponse>({
    queryKey: ['receipts', address],
    enabled: !!address,
    queryFn: async () => {
      const r = await fetch(`/api/receipts?address=${address}`)
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `receipts ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 30,
    refetchOnMount: true,
  })

  const sign = async () => {
    setErr(null)
    if (!venue || !metric || !bandOk) {
      setErr('enter a valid band (low < high, both > 0)')
      return
    }
    if (!isWalletConnected || !address || !walletClient) {
      setErr('connect a wallet to sign')
      return
    }
    setBusy(true)
    try {
      const madeAt = new Date().toISOString()
      const claim = {
        venue: venue.name,
        metric,
        bandLow: low,
        bandHigh: high,
        probabilityPct: confidence,
        horizonHours: horizonDays * 24,
        madeAt,
      }
      const statement = buildReceiptStatement(claim)
      const signature = await walletClient.signMessage({ account: address, message: statement })
      const res = await fetch('/api/receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, ...claim, signature }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `post ${res.status}`)
      setBandLow('')
      setBandHigh('')
      await refetch()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // --- share-image for a SCORED receipt -------------------------------------
  const cardRef = useRef<HTMLDivElement>(null)
  const [cardReceipt, setCardReceipt] = useState<Receipt | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const saveCard = async (r: Receipt) => {
    if (r.scored_at === null || r.realized === null) return
    setSavingId(r.id)
    setCardReceipt(r)
    try {
      // let the off-screen card paint before capturing
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      if (cardRef.current) await exportElementAsImage(cardRef.current, `called-it-${r.id}.png`)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary} letterSpacing="-0.01em">
        Called It
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.sm} maxW="680px">
        Sign a probability call on a venue outcome with your wallet. Our recorder
        scores it against what actually happened. The scored, dated receipt is
        yours to share — we grade calibration and process, never returns.
      </Text>

      {/* --- the call form ---------------------------------------------------- */}
      <SectionHeading index="01 /" title="Make a call" />
      <Card variant="default" p={SPACING.base}>
        <HStack spacing={SPACING.md} flexWrap="wrap" align="flex-end">
          <FieldLabel label="Venue">
            <Select
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="13px"
              borderRadius={0}
              bg={SEMANTIC_COLORS.bgSecondary}
              borderColor={SEMANTIC_COLORS.borderMedium}
              w="180px"
            >
              {VENUES.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </Select>
          </FieldLabel>
          <FieldLabel label="Metric">
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary} py="8px">
              {metric ?? '—'}
            </Text>
          </FieldLabel>
          <FieldLabel label="Band low (USD)">
            <NumInput value={bandLow} onChange={setBandLow} placeholder="1200000000" />
          </FieldLabel>
          <FieldLabel label="Band high (USD)">
            <NumInput value={bandHigh} onChange={setBandHigh} placeholder="1600000000" />
          </FieldLabel>
        </HStack>

        <HStack spacing={SPACING.xl} flexWrap="wrap" mt={SPACING.lg} align="flex-start">
          <Box minW="240px" flex="1">
            <FieldCaption>Horizon — {horizonDays}d</FieldCaption>
            <Slider min={1} max={30} step={1} value={horizonDays} onChange={setHorizonDays} mt="6px">
              <SliderTrack bg={SEMANTIC_COLORS.borderMedium}>
                <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
              </SliderTrack>
              <SliderThumb />
            </Slider>
          </Box>
          <Box minW="240px" flex="1">
            <FieldCaption>Confidence — {confidence}%</FieldCaption>
            <Slider min={1} max={99} step={1} value={confidence} onChange={setConfidence} mt="6px">
              <SliderTrack bg={SEMANTIC_COLORS.borderMedium}>
                <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
              </SliderTrack>
              <SliderThumb />
            </Slider>
          </Box>
        </HStack>

        {/* statement preview — the exact bytes the wallet will sign */}
        <Box mt={SPACING.lg} p={SPACING.md} bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          <FieldCaption>You will sign</FieldCaption>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary} mt="6px" lineHeight={1.6}>
            {preview}
          </Text>
        </Box>

        <HStack mt={SPACING.md} spacing={SPACING.sm}>
          {isWalletConnected ? (
            <Button
              onClick={sign}
              isDisabled={busy || !bandOk}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="13px"
              borderRadius={0}
              bg={SEMANTIC_COLORS.bgTertiary}
              color={SEMANTIC_COLORS.textPrimary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
              _focusVisible={FOCUS_STYLES.ring}
            >
              {busy ? 'signing…' : 'sign this call'}
            </Button>
          ) : (
            <Button
              onClick={() => connect()}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="13px"
              borderRadius={0}
              bg={SEMANTIC_COLORS.bgTertiary}
              color={SEMANTIC_COLORS.textPrimary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
              _focusVisible={FOCUS_STYLES.ring}
            >
              connect to sign
            </Button>
          )}
          {err && (
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.danger}>
              {err}
            </Text>
          )}
        </HStack>
      </Card>

      {/* --- the caller's receipts ------------------------------------------- */}
      {address && (
        <>
          <SectionHeading
            index="02 /"
            title="Your receipts"
            note={data ? calibrationReadout(data.calibration) : '—'}
          />
          {(!data || data.receipts.length === 0) && (
            <Card variant="subtle" p={SPACING.base}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
                No calls yet. Make one above — it becomes a signed, dated receipt
                the recorder will score at its horizon.
              </Text>
            </Card>
          )}
          {data?.receipts.map((r) => {
            const st = state(r)
            const isMiss = st === 'MISS'
            return (
              <Card
                key={r.id}
                variant="default"
                mb={SPACING.base}
                // A MISS renders at full volume — failure stays unambiguous.
                bg={isMiss ? 'rgba(207,64,52,0.10)' : undefined}
                borderColor={isMiss ? SEMANTIC_COLORS.danger : undefined}
              >
                <HStack justify="space-between" align="baseline" flexWrap="wrap" gap={SPACING.sm}>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={SEMANTIC_COLORS.textPrimary} maxW="820px">
                    {r.statement}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="14px"
                    letterSpacing="0.16em"
                    color={STATE_COLOR[st]}
                    fontWeight={isMiss ? 700 : 400}
                  >
                    {st}
                  </Text>
                </HStack>
                {r.scored_at !== null && r.realized !== null && (
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={STATE_COLOR[st]} mt={SPACING.sm}>
                    realized {fmtStatementUsd(r.realized)} vs band {fmtStatementUsd(r.band_low)}–{fmtStatementUsd(r.band_high)}
                    {' · scored '}
                    {new Date(r.scored_at).toISOString().slice(0, 16).replace('T', ' ')}Z
                  </Text>
                )}
                {r.scored_at !== null && (
                  <Button
                    onClick={() => saveCard(r)}
                    isDisabled={savingId === r.id}
                    size="sm"
                    mt={SPACING.md}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="11px"
                    borderRadius={0}
                    bg="transparent"
                    color={SEMANTIC_COLORS.textSecondary}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderStrong}
                    _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
                    _focusVisible={FOCUS_STYLES.ring}
                  >
                    {savingId === r.id ? 'rendering…' : 'save image'}
                  </Button>
                )}
              </Card>
            )
          })}

          <Box mt={SPACING.lg}>
            <Stamp>
              scored by the membrane recorder against realized venue metrics; band containment only,
              no returns, no ranking by wins. calibration is computed at read time and never stored as a badge.
            </Stamp>
          </Box>

          {/* Next — a scored call points at the board and the big books. */}
          <Card variant="subtle" p={SPACING.base} mt={SPACING.lg}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
              next
            </Text>
            <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.sm}>
              <NextLink href={`/${chainName}/strats`} style={{ textDecoration: 'underline' }}>
                <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} _hover={{ color: SEMANTIC_COLORS.success }}>
                  see the tracked books → /strats
                </Text>
              </NextLink>
              <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
                <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} _hover={{ color: SEMANTIC_COLORS.success }}>
                  the board that prices your call → /carry
                </Text>
              </NextLink>
            </HStack>
          </Card>
        </>
      )}

      {/* off-screen export card for the selected scored receipt */}
      {cardReceipt && cardReceipt.realized !== null && cardReceipt.scored_at !== null && (
        <ReceiptShareCard
          ref={cardRef}
          statement={cardReceipt.statement}
          hit={cardReceipt.hit === true}
          realized={cardReceipt.realized}
          bandLow={cardReceipt.band_low}
          bandHigh={cardReceipt.band_high}
          scoredAtText={new Date(cardReceipt.scored_at).toISOString().slice(0, 10)}
        />
      )}
    </Box>
  )
}

const FieldLabel: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <Box>
    <FieldCaption>{label}</FieldCaption>
    <Box mt="4px">{children}</Box>
  </Box>
)

const FieldCaption: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

const NumInput: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string }> = ({
  value,
  onChange,
  placeholder,
}) => (
  <Input
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    inputMode="decimal"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="13px"
    borderRadius={0}
    bg={SEMANTIC_COLORS.bgSecondary}
    borderColor={SEMANTIC_COLORS.borderMedium}
    _focusVisible={FOCUS_STYLES.ring}
    w="150px"
  />
)

export default Receipts
