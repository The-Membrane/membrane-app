// Which address the page reads, and the form that sets it.
//
// DERIVED, NOT SYNCED. The target is, in order: the wallet's address when the reader asked
// for it and the wallet has reported one; the address the reader submitted; the URL's
// ?address= (a shared link). Nothing is copied between these in an effect: the target is
// derived on every render, and only event handlers change a request. A submit, and a
// wallet that connects, write the address into the URL, so every read is shareable.
// Read-only throughout: connecting supplies an address; nothing is signed.

import { useCallback, useEffect, useState } from 'react'
import { useRouter, type NextRouter } from 'next/router'

import useWallet from '@/hooks/useWallet'
import { parseAddress } from '@/lib/position-sim/rpc'

export const BAD_ADDRESS = 'Not an Ethereum address: it needs 0x and 40 hex characters.'

export interface PositionTarget {
  target: `0x${string}` | null
  /** Bumped on every submit, so reading the same address again re-reads it. */
  nonce: number
  /** Reads the same address again (after a lever settles). */
  reread: () => void
  input: string
  setInput: (v: string) => void
  error: string | null
  submit: (raw: string) => void
  onWallet: () => void
  walletConnected: boolean
}

type Address = `0x${string}`

/** A shared link's ?address=, raw and parsed. */
function urlAddress(router: NextRouter): { raw: string | null; parsed: Address | null } {
  const raw = router.isReady && typeof router.query.address === 'string' ? router.query.address : null
  return { raw, parsed: raw === null ? null : parseAddress(raw) }
}

/** A broken ?address= with nothing else to read gets the box's own message, not silence. */
const urlErrorOf = (raw: string | null, parsed: Address | null, target: Address | null): string | null =>
  raw && parsed === null && target === null ? BAD_ADDRESS : null

/** Writes an address into ?address=, shallow, so the page does not remount and the read can be shared. */
function useReplaceAddress(router: NextRouter): (a: Address) => void {
  return useCallback(
    (a: Address) => {
      if (router.query.address === a) return
      void router.replace({ pathname: router.pathname, query: { ...router.query, address: a } }, undefined, {
        shallow: true,
        scroll: false,
      })
    },
    [router],
  )
}

export function usePositionTarget(): PositionTarget {
  const router = useRouter()
  const { address: wallet, isWalletConnected, connect } = useWallet()
  const [wantsWallet, setWantsWallet] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requested, setRequested] = useState<Address | null>(null)
  const [nonce, setNonce] = useState(0)
  const replaceAddress = useReplaceAddress(router)

  const url = urlAddress(router)
  const fromWallet = wantsWallet && wallet ? parseAddress(wallet) : null
  const target = fromWallet ?? requested ?? url.parsed
  const urlError = urlErrorOf(url.raw, url.parsed, target)

  // A wallet that connects after the tap becomes the target on its own; the URL follows it
  // (an external system kept in step), so a wallet read is as shareable as a pasted one.
  useEffect(() => {
    if (fromWallet) replaceAddress(fromWallet)
  }, [fromWallet, replaceAddress])

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
      replaceAddress(parsed)
    },
    [replaceAddress, target],
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

  const reread = useCallback(() => setNonce((n) => n + 1), [])

  return {
    target,
    nonce,
    reread,
    // Untouched, the box shows the address being read (or the broken one from the link).
    input: typed ?? target ?? (urlError ? url.raw : null) ?? '',
    setInput: setTyped,
    error: error ?? urlError,
    submit,
    onWallet,
    walletConnected: Boolean(isWalletConnected && wallet),
  }
}
