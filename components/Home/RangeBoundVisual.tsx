import { Slider, SliderFilledTrack, SliderTrack, SliderThumb, Box, Flex } from "@chakra-ui/react"

// Create and return a vertical slider
const RangeBoundVisual = () => {
    //Get bounded position data
    //Get prices
    //Get CDT price
    const cdtPrice = .987
    //Get USDC price


return (        
    <Flex gap={4} alignItems="center"> 
        <Box height="33vh">
            <Slider
              defaultValue={cdtPrice}
              isReadOnly
              cursor="default"
              min={.98}
              max={.995}
              value={cdtPrice}
              orientation="vertical"
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
      <Flex
        w="100px"
        h="40px"
        bg="gray.200"
        alignItems="center"
        justifyContent="center"
        borderRadius="md"
        fontWeight="bold"
      >
        <Text>{value}%</Text>
      </Flex>
    </Flex>
    )
}

export default RangeBoundVisual