import React from 'react'
import { useMintCar } from '@/components/Racing/hooks'
import ConfirmModal from '../ConfirmModal'
import { PaymentOption } from './hooks/usePaymentSelection'

interface MintCarConfirmButtonProps {
  option: PaymentOption
  name: string
  owner?: string
  isLoading: boolean
  onSuccess?: () => void
}

/**
 * One payment option's mint button. Owns its own `useMintCar` Hook so the parent
 * (MintPanel) never calls Hooks inside a loop — each rendered option is its own
 * component instance with a single, unconditional Hook call (Rules of Hooks).
 */
const MintCarConfirmButton: React.FC<MintCarConfirmButtonProps> = ({
  option,
  name,
  owner,
  isLoading,
  onSuccess,
}) => {
  const paymentOption =
    option.denom && option.amount !== '0'
      ? { denom: option.denom, amount: option.amount }
      : null

  const { action } = useMintCar({
    owner,
    name,
    paymentOption,
    onSuccess,
  })

  return (
    <ConfirmModal
      label={option.label}
      action={action}
      isDisabled={!option.isAvailable || isLoading}
      isLoading={isLoading}
      executeDirectly={true}
      buttonProps={{
        w: '100%',
        bg: option.isAvailable ? '#274bff' : '#1a1f2e',
        color: 'white',
        _hover: option.isAvailable ? { bg: '#1a3bff' } : {},
        _active: option.isAvailable ? { bg: '#0f2bff' } : {},
        borderRadius: 'md',
        size: 'sm',
        fontFamily: '"Press Start 2P", monospace',
        fontSize: '10px',
        minH: '32px',
        cursor: option.isAvailable ? 'pointer' : 'not-allowed',
      }}
    />
  )
}

export default MintCarConfirmButton
