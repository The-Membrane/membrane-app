import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, HStack, Text, VStack, Spacer } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import RaceViewer from '@/components/Racing/RaceViewer'
import TrackCreator from '@/components/Racing/TrackCreator'
import MintPanel from '@/components/Racing/MintPanel'
import TraitList from '@/components/Racing/TraitList'
import CarPanel from '@/components/Racing/CarPanel'
import EnergyBarV2 from '@/components/Racing/EnergyBarV2'
import QRacerTicker from '@/components/Racing/QRacerTicker'
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
  { key: 'create', label: 'Create Track' },
] as const

type TabKey = typeof tabs[number]['key']

const QRacer: React.FC = () => {
  const router = useRouter()
  const { address } = useWallet()
  const { data: ownedCars } = useOwnedCars(address)
  const { appState, setAppState } = useAppState()

  const activeTab = useMemo<TabKey>(() => {
    const q = (router.query?.tab as string) || 'race'
    return (['car', 'race', 'create'] as string[]).includes(q) ? (q as TabKey) : 'race'
  }, [router.query?.tab])

  const setTab = (key: TabKey) => {
    const nextQuery = { ...router.query, tab: key }
    router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true, scroll: false })
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
    if (appState.hasMintedFirstCar && shouldShowTutorial && !isTutorialOpen) {
      // Small delay to ensure the state has been properly updated
      const timer = setTimeout(() => {
        console.log('Starting tutorial after car mint...')
        startTutorial()
      }, 500)

      return () => clearTimeout(timer)
    }
  }, [appState.hasMintedFirstCar, shouldShowTutorial, isTutorialOpen, startTutorial])

  useEffect(() => {
    if (!router.isReady) return
    if (!router.query?.tab) {
      router.replace({ pathname: router.pathname, query: { ...router.query, tab: activeTab } }, undefined, { shallow: true, scroll: false })
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
          <Box order={{ base: 1, md: 2 }}>
            <EnergyBarV2 tokenId={carId} inline />
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