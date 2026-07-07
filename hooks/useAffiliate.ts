import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { decodeBase64UrlToAddress, isValidCosmosAddress } from '@/helpers/referral'

interface AffiliateStore {
  affiliateAddress: string | null
  affiliateLabel: string | null
  setAffiliate: (address: string | null, label?: string | null) => void
  clear: () => void
}

/**
 * Session-scoped Zustand store for the affiliate address.
 * Uses sessionStorage so the affiliate expires when the tab closes.
 */
export const useAffiliateStore = create<AffiliateStore>()(
  persist(
    (set) => ({
      affiliateAddress: null,
      affiliateLabel: null,
      setAffiliate: (address, label) => set({ affiliateAddress: address, affiliateLabel: label ?? null }),
      clear: () => set({ affiliateAddress: null, affiliateLabel: null }),
    }),
    {
      name: 'affiliate-session',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          } as Storage
        }
        return sessionStorage
      }),
    }
  )
)

/**
 * Captures the ?ref= query parameter from the URL, decodes it,
 * validates it as a Cosmos address, and stores it in the session store.
 *
 * First-touch attribution: won't overwrite an existing affiliate.
 * Call once at a high level (e.g., _app.tsx).
 */
export function useAffiliateCaptureFromUrl() {
  const router = useRouter()
  const { affiliateAddress, setAffiliate } = useAffiliateStore()

  useEffect(() => {
    if (typeof window === 'undefined') return

    const ref = router.query.ref as string | undefined
    if (!ref) return
    if (affiliateAddress) return

    const decoded = decodeBase64UrlToAddress(ref)
    if (decoded && isValidCosmosAddress(decoded)) {
      // Decode optional label param (base64url encoded, not exposed in UI)
      const labelParam = router.query.label as string | undefined
      const label = labelParam ? decodeBase64UrlToAddress(labelParam) : null
      setAffiliate(decoded, label)
    }
  }, [router.query.ref, router.query.label, affiliateAddress, setAffiliate])
}

/**
 * Returns the stored affiliate address and label for use in deposit hooks.
 * Returns undefined when no affiliate is set (maps to Rust Option<String> = None).
 */
export function useAffiliateAddress(): string | undefined {
  const { affiliateAddress } = useAffiliateStore()
  return affiliateAddress ?? undefined
}

export function useAffiliateLabel(): string | undefined {
  const { affiliateLabel } = useAffiliateStore()
  return affiliateLabel ?? undefined
}
