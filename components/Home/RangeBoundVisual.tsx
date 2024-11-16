import { Slider, SliderFilledTrack, SliderTrack, SliderThumb, Box } from "@chakra-ui/react"

// Create and return a vertical slider
const RangeBoundVisual = () => {
    //Get bounded position data
    //Get prices
    //Get CDT price
    const cdtPrice = .987
    //Get USDC price


return (         
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
              <SliderTrack h="1.5">
                {/* <SliderFilledTrack bg={'#20d6ff'} /> */}
              </SliderTrack>
                <SliderThumb 
                    h="2px"              // Makes it thin like a line
                    w="100%"             // Makes it wider horizontally
                    borderRadius="2px"   // Less rounded edges
                    bg="blue.500"        // Color of the line
                    _hover={{
                        bg: "blue.600"
                    }}
                />
            </Slider>
        </Box>
    )
}

export default RangeBoundVisual