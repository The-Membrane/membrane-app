// notify.mjs — alarm delivery for the VENUE FAILURE-PATTERN ALARM.
//
// notify(alarms) delivers a plain-text digest of new or retried open alarms over
// whatever channels are available, and returns { ok, channels, telegram }.
// ok=true means at least one channel accepted the message; telegram records
// configured/delivered separately. The checker requires Telegram delivery
// when configured, so a successful local fallback does not mask its failure.
//
// Channels, in order:
//   1. Telegram — POST api.telegram.org/bot<token>/sendMessage. ONLY if BOTH
//      TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in .env.local. Plain text
//      (no parse_mode) so evidence numbers with _ * [ ] never trip Markdown.
//   2. Log file — always append one line per alarm to ~/Library/Logs/venue-alarms.log.
//   3. macOS notification — on darwin, one `osascript -e 'display notification …'`.
//
// This module NEVER invents env values. If both Telegram vars are unset it logs
// how to enable them and relies on local fallbacks. If only one is set, Telegram
// remains required but incomplete: local fallback still runs and the checker
// leaves the row pending. A Telegram retry may repeat the local log append.

import { appendFile } from 'fs/promises'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { readEnv } from './venue-reads.mjs'
import { GATE_KINDS, isLegacyTermsOnlyGateAlarm } from './alarmRules.mjs'

const LOG_PATH = join(homedir(), 'Library', 'Logs', 'venue-alarms.log')

// One human line per alarm — venue, kind, severity, and the evidence numbers.
export function formatAlarmLine(a) {
  const legacyTermsOnly = isLegacyTermsOnlyGateAlarm(a)
  const sev = legacyTermsOnly ? 'NOTICE' : String(a.severity ?? '').toUpperCase()
  const ev = a.evidence ?? {}
  let detail = ''
  switch (a.kind) {
    case 'gate_change':
      if (legacyTermsOnly) {
        detail = `NOTICE — official terms page text changed (${ev.count ?? 1} in 24h); exit impact unclassified`
      } else {
        const measured = (ev.events ?? []).find((event) => GATE_KINDS.has(event?.kind))
        detail = measured
          ? `gate moved — ${measured.kind} (${ev.count ?? 1} in 24h): ${measured.note ?? ''}`.trim()
          : ev.latest?.kind === 'terms_page_changed'
            ? 'legacy evidence incomplete — terms page text changed; exit impact unclassified'
            : `gate moved — ${ev.latest?.kind ?? 'event'} (${ev.count ?? 1} in 24h): ${ev.latest?.note ?? ''}`.trim()
      }
      break
    case 'terms_page_notice':
      detail = `NOTICE — official terms page text changed (${ev.count ?? 1} in 24h); exit impact unclassified${ev.sourceUrl ? `; review ${ev.sourceUrl}` : ''}`
      break
    case 'drawdown_fast':
      detail = `${ev.metric ?? 'capacity'} fell ${fmtPct(ev.dropPct)} — ${fmtUsd(ev.fromValue)} (${shortDate(ev.fromDate)}) -> ${fmtUsd(ev.toValue)} (${shortDate(ev.toDate)})`
      break
    case 'net_outflow_streak':
      detail = `net outflow ${ev.streakDays}d straight — ${fmtUsd(ev.cumulativeOutflowUsd)} out = ${fmtPct(ev.pctOfTvl)} of TVL (${fmtUsd(ev.tvlUsd)})`
      break
    case 'headroom_thin':
      detail = `instant exit ${fmtUsd(ev.instantUsd)} vs worst day ${fmtUsd(ev.worstDayOutflowUsd)} = ${Number(ev.ratio).toFixed(2)}x — one bad day from gating`
      break
    default:
      detail = JSON.stringify(ev)
  }
  return `[${sev}] ${a.venue} ${a.kind}: ${detail}`
}

export function formatDigest(alarms, stamp) {
  const noticesOnly = alarms.every((a) => a.severity === 'notice' || isLegacyTermsOnlyGateAlarm(a))
  const heading = noticesOnly ? 'Membrane venue notices' : 'Membrane venue signals'
  return `${heading} (${alarms.length}) — ${stamp}\n${alarms.map(formatAlarmLine).join('\n')}`
}

export async function notify(newAlarms, opts = {}) {
  const alarms = newAlarms ?? []
  if (alarms.length === 0)
    return {
      ok: true,
      channels: [],
      telegram: { configured: false, delivered: false },
      skipped: 'no new alarms',
    }

  const lines = alarms.map(formatAlarmLine)
  const stamp = new Date().toISOString()
  const channels = []

  // --- 1. Telegram (only if both vars present; never invented) --------------
  const get = opts.get ?? readEnv().get
  const token = get('TELEGRAM_BOT_TOKEN')
  const chatId = get('TELEGRAM_CHAT_ID')
  const telegramRequired = Boolean(token || chatId)
  const telegramReady = Boolean(token && chatId)
  if (telegramReady) {
    try {
      const text = formatDigest(alarms, stamp)
      const r = await (opts.fetch ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(opts.telegramTimeoutMs ?? 30_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      })
      const body = r.ok ? await r.json() : null
      if (r.ok && body?.ok === true) {
        channels.push('telegram')
        console.log(`  notify: telegram delivered (${alarms.length} alarm(s))`)
      } else {
        console.log(`  notify: telegram rejected message (HTTP ${r.status}) — local fallback only`)
      }
    } catch {
      console.log('  notify: telegram request failed or timed out — local fallback only')
    }
  } else if (telegramRequired) {
    console.log(
      `  notify: telegram configuration incomplete — missing ${token ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN'}; local fallback only, remote delivery pending`,
    )
  } else {
    console.log(
      '  notify: telegram disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local to enable it',
    )
  }

  // --- 2. Log file (always) -------------------------------------------------
  try {
    await (opts.appendFile ?? appendFile)(
      LOG_PATH,
      lines.map((l) => `${stamp} ${l}`).join('\n') + '\n',
    )
    channels.push('logfile')
    console.log(`  notify: appended ${lines.length} line(s) to ${LOG_PATH}`)
  } catch (e) {
    console.log(`  notify: logfile append FAILED (${String(e).split('\n')[0]})`)
  }

  // --- 3. macOS notification (darwin) --------------------------------------
  if (process.platform === 'darwin') {
    try {
      const worst = alarms.some((a) => a.severity === 'alarm' && !isLegacyTermsOnlyGateAlarm(a))
        ? 'ALARM'
        : alarms.some((a) => a.severity === 'watch')
          ? 'watch'
          : 'notice'
      const body = `${alarms.length} venue signal(s): ${alarms.map((a) => `${a.venue}/${a.kind}`).join(', ')}`
      await (opts.displayNotification ?? displayNotification)(`Membrane venue ${worst}`, body)
      channels.push('macos')
      console.log('  notify: macOS notification posted')
    } catch (e) {
      console.log(`  notify: osascript failed (${String(e).split('\n')[0]})`)
    }
  }

  return {
    ok: channels.length > 0,
    channels,
    telegram: { configured: telegramRequired, delivered: channels.includes('telegram') },
  }
}

// --- helpers ---------------------------------------------------------------
function displayNotification(title, body) {
  // Pass title/body as osascript arguments (on-account-of "$1"/"$2"), never
  // string-interpolated into the script, so an evidence value can't break out.
  const script =
    'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run'
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, title, body], { timeout: 10_000 }, (err) =>
      err ? reject(err) : resolve(),
    )
  })
}

function fmtUsd(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '$?'
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3)}k`
  return `$${Math.round(v)}`
}

function fmtPct(n) {
  const v = Number(n)
  return Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '?%'
}

function shortDate(d) {
  if (!d) return '?'
  const s = typeof d === 'string' ? d : new Date(d).toISOString()
  return s.slice(0, 10)
}
