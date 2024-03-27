import { num } from '@/helpers/num'
import { Box, Image } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import React, { Fragment, useMemo } from 'react'
import useMintState from './hooks/useMintState'

const BeakerLiquid = () => {
  const { mintState } = useMintState()

  const percent = useMemo(() => {
    const ltvSlider = mintState?.ltvSlider || 0
    const value = num(ltvSlider).isLessThan(5) ? num(ltvSlider).times(2.6) : num(ltvSlider)
    return num(value).times(336).div(100).toNumber()
  }, [mintState.ltvSlider])

  if (!num(percent).isGreaterThan(0)) return null

  return (
    <motion.div
      style={{
        position: 'absolute',
        left: 770,
        top: 710,
        maxHeight: percent,
        transform: 'scale(0.85) rotate(180deg)',
        height: percent,
        overflow: 'hidden',
        transformOrigin: 'top',
      }}
      initial={{ height: 0 }}
      animate={{ height: percent }}
      transition={{ type: 'spring', stiffness: 1000 }}
    >
      <Image src="/images/beaker_liquid.svg" transform="rotate(180deg)" />
    </motion.div>
  )
}

const BeakerScale = () => {
  return (
    <Fragment>
      <Box position="absolute" left="889px" top="391px" zIndex={2} transform="scale(0.85)">
        <Image src="/images/beaker_lines.svg" />
      </Box>
      <BeakerLiquid />
    </Fragment>
  )
}

export default BeakerScale
