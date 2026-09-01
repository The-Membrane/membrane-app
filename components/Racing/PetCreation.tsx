// PetCreation — OWNER-signed pet minting with a CDT / USDC / ETH payment selector.
// Demo-first: with no wallet the rows still render; the CTA becomes an intent-preserving
// "Connect wallet" that lands back here. Living Typeface, mono numbers.

import React, { useState } from 'react'
import { Box, Button, HStack, Input, Text, VStack } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatUnits, type PublicClient } from 'viem'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { RouterQuoteSource } from '@/lib/payments/quotes'
import { CDT_DECIMALS } from '@/lib/qgame/abi'
import { pocketGPAbi } from '@/lib/qgame/abi'
import { useCreatePet, useQGameConfig, type PayWith } from '@/hooks/useQGame'

export const PET_CREATION_ANCHOR = 'qgame-pet-creation'

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}
const mono = { fontFamily: TYPOGRAPHY.fontMono, color: SEMANTIC_COLORS.textPrimary }

const PAY_OPTIONS: { key: PayWith; text: string; sub: string }[] = [
  { key: 'CDT', text: 'CDT', sub: 'pay the 3 CDT hatch fee directly' },
  { key: 'USDC', text: 'USDC', sub: 'swap USDC → 3 CDT, then hatch' },
  { key: 'ETH', text: 'ETH', sub: 'swap ETH → 3 CDT, then hatch' },
]

const PetCreation: React.FC = () => {
  const { addresses, address, publicClient } = useQGameConfig()
  const { openConnectModal } = useConnectModal()
  const createPet = useCreatePet()
  const [name, setName] = useState('')
  const [pay, setPay] = useState<PayWith>('CDT')

  // Live quote for USDC/ETH: how much input the swap will pull to buy the 3 CDT fee.
  const quote = useQuery({
    queryKey: ['qgame', 'createpet_quote', addresses?.pocketGP, pay],
    enabled: !!addresses && !!publicClient && pay !== 'CDT',
    staleTime: 30_000,
    queryFn: async () => {
      const pc = publicClient as PublicClient
      const a = addresses!
      const petPrice = (await pc.readContract({
        address: a.pocketGP,
        abi: pocketGPAbi,
        functionName: 'petPrice',
      })) as bigint
      const q = await new RouterQuoteSource({
        publicClient: pc,
        router: a.router,
        cdt: a.cdt,
        usdc: a.usdc,
        weth: a.weth,
      }).quote({ sellToken: pay as 'USDC' | 'ETH', cdtOut: petPrice })
      const decimals = pay === 'USDC' ? 6 : 18
      const pretty = Number(formatUnits(q.pullMax, decimals))
      return {
        text: `${pretty.toLocaleString(undefined, { maximumFractionDigits: pay === 'USDC' ? 2 : 5 })} ${pay}`,
        source: q.source,
        fetchedAt: q.fetchedAt,
      }
    },
  })

  const canSubmit = !!address && name.trim().length > 0 && !createPet.isPending

  return (
    <Box id={PET_CREATION_ANCHOR}>
      <Card variant="elevated">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Text {...label}>Create your pet</Text>
          <Text {...mono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            Mint a maze-running pet on-chain. Costs a 3 CDT hatch fee. Your pet, its stats, and all
            winnings live under your wallet.
          </Text>

          <Box>
            <Text {...label} mb={SPACING.sm}>Name</Text>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 24))}
              placeholder="Name your runner"
              maxLength={24}
              borderRadius={0}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              bg={SEMANTIC_COLORS.bgPrimary}
              color={SEMANTIC_COLORS.textPrimary}
              fontFamily={TYPOGRAPHY.fontMono}
              transition={TRANSITIONS.colors}
              _focus={FOCUS_STYLES.ring}
              _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
            />
          </Box>

          <Box>
            <Text {...label} mb={SPACING.sm}>Pay with</Text>
            <HStack spacing={SPACING.sm}>
              {PAY_OPTIONS.map((o) => {
                const active = pay === o.key
                return (
                  <Button
                    key={o.key}
                    onClick={() => setPay(o.key)}
                    flex="1"
                    variant="ghost"
                    borderRadius={0}
                    border="1px solid"
                    borderColor={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                    color={active ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                  >
                    {o.text}
                  </Button>
                )
              })}
            </HStack>
            <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
              {PAY_OPTIONS.find((o) => o.key === pay)?.sub}
            </Text>
          </Box>

          {pay !== 'CDT' && (
            <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
              {quote.isLoading ? (
                <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
                  quoting…
                </Text>
              ) : quote.data ? (
                <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                  pull ≤ {quote.data.text} · {quote.data.source} · fetched{' '}
                  {quote.data.fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              ) : (
                <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
                  quote unavailable
                </Text>
              )}
            </Box>
          )}

          {address ? (
            <Button
              colorScheme="phosphor"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              isDisabled={!canSubmit}
              isLoading={createPet.isPending}
              loadingText="Hatching…"
              transition={TRANSITIONS.colors}
              _hover={HOVER_EFFECTS.borderHighlight}
              _active={ACTIVE_EFFECTS.dim}
              _focus={FOCUS_STYLES.ring}
              onClick={() => createPet.mutate({ name: name.trim(), pay })}
            >
              Create pet · {pay === 'CDT' ? `3 CDT` : `pay in ${pay}`}
            </Button>
          ) : (
            <Button
              colorScheme="phosphor"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              transition={TRANSITIONS.colors}
              _hover={HOVER_EFFECTS.borderHighlight}
              _active={ACTIVE_EFFECTS.dim}
              _focus={FOCUS_STYLES.ring}
              onClick={() => openConnectModal?.()}
            >
              Connect wallet to create your pet
            </Button>
          )}

          {createPet.isError && (
            <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.danger}>
              {(createPet.error as Error)?.message ?? 'Create failed'}
            </Text>
          )}
          {createPet.isSuccess && (
            <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.success}>
              Pet created. Start a play session below to train and race.
            </Text>
          )}
          <Text {...mono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
            Hatch fee is {formatUnits(3n * 10n ** BigInt(CDT_DECIMALS), CDT_DECIMALS)} CDT.
          </Text>
        </VStack>
      </Card>
    </Box>
  )
}

export default PetCreation
