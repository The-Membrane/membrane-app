import { Slider, SliderFilledTrack, SliderThumb, SliderTrack } from '@chakra-ui/react'
import React from 'react'
import { Summary } from './Summary'

export type SliderProps = {
  value?: number
  onChange: (value: number) => void
  min?: number
  max?: number
  walletCDT?: number
  summary?: any[]
}


const handleThumbClick = (event) => {
  event.preventDefault(); // Prevent default behavior
  event.stopPropagation(); // Stop event from bubbling up
};

export const SliderWithState = ({ value = 0, onChange, min = 0, max = 100, walletCDT = 0, summary = []}: SliderProps) => {

  const sliderRef = React.useRef();

  const handleChange = (value) => {
    onChange(value);
    // Handle slider value change here
    // Optionally, you can set focus back to the slider after value change
    sliderRef.current.focus();
  };

  return (
    <Slider
      aria-label="slider-ex-4"
      defaultValue={0}
      min={min}
      max={max === 0 ? 1 : max}
      value={value}
      onChange={handleChange}
      isDisabled={max === 0 && (walletCDT === 0 || summary.length === 0)}
    >
      <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
        <SliderFilledTrack bg="#C445F0" />
      </SliderTrack>
      <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA"/>
    </Slider>
  )
}
