import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, HStack, Text, VStack, Spacer } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import RaceViewer from '@/components/Racing/RaceViewer'
import RockPaperScissors from '@/components/Racing/RockPaperScissors'
import TrackCreator from '@/components/Racing/TrackCreator'
import MintPanel from '@/components/Racing/MintPanel'
import TraitList from '@/components/Racing/TraitList'
import CarPanel from '@/components/Racing/CarPanel'
import QRacerTicker from '@/components/Racing/QRacerTicker'
import TournamentBracket from '@/components/Racing/TournamentBracket'
import useWallet from '@/hooks/useWallet'
import { useOwnedCars } from '@/hooks/useQRacing'
import useAppState from '@/persisted-state/useAppState'
import { } from '@/components/ConfirmModal'
import { } from '@/components/Racing/hooks/useRefillEnergy'
import {
  PreMintGuidance,
  TutorialOverlay,
  TutorialButton,
  useTutorial
} from '@/components/Racing/Guidance'
import useRacingCampaign from '@/persisted-state/useRacingCampaign'
import campaignConfig from '@/components/Racing/campaignConfig'

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      variant="ghost"
      fontFamily='"Press Start 2P", monospace'
      fontSize={{ base: '10px', sm: '12px' }}
      color={active ? '#00ffea' : '#b8c1ff'}
      borderBottom={active ? '3px solid #00ffea' : '3px solid transparent'}
      borderRadius={0}
      _hover={{ color: '#ffffff', bg: 'transparent' }}
      minH={{ base: '44px', md: 'auto' }}
      px={{ base: 2, md: 4 }}
      flex="1"
    >
      {label}
    </Button>
  )
}

const tabs = [
  { key: 'car', label: 'Car' },
  { key: 'race', label: 'Race' },
  { key: 'pvp', label: 'PvP' },
  { key: 'tournament', label: 'Tournament' },
  { key: 'create', label: 'Create Track' },
] as const

type TabKey = typeof tabs[number]['key']

const QRacer: React.FC = () => {
  const router = useRouter()
  const { address } = useWallet()
  const { data: ownedCars } = useOwnedCars(address)
  const { appState, setAppState } = useAppState()
  const { progress, startCampaign, endCampaign } = useRacingCampaign()

  const activeTab = useMemo<TabKey>(() => {
    const q = (router.query?.tab as string) || 'race'
    return (['car', 'race', 'pvp', 'tournament', 'create'] as string[]).includes(q) ? (q as TabKey) : 'race'
  }, [router.query?.tab])

  const setTab = (key: TabKey) => {
    console.log('🔧 QRacer setTab called with:', key);
    console.log('🔧 QRacer router state:', {
      asPath: router.asPath,
      pathname: router.pathname,
      query: router.query,
      isReady: router.isReady
    });

    const nextQuery = { ...router.query, tab: key }

    // Log current chain parameter (don't override)
    console.log('🔧 QRacer current chain parameter:', nextQuery.chain);

    console.log('🔧 QRacer final routing data:', {
      pathname: router.pathname,
      nextQuery,
      hasChain: !!nextQuery.chain
    });

    if (!nextQuery.chain) {
      console.error('❌ QRacer CRITICAL: Missing chain parameter!', {
        pathname: router.pathname,
        nextQuery,
        currentPath,
        pathSegments
      });
      return;
    }

    try {
      router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true, scroll: false });
      console.log('✅ QRacer setTab route update successful');
    } catch (error) {
      console.error('❌ QRacer setTab route update failed:', error);
    }
  }

  // Tutorial system
  const {
    isTutorialOpen,
    currentStep,
    shouldShowPreMintGuidance,
    shouldShowTutorial,
    startTutorial,
    nextStep,
    previousStep,
    closeTutorial,
    skipTutorial,
    steps,
  } = useTutorial(setTab)

  // const trackId = (router.query?.trackId as string) || undefined
  // const raceId = (router.query?.raceId as string) || undefined
  const carId = (router.query?.carId as string) || undefined

  // Check if user has minted their first car - more robust detection
  useEffect(() => {
    if (ownedCars && ownedCars.length > 0 && !appState.hasMintedFirstCar) {
      console.log('First car detected! Starting tutorial...')
      setAppState({ hasMintedFirstCar: true })
    }
  }, [ownedCars, appState.hasMintedFirstCar, setAppState])

  // Auto-start tutorial after first car mint - with delay to ensure state is updated
  useEffect(() => {
    console.log('[QRacer] auto-start check', { hasMintedFirstCar: appState.hasMintedFirstCar, autoStartEnabled: progress.autoStartEnabled, active: progress.active, tab: router.query?.tab })
    if (appState.hasMintedFirstCar && progress.autoStartEnabled && !progress.active) {
      // New post-mint flow: go straight to Race and start campaign
      const timer = setTimeout(() => {
        const shouldSwitchTab = router.query?.tab !== 'race'
        console.log('[QRacer] attempting auto-start', { shouldSwitchTab })
        if (shouldSwitchTab) {
          console.log('🔧 QRacer auto-start switching to race tab');
          const nextQuery = { ...router.query, tab: 'race' };

          // Log current chain parameter (don't override)
          console.log('🔧 QRacer auto-start current chain parameter:', nextQuery.chain);

          if (!nextQuery.chain) {
            console.error('❌ QRacer auto-start CRITICAL: Missing chain parameter!');
            return;
          }

          try {
            router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true, scroll: false });
            console.log('✅ QRacer auto-start route update successful');
          } catch (error) {
            console.error('❌ QRacer auto-start route update failed:', error);
          }
        }
        console.log('[QRacer] starting campaign via auto-start')
        startCampaign(campaignConfig)
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [appState.hasMintedFirstCar, progress.autoStartEnabled, progress.active, router.query?.tab, startCampaign])

  useEffect(() => {
    if (!router.isReady) return
    if (!router.query?.tab) {
      console.log('🔧 QRacer setting default tab:', activeTab);
      const nextQuery = { ...router.query, tab: activeTab };

      // Log current chain parameter (don't override)
      console.log('🔧 QRacer default tab current chain parameter:', nextQuery.chain);

      if (!nextQuery.chain) {
        console.error('❌ QRacer default tab CRITICAL: Missing chain parameter!');
        return;
      }

      try {
        router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true, scroll: false });
        console.log('✅ QRacer default tab route update successful');
      } catch (error) {
        console.error('❌ QRacer default tab route update failed:', error);
      }
    }
    // no-op; EnergyBar handles refill modal directly
    return () => { }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, activeTab])



  return (
    <Flex direction="column" w="100%" h="100vh" bgGradient="linear(to-b, #05070f, #0b0e17)" color="#e6e6e6" position="relative">
      <Box px={{ base: 3, md: 6 }} py={{ base: 2, md: 4 }} borderBottom="2px solid #0033ff" bg="#0a0f1e">
        <Flex
          direction={{ base: 'column', md: 'row' }}
          w="100%"
          align={{ base: 'stretch', md: 'center' }}
          gap={{ base: 2, md: 0 }}
        >
          <Text
            fontFamily='"Press Start 2P", monospace'
            fontSize={{ base: '12px', sm: '14px', md: '18px' }}
            color="#00ffea"
            textAlign={{ base: 'center', md: 'left' }}
          >
            MAZE RUNNERS
          </Text>
          <Box flex="1" mx={{ base: 0, md: 4 }} order={{ base: 2, md: 1 }}>
            <QRacerTicker rpc={appState.rpcUrl} />
          </Box>
        </Flex>
      </Box>

      <HStack spacing={0} borderBottom="2px solid #0033ff" bg="#0a0f1e" px={2}>
        {tabs.map((t) => (
          <TabButton key={t.key} label={t.label} active={activeTab === t.key} onClick={() => setTab(t.key)} />
        ))}
      </HStack>

      <Flex flex="1" p={{ base: 2, md: 4 }} gap={{ base: 2, md: 4 }}>
        {activeTab === 'car' && (
          ownedCars && ownedCars.length === 0 ? (
            <Flex align="center" justify="center" w="100%">
              <MintPanel />
            </Flex>
          ) : (
            <Flex
              direction={{ base: 'column', lg: 'row' }}
              align="start"
              w="100%"
              justifyContent="center"
              gap={{ base: 2, md: 4 }}
            >
              <CarPanel />
              <VStack align="stretch" spacing={4} w={{ base: '100%', lg: 'auto' }}>
                <MintPanel />
                {/* <TraitList />  */}
              </VStack>
            </Flex>
          )
        )}
        {activeTab === 'race' && (
          <Box flex="1" border="2px solid #0033ff" p={2} bg="#070b15">
            <RaceViewer />
          </Box>
        )}
        {activeTab === 'pvp' && (
          <Box flex="1" border="2px solid #0033ff" p={2} bg="#070b15">
            <RockPaperScissors />
          </Box>
        )}
        {activeTab === 'tournament' && (
          <Box flex="1" border="2px solid #0033ff" p={2} bg="#070b15">
            <TournamentBracket />
          </Box>
        )}
        {activeTab === 'create' && (
          <Box flex="1" border="2px solid #0033ff" bg="#070b15">
            <TrackCreator />
          </Box>
        )}

      </Flex>

      <Box px={6} py={2} borderTop="2px solid #0033ff" bg="#0a0f1e">
        <Flex justify="space-between" align="center">
          <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
            Insert coin to continue…
          </Text>
          <HStack spacing={2}>
            <Button
              onClick={() => setAppState({ hasSeenPreMintGuidance: false })}
              variant="ghost"
              size="sm"
              color="#b8c1ff"
              _hover={{ color: '#00ffea' }}
              fontFamily='"Press Start 2P", monospace'
              fontSize="10px"
              px={2}
            >
              TEST PRE-MINT
            </Button>
            <Button
              onClick={() => progress.active ? endCampaign() : startCampaign(campaignConfig)}
              variant="ghost"
              size="sm"
              color="#b8c1ff"
              _hover={{ color: '#00ffea' }}
              fontFamily='"Press Start 2P", monospace'
              fontSize="10px"
              px={2}
            >
              {progress.active ? 'Restart Trials' : 'Start Trials'}
            </Button>
            <TutorialButton onClick={startTutorial} />
          </HStack>
        </Flex>
      </Box>

      {/* Guidance System */}
      <PreMintGuidance
        isOpen={shouldShowPreMintGuidance}
        onClose={() => setAppState({ hasSeenPreMintGuidance: true })}
      />

      <TutorialOverlay
        isOpen={isTutorialOpen}
        onClose={closeTutorial}
        steps={steps}
        currentStep={currentStep}
        onNext={nextStep}
        onPrevious={previousStep}
        onSkip={skipTutorial}
      />

    </Flex>
  )
}

export default QRacer 