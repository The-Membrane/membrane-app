import { useOraclePrice } from "@/hooks/useOracle"
import { Slider, SliderTrack, SliderThumb, Box, Flex, Text, Stack, Card, HStack, useBreakpointValue, Button } from "@chakra-ui/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { getCLPositionsForVault } from "@/services/osmosis"
import { colors } from "@/config/defaults"
import React from "react"
import useToaster from "@/hooks/useToaster"
import useSetUserRBClaims from "./hooks/useSetUserRBClaims"
import { useBoundedCDTRealizedAPR, useBoundedTVL, useRBLPCDTBalance } from "@/hooks/useEarnQueries"
import { num, shiftDigits } from "@/helpers/num"


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
    h="8%"
    marginTop={isTop ? "8%" : undefined}
    marginBottom={!isTop ? "11%" : undefined}
    alignItems="center"
    justifyContent="center"
    borderRadius="md"
    border={"2px solid"}
    borderColor={colors.rangeBoundBorder}
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

//@ts-ignore
function ToastButton({ isLoading, isDisabled, onClick }) {
  return (
    <Button isDisabled={isDisabled} isLoading={isLoading} onClick={onClick}>
      Set
    </Button>
  );
}

const RangeBoundVisual = () => {
  const toaster = useToaster();
  const [hasShownToast, setHasShownToast] = useState(false);
  const { action: set } = useSetUserRBClaims()


  const isDisabled = set?.simulate.isError || !set?.simulate.data
  const isLoading = set?.simulate.isLoading || set?.tx.isPending

  // Memoize the toggle handler to prevent recreating on each render
  const onClick = useCallback(() => {
    set?.tx.mutate()
  }, [set?.tx]);


  useEffect(() => {

    console.log("isDisabled points track", isDisabled, isLoading)
    console.log("error", set?.simulate.isError, set?.simulate.errorMessage, set?.simulate.data, set?.simulate.error)

    if (!hasShownToast && !isDisabled && !isLoading) {
      toaster.message({
        title: 'Execute to Set Points Tracker for Range Bound LP',
        message: (
          <ToastButton
            isDisabled={isDisabled}
            isLoading={isLoading}
            onClick={onClick}
          />
        ),
        duration: null
      });
      setHasShownToast(true);
    } else if (hasShownToast && !isDisabled && isLoading) {
      toaster.dismiss();
      toaster.message({
        title: 'Execute to Set Points Tracker for Range Bound LP',
        message: (
          <ToastButton
            isDisabled={isDisabled}
            isLoading={isLoading}
            onClick={onClick}
          />
        ),
        duration: null
      });

    }
  }, [isDisabled, isLoading]);

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
    { value: 1.001, label: '1.001' },
    { value: 0.9999, label: '0.999' },
    { value: 0.990, label: '0.990' },
    { value: 0.9889, label: '0.989' },
    // { value: 0.988, label: '0.988' },
  ];

  const { data: realizedAPR } = useBoundedCDTRealizedAPR()
  const { data: TVL } = useBoundedTVL()
  const { data: existingBuffer } = useRBLPCDTBalance()




  return (
    <Card gap={0} width={isMobile ? "100%" : "66%"} maxWidth="720px" borderWidth={3} height={isMobile ? "45vh" : "100%"}>

      <Text alignSelf="center" fontFamily="Inter" fontSize="xl" fontWeight={"bold"} pb="1rem"><a style={{ fontWeight: "bold", color: colors.earnText }}>Realized APY: &nbsp;</a> <a className="textShadow">{realizedAPR?.negative ? "-" : ""}{(realizedAPR && realizedAPR.apr) ? num(realizedAPR?.apr).times(100).toFixed(1) + "%" : "loading..."}</a></Text>

      <HStack justifyContent="center" pb="1rem">
        <Text alignSelf="center" fontFamily="Inter" fontSize="16px" fontWeight={"bold"}> TVL: ${(num(shiftDigits(TVL ?? "0", -6)).times(cdtPrice).toFixed(2))}</Text>
        <Text alignSelf="center" fontFamily="Inter" fontSize="16px"> with {Number(shiftDigits(existingBuffer ?? "0", -6)).toFixed(0)} CDT Waiting to Sell High</Text>
      </HStack>


      <HStack width="100%" height="100%" gap={0}>
        {/* Tick marks container */}
        <Box position="relative" height="100%" width="40px" mr={2}>
          {ticks.map((tick) => (
            <Box
              key={tick.value}
              position="absolute"
              left="0"
              top={`${(1 - (tick.value - 0.988) / (1.001 - 0.988)) * 100}%`}
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
        <Box height="80%" width="90%" pos="absolute">
          <Slider
            value={cdtPrice}
            isReadOnly
            cursor="default"
            min={0.988}
            max={1.001}
            orientation="vertical"
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

        <Stack justifyContent="center" gap="79%" width="100%" height="100%">
          <PriceBox
            switch={cSwitch}
            setSwitch={setCSwitch}
            isTop={true}
            tvl={positions?.positionsTVL.ceilingTVL.toFixed(2)}
            range="$1.00 - $0.9999"
          />
          <PriceBox
            switch={fSwitch}
            setSwitch={setFSwitch}
            tvl={positions?.positionsTVL.floorTVL.toFixed(2)}
            range="$0.990 - $0.9899"
          />
        </Stack>
      </HStack>
    </Card>
  )
}

export default RangeBoundVisual