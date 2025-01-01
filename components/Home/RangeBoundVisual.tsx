import { useOraclePrice } from "@/hooks/useOracle"
import { Slider, SliderFilledTrack, SliderTrack, SliderThumb, Box, Flex, Text, Stack, Card, HStack, useBreakpointValue } from "@chakra-ui/react"
import { useMemo, useState } from "react"
import { shiftDigits } from "@/helpers/math"
import { getCLPositionsForVault } from "@/services/osmosis"
import { colors } from "@/config/defaults"
import React from "react"


interface PriceBoxProps {
  switch: boolean;
  setSwitch: (value: boolean) => void;
  isTop?: boolean;
  tvl?: string;
  range: string;
}

const PriceBox = React.memo(({
  switch: switchState,
  setSwitch,
  isTop = false,
  tvl = "0.00",
  range
}: PriceBoxProps) => (
  <Flex
    display="grid"
    w="84%"
    h="22%"
    marginTop={isTop ? "1%" : undefined}
    marginBottom={!isTop ? "9%" : undefined}
    bg={colors.rangeBoundBox}
    alignItems="center"
    justifyContent="center"
    borderRadius="md"
    fontWeight="bold"
    onMouseEnter={() => setSwitch(true)}
    onMouseLeave={() => setSwitch(false)}
  >
    {switchState
      ? <Text justifySelf="center" width="100">Range: {range}</Text>
      : <Text justifySelf="center" width="100">TVL: ${tvl}</Text>
    }
  </Flex>
))

const RangeBoundVisual = () => {
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false
  const [cSwitch, setCSwitch] = useState(false)
  const [fSwitch, setFSwitch] = useState(false)

  const { data: positions } = getCLPositionsForVault()
  const { data: prices } = useOraclePrice()

  const cdtPrice = useMemo(() => {
    const price = prices?.find(price =>
      price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt"
    )?.price
    return parseFloat(price ?? "0")
  }, [prices])

  return (
    <Card gap={0} width={isMobile ? "100%" : "70%"} borderWidth={3} height={isMobile ? "45vh" : ""}>
      <Stack height="100%">
        <HStack width="100%" height="100%" gap={0}>
          <Box height="90%" width="90%" pos="absolute">
            <Slider
              value={cdtPrice}
              isReadOnly
              cursor="default"
              min={.98}
              max={.995}
              orientation="vertical"
              paddingInlineStart="0"
              width="inherit"
              pos="relative"
              height="90%"
            >
              <SliderTrack className="noLeftHand" height="100%" left="0%" h="1.5">
              </SliderTrack>
              <SliderThumb
                transform="0"
                left="0px"
                h="5px"
                w="95%"
                borderRadius="2px"
                bg={colors.sliderThumb}
                _hover={{ bg: "blue.600" }}
              >
                <Box position="relative" left="57%" color="white" p="1" borderRadius="md" fontSize="lg" whiteSpace="nowrap">
                  ${cdtPrice.toFixed(4)}
                </Box>
              </SliderThumb>
            </Slider>
          </Box>

          <Stack justifyContent="center" gap="33%" width="100%" height="100%">
            <PriceBox
              switch={cSwitch}
              setSwitch={setCSwitch}
              isTop={true}
              tvl={positions?.positionsTVL.ceilingTVL.toFixed(2)}
              range="$0.993 - $0.99"
            />
            <PriceBox
              switch={fSwitch}
              setSwitch={setFSwitch}
              tvl={positions?.positionsTVL.floorTVL.toFixed(2)}
              range="$0.985 - $0.982"
            />
          </Stack>
        </HStack>
      </Stack>
    </Card>
  )
}

export default RangeBoundVisual