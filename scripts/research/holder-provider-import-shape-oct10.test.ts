import { it } from 'vitest'
import '@/pages/api/carry/holder-exit-assessment'

it('reports provider module import shape without invoking its exports', async () => {
  const module = await import('@/scripts/research/carry-depth-quote-archive.mjs')
  const defaultExport = (module as { default?: Record<string, unknown> | null }).default
  console.log(JSON.stringify({
    schema: 'holder_provider_import_shape_diagnostic_v1',
    moduleKeys: Object.keys(module),
    configuredProviders: typeof module.configuredProviders,
    readProviderPolicy: typeof module.readProviderPolicy,
    defaultExport: typeof defaultExport,
    defaultConfiguredProviders: typeof defaultExport?.configuredProviders,
    defaultReadProviderPolicy: typeof defaultExport?.readProviderPolicy,
    providerFunctionsInvoked: false,
    diagnosticRequestsRPC: false,
    diagnosticInspectsEnvironment: false,
  }))
}, 10000)
