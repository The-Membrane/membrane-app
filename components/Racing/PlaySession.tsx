// PlaySession — the burner session lifecycle card. Starting a session is the only place
// (besides createPet and its approvals) the OWNER signs: grantSession + a small ETH top-up.
// Everything after is burner-signed and promptless. Shows burner address, expiry, remaining
// dust gas, and the base-fee cap that guards every burner send.

import React, { useState } from 'react'
import { Box, Button, HStack, Input, Text, VStack } from '@chakra-ui/react'
import { formatEther } from 'viem'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { useQGameSession, useStartSession, useEndSession } from '@/hooks/useQGame'
import { getFeeCapGwei, setFeeCapGwei, DEFAULT_TOPUP_ETH } from '@/lib/qgame/session'

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}
const trunc = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—')

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <HStack justify="space-between">
      <Text {...label} fontSize="10px">{k}</Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={tone ?? SEMANTIC_COLORS.textPrimary}>
        {v}
      </Text>
    </HStack>
  )
}

const PlaySession: React.FC = () => {
  const { data: status } = useQGameSession()
  const start = useStartSession()
  const end = useEndSession()
  const [topup, setTopup] = useState(DEFAULT_TOPUP_ETH)
  const [feeCap, setFeeCap] = useState<number>(getFeeCapGwei())

  const live = status?.live ?? false
  const expiryDate = status && status.session.expiry > 0n ? new Date(Number(status.session.expiry) * 1000) : null

  const onFeeCap = (v: string) => {
    const n = Number(v)
    setFeeCap(Number.isFinite(n) ? n : 0)
    if (Number.isFinite(n) && n > 0) setFeeCapGwei(n)
  }

  return (
    <Card variant="elevated">
      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <HStack justify="space-between">
          <Text {...label}>Play session</Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            color={live ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}
          >
            {live ? '● live' : '○ inactive'}
          </Text>
        </HStack>

        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
          A session grants a throwaway burner key so training and racing run without a wallet
          prompt each time. The burner only ever holds a little gas — all winnings go to your wallet.
        </Text>

        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          <VStack align="stretch" spacing={SPACING.sm}>
            <Row k="Burner" v={trunc(status?.burnerAddress)} />
            <Row
              k="Expires"
              v={live && expiryDate ? expiryDate.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
            />
            <Row
              k="Gas left"
              v={status ? `${Number(formatEther(status.gasBalanceWei)).toPrecision(3)} ETH` : '…'}
              tone={status && status.gasBalanceWei > 0n ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.warning}
            />
            <HStack justify="space-between">
              <Text {...label} fontSize="10px">Base-fee cap</Text>
              <HStack spacing={SPACING.xs}>
                <Input
                  value={feeCap}
                  onChange={(e) => onFeeCap(e.target.value)}
                  type="number"
                  min={1}
                  size="xs"
                  w="72px"
                  textAlign="right"
                  borderRadius={0}
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  bg={SEMANTIC_COLORS.bgPrimary}
                  color={SEMANTIC_COLORS.textPrimary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  _focus={FOCUS_STYLES.ring}
                />
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
                  gwei
                </Text>
              </HStack>
            </HStack>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
              The burner refuses to send when the network base fee is over this cap.
            </Text>
          </VStack>
        </Box>

        {!live ? (
          <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
            <HStack justify="space-between" mb={SPACING.sm}>
              <Text {...label} fontSize="10px">Top-up</Text>
              <HStack spacing={SPACING.xs}>
                <Input
                  value={topup}
                  onChange={(e) => setTopup(e.target.value)}
                  size="xs"
                  w="72px"
                  textAlign="right"
                  borderRadius={0}
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  bg={SEMANTIC_COLORS.bgPrimary}
                  color={SEMANTIC_COLORS.textPrimary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  _focus={FOCUS_STYLES.ring}
                />
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
                  ETH
                </Text>
              </HStack>
            </HStack>
            <Button
              w="100%"
              colorScheme="phosphor"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              isLoading={start.isPending}
              loadingText="Granting session…"
              transition={TRANSITIONS.colors}
              _hover={HOVER_EFFECTS.borderHighlight}
              _active={ACTIVE_EFFECTS.dim}
              _focus={FOCUS_STYLES.ring}
              onClick={() => start.mutate({ topupEth: topup })}
            >
              Start play session
            </Button>
            {start.isError && (
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.danger} mt={SPACING.xs}>
                {(start.error as Error)?.message ?? 'Could not start session'}
              </Text>
            )}
          </Box>
        ) : (
          <Button
            w="100%"
            variant="ghost"
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            isLoading={end.isPending}
            loadingText="Ending & sweeping…"
            transition={TRANSITIONS.colors}
            _hover={HOVER_EFFECTS.borderHighlight}
            _active={ACTIVE_EFFECTS.dim}
            _focus={FOCUS_STYLES.ring}
            onClick={() => end.mutate()}
          >
            End session · sweep gas back
          </Button>
        )}
      </VStack>
    </Card>
  )
}

export default PlaySession
