import { useOraclePrice } from "@/hooks/useOracle"
import { Slider, SliderTrack, SliderThumb, Box, Flex, Text, Stack, Card, HStack, useBreakpointValue } from "@chakra-ui/react"
import { useMemo, useState } from "react"
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

const PriceBox = ({
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
    marginTop={isTop ? "11%" : undefined}
    marginBottom={!isTop ? "12%" : undefined}
    alignItems="center"
    justifyContent="center"
    borderRadius="md"
    border={"2px solid"}
    // borderColor={colors.rangeBoundBorder}
    bg={colors.rangeBoundBox}
    fontWeight="bold"
    onMouseEnter={() => setSwitch(true)}
    onMouseLeave={() => setSwitch(false)}
  >
    {switchState
      ? <Text justifySelf="center" width="100">Range: {range}</Text>
      : <Text justifySelf="center" width="100">{isTop ? "Upper Bound " : "Lower Bound "} TVL: ${tvl}</Text>
    }
  </Flex>
)

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

  // Generate tick marks and labels
  const ticks = [
    { value: 0.995, label: '0.995' },
    { value: 0.993, label: '0.993' },
    { value: 0.990, label: '0.990' },
    { value: 0.985, label: '0.985' },
    { value: 0.982, label: '0.982' },
    { value: 0.980, label: '0.980' }
  ];


  return (
    <Card gap={0} width={isMobile ? "100%" : "66%"} maxWidth="720px" borderWidth={3} height={isMobile ? "45vh" : "100%"}>
      <Stack height="100%">

        <HStack width="100%" height="100%" gap={0}>
          {/* Tick marks container */}
          <Box position="relative" height="100%" width="40px" mr={2}>
            {ticks.map((tick) => (
              <Box
                key={tick.value}
                position="absolute"
                left="0"
                top={`${(1 - (tick.value - 0.98) / (0.995 - 0.98)) * 100}%`}
                transform="translateY(-50%)"
                // width="100%"
                display="flex"
                alignItems="center"
                gap={2}
              >
                <Box
                  as="span"
                  color="white"
                  fontSize="sm"
                  width="49px"
                  textAlign="right"
                >
                  - {tick.label}
                </Box>
                {/* <Box
                  width="8px"
                  height="1px"
                  bg="gray.400"
                /> */}
              </Box>
            ))}
          </Box>
          <Box height="100%" width="90%" pos="absolute">
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
              height="100%"
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