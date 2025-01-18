import { colors } from '@/config/defaults'
import { useUserPoints, useSoloLevel } from '@/hooks/usePoints'
import { Stack, Text, Slider, SliderTrack, SliderFilledTrack, SliderMark, Box } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import { TxButton } from '../TxButton'
import useClaimPoints from './hooks/usePointsClaim'

function SoloLeveling() {
  const { action: claimPoints } = useClaimPoints()
  const { data: pointsData } = useUserPoints()
  const points = useMemo(() => {
    console.log("total points", pointsData)
    return pointsData || { stats: { total_points: "0" } }
  }, [pointsData])

  const { data: data } = useSoloLevel()
  const { level, points_in_level, levelup_max_points } = useMemo(() => {
    console.log("solo leveling", data)
    return data || {
      level: 1,
      points_in_level: 0,
      levelup_max_points: 1,
    }
  }, [data])

  return (
    <Stack as="solo-leveling" style={{ marginTop: "6%" }}>
      <Text fontSize="sm" color="whiteAlpha.700">
        <span style={{ fontWeight: "bold", color: "white" }}>Level {level}:</span> {parseFloat(points.stats.total_points).toFixed(1)} Joules
      </Text>
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
