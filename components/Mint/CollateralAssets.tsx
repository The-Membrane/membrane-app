import { num } from '@/helpers/num'
import { Stack, Checkbox } from '@chakra-ui/react'
import { AssetWithInput } from './AssetWithSlider'
import useMintState from './hooks/useMintState'
import useCombinBalance, { AssetWithBalance } from './hooks/useCombinBalance'
import { useEffect, useState } from 'react'
import { colors } from '@/config/defaults'
import { InitialCDPDeposit } from './InitialCDPDeposit'

export const getAssetWithNonZeroValues = (combinBalance: AssetWithBalance[]) => {
  return combinBalance
    ?.filter((asset) => {
      if (!asset) return false
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
  const combinBalance = useCombinBalance(mintState.positionNumber - 1)
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
    <Stack>
      <Checkbox alignSelf="center" onChange={() => setToggle(!toggle)}>
        Show All Assets
      </Checkbox>
      <Stack
        gap="5"
        maxH="53vh"
        overflowY="auto"
        w="full"
        px="4"
        py="2"
        paddingInlineEnd={0}
        css={{
          // Customize scrollbar appearance
          '::-webkit-scrollbar': {
            width: '6px', // Set width of the scrollbar
            backgroundColor: 'transparent', // Set background color of the scrollbar to transparent
          },
          '::-webkit-scrollbar-thumb': {
            backgroundColor: colors.collateralScrollBG, // Set color of the scrollbar thumb to blue
            borderRadius: '6px', // Set border radius of the scrollbar thumb
          },
        }}
      >
        <InitialCDPDeposit />
        {/* {assets?.map((asset) => {
          return <AssetWithInput key={asset?.base} asset={asset} label={asset?.symbol} />
        })} */}
      </Stack>
    </Stack>

  )
}

export default CollateralAssets
