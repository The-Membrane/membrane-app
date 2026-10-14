// Which address the page reads, and the form that sets it.
//
// DERIVED, NOT SYNCED. The target is, in order: the wallet's address when the reader asked
// for it and the wallet has reported one; the address the reader submitted; the URL's
// ?address= (a shared link). Nothing is copied between these in an effect: the target is
// derived on every render, and only event handlers change a request. A submit also writes
// the address into the URL, so every read is shareable.
// Read-only throughout: connecting supplies an address; nothing is signed.

import { useCallback, useState } from 'react'
import { useRouter } from 'next/router'

import useWallet from '@/hooks/useWallet'
import { parseAddress } from '@/lib/position-sim/rpc'

export const BAD_ADDRESS = 'Not an Ethereum address: it needs 0x and 40 hex characters.'

export interface PositionTarget {
  target: `0x${string}` | null
  /** Bumped on every submit, so reading the same address again re-reads it. */
  nonce: number
  input: string
  setInput: (v: string) => void
  error: string | null
  submit: (raw: string) => void
  onWallet: () => void
  walletConnected: boolean
}

export function usePositionTarget(): PositionTarget {
  const router = useRouter()
  const { address: wallet, isWalletConnected, connect } = useWallet()
  const [wantsWallet, setWantsWallet] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requested, setRequested] = useState<`0x${string}` | null>(null)
  const [nonce, setNonce] = useState(0)

  const fromUrl =
    router.isReady && typeof router.query.address === 'string' ? parseAddress(router.query.address) : null
  const fromWallet = wantsWallet && wallet ? parseAddress(wallet) : null
  const target = fromWallet ?? requested ?? fromUrl

  const submit = useCallback(
    (raw: string) => {
      const parsed = parseAddress(raw)
      if (!parsed) {
        setError(BAD_ADDRESS)
        return
      }
      setError(null)
      setWantsWallet(false)
      setRequested(parsed)
      // The same address again is a deliberate re-read; a new one reads by changing target.
      if (parsed === target) setNonce((n) => n + 1)
      // Shallow, so the page does not remount; the address rides in the URL to share.
      if (router.query.address !== parsed) {
        void router.replace({ pathname: router.pathname, query: { ...router.query, address: parsed } }, undefined, {
          shallow: true,
          scroll: false,
        })
      }
    },
    [router, target],
  )

  const onWallet = useCallback(() => {
    if (isWalletConnected && wallet) {
      setTyped(wallet)
      submit(wallet)
      return
    }
    // Read the wallet's address as soon as it connects; until then nothing changes.
    setTyped(null)
    setWantsWallet(true)
    connect()
  }, [isWalletConnected, wallet, submit, connect])

  return {
    target,
    nonce,
    // Untouched, the box shows the address being read.
    input: typed ?? target ?? '',
    setInput: setTyped,
    error,
    submit,
    onWallet,
    walletConnected: Boolean(isWalletConnected && wallet),
  }
}
