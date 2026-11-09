import { useQuery } from '@tanstack/react-query'

import type { AlertsStatus } from '@/pages/api/alerts/status'

/**
 * What the "Alert me at" control may offer: storage (else the control is hidden —
 * never a disabled gate), RSS, and Telegram (only once the owner sets the bot's
 * webhook secret). One shared query for every control on the page.
 */
export const useAlertsStatus = () =>
  useQuery<AlertsStatus>({
    queryKey: ['alerts_status'],
    queryFn: async () => {
      const r = await fetch('/api/alerts/status')
      if (!r.ok) throw new Error(`alerts status ${r.status}`)
      return r.json()
    },
    staleTime: 60_000,
    refetchOnMount: true,
    retry: false,
  })
