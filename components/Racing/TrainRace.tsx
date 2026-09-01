// TrainRace — the burner-signed gameplay controls: train, batch-train, ladder race, and the
// daily maze run. Every control shows a live gas→USD estimate before it sends. All sends are
// promptless (burner-signed) once a play session is live.

import React, { useMemo, useState } from 'react'
import { Box, Button, HStack, Slider, SliderFilledTrack, SliderThumb, SliderTrack, Text, VStack } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import type { Abi, PublicClient } from 'viem'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { pocketGPAbi, TIER_NAMES } from '@/lib/qgame/abi'
import { estimateActionGasCost } from '@/lib/qgame/gas'
import type { EvmCall } from '@/services/chain/types'
import {
  useQGameConfig,
  useQGameDaily,
  useTrain,
  useTrainBatch,
  useRace,
  useRunDaily,
  type PetWithId,
} from '@/hooks/useQGame'

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}

// Batch cap: mainnet keeps it low (each training race is a heavy Q-table sim; a big batch
// risks blowing the block gas limit), anvil allows the full contract cap of 20.
const BATCH_CAP_MAINNET = 8
const BATCH_CAP_ANVIL = 20

/** Live gas→USD estimate for one call, estimated against the owner (cost is signer-agnostic). */
function GasLabel({ call, enabled }: { call: EvmCall | null; enabled: boolean }) {
  const { address, publicClient, chainId } = useQGameConfig()
  const q = useQuery({
    queryKey: ['qgame', 'gas', chainId, call?.functionName, JSON.stringify(call?.args?.map(String)), address],
    enabled: enabled && !!call && !!address && !!publicClient,
    staleTime: 12_000,
    queryFn: () =>
      estimateActionGasCost({ publicClient: publicClient as PublicClient, call: call!, account: address!, chainId }),
  })
  const txt = q.isLoading ? 'estimating…' : q.data ? `≈ $${q.data.usd.toFixed(3)} gas` : 'gas est. n/a'
  return (
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
      {txt}
    </Text>
  )
}

const TrainRace: React.FC<{ pet: PetWithId; sessionLive: boolean }> = ({ pet, sessionLive }) => {
  const { addresses, chainId } = useQGameConfig()
  const isAnvil = chainId === 31337
  const batchCap = isAnvil ? BATCH_CAP_ANVIL : BATCH_CAP_MAINNET

  const [tier, setTier] = useState(0)
  const [count, setCount] = useState(3)
  const [seed] = useState(() => Math.floor(Math.random() * 0xffffffff))

  const train = useTrain()
  const trainBatch = useTrainBatch()
  const race = useRace()
  const daily = useRunDaily()
  const { data: dailyState } = useQGameDaily()

  const gp = pocketGPAbi as unknown as Abi
  const gpAddr = addresses?.pocketGP
  const trainCall = useMemo<EvmCall | null>(
    () => (gpAddr ? { address: gpAddr, abi: gp, functionName: 'train', args: [pet.id, tier] } : null),
    [gpAddr, gp, pet.id, tier],
  )
  const batchCall = useMemo<EvmCall | null>(
    () => (gpAddr ? { address: gpAddr, abi: gp, functionName: 'trainBatch', args: [pet.id, tier, count] } : null),
    [gpAddr, gp, pet.id, tier, count],
  )
  const raceCall = useMemo<EvmCall | null>(
    () => (gpAddr ? { address: gpAddr, abi: gp, functionName: 'race', args: [pet.id, tier, seed] } : null),
    [gpAddr, gp, pet.id, tier, seed],
  )
  const dailyCall = useMemo<EvmCall | null>(
    () => (gpAddr ? { address: gpAddr, abi: gp, functionName: 'runDaily', args: [pet.id] } : null),
    [gpAddr, gp, pet.id],
  )

  const busy = train.isPending || trainBatch.isPending || race.isPending || daily.isPending
  const disabled = !sessionLive || busy

  return (
    <Card variant="default">
      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <Text {...label}>Train &amp; race</Text>

        {/* Tier selector */}
        <Box>
          <Text {...label} fontSize="10px" mb={SPACING.xs}>Circuit</Text>
          <HStack spacing={SPACING.xs} flexWrap="wrap">
            {TIER_NAMES.map((name, i) => {
              const active = tier === i
              return (
                <Button
                  key={name}
                  onClick={() => setTier(i)}
                  size="xs"
                  variant="ghost"
                  borderRadius={0}
                  border="1px solid"
                  borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                  color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  transition={TRANSITIONS.colors}
                  _hover={HOVER_EFFECTS.borderHighlight}
                  _active={ACTIVE_EFFECTS.dim}
                  _focus={FOCUS_STYLES.ring}
                >
                  {name}
                </Button>
              )
            })}
          </HStack>
        </Box>

        {/* Train once */}
        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          <HStack justify="space-between" align="center">
            <VStack align="start" spacing={0}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
                Train once
              </Text>
              <GasLabel call={trainCall} enabled={!disabled} />
            </VStack>
            <Button
              size="sm" borderRadius={0} variant="ghost" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}
              color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}
              isDisabled={disabled} isLoading={train.isPending}
              transition={TRANSITIONS.colors} _hover={HOVER_EFFECTS.borderHighlight} _active={ACTIVE_EFFECTS.dim} _focus={FOCUS_STYLES.ring}
              onClick={() => train.mutate({ id: pet.id, tierIdx: tier })}
            >
              Train
            </Button>
          </HStack>
        </Box>

        {/* Batch train */}
        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          <HStack justify="space-between" mb={SPACING.xs}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
              Batch train · {count}
            </Text>
            <GasLabel call={batchCall} enabled={!disabled} />
          </HStack>
          <HStack spacing={SPACING.md}>
            <Slider aria-label="batch-count" min={1} max={batchCap} step={1} value={count} onChange={setCount} flex="1" focusThumbOnChange={false}>
              <SliderTrack bg={SEMANTIC_COLORS.borderSubtle}>
                <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
              </SliderTrack>
              <SliderThumb boxSize={3} bg={SEMANTIC_COLORS.primary} borderRadius={0} _focus={FOCUS_STYLES.ring} />
            </Slider>
            <Button
              size="sm" borderRadius={0} variant="ghost" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}
              color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}
              isDisabled={disabled} isLoading={trainBatch.isPending}
              transition={TRANSITIONS.colors} _hover={HOVER_EFFECTS.borderHighlight} _active={ACTIVE_EFFECTS.dim} _focus={FOCUS_STYLES.ring}
              onClick={() => trainBatch.mutate({ id: pet.id, tierIdx: tier, count })}
            >
              Run {count}
            </Button>
          </HStack>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
            Cap {batchCap} ({isAnvil ? 'anvil' : 'mainnet — kept low to stay under the block gas limit'}). Each race is a
            full Q-table sim; oversized batches can exceed block gas and revert.
          </Text>
        </Box>

        {/* Ladder race */}
        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          <HStack justify="space-between" align="center">
            <VStack align="start" spacing={0}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
                Race · {TIER_NAMES[tier]}
              </Text>
              <GasLabel call={raceCall} enabled={!disabled} />
            </VStack>
            <Button
              size="sm" borderRadius={0} variant="ghost" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}
              color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}
              isDisabled={disabled} isLoading={race.isPending}
              transition={TRANSITIONS.colors} _hover={HOVER_EFFECTS.borderHighlight} _active={ACTIVE_EFFECTS.dim} _focus={FOCUS_STYLES.ring}
              onClick={() => race.mutate({ id: pet.id, tierIdx: tier, seed })}
            >
              Race
            </Button>
          </HStack>
        </Box>

        {/* Daily maze */}
        <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
          <HStack justify="space-between" align="center">
            <VStack align="start" spacing={0}>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
                Daily maze {dailyState?.claimed ? '· claimed today' : ''}
              </Text>
              <GasLabel call={dailyCall} enabled={!disabled} />
            </VStack>
            <Button
              size="sm" borderRadius={0} variant="ghost" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}
              color={SEMANTIC_COLORS.textPrimary} fontFamily={TYPOGRAPHY.fontMono}
              isDisabled={disabled} isLoading={daily.isPending}
              transition={TRANSITIONS.colors} _hover={HOVER_EFFECTS.borderHighlight} _active={ACTIVE_EFFECTS.dim} _focus={FOCUS_STYLES.ring}
              onClick={() => daily.mutate({ id: pet.id })}
            >
              Run daily
            </Button>
          </HStack>
        </Box>

        {!sessionLive && (
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
            Start a play session to enable promptless training and racing.
          </Text>
        )}
      </VStack>
    </Card>
  )
}

export default TrainRace
