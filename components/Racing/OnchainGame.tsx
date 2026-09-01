// OnchainGame — the "On-chain" section mounted in QRacer above the practice circuit. Composes
// pet creation, the pet dashboard, train/race controls, the play-session card, and the live
// standings. Owns pet selection so the dashboard and controls share it. Living Typeface.

import React, { useEffect, useState } from 'react'
import { Box, Button, Flex, HStack, Text, VStack } from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import PetCreation from '@/components/Racing/PetCreation'
import PetDashboard from '@/components/Racing/PetDashboard'
import PlaySession from '@/components/Racing/PlaySession'
import TrainRace from '@/components/Racing/TrainRace'
import OnchainStandings from '@/components/Racing/OnchainStandings'
import { useQGameConfig, useQGamePets, useQGameSession } from '@/hooks/useQGame'

const eyebrow = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}

const OnchainGame: React.FC = () => {
  const { address, addresses } = useQGameConfig()
  const { data: pets, isLoading: petsLoading } = useQGamePets()
  const { data: session } = useQGameSession()
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (pets && pets.length > 0 && (!selected || !pets.some((p) => p.id.toString() === selected))) {
      setSelected(pets[0].id.toString())
    }
  }, [pets, selected])

  if (!addresses) {
    return (
      <Card variant="subtle">
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
          The on-chain game is not deployed on this network.
        </Text>
      </Card>
    )
  }

  const activePet = pets?.find((p) => p.id.toString() === selected) ?? pets?.[0]
  const sessionLive = session?.live ?? false

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <HStack justify="space-between" align="baseline">
        <Text {...eyebrow}>01 / On-chain</Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
          your real record · anvil
        </Text>
      </HStack>

      <Flex direction={{ base: 'column', lg: 'row' }} gap={SPACING_PATTERNS.sectionGap} align="stretch">
        {/* Pet column */}
        <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap} flex="1" minW={0}>
          {activePet ? (
            <>
              {pets && pets.length > 1 && (
                <HStack spacing={SPACING.xs} flexWrap="wrap">
                  {pets.map((p) => {
                    const active = p.id.toString() === activePet.id.toString()
                    return (
                      <Button
                        key={p.id.toString()}
                        onClick={() => setSelected(p.id.toString())}
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
                        #{p.id.toString()}
                      </Button>
                    )
                  })}
                </HStack>
              )}
              <PetDashboard pet={activePet} sessionLive={sessionLive} />
              <TrainRace pet={activePet} sessionLive={sessionLive} />
            </>
          ) : (
            <PetCreation />
          )}
        </VStack>

        {/* Session + standings column */}
        <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap} w={{ base: '100%', lg: '340px' }} flexShrink={0}>
          {address && <PlaySession />}
          <OnchainStandings highlight={address} />
        </VStack>
      </Flex>

      {/* When you already have pets, PetCreation stays reachable to hatch another (and is the
          scroll target for the practice-circuit nudge). */}
      {activePet && (
        <Box>
          <PetCreation />
        </Box>
      )}

      {petsLoading && !pets && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
          loading your pets…
        </Text>
      )}
    </VStack>
  )
}

export default OnchainGame
