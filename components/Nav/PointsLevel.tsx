import { useUserPoints, useSoloLevel } from '@/hooks/usePoints'
import { Stack, Text, Slider, SliderTrack, SliderFilledTrack, SliderMark, Box } from '@chakra-ui/react'
import React  from 'react'

function SoloLeveling(){
    const { data: pointsData } = useUserPoints()
    const points = pointsData || { stats: { total_points: 0 } }
    const { data: data } = useSoloLevel()
    const { level, points_in_level, levelup_max_points } = data || {
        level: 1,
        points_in_level: 5,
        levelup_max_points: 14,
    }

    return (
        <Stack as="solo-leveling" gap="1" marginTop={"1"} style={{marginTop: "1%"}}>
            <Text fontSize="sm" color="whiteAlpha.700">
                Level {level}: {points.stats.total_points} Joules
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
                  <SliderFilledTrack bg={'rgb(196, 69, 240)'} />
                </SliderTrack>
                <SliderMark value={points_in_level}>
                  <Box bg="white" w="0.5" h="4" mt="-2" />
                </SliderMark>
              </Slider>
        </Stack>
    )
}

export default SoloLeveling