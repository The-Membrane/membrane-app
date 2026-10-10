import { it } from 'vitest'
import { readFileSync } from 'node:fs'

import handler from '@/pages/api/carry/holder-exit-assessment'

it('calls the actual EURCV default API once and reports safe outcome diagnostics', async () => {
  const input = JSON.parse(readFileSync('/private/tmp/eurcv-holder-stage-default-live-oct10-2026-10-10T04-47-30.939Z-75356bbf-f20a-4562-8a02-dbb00898d0fa/request.json', 'utf8')).input
  let statusCode = 0
  let responseCalls = 0
  let body: unknown
  const response = {
    setHeader(_key: string, _value: string | string[]) {},
    status(value: number) { statusCode = value; return response },
    json(value: unknown) { responseCalls += 1; body = value; return response },
  }
  const requestedAtMs = Date.now()
  await handler({ method: 'POST', body: input, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never, response as never)
  const receivedAtMs = Date.now()
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  const errorCodes = new Set(['holder_exit_assessment_unavailable', 'rate_limited', 'request_too_large', 'invalid_holder_exit_request'])
  console.log(JSON.stringify({
    schema: 'eurcv_actual_default_api_stage_diagnostic_v2',
    statusCode, responseCalls, requestCalls: 1,
    bodyKeys: record ? Object.keys(record) : [],
    errorCode: record && typeof record.error === 'string' && errorCodes.has(record.error) ? record.error : null,
    requestedAtMs, receivedAtMs,
    requestedAtUtc: new Date(requestedAtMs).toISOString(),
    receivedAtUtc: new Date(receivedAtMs).toISOString(),
    elapsedMs: receivedAtMs - requestedAtMs,
    frozenInputUsedWithoutSourceOverride: true,
    actualDefaultHandler: true, HTTP: false, browser: false,
    SDKPhysicalStarts: null, qualification: false,
    executionQualified: false, forecastEligibility: false, coveragePromotion: false,
  }))
}, 35000)
