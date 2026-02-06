import { colors } from '@/config/defaults'
import { useUserPoints, useSoloLevel, useUserRank } from '@/hooks/usePoints'
import { Stack, Text, Slider, SliderTrack, SliderFilledTrack, SliderMark, Box, HStack } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import { TxButton } from '../TxButton'
import useClaimPoints from './hooks/usePointsClaim'
import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

function SoloLeveling() {
  const { action: claimPoints } = useClaimPoints()
  const { appState, setAppState } = useAppState()
  const { data: pointsData } = useUserPoints()
  const { address } = useWallet()

  if (!appState.totalPoints) {
    appState.totalPoints = []
  }

  const points = useMemo(() => {
    if (!appState.totalPoints?.find((p) => p.user === address) && pointsData?.stats?.total_points && address) {
      appState.totalPoints.push({ points: pointsData?.stats?.total_points, user: address })
      setAppState({ totalPoints: appState.totalPoints })
    } else if (appState.totalPoints?.find((p) => p.user === address)?.points != pointsData?.stats?.total_points && address === appState.totalPoints?.find((p) => p.user === address)?.user) {
      // Update total points (removed toast notification)
      appState.totalPoints.find((p) => p.user === address)!.points = pointsData?.stats?.total_points ?? "0"
      setAppState({ totalPoints: appState.totalPoints })
    }

    return pointsData || { stats: { total_points: "0" } }
  }, [pointsData, address, appState, setAppState])


  const { data: data } = useSoloLevel()
  const { level, points_in_level, levelup_max_points } = useMemo(() => {
    // console.log("solo leveling", data)
    return data || {
      level: 1,
      points_in_level: 0,
      levelup_max_points: 1,
    }
  }, [data])

  const { data: rank } = useUserRank()

  return (
    <Stack as="solo-leveling" style={{ marginTop: "6%" }}>
      <HStack justify="space-between" align="center">
        <Text fontSize="1rem" color="whiteAlpha.700">
          <span style={{ fontWeight: "bold", color: "white" }}>Rank {rank}:</span> {parseFloat(points.stats.total_points).toFixed(1)} Points
        </Text>
        <ShareButton cardType="points" size="xs" />
      </HStack>
      <Slider
        defaultValue={points_in_level}
        isReadOnly
        cursor="default"
        min={0}
        max={levelup_max_points}
        value={points_in_level}
      >
        <SliderTrack h="1.5">
          <SliderFilledTrack bg={colors.rangeBoundBox} />
        </SliderTrack>
        <SliderMark value={points_in_level}>
          <Box bg="white" w="0.5" h="4" mt="-2" />
        </SliderMark>
      </Slider>
      <TxButton
        style={{ fontSize: "12px" }}
        fontSize="12px"
        w="100%"
        height="20px"
        isLoading={claimPoints.simulate.isLoading || claimPoints.tx.isPending}
        isDisabled={claimPoints.simulate.isError || !claimPoints.simulate.data}
        onClick={() => claimPoints.tx.mutate()}
        toggleConnectLabel={false}
      >
        Claim MBRN
      </TxButton>
    </Stack>
  )
}

export default SoloLeveling
