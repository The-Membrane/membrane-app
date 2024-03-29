import React, { useEffect } from 'react'
import Select from '@/components/Select'
import useAssets from '@/hooks/useAssets'
import useBidState from './hooks/useBidState'

type Props = {}

const SelectAsset = (props: Props) => {
  const assets = useAssets()
  const { bidState, setBidState } = useBidState()

  const newAssets = assets?.map((asset) => ({
    ...asset,
    value: asset.symbol,
    label: asset.symbol,
  }))

  useEffect(() => {
    if (!bidState?.selectedAsset && newAssets?.[0]) {
      setBidState({
        selectedAsset: newAssets?.[0],
      })
    }
  }, [newAssets])

  const onChange = (value: string) => {
    setBidState({
      selectedAsset: value,
    })
  }

  return <Select options={newAssets} onChange={onChange} value={bidState?.selectedAsset} />
}

export default SelectAsset
