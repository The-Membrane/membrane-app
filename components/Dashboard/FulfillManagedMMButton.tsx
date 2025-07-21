import { Box, Button, Stack } from '@chakra-ui/react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { TxButton } from '../TxButton'
import { useFulfillManagedMarketIntents } from './hooks/useFulfillManagedMarketIntents'

export const CheckManagedIntents = () => {
    const [enabled, setEnabled] = useState(false)
    return (
      <Box mt={4} w="100%">
        {!enabled ? (
          <Box display="flex" justifyContent="center">
            <Button onClick={() => setEnabled(true)}>
              Check for Managed Market Intents
            </Button>
          </Box>
        ) : (
          <FulfillManagedMMButton enabled={enabled} setEnabled={setEnabled} />
        )}
      </Box>
    )
  }

/*
  Button that triggers managed-market intent fulfilment.
  Mimics LiquidateButton behaviour: an external `enabled` toggle controls when the
  intent hook is run. If no messages are produced the toggle is reset after a delay.
*/

function FulfillManagedMMButton({ enabled, setEnabled }: { enabled: boolean; setEnabled: (v: boolean) => void }) {
  const { action, msgs, status } = useFulfillManagedMarketIntents(enabled )
//   console.log("msgs", msgs.length, msgs)
  console.log("status", status)
  const disabled = msgs.length === 0
  const loading = action?.simulate.isLoading || action?.tx.isPending
  const error = action?.simulate.isError
//   console.log("action", action?.simulate.errorMessage, action?.tx.error)

  // Automatically broadcast when enabled and simulation finished
//   useEffect(() => {
//     if (enabled && msgs.length > 0 && !loading && !error) {
//       action?.tx.mutate()
//     }
//   }, [enabled, msgs, loading, error])

  // Refs to track latest values for setTimeout closure
  const disabledRef = useRef(disabled)
  const enabledRef = useRef(enabled)
  const loadingRef = useRef(loading)

  useEffect(() => {
    disabledRef.current = disabled
    enabledRef.current = enabled
    loadingRef.current = loading
  }, [disabled, enabled, loading])

  // Auto-disable when nothing to do (mirrors LiquidateButton logic)
//   useEffect(() => {
//     if (disabled && enabled) {
//       const timeout = setTimeout(() => {
//         if (disabledRef.current && enabledRef.current && !loadingRef.current) {
//           setEnabled(false)
//         }
//       }, 10000)
//       return () => clearTimeout(timeout)
//     }
//   }, [disabled, enabled])

  return (
    <Stack gap="1">
      <TxButton
        isLoading={loading}
        isDisabled={error || disabled || (status === "finished" && msgs.length === 0)}
        onClick={() => setEnabled(true)}
        toggleConnectLabel={false}
      >
        {status != "finished" ? "Fulfill Managed Market Intents" : (status === "finished" && msgs.length === 0) ? "Nothing to fulfill" : "Fulfill Managed Market Intents"}
      </TxButton>
    </Stack>
  )
}

export default FulfillManagedMMButton 