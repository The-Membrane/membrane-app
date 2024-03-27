import { Slider, SliderFilledTrack, SliderThumb, SliderTrack } from '@chakra-ui/react'
import React from 'react'

export type SliderProps = {
  value?: number
  onChange: (value: number) => void
  min?: number
  max?: number
}

export const SliderWithState = ({ value = 0, onChange, min = 0, max = 100 }: SliderProps) => {
  return (
    <Slider
      aria-label="slider-ex-4"
      defaultValue={0}
      min={min}
      max={max}
      value={value}
      onChange={onChange}
    >
      <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
        <SliderFilledTrack bg="#C445F0" />
      </SliderTrack>
      <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA" />
    </Slider>
  )
}
