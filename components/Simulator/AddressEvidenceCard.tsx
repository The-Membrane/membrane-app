import React, { useRef, useState } from 'react'
import {
  Box,
  Button,
  Popover,
  PopoverBody,
  PopoverCloseButton,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Text,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { netKeptUsd, type HistoryResponse } from '@/lib/position-sim/history'
import { CORPUS_SCALE_LINE, OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'
import { exportElementAsImage } from '@/services/shareableCard'

import { usd } from './format'
import { historyDate } from './HistoryProof'

type Props = {
  address: string
  history: HistoryResponse | undefined
  loading: boolean
  failed: boolean
}

const eyebrow = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '12px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
}

/** One wallet result and two separate global findings; their units never mix. */
const AddressEvidenceCard: React.FC<Props> = ({ address, history, loading, failed }) => {
  const cardRef = useRef<HTMLDivElement>(null)
  const [shareState, setShareState] = useState('')
  const priced = history?.episodes.filter((episode) => episode.verdict !== 'unknown') ?? []
  const netKept = netKeptUsd(history?.episodes ?? []) ?? 0
  const unpricedEvents = history?.events.filter((event) => event.unpriced).length ?? 0
  const notScanned = history?.notScanned?.map((item) => item.protocol).join(', ') ?? ''
  const partialCoverage = unpricedEvents > 0 || notScanned.length > 0
  const scannedAt = history?.scannedAt ? new Date(history.scannedAt) : null
  const scannedDate =
    scannedAt && !Number.isNaN(scannedAt.getTime())
      ? scannedAt.toLocaleDateString('en-US', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : null

  const copyLink = async () => {
    try {
      // This card shares the wallet's history, not a position-model run. Build a
      // clean link so a rapid wallet switch cannot copy the previous wallet's
      // still-pending shallow URL state or its model controls.
      const url = new URL(window.location.pathname, window.location.origin)
      url.searchParams.set('a', address)
      await navigator.clipboard.writeText(url.toString())
      setShareState('Link copied')
    } catch {
      setShareState('Could not copy link')
    }
  }

  const downloadImage = async () => {
    if (!cardRef.current) return
    try {
      await exportElementAsImage(cardRef.current, `membrane-protection-${address.slice(2, 8)}.png`)
      setShareState('Image saved')
    } catch {
      setShareState('Could not save image')
    }
  }

  return (
    <Box
      data-testid="address-evidence"
      minW={0}
      display="grid"
      gap={SPACING.sm}
      w="100%"
      justifySelf="stretch"
      textAlign="left"
    >
      <Box
        ref={cardRef}
        data-card-element
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        bg={SEMANTIC_COLORS.bgSecondary}
        p={{ base: SPACING.base, md: SPACING.lg }}
        minW={0}
        display="grid"
        gap={SPACING.base}
      >
        <Box
          minW={0}
          display="flex"
          justifyContent="space-between"
          flexWrap="wrap"
          gap={SPACING.sm}
        >
          <Text {...eyebrow} color={SEMANTIC_COLORS.textSecondary}>
            Your liquidation replay
          </Text>
          <Text {...eyebrow} color={SEMANTIC_COLORS.textSecondary} overflowWrap="anywhere">
            {address}
          </Text>
        </Box>

        <Box minW={0} display="grid" gap={SPACING.xs}>
          <Text {...eyebrow} color={SEMANTIC_COLORS.textSecondary}>
            Your recorded liquidation history
          </Text>
          {loading ? (
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
              Checking recorded liquidations…
            </Text>
          ) : failed || history?.error ? (
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.danger}>
              History scan unavailable. No personal savings claim is shown.
            </Text>
          ) : !history?.episodes.length ? (
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
              {notScanned
                ? `No mainnet liquidations found in completed scans. Not scanned: ${notScanned}.`
                : 'No mainnet liquidations on record for this address on Aave V3, Spark or Morpho Blue.'}
            </Text>
          ) : priced.length === 0 ? (
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
              {history.episodes.length} recorded episode{history.episodes.length === 1 ? '' : 's'},
              none priced for a dollar comparison.
            </Text>
          ) : (
            <>
              <Text
                data-testid="address-evidence-net"
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize="clamp(30px, 6vw, 52px)"
                lineHeight={1.05}
                color={
                  netKept > 0
                    ? SEMANTIC_COLORS.success
                    : netKept < 0
                      ? SEMANTIC_COLORS.danger
                      : SEMANTIC_COLORS.textPrimary
                }
                overflowWrap="anywhere"
              >
                {partialCoverage
                  ? `${usd(netKept)} net on covered events`
                  : netKept > 0
                    ? `Would have kept ${usd(netKept)}`
                    : netKept < 0
                      ? `Would have cost ${usd(-netKept)}`
                      : 'No net difference'}
              </Text>
              <Box display="flex" alignItems="center" gap={SPACING.xs} minW={0}>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="12px"
                  lineHeight={1.6}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Actual collateral seized minus modeled Membrane collateral seized across{' '}
                  {priced.length} priced episode{priced.length === 1 ? '' : 's'}.
                </Text>
                <Popover placement="bottom-end" closeOnBlur>
                  <PopoverTrigger>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label="About this liquidation history"
                      title="About this liquidation history"
                      w="44px"
                      minW="44px"
                      h="44px"
                      p={0}
                      flexShrink={0}
                      borderRadius={0}
                      fontSize="18px"
                    >
                      ⓘ
                    </Button>
                  </PopoverTrigger>
                  <Portal>
                    <PopoverContent
                      w={{ base: 'calc(100vw - 32px)', md: '360px' }}
                      borderRadius={0}
                      border="1px solid"
                      borderColor={SEMANTIC_COLORS.borderStrong}
                      bg={SEMANTIC_COLORS.bgPrimary}
                      color={SEMANTIC_COLORS.textPrimary}
                      boxShadow="lg"
                    >
                      <PopoverCloseButton aria-label="Close history details" borderRadius={0} />
                      <PopoverBody p={SPACING.base} pr={SPACING.lg}>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" lineHeight={1.6}>
                          {history.since.firstEventTs
                            ? `First recorded episode ${historyDate(history.since.firstEventTs)}. `
                            : ''}
                          {scannedDate ? `Scanned ${scannedDate}. ` : ''}
                          Observed mainnet liquidation events where the scan completed; Membrane
                          outcomes are modeled.
                          {notScanned ? ` Not scanned: ${notScanned}.` : ''}
                          {unpricedEvents > 0
                            ? ` ${unpricedEvents} unpriced event${unpricedEvents === 1 ? '' : 's'} excluded, including any inside priced episodes; this is not a complete wallet total.`
                            : ''}
                        </Text>
                      </PopoverBody>
                    </PopoverContent>
                  </Portal>
                </Popover>
              </Box>
            </>
          )}
        </Box>

        <Box
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          pt={SPACING.base}
          display="grid"
          gridTemplateColumns={{ base: '1fr', md: 'repeat(2, minmax(0, 1fr))' }}
          gap={SPACING.base}
        >
          <Box minW={0} display="grid" gap={SPACING.xs}>
            <Text {...eyebrow} color={SEMANTIC_COLORS.textSecondary}>
              Global · 10 Oct 2025
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="clamp(20px, 3vw, 28px)"
              color={SEMANTIC_COLORS.warning}
            >
              {OCT10_SCALE_LINE.figure} debt protected
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              Aave liquidation cohort, not this wallet’s result.
            </Text>
          </Box>
          <Box minW={0} display="grid" gap={SPACING.xs}>
            <Text {...eyebrow} color={SEMANTIC_COLORS.textSecondary}>
              Global · {CORPUS_SCALE_LINE.window}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="clamp(20px, 3vw, 28px)"
              color={SEMANTIC_COLORS.warning}
            >
              {CORPUS_SCALE_LINE.partial ? 'At least ' : ''}
              {CORPUS_SCALE_LINE.figure} collateral kept
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12px"
              color={SEMANTIC_COLORS.textSecondary}
            >
              Aave V3 episodes, not this wallet’s result.
            </Text>
          </Box>
        </Box>
      </Box>

      {!loading && !failed && !history?.error && (
        <Box display="flex" flexWrap="wrap" alignItems="center" gap={SPACING.sm}>
          <Button size="sm" variant="outline" borderRadius={0} onClick={copyLink}>
            Copy result link
          </Button>
          <Button size="sm" variant="outline" borderRadius={0} onClick={downloadImage}>
            Save card image
          </Button>
          <Text
            role="status"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="12px"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {shareState}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default AddressEvidenceCard
