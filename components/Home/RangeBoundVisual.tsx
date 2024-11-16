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
                    w="68.2vw"             // Makes it wider horizontally
                    borderRadius="2px"   // Less rounded edges
                    bg="blue.500"        // Color of the line
                    _hover={{
                        bg: "blue.600"
                    }}
                />
            </Slider>
        </Box>
      
      {/* Label Rectangle */}
      <Stack justifyContent="space-between">
        <Flex
            w="100px"
            h="20%"
            paddingBottom="13.33%"
            bg="gray.200"
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            fontWeight="bold" 
        >
            <Text>99.3% - 99%</Text>
        </Flex>
        <Flex
            w="100px"
            h="20%"
            paddingBottom="13.33%"
            bg="gray.200"
            alignItems="center"
            justifyContent="center"
            borderRadius="md"
            fontWeight="bold"
        >
            <Text>98.5% - 98.2%</Text>
        </Flex>
      </Stack>
    </Flex>
    )
}

export default RangeBoundVisual