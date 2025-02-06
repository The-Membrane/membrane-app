import { Link, Text, useToast, UseToastOptions, VStack } from '@chakra-ui/react'
import { useMemo } from 'react'
import useWallet from './useWallet'
import { Chain } from '@chain-registry/types'

type Explorer = {
  name?: string
  kind?: string
  url?: string
  tx_page?: string
  account_page?: string
}

export enum ToastTypes {
  Success = 'success',
  Error = 'error',
  Pending = 'pending',
  Warning = 'warning',
  Info = 'info',
}

export interface ToastPayload {
  actions?: JSX.Element
  message?: string | JSX.Element
  title: string
  type: ToastTypes
  dismissable?: boolean
}

type ToastProps = {
  message: JSX.Element | string
  title?: string
  chainName?: string
  txHash?: string
  explorer?: Explorer
  duration?: number | null
}
export interface IToaster {
  dismiss: any
  message: (data: ToastProps) => void
  success: (data: ToastProps) => void
  pending: (data: ToastProps) => void
  error: (data: ToastProps) => void
}

const defaultSettings: UseToastOptions = {
  duration: 9000,
  variant: 'left-accent',
  colorScheme: 'primary',
  isClosable: true,
  containerStyle: {
    margin: 5,
    bg: '#05071B',
    borderRadius: 'md',
    // boxShadow: '0px 0px 24px 0px rgba(250, 129, 253, 0.32)',
    backdropFilter: 'blur(6px)',
  },
}

const ToastContent = ({ message, txHash, explorer }: ToastProps) => {
  const first4 = txHash?.slice(0, 4)
  const last4 = txHash?.slice(-4)
  const txLink = eval('`' + explorer?.tx_page + '`')

  // console.log("tx ready to toast", txLink)

  return (
    <VStack alignItems="flex-start" gap={0} paddingTop={"3%"}>
      {typeof message === "string" ? <span>{message}</span> : message}
      {!!txHash && (
        <Link isExternal href={txLink} style={{ margin: 'unset' }}>
          TxHash: {[first4, last4].join('...')}
        </Link>
      )}
    </VStack>
  )
}

export const getExplorer = (chain: Chain | undefined) => {
  const explorerOrder = ['mintscan', 'atomscan'].reverse()
  const explorers = chain?.explorers || []

  return explorers
    .filter((explorer) => explorer?.kind)
    .sort((a: Explorer, b: Explorer) => {
      const aKind = a?.kind || ''
      const bKind = b?.kind || ''
      return explorerOrder.indexOf(bKind) - explorerOrder.indexOf(aKind)
    })
}

const useToaster = (): IToaster => {
  const toast = useToast()
  const { chain } = useWallet()
  //@ts-ignore
  const [_explorer] = useMemo(() => getExplorer(chain), [chain])

  const error = ({ message, txHash, explorer }: ToastProps) => {
    toast({
      ...defaultSettings,
      title: 'Error',
      description: (
        <ToastContent explorer={explorer || _explorer} message={message} txHash={txHash} />
      ),
      status: ToastTypes.Error,
      position: 'top-right',
    })
  }
  const success = ({ message, txHash, explorer }: ToastProps) => {
    console.log("success", message, txHash, explorer)
    toast({
      ...defaultSettings,
      title: 'Success',
      description: (
        <ToastContent explorer={explorer || _explorer} message={message} txHash={txHash} />
      ),
      status: ToastTypes.Success,
      position: 'top-right',
    })
  }
  const pending = ({ message, txHash }: ToastProps) => {
    toast({
      ...defaultSettings,
      title: 'Pending',
      description: <ToastContent explorer={_explorer} message={message} txHash={txHash} />,
      status: ToastTypes.Info,
      position: 'top-right',
    })
  }
  const message = ({ title, message, duration = 7000 }: ToastProps) => {
    toast({
      ...defaultSettings,
      title: title,
      description: <ToastContent explorer={_explorer} message={message} />,
      status: ToastTypes.Info,
      position: 'top-right',
      duration,
    })
  }

  //dismiss logic is missing for now
  return {
    dismiss: () => { toast.closeAll() },
    message,
    success,
    error,
    pending,
  }
}

export default useToaster
