import { num } from '@/helpers/num'
import { Stack, Checkbox } from '@chakra-ui/react'
import { AssetWithSlider } from './AssetWithSlider'
import useMintState from './hooks/useMintState'
import useCombinBalance, { AssetWithBalance } from './hooks/useCombinBalance'
import { useEffect, useState } from 'react'

const getAssetWithNonZeroValues = (combinBalance: AssetWithBalance[]) => {
  return combinBalance
    ?.filter((asset) => {
      return num(asset.combinUsdValue || 0).isGreaterThan(1)
    })
    .map((asset) => ({
      ...asset,
      sliderValue: asset.depositUsdValue || 0,
      amount: 0,
      amountValue: 0,
    }))
}

const CollateralAssets = () => {
  const [toggle, setToggle] = useState<boolean>(false)
  const { mintState, setMintState } = useMintState()
  const combinBalance = useCombinBalance(mintState.positionNumber)
  const { assets } = mintState

  useEffect(() => {
    const assetsWithValuesGreaterThanZero = getAssetWithNonZeroValues(combinBalance)
    setMintState({ assets: assetsWithValuesGreaterThanZero })
  }, [combinBalance])

  useEffect(() => {    
    const assetsWithValuesGreaterThanZero = getAssetWithNonZeroValues(combinBalance)
    
    if (toggle) {
      //Replace assets in combinBalance that are in assetsWithValuesGreaterThanZero
      const combinedAssets = combinBalance.map((asset) => {
        const assetWithValuesGreaterThanZero = assetsWithValuesGreaterThanZero.find((a) => a.base === asset.base)
        return assetWithValuesGreaterThanZero || asset
      })
      setMintState({ assets: combinedAssets })
    } else {
      setMintState({ assets: assetsWithValuesGreaterThanZero })
    }
  }, [toggle])

  return (
    <Stack
      gap="5"
      maxH="75vh"
      overflowY="auto"
      w="full"
      px="4"
      py="2"
      css={{
        // Customize scrollbar appearance
        '::-webkit-scrollbar': {
          width: '6px', // Set width of the scrollbar
          backgroundColor: 'transparent', // Set background color of the scrollbar to transparent
        },
        '::-webkit-scrollbar-thumb': {
          backgroundColor: '#05071B', // Set color of the scrollbar thumb to blue
          borderRadius: '6px', // Set border radius of the scrollbar thumb
        },
      }}
    >
    <Checkbox onChange={()=>setToggle(!toggle)}>
      Show All Assets
    </Checkbox>
      {assets?.map((asset) => {
        return <AssetWithSlider key={asset?.base} asset={asset} label={asset?.symbol} />
      })}
    </Stack>
  )
}

export default CollateralAssets
