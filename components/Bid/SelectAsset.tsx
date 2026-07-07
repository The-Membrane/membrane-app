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

  // The Select option objects are the collateral assets themselves (spread + label/value),
  // so the selected option is a valid Asset. Typed as any at the Select seam because the
  // generic Select props narrow to OptionType.
  const onChange = (value: any) => {
    console.log("selectedAsset", value)

    setBidState({
      selectedAsset: value,
      placeBid: {
        cdt: 0,
        premium: 0,
      },
    })
  }

  return <Select options={(assetsWithOptions ?? []) as any} onChange={onChange} value={bidState?.selectedAsset as any} />
}

export default SelectAsset
