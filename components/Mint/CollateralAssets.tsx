import { Stack, Checkbox } from '@chakra-ui/react'
import { AssetWithInput } from './AssetWithInput'
import useMintState from './hooks/useMintState'
import useCombinBalance from './hooks/useCombinBalance'
import { useEffect, useState } from 'react'
import { colors } from '@/config/defaults'
import { InitialCDPDeposit } from './InitialCDPDeposit'
import { useUserPositions } from '@/hooks/useCDP'
import { getAssetWithNonZeroValues } from './collateralAssetsUtils'

const CollateralAssets = () => {
  const [toggle, setToggle] = useState<boolean>(false)
  const { mintState, setMintState } = useMintState()
  const { data: basketPositions } = useUserPositions()
  const combinBalance = useCombinBalance(mintState.positionNumber - 1)
  const { assets } = mintState

  useEffect(() => {
    const assetsWithValuesGreaterThanZero = getAssetWithNonZeroValues(combinBalance, mintState.transactionType)
    // console.log("assetsWithValuesGreaterThanZero", assetsWithValuesGreaterThanZero)
    setMintState({ assets: assetsWithValuesGreaterThanZero })
  }, [combinBalance, mintState.transactionType, setMintState])

  useEffect(() => {
    const assetsWithValuesGreaterThanZero = getAssetWithNonZeroValues(combinBalance, mintState.transactionType)

    if (toggle) {
      //Replace assets in combinBalance that are in assetsWithValuesGreaterThanZero
      const combinedAssets = combinBalance.flatMap((asset) => {
        const assetWithValuesGreaterThanZero = assetsWithValuesGreaterThanZero.find((a) => a.base === asset.base)
        const resolvedAsset = assetWithValuesGreaterThanZero || asset
        return resolvedAsset.symbol !== "OSMO/USDC.axl LP" && resolvedAsset.symbol !== "ATOM/OSMO LP" && resolvedAsset.symbol !== "marsUSDC" ? [resolvedAsset] : []
      })
      setMintState({ assets: combinedAssets })
    } else {
      setMintState({ assets: assetsWithValuesGreaterThanZero })
    }
  }, [toggle, mintState.transactionType, combinBalance, setMintState])

  // TODO(evm-migration): useUserPositions returns EvmUserPosition[] (flat), not CosmWasm BasketPositions[] with `.positions`.
  const showInitialCDPDeposit = !!basketPositions && basketPositions.length > 0 && mintState.positionNumber <= (((basketPositions as any)[0]?.positions?.length) ?? 0)

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
