import { num } from '@/helpers/num'
import { Stack, Checkbox } from '@chakra-ui/react'
import { AssetWithInput } from './AssetWithInput'
import useMintState from './hooks/useMintState'
import useCombinBalance, { AssetWithBalance } from './hooks/useCombinBalance'
import { useEffect, useState } from 'react'
import { colors } from '@/config/defaults'
import { InitialCDPDeposit } from './InitialCDPDeposit'
import { useUserPositions } from '@/hooks/useCDP'

export const getAssetWithNonZeroValues = (combinBalance: AssetWithBalance[]) => {
  return combinBalance
    ?.filter((asset) => {
      if (!asset) return false
      return num(asset.combinUsdValue || 0).isGreaterThan(0)
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
  const { data: basketPositions } = useUserPositions()
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
      }).filter((asset) => asset.symbol !== "OSMO/USDC.axl LP" && asset.symbol !== "ATOM/OSMO LP" && asset.symbol !== "marsUSDC")
      setMintState({ assets: combinedAssets })
    } else {
      setMintState({ assets: assetsWithValuesGreaterThanZero })
    }
  }, [toggle])

  const showInitialCDPDeposit = basketPositions !== undefined && mintState.positionNumber <= basketPositions[0].positions.length

  return (
    <Stack gap={showInitialCDPDeposit ? "1.5rem" : "0.5rem"}>
      <Checkbox alignSelf="center" onChange={() => setToggle(!toggle)}>
        Browse All Assets
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
        {showInitialCDPDeposit
          ?
          <>
            {assets?.map((asset) => {
              return <AssetWithInput key={asset?.base} asset={asset} label={asset?.symbol} />
            })}
          </>
          :
          <InitialCDPDeposit />
        }
      </Stack>
    </Stack>

  )
}

export default CollateralAssets
