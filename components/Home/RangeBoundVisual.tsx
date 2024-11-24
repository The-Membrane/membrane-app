import { useOraclePrice } from "@/hooks/useOracle"
import { Slider, SliderFilledTrack, SliderTrack, SliderThumb, Box, Flex, Text, Stack, Card, HStack } from "@chakra-ui/react"
import { useMemo, useState } from "react"
import { shiftDigits } from "@/helpers/math"
import { getCLPositionsForVault } from "@/services/osmosis"


// Create and return a vertical slider
const RangeBoundVisual = () => {
  //Set ceiling & floor switch state
  const [cSwitch, setCSwitch] = useState(false)
  const [fSwitch, setFSwitch] = useState(false)
  //Get bounded position data
  const { data: positions } = getCLPositionsForVault()
  console.log("positions", positions)
  //Get prices
  const { data: prices } = useOraclePrice()
  //Get CDT price
  const cdtPrice = useMemo (() => parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0"), [prices])
  //Get USDC price
  // const usdcPrice = useMemo (() => parseFloat(prices?.find((price) => price.denom === "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4")?.price ?? "0"), [prices])
    
    

return (        
    <Card gap={0} width={"70%"} borderColor={""} borderWidth={3}>
      <Stack>
      <Text variant="title" fontFamily="Inter" fontSize={"lg"} letterSpacing={"1px"} justifyContent={"center"} display="flex" color="rgb(226, 216, 218)">The Membrane aka Range Bound LP</Text>
      <HStack>
        <Box height="100%">
            <Slider
              defaultValue={cdtPrice}
              isReadOnly
              cursor="default"
              min={.98}
              max={.995}
              value={cdtPrice}
              orientation="vertical"
              paddingInlineStart={"0"}
            >
              <SliderTrack h="1.5" transform={"0"}>
                {/* <SliderFilledTrack bg={'#20d6ff'} /> */}
              </SliderTrack>
                <SliderThumb 
                    transform={"0"}
                    left={"0px"}
                    h="5px"              // Makes it thin like a line
                    w="9710%"             // Makes it wider horizontally
                    borderRadius="2px"   // Less rounded edges
                    bg="blue.500"        // Color of the line
                    _hover={{
                        bg: "blue.600"
                    }}
                >{/* Label attached to thumb */}
                <Box
                  position="relative"
                  left="57%"  // positions label to the right of thumb
                  color="white"
                  p="1"
                  borderRadius="md"
                  fontSize="lg"
                  whiteSpace="nowrap"
                >
                  ${(cdtPrice).toFixed(4)}
                </Box>
              </SliderThumb>
            </Slider>
        </Box>
      
      {/* Label Rectangle */}
      <Stack justifyContent="space-between" width="100%"  height="100%">
        <Flex
            display={"grid"}
            w="84%"
            h="22%"
            marginTop="9%"
            bg="#5f71ed"
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            fontWeight="bold"
            onMouseEnter={()=>{setCSwitch(true)}}
            onMouseLeave={()=>{setCSwitch(false)}}
        >
            {cSwitch ? <Text justifySelf={"center"} width="100">Range: $0.993 - $0.99</Text> 
            : <Text justifySelf={"center"} width="100">TVL: ${positions?.positionsTVL.ceilingTVL.toFixed(2)}</Text>}
        </Flex>
        <Flex
            display={"grid"}
            w="84%"
            h="22%"
            marginBottom="9%"
            bg="#5f71ed"
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            fontWeight="bold"
            onMouseEnter={()=>{setFSwitch(true)}}
            onMouseLeave={()=>{setFSwitch(false)}}
        >
            {fSwitch ? <Text justifySelf={"center"} width="100">Range: $0.985 - $0.982</Text> 
            : <Text justifySelf={"center"} width="100">TVL: ${positions?.positionsTVL.floorTVL.toFixed(2)}</Text>}
        </Flex>
      </Stack>
      </HStack>
      </Stack>
    </Card >
    )
}

export default RangeBoundVisual