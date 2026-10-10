import {
  carryExitV2RpcBudgetReason,
  startCarryExitV2BudgetedRpc,
} from './carry-exit-v2-rpc-budget.mjs'
import { selectCarryExitV2FirstFinalizedBlock } from './carry-exit-v2-block-auditor.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'
import { classifyUmbrellaGhoScore } from './carry-exit-v2-umbrella-gho-classifier.mjs'

const host = (url) => {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('umbrella_origin_invalid')
  const name = parsed.hostname.replace(/\.$/, '').replace(/^www\./, '')
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(name) ? 'loopback' : name
}
/** One source budget covers selection, failover, collection, and both replay origins. */
export function createUmbrellaGhoV2ScorerAdapter({
  origins,
  preferredSecondaryUrl,
  now = () => new Date(),
  select = selectCarryExitV2FirstFinalizedBlock,
  measure = measureCarryExitV2Verified,
  classify = classifyUmbrellaGhoScore,
  deadlineMs = now().getTime() + 240000,
  wallDeadlineMs = Date.now() + 240000,
}) {
  if (
    !Array.isArray(origins) ||
    origins.length < 2 ||
    origins.length > 8 ||
    origins.some((c) => typeof c?.send !== 'function')
  )
    throw Error('umbrella_transports_invalid')
  let requestId = 0
  origins = origins.map((client) => ({
    ...client,
    request:
      client.request ??
      (async (method, params) => {
        const id = `umbrella-target-${++requestId}`
        const response = await client.send({ jsonrpc: '2.0', id, method, params })
        if (
          response?.jsonrpc !== '2.0' ||
          response.id !== id ||
          Object.hasOwn(response, 'error') ||
          !Object.hasOwn(response, 'result')
        )
          throw Error('umbrella_rpc_invalid')
        return response.result
      }),
  }))
  const started = now().getTime(),
    wallDeadline = Math.min(Date.now() + 240000, wallDeadlineMs),
    deadline = Math.min(started + 240000, deadlineMs)
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(wallDeadline))
    throw Error('umbrella_budget_invalid')
  const budget = { starts: 0, limit: 256, deadlineMs: deadline, wallDeadlineMs: wallDeadline }
  const codes = {
    cap: 'umbrella_score_rpc_start_limit',
    deadline: 'umbrella_score_deadline_elapsed',
  }
  const exhausted = (context) =>
    carryExitV2RpcBudgetReason(budget, now().getTime(), codes) ??
    (now().getTime() >= Date.parse(context.due.deadlineAtUtc)
      ? (budget.exhaustedReason = codes.deadline)
      : null)
  const choices = new Map()
  const key = (context) => `${context.issue.payload.issueId}:${context.due.horizonH}`
  const guard = (context) => {
    const reason = exhausted(context)
    if (reason) throw Error(reason)
  }
  const bounded = (client, context) => {
    const call =
      (fn) =>
      async (...args) => {
        guard(context)
        startCarryExitV2BudgetedRpc(budget, now().getTime(), codes)
        let timer
        try {
          const remaining = Math.min(
            15000,
            deadline - now().getTime(),
            Date.parse(context.due.deadlineAtUtc) - now().getTime(),
            wallDeadline - Date.now(),
          )
          const value = await Promise.race([
            fn(...args),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error('umbrella_score_deadline_elapsed')),
                Math.max(1, remaining),
              )
            }),
          ])
          guard(context)
          return value
        } finally {
          clearTimeout(timer)
        }
      }
    return {
      ...client,
      request: call(client.request.bind(client)),
      send: call(client.send.bind(client)),
    }
  }
  const independent = (primary) => origins.filter((c) => host(c.url) !== host(primary.url))
  const secondaryFor = (primary) =>
    independent(primary).find((c) => c.url === preferredSecondaryUrl) ?? independent(primary)[0]
  return {
    id: 'carry_local_exit_v2_umbrella_gho_classifier_v1',
    async chooseTarget(context) {
      for (const origin of origins) {
        guard(context)
        if (!secondaryFor(origin)) continue
        const client = bounded(origin, context)
        try {
          const target = await select({
            targetAt: context.plan.targetAtUtc,
            baselineBlock: context.issue.payload.baselineBlock,
            baselineHash: context.issue.payload.baselineHash,
            provider: client.provider,
            source: 'carry_local_exit_v2_umbrella_gho_target',
            request: client.request,
            now,
          })
          guard(context)
          choices.set(key(context), origin)
          return target
        } catch (error) {
          guard(context)
          if (exhausted(context)) throw Error(exhausted(context))
          if (error?.message === 'umbrella_score_deadline_elapsed') throw error
        }
      }
      throw Error('umbrella_score_target_unavailable')
    },
    async measure(context, target) {
      const chosen = choices.get(key(context))
      if (!chosen) return { status: 'unavailable', reason: 'umbrella_target_not_selected' }
      for (const origin of [chosen, ...origins.filter((c) => c !== chosen)]) {
        const secondary = secondaryFor(origin)
        if (!secondary) continue
        try {
          guard(context)
          const primary = bounded(origin, context),
            verification = bounded(secondary, context)
          const result = await measure({
            ...context.row,
            target,
            provider: primary.provider,
            source: 'carry_local_exit_v2_umbrella_gho_score',
            send: primary.send,
            primary: { url: primary.url, request: primary.send },
            secondary: { url: verification.url, request: verification.send },
            now,
          })
          guard(context)
          if (result.status === 'verified') return result
          if (exhausted(context)) return { status: 'unavailable', reason: exhausted(context) }
        } catch {
          if (exhausted(context)) return { status: 'unavailable', reason: exhausted(context) }
        }
      }
      return {
        status: 'unavailable',
        reason: exhausted(context) ?? 'umbrella_score_measurement_unavailable',
      }
    },
    classify,
  }
}
