import { Slider, SliderFilledTrack, SliderThumb, SliderTrack } from '@chakra-ui/react'
import React from 'react'

export type SliderProps = {
  value?: number
  onChange: (value: number) => void
  min?: number
  max?: number
  walletCDT?: number
  summary?: any[]
  width?: string
  padding?: string
  color?: string
}

export const SliderWithState = ({ value = 0, onChange, min = 0, max = 100, walletCDT = 0, summary = [], width, padding, color }: SliderProps) => {
  return (
    <Slider
      width={width}
      padding={padding}
      aria-label="slider-ex-4"
      defaultValue={0}
      min={min}
      max={max === 0 ? 1 : max}
      value={value}
      onChange={onChange}
      isDisabled={max === 0 && (walletCDT === 0 || summary.length === 0)}
    >
      <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
        <SliderFilledTrack bg={color ?? "#C445F0"} />
      </SliderTrack>
      <SliderThumb boxSize={6} bg={color ?? "#C445F0"} cursor="grab" border="2px solid #E2D8DA" zIndex={0}/>
    </Slider>
  )
}
