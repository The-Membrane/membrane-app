import Select from '@/components/Select'
import { useEffect } from 'react'
import useBidState from './hooks/useBidState'
import useCollateralAssets from './hooks/useCollateralAssets'

type Props = {}

const SelectAsset = (props: Props) => {
  const assets = useCollateralAssets()
  const { bidState, setBidState } = useBidState()

  const assetsWithOptions = assets
    ?.map((asset) => ({
      ...asset,
      value: asset?.symbol,
      label: asset?.symbol,
    }))

    console.log("bid assets", assetsWithOptions)

  useEffect(() => {
    if (!bidState?.selectedAsset && assetsWithOptions?.[0]) {
      setBidState({
        selectedAsset: assetsWithOptions?.[0],
      })
    }
  }, [assetsWithOptions])

  const onChange = (value: string) => {
    console.log("selectedAsset", value)
    
    setBidState({
      selectedAsset: value,
      placeBid: {
        cdt: 0,
        premium: 0,
      },
    })
  }

  return <Select options={assetsWithOptions} onChange={onChange} value={bidState?.selectedAsset} />
}

export default SelectAsset
