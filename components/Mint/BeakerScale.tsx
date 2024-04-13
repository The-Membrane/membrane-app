import { num } from '@/helpers/num'
import { Image } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { useMemo } from 'react'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'

export const BeakerLiquid = () => {
  const { mintState } = useMintState()

  const { ltv, liqudationLTV, borrowLTV } = useVaultSummary()

  const health = num(1).minus(num(ltv).dividedBy(liqudationLTV)).times(100).dp(0).toNumber()

  const percent = useMemo(() => {
    const ltvSlider = mintState?.ltvSlider || 0
    const value = num(ltvSlider).isLessThan(5) ? num(ltvSlider).times(2.6) : num(ltvSlider)
    return num(health).times(336).div(100).toNumber()
  }, [mintState.ltvSlider, health])

  if (!num(percent).isGreaterThan(0)) return null

  var color = 'blue'
  if (health <= (1 - borrowLTV / liqudationLTV) * 100 && health > 10 && health < 100)
    color = 'sewage'
  if (health <= 10) color = 'red'

  return (
    <motion.div
      style={{
        position: 'absolute',
        // bottom: -17,
        top: 485,
        left: 125,
        maxHeight: percent,
        transform: 'scale(1.17) rotate(180deg)',
        height: percent,
        overflow: 'hidden',
        transformOrigin: 'top',
        // zIndex: 2,
      }}
      initial={{ height: 0 }}
      animate={{ height: percent }}
      transition={{ type: 'spring', stiffness: 1000 }}
    >
      <Image src={`/images/beaker_liquid_${color}.svg`} transform="rotate(180deg)" />
    </motion.div>
  )
}

export default BeakerLiquid
