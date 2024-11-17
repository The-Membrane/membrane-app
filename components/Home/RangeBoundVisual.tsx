import { Slider, SliderFilledTrack, SliderTrack, SliderThumb, Box, Flex, Text, Stack } from "@chakra-ui/react"

// Create and return a vertical slider
const RangeBoundVisual = () => {
    //Get bounded position data
    //Get prices
    //Get CDT price
    const cdtPrice = .987
    //Get USDC price


return (        
    <Flex gap={0}> 
        <Box height="33vh">
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
                    h="2px"              // Makes it thin like a line
                    w="45.2vw"             // Makes it wider horizontally
                    borderRadius="2px"   // Less rounded edges
                    bg="blue.500"        // Color of the line
                    _hover={{
                        bg: "blue.600"
                    }}
                >{/* Label attached to thumb */}
                <Box
                  position="relative"
                  left="53%"  // positions label to the right of thumb
                  color="white"
                  p="1"
                  borderRadius="md"
                  fontSize="lg"
                  whiteSpace="nowrap"
                >
                  {cdtPrice * 100}
                </Box>
              </SliderThumb>
            </Slider>
        </Box>
      
      {/* Label Rectangle */}
      <Stack justifyContent="space-between" width="100%">
        <Flex
            display={"grid"}
            w="65.2%"
            h="20%"
            marginTop="2%"
            bg="#5f71ed"
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            fontWeight="bold" 
        >
            <Text justifySelf={"center"} width="100">99.3% - 99%</Text>
        </Flex>
        <Flex
            display={"grid"}
            w="65.2%"
            h="20%"
            marginBottom="2%"
            bg="#5f71ed"
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            fontWeight="bold"
        >
            <Text justifySelf={"center"} width="100">98.5% - 98.2%</Text>
        </Flex>
      </Stack>
    </Flex>
    )
}

export default RangeBoundVisual