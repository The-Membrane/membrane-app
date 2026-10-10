// Prospective, exact-holder, fixed-Q multihorizon measurement. Schema only:
// applying it issues no batches, quotes, alerts, or forecasts.
// A separate RPC auditor must verify that the stored target/parent headers are
// canonical, finalized, adjacent, and the first canonical block at/after target.
// The auditor must also verify missing receipts against capture logs or chain
// availability; stored payloads/hashes are replay inputs, not proof. Rates must retain all
// predeclared plans, including pending and missing rows, in their denominator.
// The issue witness must be called from a separate autocommit observer connection
// after carry_exit_v2_issue returns. Its DB stamp proves visibility at statement
// time, but a shared writer credential or a transaction held after the witness
// statement still requires external audit before publication.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export const EXIT_V2_HORIZONS_H = Object.freeze([1, 4, 24, 48, 168])
export const EXIT_V2_DEADLINE_US = 2n * 60n * 60n * 1_000_000n
function isoMicros(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value)
  if (!match) return null
  const ms = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null
  return BigInt(ms) * 1_000n + BigInt((match[2] ?? '').padEnd(6, '0') || '0')
}

/** Use exact DB strings. Separate RPC audit must verify canonical first-block selection. */
export function assessExitV2TargetEvidence(sample) {
  const issue = isoMicros(sample.issuedAt)
  const target = isoMicros(sample.targetAt)
  const deadline = isoMicros(sample.deadlineAt)
  const parent = isoMicros(sample.parentBlockAt)
  const block = isoMicros(sample.targetBlockAt)
  const predecessor =
    sample.predecessorBlockAt == null ? null : isoMicros(sample.predecessorBlockAt)
  const captured = isoMicros(sample.capturedAt)
  const recorded = isoMicros(sample.recordedAt)
  const horizon = Number(sample.horizonH)
  if (
    [issue, target, deadline, parent, block, captured, recorded].some((v) => v === null) ||
    !EXIT_V2_HORIZONS_H.includes(horizon) ||
    (sample.predecessorBlockAt != null && predecessor === null)
  )
    return false
  if (
    target !== issue + BigInt(horizon) * 3_600_000_000n ||
    deadline !== target + EXIT_V2_DEADLINE_US
  )
    return false
  if ((horizon === 1 && predecessor === null) || (predecessor !== null && predecessor >= target))
    return false
  if (
    !(
      parent < target &&
      target <= block &&
      block <= captured &&
      captured <= recorded &&
      recorded <= deadline
    )
  )
    return false
  if (
    !/^0x[0-9a-f]{64}$/.test(sample.targetHash) ||
    !/^0x[0-9a-f]{64}$/.test(sample.parentHash) ||
    sample.parentHash !== sample.parentHeaderHash
  )
    return false
  try {
    return BigInt(sample.parentBlock) + 1n === BigInt(sample.targetBlock)
  } catch {
    return false
  }
}

export const DDL = [
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_batches (
    id bigserial PRIMARY KEY,
    plan_doc jsonb NOT NULL CHECK (jsonb_typeof(plan_doc) = 'object'
      AND octet_length(convert_to(plan_doc::text, 'UTF8')) <= 524288),
    plan_sha256 text NOT NULL UNIQUE CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'
      AND plan_sha256 = encode(sha256(convert_to(plan_doc::text, 'UTF8')), 'hex')),
    route_key text NOT NULL CHECK (length(route_key) BETWEEN 1 AND 160),
    slot_at timestamptz NOT NULL,
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    asset_decimals smallint NOT NULL CHECK (asset_decimals BETWEEN 0 AND 36),
    holder text NOT NULL CHECK (holder ~ '^0x[0-9a-f]{40}$'),
    chain_id integer NOT NULL DEFAULT 1 CHECK (chain_id = 1),
    baseline_block bigint NOT NULL CHECK (baseline_block > 0),
    baseline_hash text NOT NULL CHECK (baseline_hash ~ '^0x[0-9a-f]{64}$'),
    baseline_block_at timestamptz NOT NULL,
    baseline_observed_at timestamptz NOT NULL,
    candidate_provenance text NOT NULL CHECK (candidate_provenance IN
      ('receipt_verified_transfer', 'receipt_verified_supply',
       'sealed_morpho_flow', 'august_seed_revalidated')),
    candidate_evidence_sha256 text NOT NULL CHECK
      (candidate_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (baseline_block_at <= baseline_observed_at),
    CHECK (baseline_observed_at <= issued_at),
    UNIQUE (route_key, slot_at)
  )`,
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_cases (
    id bigserial PRIMARY KEY,
    batch_id bigint NOT NULL REFERENCES carry_exit_v2_batches(id),
    case_index smallint NOT NULL CHECK (case_index BETWEEN 1 AND 6),
    assets_raw numeric(78,0) NOT NULL CHECK (assets_raw > 0),
    baseline_status text NOT NULL CHECK (baseline_status IN
      ('success', 'covered_revert', 'ineligible', 'inconclusive', 'unavailable')),
    -- Morpho reports holder shares and previewRedeem assets in different units.
    coverage_kind text CHECK (coverage_kind IN ('shares', 'assets', 'morpho_shares_claim')),
    holder_coverage_raw numeric(78,0) CHECK (holder_coverage_raw >= 0),
    required_coverage_raw numeric(78,0) CHECK (required_coverage_raw >= 0),
    actual_consumed_raw numeric(78,0) CHECK (actual_consumed_raw > 0),
    simulation_status text CHECK (simulation_status IN ('success', 'evm_revert')),
    call_evidence_doc jsonb CHECK (jsonb_typeof(call_evidence_doc) = 'object'
      AND octet_length(convert_to(call_evidence_doc::text, 'UTF8')) <= 32768),
    call_evidence_sha256 text CHECK (call_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    entitlement_method text CHECK (entitlement_method IN
      ('zero_shares', 'exact_asset_balance', 'morpho_claim_below_q')),
    entitlement_evidence_doc jsonb CHECK (jsonb_typeof(entitlement_evidence_doc) = 'object'
      AND octet_length(convert_to(entitlement_evidence_doc::text, 'UTF8')) <= 32768),
    entitlement_evidence_sha256 text CHECK
      (entitlement_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    inconclusive_reason text CHECK (inconclusive_reason IN
      ('preview_gap', 'max_withdraw_gap', 'ambiguous_revert')),
    unavailable_reason text CHECK (unavailable_reason IN
      ('candidate_unavailable', 'identity_unavailable', 'quote_unavailable',
       'holder_position_unavailable')),
    UNIQUE (batch_id, case_index), UNIQUE (batch_id, assets_raw),
    CHECK ((call_evidence_doc IS NULL AND call_evidence_sha256 IS NULL)
      OR (call_evidence_doc IS NOT NULL AND call_evidence_sha256 IS NOT NULL
        AND call_evidence_sha256 = encode(sha256(convert_to(call_evidence_doc::text, 'UTF8')), 'hex'))),
    CHECK ((entitlement_evidence_doc IS NULL AND entitlement_evidence_sha256 IS NULL)
      OR (entitlement_evidence_doc IS NOT NULL AND entitlement_evidence_sha256 IS NOT NULL
        AND entitlement_evidence_sha256 = encode(
          sha256(convert_to(entitlement_evidence_doc::text, 'UTF8')), 'hex'))),
    -- For direct underlying coverage the entitlement needed to exit is exactly
    -- the frozen asset amount, never a caller supplied smaller threshold.
    CHECK (coverage_kind IS DISTINCT FROM 'assets' OR required_coverage_raw = assets_raw),
    CHECK ((baseline_status = 'success' AND coverage_kind IS NOT NULL
      AND holder_coverage_raw IS NOT NULL AND required_coverage_raw > 0
      AND simulation_status IS NOT NULL AND simulation_status = 'success'
      AND call_evidence_doc IS NOT NULL AND call_evidence_sha256 IS NOT NULL
      AND ((coverage_kind IN ('shares', 'morpho_shares_claim') AND actual_consumed_raw IS NOT NULL
        AND actual_consumed_raw <= holder_coverage_raw)
        OR (coverage_kind = 'assets' AND actual_consumed_raw IS NULL
          AND holder_coverage_raw >= assets_raw))
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL
      AND unavailable_reason IS NULL)
      OR (baseline_status = 'covered_revert' AND coverage_kind IS NOT NULL
      AND holder_coverage_raw IS NOT NULL AND required_coverage_raw > 0
      AND ((coverage_kind = 'morpho_shares_claim' AND required_coverage_raw >= assets_raw)
        OR (coverage_kind <> 'morpho_shares_claim'
          AND holder_coverage_raw >= required_coverage_raw))
      AND actual_consumed_raw IS NULL
      AND simulation_status IS NOT NULL AND simulation_status = 'evm_revert'
      AND call_evidence_doc IS NOT NULL AND call_evidence_sha256 IS NOT NULL
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL
      AND unavailable_reason IS NULL)
      OR (baseline_status = 'ineligible' AND coverage_kind IS NOT NULL
      AND holder_coverage_raw IS NOT NULL AND required_coverage_raw IS NOT NULL
      AND ((coverage_kind IN ('shares', 'morpho_shares_claim') AND holder_coverage_raw = 0
        AND entitlement_method = 'zero_shares')
        OR (coverage_kind = 'morpho_shares_claim' AND holder_coverage_raw > 0
          AND required_coverage_raw < assets_raw
          AND entitlement_method = 'morpho_claim_below_q')
        OR (coverage_kind = 'assets' AND holder_coverage_raw < assets_raw
          AND entitlement_method = 'exact_asset_balance'))
      AND entitlement_evidence_doc IS NOT NULL AND entitlement_evidence_sha256 IS NOT NULL
      AND actual_consumed_raw IS NULL
      AND simulation_status IS NULL AND call_evidence_doc IS NULL
      AND call_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL
      AND unavailable_reason IS NULL)
      OR (baseline_status = 'inconclusive' AND coverage_kind IS NOT NULL
      AND holder_coverage_raw IS NOT NULL AND required_coverage_raw IS NOT NULL
      AND actual_consumed_raw IS NULL AND simulation_status IS DISTINCT FROM 'success'
      AND ((simulation_status = 'evm_revert' AND call_evidence_doc IS NOT NULL
        AND call_evidence_sha256 IS NOT NULL)
        OR (simulation_status IS NULL AND call_evidence_doc IS NULL
          AND call_evidence_sha256 IS NULL))
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NOT NULL
      AND entitlement_evidence_sha256 IS NOT NULL
      AND inconclusive_reason IS NOT NULL AND unavailable_reason IS NULL)
      OR (baseline_status = 'unavailable' AND coverage_kind IS NULL
      AND holder_coverage_raw IS NULL AND required_coverage_raw IS NULL
      AND actual_consumed_raw IS NULL
      AND simulation_status IS NULL AND call_evidence_doc IS NULL
      AND call_evidence_sha256 IS NULL
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL
      AND unavailable_reason IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_plans (
    case_id bigint NOT NULL REFERENCES carry_exit_v2_cases(id),
    horizon_h smallint NOT NULL CHECK (horizon_h IN (1, 4, 24, 48, 168)),
    target_at timestamptz NOT NULL,
    deadline_at timestamptz NOT NULL,
    predecessor_h smallint NOT NULL CHECK (predecessor_h IN (0, 1, 4, 24, 48)),
    conditional_recovery boolean NOT NULL,
    PRIMARY KEY (case_id, horizon_h),
    CHECK (deadline_at = target_at + interval '2 hours'),
    CHECK ((horizon_h = 1 AND predecessor_h = 0 AND NOT conditional_recovery)
      OR (horizon_h = 4 AND predecessor_h = 1 AND NOT conditional_recovery)
      OR (horizon_h = 24 AND predecessor_h = 4 AND NOT conditional_recovery)
      OR (horizon_h = 48 AND predecessor_h = 24 AND NOT conditional_recovery)
      OR (horizon_h = 168 AND predecessor_h = 48 AND NOT conditional_recovery))
  )`,
  // Inserted by a separate observer after the issuer's transaction commits.
  // The trigger supplies the DB clock and refuses the issuer's transaction ID.
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_issue_witness (
    batch_id bigint PRIMARY KEY REFERENCES carry_exit_v2_batches(id),
    plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    observed_case_count smallint NOT NULL CHECK (observed_case_count BETWEEN 1 AND 6),
    observed_plan_count smallint NOT NULL CHECK (observed_plan_count = 5 * observed_case_count)
  )`,
  // One immutable outcome per exact route and native 15-minute issue slot.
  // Unavailable attempts have no holder, amount, or synthetic issue batch.
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_attempts (
    id bigserial PRIMARY KEY,
    route_key text NOT NULL CHECK (length(route_key) BETWEEN 1 AND 160),
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    slot_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL CHECK (status IN ('issued', 'unavailable')),
    reason text CHECK (reason IN
      ('no_eligible_holder', 'zero_or_duplicate_q', 'candidate_unavailable',
       'identity_unavailable', 'quote_unavailable', 'rpc_unavailable',
       'baseline_unavailable', 'plan_invalid')),
    batch_id bigint UNIQUE REFERENCES carry_exit_v2_batches(id),
    UNIQUE (route_key, slot_at),
    CHECK ((status = 'issued' AND reason IS NULL AND batch_id IS NOT NULL)
      OR (status = 'unavailable' AND reason IS NOT NULL AND batch_id IS NULL))
  )`,
  // Durable proof that the SQL batch's exact-Q issues were fsynced into the
  // local append-only ledger. This is separate from prospective admission:
  // an ordinary issue attempt can exist even when the process crashed before
  // its local mirror completed.
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_local_mirrors (
    batch_id bigint PRIMARY KEY REFERENCES carry_exit_v2_batches(id),
    route_key text NOT NULL CHECK (length(route_key) BETWEEN 1 AND 160),
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    slot_at timestamptz NOT NULL,
    mirrored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (route_key, slot_at)
  )`,
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_missing_receipts (
    id bigserial PRIMARY KEY,
    case_id bigint NOT NULL,
    horizon_h smallint NOT NULL,
    evidence_kind text NOT NULL CHECK (evidence_kind IN
      ('capture_attempt', 'chain_availability_audit')),
    missing_reason text NOT NULL CHECK (missing_reason IN
      ('target_window_missed', 'rpc_unavailable', 'identity_unavailable',
       'quote_unavailable', 'code_identity_changed')),
    evidence_at timestamptz NOT NULL,
    evidence_doc jsonb NOT NULL CHECK (jsonb_typeof(evidence_doc) = 'object'
      AND octet_length(convert_to(evidence_doc::text, 'UTF8')) <= 32768),
    evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    verifier_kind text NOT NULL CHECK (verifier_kind IN
      ('rpc_replay', 'chain_availability_audit')),
    verified_at timestamptz NOT NULL,
    verifier_doc jsonb NOT NULL CHECK (jsonb_typeof(verifier_doc) = 'object'
      AND octet_length(convert_to(verifier_doc::text, 'UTF8')) <= 32768),
    verifier_sha256 text NOT NULL CHECK (verifier_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (case_id, horizon_h),
    FOREIGN KEY (case_id, horizon_h) REFERENCES carry_exit_v2_plans(case_id, horizon_h),
    CHECK (evidence_at <= verified_at),
    CHECK (evidence_sha256 = encode(sha256(convert_to(evidence_doc::text, 'UTF8')), 'hex')),
    CHECK (verifier_sha256 = encode(sha256(convert_to(verifier_doc::text, 'UTF8')), 'hex'))
  )`,
  `CREATE TABLE IF NOT EXISTS carry_exit_v2_scores (
    id bigserial UNIQUE NOT NULL,
    case_id bigint NOT NULL,
    horizon_h smallint NOT NULL,
    target_at timestamptz NOT NULL,
    deadline_at timestamptz NOT NULL,
    predecessor_h smallint NOT NULL,
    predecessor_score_id bigint REFERENCES carry_exit_v2_scores(id),
    predecessor_status text NOT NULL,
    predecessor_block bigint,
    predecessor_hash text CHECK (predecessor_hash ~ '^0x[0-9a-f]{64}$'),
    predecessor_block_at timestamptz,
    status text NOT NULL CHECK (status IN
      ('success', 'covered_revert', 'holder_attrition', 'inconclusive', 'missing',
       'not_eligible', 'episode_censored')),
    missing_reason text CHECK (missing_reason IN
      ('target_window_missed', 'rpc_unavailable', 'identity_unavailable',
       'quote_unavailable', 'code_identity_changed')),
    missing_receipt_id bigint REFERENCES carry_exit_v2_missing_receipts(id),
    target_block bigint CHECK (target_block > 0),
    target_hash text CHECK (target_hash ~ '^0x[0-9a-f]{64}$'),
    target_parent_block bigint CHECK (target_parent_block > 0),
    target_parent_hash text CHECK (target_parent_hash ~ '^0x[0-9a-f]{64}$'),
    parent_header_hash text CHECK (parent_header_hash ~ '^0x[0-9a-f]{64}$'),
    target_parent_block_at timestamptz,
    target_block_at timestamptz,
    target_observed_at timestamptz,
    captured_at timestamptz,
    canonicality_evidence_doc jsonb CHECK
      (jsonb_typeof(canonicality_evidence_doc) = 'object'
        AND octet_length(convert_to(canonicality_evidence_doc::text, 'UTF8')) <= 32768),
    canonicality_evidence_sha256 text CHECK
      (canonicality_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    coverage_kind text CHECK (coverage_kind IN ('shares', 'assets', 'morpho_shares_claim')),
    holder_coverage_raw numeric(78,0) CHECK (holder_coverage_raw >= 0),
    required_coverage_raw numeric(78,0) CHECK (required_coverage_raw >= 0),
    actual_consumed_raw numeric(78,0) CHECK (actual_consumed_raw > 0),
    simulation_status text CHECK (simulation_status IN
      ('success', 'evm_revert', 'position_insufficient')),
    call_evidence_doc jsonb CHECK (jsonb_typeof(call_evidence_doc) = 'object'
      AND octet_length(convert_to(call_evidence_doc::text, 'UTF8')) <= 32768),
    call_evidence_sha256 text CHECK (call_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    entitlement_method text CHECK (entitlement_method IN
      ('zero_shares', 'exact_asset_balance')),
    entitlement_evidence_doc jsonb CHECK (jsonb_typeof(entitlement_evidence_doc) = 'object'
      AND octet_length(convert_to(entitlement_evidence_doc::text, 'UTF8')) <= 32768),
    entitlement_evidence_sha256 text CHECK
      (entitlement_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    inconclusive_reason text CHECK (inconclusive_reason IN
      ('preview_gap', 'max_withdraw_gap', 'ambiguous_revert')),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (case_id, horizon_h),
    FOREIGN KEY (case_id, horizon_h) REFERENCES carry_exit_v2_plans(case_id, horizon_h),
    CHECK ((canonicality_evidence_doc IS NULL AND canonicality_evidence_sha256 IS NULL)
      OR (canonicality_evidence_doc IS NOT NULL AND canonicality_evidence_sha256 IS NOT NULL
        AND canonicality_evidence_sha256 = encode(
          sha256(convert_to(canonicality_evidence_doc::text, 'UTF8')), 'hex'))),
    CHECK ((call_evidence_doc IS NULL AND call_evidence_sha256 IS NULL)
      OR (call_evidence_doc IS NOT NULL AND call_evidence_sha256 IS NOT NULL
        AND call_evidence_sha256 = encode(sha256(convert_to(call_evidence_doc::text, 'UTF8')), 'hex'))),
    CHECK ((entitlement_evidence_doc IS NULL AND entitlement_evidence_sha256 IS NULL)
      OR (entitlement_evidence_doc IS NOT NULL AND entitlement_evidence_sha256 IS NOT NULL
        AND entitlement_evidence_sha256 = encode(
          sha256(convert_to(entitlement_evidence_doc::text, 'UTF8')), 'hex'))),
    CHECK ((predecessor_block IS NULL AND predecessor_hash IS NULL
        AND predecessor_block_at IS NULL)
      OR (predecessor_block > 0 AND predecessor_hash IS NOT NULL
        AND predecessor_block_at IS NOT NULL)),
    CHECK ((status = 'success' AND missing_reason IS NULL AND missing_receipt_id IS NULL
      AND target_block IS NOT NULL
      AND target_hash IS NOT NULL AND target_block_at IS NOT NULL
      AND target_parent_block IS NOT NULL AND target_parent_hash IS NOT NULL
      AND parent_header_hash IS NOT NULL AND target_parent_block_at IS NOT NULL
      AND target_observed_at IS NOT NULL AND captured_at IS NOT NULL
      AND canonicality_evidence_doc IS NOT NULL AND canonicality_evidence_sha256 IS NOT NULL
      AND coverage_kind IS NOT NULL AND holder_coverage_raw IS NOT NULL
      AND required_coverage_raw > 0
      AND ((coverage_kind IN ('shares', 'morpho_shares_claim') AND actual_consumed_raw IS NOT NULL
        AND actual_consumed_raw <= holder_coverage_raw)
        OR (coverage_kind = 'assets' AND actual_consumed_raw IS NULL))
      AND simulation_status IS NOT NULL AND simulation_status = 'success'
      AND call_evidence_doc IS NOT NULL AND call_evidence_sha256 IS NOT NULL
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL)
      OR (status = 'covered_revert' AND missing_reason IS NULL
      AND missing_receipt_id IS NULL
      AND target_block IS NOT NULL AND target_hash IS NOT NULL
      AND target_parent_block IS NOT NULL AND target_parent_hash IS NOT NULL
      AND parent_header_hash IS NOT NULL AND target_parent_block_at IS NOT NULL
      AND target_block_at IS NOT NULL AND target_observed_at IS NOT NULL
      AND captured_at IS NOT NULL AND coverage_kind IS NOT NULL
      AND canonicality_evidence_doc IS NOT NULL AND canonicality_evidence_sha256 IS NOT NULL
      AND holder_coverage_raw IS NOT NULL AND required_coverage_raw > 0
      AND ((coverage_kind = 'morpho_shares_claim' AND required_coverage_raw IS NOT NULL)
        OR (coverage_kind <> 'morpho_shares_claim'
          AND holder_coverage_raw >= required_coverage_raw))
      AND actual_consumed_raw IS NULL
      AND simulation_status IS NOT NULL AND simulation_status = 'evm_revert'
      AND call_evidence_doc IS NOT NULL AND call_evidence_sha256 IS NOT NULL
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL)
      OR (status = 'holder_attrition' AND missing_reason IS NULL
      AND missing_receipt_id IS NULL
      AND target_block IS NOT NULL AND target_hash IS NOT NULL
      AND target_parent_block IS NOT NULL AND target_parent_hash IS NOT NULL
      AND parent_header_hash IS NOT NULL AND target_parent_block_at IS NOT NULL
      AND target_block_at IS NOT NULL AND target_observed_at IS NOT NULL
      AND captured_at IS NOT NULL AND coverage_kind IS NOT NULL
      AND canonicality_evidence_doc IS NOT NULL AND canonicality_evidence_sha256 IS NOT NULL
      AND holder_coverage_raw IS NOT NULL AND required_coverage_raw IS NOT NULL
      AND entitlement_method IS NOT NULL AND entitlement_evidence_doc IS NOT NULL
      AND entitlement_evidence_sha256 IS NOT NULL
      AND actual_consumed_raw IS NULL
      AND simulation_status IS NULL AND call_evidence_doc IS NULL
      AND call_evidence_sha256 IS NULL
      AND inconclusive_reason IS NULL)
      OR (status = 'inconclusive' AND missing_reason IS NULL
      AND missing_receipt_id IS NULL
      AND target_block IS NOT NULL AND target_hash IS NOT NULL
      AND target_parent_block IS NOT NULL AND target_parent_hash IS NOT NULL
      AND parent_header_hash IS NOT NULL AND target_parent_block_at IS NOT NULL
      AND target_block_at IS NOT NULL AND target_observed_at IS NOT NULL
      AND captured_at IS NOT NULL AND canonicality_evidence_doc IS NOT NULL
      AND canonicality_evidence_sha256 IS NOT NULL
      AND coverage_kind IS NOT NULL AND holder_coverage_raw IS NOT NULL
      AND required_coverage_raw IS NOT NULL AND actual_consumed_raw IS NULL
      AND simulation_status IS DISTINCT FROM 'success'
      AND ((simulation_status = 'evm_revert' AND call_evidence_doc IS NOT NULL
        AND call_evidence_sha256 IS NOT NULL)
        OR (simulation_status = 'position_insufficient' AND call_evidence_doc IS NULL
          AND call_evidence_sha256 IS NULL)
        OR (simulation_status IS NULL AND call_evidence_doc IS NULL
          AND call_evidence_sha256 IS NULL))
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NOT NULL
      AND entitlement_evidence_sha256 IS NOT NULL
      AND inconclusive_reason IS NOT NULL)
      OR (status = 'missing' AND missing_reason IS NOT NULL
      AND missing_receipt_id IS NOT NULL
      AND target_block IS NULL AND target_hash IS NULL AND target_block_at IS NULL
      AND target_parent_block IS NULL AND target_parent_hash IS NULL
      AND parent_header_hash IS NULL AND target_parent_block_at IS NULL
      AND target_observed_at IS NULL AND captured_at IS NULL
      AND canonicality_evidence_doc IS NULL AND canonicality_evidence_sha256 IS NULL
      AND coverage_kind IS NULL AND holder_coverage_raw IS NULL
      AND required_coverage_raw IS NULL AND actual_consumed_raw IS NULL
      AND simulation_status IS NULL
      AND call_evidence_doc IS NULL AND call_evidence_sha256 IS NULL
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL AND inconclusive_reason IS NULL)
      OR (status IN ('not_eligible', 'episode_censored') AND missing_reason IS NULL
      AND missing_receipt_id IS NULL
      AND target_block IS NULL AND target_hash IS NULL AND target_block_at IS NULL
      AND target_parent_block IS NULL AND target_parent_hash IS NULL
      AND parent_header_hash IS NULL AND target_parent_block_at IS NULL
      AND target_observed_at IS NULL AND captured_at IS NULL
      AND canonicality_evidence_doc IS NULL AND canonicality_evidence_sha256 IS NULL
      AND coverage_kind IS NULL AND holder_coverage_raw IS NULL
      AND required_coverage_raw IS NULL AND actual_consumed_raw IS NULL
      AND simulation_status IS NULL
      AND call_evidence_doc IS NULL AND call_evidence_sha256 IS NULL
      AND entitlement_method IS NULL AND entitlement_evidence_doc IS NULL
      AND entitlement_evidence_sha256 IS NULL AND inconclusive_reason IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS carry_exit_v2_plans_due_idx
    ON carry_exit_v2_plans(target_at, horizon_h)`,
  `CREATE INDEX IF NOT EXISTS carry_exit_v2_scores_recorded_idx
    ON carry_exit_v2_scores(recorded_at DESC)`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_direct_ladder_valid(p_candidate jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE supplied numeric; balance numeric; q numeric; prior integer;
      labels jsonb; expected jsonb := '[]'::jsonb; entry jsonb;
      amounts numeric[] := ARRAY[]::numeric[];
      names text[] := ARRAY[
        'holder_half_balance_capped_market_0p001pct', 'market_0p001pct',
        'market_0p01pct', 'market_0p1pct', 'market_0p5pct', 'market_1pct'];
      divisors numeric[] := ARRAY[0, 100000, 10000, 1000, 200, 100];
    BEGIN
      IF (p_candidate->>'selectedAssetBalanceRaw') !~ '^[1-9][0-9]*$'
        OR (p_candidate->'baselineState'->>'marketSupplyRaw') !~ '^[1-9][0-9]*$'
        OR jsonb_typeof(p_candidate->'ladder'->'labels') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_candidate->'ladder'->'labels') <> 6
      THEN RETURN false; END IF;
      supplied := (p_candidate->'baselineState'->>'marketSupplyRaw')::numeric;
      balance := (p_candidate->>'selectedAssetBalanceRaw')::numeric;
      FOR i IN 1..6 LOOP
        IF i = 1 THEN
          q := least(greatest(1, div(balance, 2)),
            greatest(1, div(supplied, 100000)));
        ELSE
          q := div(supplied, divisors[i]);
        END IF;
        prior := array_position(amounts, q);
        IF q = 0 THEN
          entry := jsonb_build_object('label', names[i], 'assetsRaw', NULL,
            'reason', 'zero_sized');
        ELSIF prior IS NOT NULL THEN
          entry := jsonb_build_object('label', names[i], 'assetsRaw', NULL,
            'reason', 'duplicate_q', 'duplicateOf', names[prior]);
        ELSE
          entry := jsonb_build_object('label', names[i], 'assetsRaw', q::text,
            'reason', NULL);
        END IF;
        amounts := array_append(amounts, q);
        expected := expected || jsonb_build_array(entry);
      END LOOP;
      RETURN p_candidate->'ladder'->'labels' = expected;
    EXCEPTION WHEN others THEN RETURN false;
    END $$`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_vault_ladder_valid(p_candidate jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE total numeric; claim numeric; q numeric; prior integer;
      expected jsonb := '[]'::jsonb; entry jsonb; amounts numeric[] := ARRAY[]::numeric[];
      names text[] := ARRAY[
        'holder_half_claim_capped_vault_0p001pct', 'vault_0p001pct',
        'vault_0p01pct', 'vault_0p1pct', 'vault_0p5pct', 'vault_1pct'];
      divisors numeric[] := ARRAY[0, 100000, 10000, 1000, 200, 100];
    BEGIN
      IF (p_candidate->>'selectedClaimRaw') !~ '^[1-9][0-9]*$'
        OR (p_candidate->'baselineState'->>'totalAssetsRaw') !~ '^[1-9][0-9]*$'
        OR jsonb_typeof(p_candidate->'ladder'->'labels') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_candidate->'ladder'->'labels') <> 6
      THEN RETURN false; END IF;
      total := (p_candidate->'baselineState'->>'totalAssetsRaw')::numeric;
      claim := (p_candidate->>'selectedClaimRaw')::numeric;
      FOR i IN 1..6 LOOP
        IF i = 1 THEN
          q := least(greatest(1, div(claim, 2)),
            greatest(1, div(total, 100000)));
          entry := jsonb_build_object('label', names[i],
            'basis', 'selected_holder_claim_raw_and_frozen_vault_total_assets_raw',
            'fractionDenominator', NULL);
        ELSE
          q := div(total, divisors[i]);
          entry := jsonb_build_object('label', names[i],
            'basis', 'frozen_vault_total_assets_raw',
            'fractionDenominator', divisors[i]::text);
        END IF;
        prior := array_position(amounts, q);
        IF q = 0 THEN
          entry := entry || jsonb_build_object('assetsRaw', NULL, 'reason', 'zero_sized');
        ELSIF prior IS NOT NULL THEN
          entry := entry || jsonb_build_object('assetsRaw', NULL,
            'reason', 'duplicate_q', 'duplicateOf', names[prior]);
        ELSE
          entry := entry || jsonb_build_object('assetsRaw', q::text, 'reason', NULL);
        END IF;
        amounts := array_append(amounts, q);
        expected := expected || jsonb_build_array(entry);
      END LOOP;
      RETURN p_candidate->'ladder'->'labels' = expected;
    EXCEPTION WHEN others THEN RETURN false;
    END $$`,
  // These are replayable RPC envelopes, not caller-authored outcome strings.
  // External replay must still verify that responses came from canonical RPC.
  `CREATE OR REPLACE FUNCTION carry_exit_v2_rpc_proof_valid(
      p_rpc jsonb, p_holder text, p_block_hash text, p_outcome text)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(
      jsonb_typeof(p_rpc) = 'object'
      AND length(p_rpc->>'provider') BETWEEN 1 AND 160
      AND length(p_rpc->>'source') BETWEEN 1 AND 160
      AND (p_rpc->>'callTarget') ~ '^0x[0-9a-f]{40}$'
      AND jsonb_typeof(p_rpc->'request') = 'object'
      AND jsonb_typeof(p_rpc->'response') = 'object'
      AND p_rpc->'request'->>'jsonrpc' = '2.0'
      AND p_rpc->'request'->>'method' = 'eth_call'
      AND p_rpc->'request'->>'id' IS NOT NULL
      AND jsonb_typeof(p_rpc->'request'->'params') = 'array'
      AND jsonb_array_length(p_rpc->'request'->'params') = 2
      AND p_rpc->'request'->'params'->0->>'from' = p_holder
      AND p_rpc->'request'->'params'->0->>'to' = p_rpc->>'callTarget'
      AND (p_rpc->'request'->'params'->0->>'data') ~ '^0x([0-9a-f]{2}){4,}$'
      AND p_rpc->'request'->'params'->1->>'blockHash' = p_block_hash
      AND p_rpc->'request'->'params'->1->'requireCanonical' = 'true'::jsonb
      AND p_rpc->'response'->>'jsonrpc' = '2.0'
      AND p_rpc->'response'->>'id' = p_rpc->'request'->>'id'
      AND ((p_outcome = 'success'
          AND (p_rpc->'response'->>'result') ~ '^0x([0-9a-f]{2})*$'
          AND nullif(p_rpc->'response'->'error', 'null'::jsonb) IS NULL)
        OR (p_outcome = 'evm_revert'
          AND jsonb_typeof(p_rpc->'response'->'error') = 'object'
          AND jsonb_typeof(p_rpc->'response'->'error'->'code') = 'number'
          AND (p_rpc->'response'->'error'->>'code') IN ('3', '-32000', '-32015')
          AND (p_rpc->'response'->'error'->>'message') ~*
              '(execution reverted|(^|[^a-z])revert(ed)?([^a-z]|$))'
          AND (p_rpc->'response'->'error'->>'message') !~*
              '(gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit)'
          AND nullif(p_rpc->'response'->'result', 'null'::jsonb) IS NULL)), false)
    $$`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_proof_doc_valid(
      p_doc jsonb, p_purpose text, p_route_key text, p_destination text,
      p_asset text, p_holder text, p_q numeric, p_block bigint,
      p_block_hash text, p_coverage_kind text, p_holder_raw numeric,
      p_required_raw numeric, p_consumed_raw numeric, p_simulation_status text,
      p_entitlement_method text, p_inconclusive_reason text)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(
      jsonb_typeof(p_doc) = 'object'
      AND p_doc->>'schema' = 'carry_exit_v2_proof_v1'
      AND p_doc->>'purpose' = p_purpose
      AND p_doc->>'chainId' = '1'
      AND p_doc->>'routeKey' = p_route_key
      AND p_doc->>'destination' = p_destination
      AND p_doc->>'asset' = p_asset
      AND p_doc->>'holder' = p_holder
      AND p_doc->>'caller' = p_holder
      AND p_doc->>'assetsRaw' = p_q::text
      AND p_doc->>'blockNumber' = p_block::text
      AND p_doc->>'blockHash' = p_block_hash
      AND p_doc->>'coverageKind' = p_coverage_kind
      AND p_doc->>'holderCoverageRaw' = p_holder_raw::text
      AND p_doc->>'requiredCoverageRaw' = p_required_raw::text
      AND (p_doc->>'actualConsumedRaw') IS NOT DISTINCT FROM p_consumed_raw::text
      AND (p_doc->>'simulationStatus') IS NOT DISTINCT FROM p_simulation_status
      AND (p_doc->>'entitlementMethod') IS NOT DISTINCT FROM p_entitlement_method
      AND (p_doc->>'inconclusiveReason') IS NOT DISTINCT FROM p_inconclusive_reason
      AND carry_exit_v2_rpc_proof_valid(p_doc->'holderCoverageRpc', p_holder,
          p_block_hash, 'success')
      AND (p_doc->'holderCoverageRpc'->'response'->>'result') ~ '^0x[0-9a-f]{64}$'
      AND p_doc->'holderCoverageRpc'->>'decodedRaw' = p_holder_raw::text
      AND ((p_coverage_kind IN ('shares', 'morpho_shares_claim')
          AND carry_exit_v2_rpc_proof_valid(p_doc->'requiredCoverageRpc', p_holder,
              p_block_hash, 'success')
          AND (p_doc->'requiredCoverageRpc'->'response'->>'result') ~ '^0x[0-9a-f]{64}$'
          AND p_doc->'requiredCoverageRpc'->>'decodedRaw' = p_required_raw::text)
        OR (p_coverage_kind = 'assets'
          AND nullif(p_doc->'requiredCoverageRpc', 'null'::jsonb) IS NULL))
      AND ((p_purpose = 'call'
          AND p_simulation_status IN ('success','evm_revert')
          AND p_doc->>'verificationStatus' = 'verified'
          AND jsonb_typeof(p_doc->'identityEvidence') = 'object'
          AND p_doc->'identityEvidence'->>'schema' = 'carry_exit_v2_identity_v1'
          AND p_doc->'identityEvidence'->>'chainId' = '1'
          AND p_doc->'identityEvidence'->>'routeKey' = p_route_key
          AND p_doc->'identityEvidence'->>'destination' = p_destination
          AND p_doc->'identityEvidence'->>'asset' = p_asset
          AND p_doc->'identityEvidence'->>'holder' = p_holder
          AND p_doc->'identityEvidence'->>'blockNumber' = p_block::text
          AND p_doc->'identityEvidence'->>'blockHash' = p_block_hash
          AND jsonb_typeof(p_doc->'identityEvidence'->'checks') = 'array'
          AND jsonb_array_length(p_doc->'identityEvidence'->'checks') >= 3
          AND jsonb_typeof(p_doc->'replayEvidenceDoc') = 'object'
          AND p_doc->'replayEvidenceDoc'->>'schema' = 'carry_exit_v2_independent_replay_v1'
          AND p_doc->'replayEvidenceDoc'->>'blockNumber' = p_block::text
          AND p_doc->'replayEvidenceDoc'->>'blockHash' = p_block_hash
          AND length(p_doc->'replayEvidenceDoc'->'origins'->>'primary') BETWEEN 8 AND 160
          AND length(p_doc->'replayEvidenceDoc'->'origins'->>'secondary') BETWEEN 8 AND 160
          AND p_doc->'replayEvidenceDoc'->'origins'->>'primary'
              <> p_doc->'replayEvidenceDoc'->'origins'->>'secondary'
          AND jsonb_typeof(p_doc->'replayEvidenceDoc'->'responses'->'primary') = 'object'
          AND jsonb_typeof(p_doc->'replayEvidenceDoc'->'responses'->'secondary') = 'object'
          AND jsonb_typeof(p_doc->'replayEvidenceDoc'->'identityReplay'->'primary') = 'array'
          AND jsonb_typeof(p_doc->'replayEvidenceDoc'->'identityReplay'->'secondary') = 'array'
          AND p_doc->'replayEvidenceDoc'->'decoded'->>'holderCoverageRaw' = p_holder_raw::text
          AND p_doc->'replayEvidenceDoc'->'decoded'->>'requiredCoverageRaw' = p_required_raw::text
          AND (p_doc->'replayEvidenceDoc'->'decoded'->>'actualConsumedRaw')
              IS NOT DISTINCT FROM p_consumed_raw::text
          AND p_doc->'replayEvidenceDoc'->'decoded'->>'simulationStatus' = p_simulation_status
          AND carry_exit_v2_rpc_proof_valid(p_doc->'withdrawRpc', p_holder,
              p_block_hash, p_simulation_status)
          AND p_doc->'withdrawRpc'->>'decodedAssetsRaw' = p_q::text
          AND (p_doc->'withdrawRpc'->>'decodedConsumedRaw')
              IS NOT DISTINCT FROM p_consumed_raw::text)
        OR (p_purpose = 'entitlement'
          AND nullif(p_doc->'withdrawRpc', 'null'::jsonb) IS NULL)), false)
    $$`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_guard_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE n timestamptz := clock_timestamp(); b carry_exit_v2_batches%ROWTYPE;
      c carry_exit_v2_cases%ROWTYPE; plan carry_exit_v2_plans%ROWTYPE;
      witness carry_exit_v2_issue_witness%ROWTYPE;
      attempt carry_exit_v2_attempts%ROWTYPE;
      missing_receipt carry_exit_v2_missing_receipts%ROWTYPE;
      prior carry_exit_v2_scores%ROWTYPE; expected jsonb;
      prior_holder_attrition boolean; issue_xid bigint;
    BEGIN
      IF TG_TABLE_NAME = 'carry_exit_v2_batches' THEN
        NEW.issued_at := n;
        IF NEW.baseline_block_at NOT BETWEEN n - interval '30 minutes' AND n
          OR NEW.baseline_observed_at > NEW.issued_at
          OR NEW.plan_doc->>'version' IS DISTINCT FROM 'carry_exit_v2'
          OR NEW.plan_doc->>'clock' IS DISTINCT FROM 'db_issued_at'
          OR NEW.plan_doc->>'endpointSelection' IS DISTINCT FROM 'first_finalized_at_or_after_target'
          OR (NEW.plan_doc->>'captureDeadlineHours')::integer IS DISTINCT FROM 2
          OR NEW.plan_doc->'horizons' IS DISTINCT FROM '[1,4,24,48,168]'::jsonb
          OR jsonb_typeof(NEW.plan_doc->'cases') IS DISTINCT FROM 'array'
          OR jsonb_array_length(NEW.plan_doc->'cases') NOT BETWEEN 1 AND 6
          OR NEW.plan_doc->>'routeKey' IS DISTINCT FROM NEW.route_key
          OR (NEW.plan_doc->>'slotAt')::timestamptz IS DISTINCT FROM NEW.slot_at
          OR NEW.slot_at IS DISTINCT FROM date_bin('15 minutes'::interval, n,
            '2000-01-01 00:10:00+00'::timestamptz)
          OR NEW.plan_doc->>'destination' IS DISTINCT FROM NEW.destination
          OR NEW.plan_doc->>'asset' IS DISTINCT FROM NEW.asset
          OR (NEW.plan_doc->>'assetDecimals')::integer IS DISTINCT FROM NEW.asset_decimals
          OR NEW.plan_doc->>'holder' IS DISTINCT FROM NEW.holder
          OR (NEW.plan_doc->>'baselineBlock')::bigint IS DISTINCT FROM NEW.baseline_block
          OR NEW.plan_doc->>'baselineHash' IS DISTINCT FROM NEW.baseline_hash
          OR (NEW.plan_doc->>'baselineBlockAt')::timestamptz IS DISTINCT FROM NEW.baseline_block_at
          OR (NEW.plan_doc->>'baselineObservedAt')::timestamptz IS DISTINCT FROM NEW.baseline_observed_at
          OR NEW.plan_doc->>'candidateProvenance' IS DISTINCT FROM NEW.candidate_provenance
          OR NEW.plan_doc->>'candidateEvidenceSha256' IS DISTINCT FROM NEW.candidate_evidence_sha256
          OR jsonb_typeof(NEW.plan_doc->'candidateEvidenceDoc') IS DISTINCT FROM 'object'
          OR NEW.candidate_evidence_sha256 IS DISTINCT FROM encode(sha256(convert_to(
            (NEW.plan_doc->'candidateEvidenceDoc')::text, 'UTF8')), 'hex')
          OR NEW.plan_doc->'candidateEvidenceDoc'->>'routeKey' IS DISTINCT FROM NEW.route_key
          OR NEW.plan_doc->'candidateEvidenceDoc'->>'destination' IS DISTINCT FROM NEW.destination
          OR NEW.plan_doc->'candidateEvidenceDoc'->>'asset' IS DISTINCT FROM NEW.asset
          OR NEW.plan_doc->'candidateEvidenceDoc'->>'baselineHash' IS DISTINCT FROM NEW.baseline_hash
          OR NEW.plan_doc->'candidateEvidenceDoc'->>'selectedHolderCommitment'
            IS DISTINCT FROM encode(sha256(convert_to(
              NEW.destination || ':' || NEW.holder, 'UTF8')), 'hex')
          OR jsonb_typeof(NEW.plan_doc->'candidateEvidenceDoc'->'screenedCandidates')
            IS DISTINCT FROM 'array'
          OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(
              NEW.plan_doc->'candidateEvidenceDoc'->'screenedCandidates') AS screened(item)
            WHERE screened.item->>'holderCommitment' =
              NEW.plan_doc->'candidateEvidenceDoc'->>'selectedHolderCommitment'
              AND screened.item->>'status' = 'eligible_holder')
          OR NOT coalesce((
            (NEW.plan_doc->'candidateEvidenceDoc'->>'schema' =
                'carry_exit_v2_morpho_candidate_v1'
              AND NEW.candidate_provenance = 'receipt_verified_transfer'
              AND EXISTS (SELECT 1 FROM carry_morpho_v2_flow_subjects subject
                WHERE subject.vault = NEW.destination AND subject.asset = NEW.asset
                  AND subject.route_keys ? NEW.route_key)
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->>'selectedSharesRaw')::numeric > 0, false)
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->>'selectedClaimRaw')::numeric > 0, false)
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'basis' =
                'frozen_holder_claim_and_vault_total_assets_raw'
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'selectedClaimRaw' =
                NEW.plan_doc->'candidateEvidenceDoc'->>'selectedClaimRaw'
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'totalAssetsRaw' =
                NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'totalAssetsRaw'
              AND carry_exit_v2_vault_ladder_valid(
                NEW.plan_doc->'candidateEvidenceDoc')
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                  NEW.plan_doc->'candidateEvidenceDoc'->'screenedCandidates') AS screened(item)
                WHERE screened.item->>'holderCommitment' =
                  NEW.plan_doc->'candidateEvidenceDoc'->>'selectedHolderCommitment'
                  AND screened.item->>'status' = 'eligible_holder'
                  AND screened.item->>'sharesRaw' =
                    NEW.plan_doc->'candidateEvidenceDoc'->>'selectedSharesRaw'
                  AND screened.item->>'claimRaw' =
                    NEW.plan_doc->'candidateEvidenceDoc'->>'selectedClaimRaw'))
            OR (NEW.plan_doc->'candidateEvidenceDoc'->>'schema' =
                'carry_exit_v2_sync_vault_candidate_v1'
              AND NEW.candidate_provenance = 'receipt_verified_transfer'
              AND ((NEW.route_key = 'USDS → SUsds [USDS]'
                  AND NEW.destination = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
                  AND NEW.asset = '0xdc035d45d973e3ec169d2276ddab16f1e407384f')
                OR (NEW.route_key = 'USDC → USD3 [USDC]'
                  AND NEW.destination = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
                  AND NEW.asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
                OR (NEW.route_key = 'USDS → StUsds [USDS]'
                  AND NEW.destination = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'
                  AND NEW.asset = '0xdc035d45d973e3ec169d2276ddab16f1e407384f')
                OR (NEW.route_key = 'GHO → sGho [GHO]'
                  AND NEW.destination = '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
                  AND NEW.asset = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'))
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->>'selectedSharesRaw')::numeric > 0, false)
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->>'selectedClaimRaw')::numeric > 0, false)
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'totalAssetsRaw')::numeric > 0, false)
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'totalSupplyRaw')::numeric > 0, false)
              AND (NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'assetDecimals')::integer
                = NEW.asset_decimals
              AND (NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'shareDecimals')::integer
                BETWEEN 0 AND 36
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'basis' =
                'frozen_holder_claim_and_vault_total_assets_raw'
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'selectedClaimRaw' =
                NEW.plan_doc->'candidateEvidenceDoc'->>'selectedClaimRaw'
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'totalAssetsRaw' =
                NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'totalAssetsRaw'
              AND carry_exit_v2_vault_ladder_valid(
                NEW.plan_doc->'candidateEvidenceDoc')
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                  NEW.plan_doc->'candidateEvidenceDoc'->'screenedCandidates') AS screened(item)
                WHERE screened.item->>'holderCommitment' =
                  NEW.plan_doc->'candidateEvidenceDoc'->>'selectedHolderCommitment'
                  AND screened.item->>'status' = 'eligible_holder'
                  AND screened.item->>'sharesRaw' =
                    NEW.plan_doc->'candidateEvidenceDoc'->>'selectedSharesRaw'
                  AND screened.item->>'claimRaw' =
                    NEW.plan_doc->'candidateEvidenceDoc'->>'selectedClaimRaw'))
            OR (NEW.plan_doc->'candidateEvidenceDoc'->>'schema' =
                'carry_exit_v2_direct_candidate_v1'
              AND NEW.candidate_provenance IN
                ('receipt_verified_transfer', 'receipt_verified_supply')
              AND ((NEW.route_key = 'USDC → supply on Aave V3'
                  AND NEW.destination = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
                  AND NEW.asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
                  AND NEW.candidate_provenance = 'receipt_verified_transfer')
                OR (NEW.route_key = 'USDe → supply on Aave V3'
                  AND NEW.destination = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
                  AND NEW.asset = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
                  AND NEW.candidate_provenance = 'receipt_verified_transfer')
                OR (NEW.route_key = 'USDC → supply on Compound v3'
                  AND NEW.destination = '0xc3d688b66703497daa19211eedff47f25384cdc3'
                  AND NEW.asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
                  AND NEW.candidate_provenance = 'receipt_verified_supply')
                OR (NEW.route_key = 'USDT → supply on Spark'
                  AND NEW.destination = '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'
                  AND NEW.asset = '0xdac17f958d2ee523a2206206994597c13d831ec7'
                  AND NEW.candidate_provenance = 'receipt_verified_transfer'))
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->>'selectedAssetBalanceRaw')::numeric > 0, false)
              AND coalesce((NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'marketSupplyRaw')::numeric > 0, false)
              AND (NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'assetDecimals')::integer
                = NEW.asset_decimals
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'basis' =
                'frozen_holder_balance_and_market_supply_raw'
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'selectedAssetBalanceRaw' =
                NEW.plan_doc->'candidateEvidenceDoc'->>'selectedAssetBalanceRaw'
              AND NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->>'marketSupplyRaw' =
                NEW.plan_doc->'candidateEvidenceDoc'->'baselineState'->>'marketSupplyRaw'
              AND carry_exit_v2_direct_ladder_valid(
                NEW.plan_doc->'candidateEvidenceDoc')
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                  NEW.plan_doc->'candidateEvidenceDoc'->'screenedCandidates') AS screened(item)
                WHERE screened.item->>'holderCommitment' =
                  NEW.plan_doc->'candidateEvidenceDoc'->>'selectedHolderCommitment'
                  AND screened.item->>'status' = 'eligible_holder'
                  AND screened.item->>'assetBalanceRaw' =
                    NEW.plan_doc->'candidateEvidenceDoc'->>'selectedAssetBalanceRaw'))),
            false)
          OR jsonb_typeof(NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->'labels')
            IS DISTINCT FROM 'array'
          OR (SELECT jsonb_agg(label.value->>'assetsRaw' ORDER BY label.ord)
                FROM jsonb_array_elements(NEW.plan_doc->'candidateEvidenceDoc'->'ladder'->'labels')
                  WITH ORDINALITY AS label(value, ord)
                WHERE label.value->>'assetsRaw' IS NOT NULL)
            IS DISTINCT FROM
             (SELECT jsonb_agg(item.value->>'assetsRaw' ORDER BY item.ord)
                FROM jsonb_array_elements(NEW.plan_doc->'cases')
                  WITH ORDINALITY AS item(value, ord))
        THEN RAISE EXCEPTION 'exit_v2_batch_plan_invalid'; END IF;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_cases' THEN
        SELECT * INTO b FROM carry_exit_v2_batches WHERE id = NEW.batch_id;
        expected := b.plan_doc->'cases'->(NEW.case_index - 1);
        IF NOT FOUND OR n > b.issued_at + interval '1 minute' OR expected IS NULL
          OR expected->>'assetsRaw' IS DISTINCT FROM NEW.assets_raw::text
          OR expected->>'baselineStatus' IS DISTINCT FROM NEW.baseline_status
          OR expected->>'coverageKind' IS DISTINCT FROM NEW.coverage_kind
          OR nullif(expected->>'holderCoverageRaw','')::numeric IS DISTINCT FROM NEW.holder_coverage_raw
          OR nullif(expected->>'requiredCoverageRaw','')::numeric IS DISTINCT FROM NEW.required_coverage_raw
          OR nullif(expected->>'actualConsumedRaw','')::numeric IS DISTINCT FROM NEW.actual_consumed_raw
          OR expected->>'simulationStatus' IS DISTINCT FROM NEW.simulation_status
          OR nullif(expected->'callEvidenceDoc', 'null'::jsonb)
              IS DISTINCT FROM NEW.call_evidence_doc
          OR expected->>'callEvidenceSha256' IS DISTINCT FROM NEW.call_evidence_sha256
          OR expected->>'entitlementMethod' IS DISTINCT FROM NEW.entitlement_method
          OR nullif(expected->'entitlementEvidenceDoc', 'null'::jsonb)
              IS DISTINCT FROM NEW.entitlement_evidence_doc
          OR expected->>'entitlementEvidenceSha256' IS DISTINCT FROM NEW.entitlement_evidence_sha256
          OR expected->>'inconclusiveReason' IS DISTINCT FROM NEW.inconclusive_reason
          OR expected->>'unavailableReason' IS DISTINCT FROM NEW.unavailable_reason
        THEN RAISE EXCEPTION 'exit_v2_case_plan_mismatch'; END IF;
        IF NEW.call_evidence_doc IS NOT NULL AND NOT carry_exit_v2_proof_doc_valid(
          NEW.call_evidence_doc, 'call', b.route_key, b.destination, b.asset,
          b.holder, NEW.assets_raw, b.baseline_block, b.baseline_hash,
          NEW.coverage_kind, NEW.holder_coverage_raw, NEW.required_coverage_raw,
          NEW.actual_consumed_raw, NEW.simulation_status, NEW.entitlement_method,
          NEW.inconclusive_reason)
        THEN RAISE EXCEPTION 'exit_v2_baseline_call_evidence_invalid'; END IF;
        IF NEW.baseline_status = 'covered_revert' AND
          NEW.call_evidence_doc->'replayEvidenceDoc'->'decoded'->'coveredRevert'
            IS DISTINCT FROM 'true'::jsonb
        THEN RAISE EXCEPTION 'exit_v2_baseline_revert_not_covered'; END IF;
        IF NEW.entitlement_evidence_doc IS NOT NULL AND NOT carry_exit_v2_proof_doc_valid(
          NEW.entitlement_evidence_doc, 'entitlement', b.route_key, b.destination, b.asset,
          b.holder, NEW.assets_raw, b.baseline_block, b.baseline_hash,
          NEW.coverage_kind, NEW.holder_coverage_raw, NEW.required_coverage_raw,
          NEW.actual_consumed_raw, NEW.simulation_status, NEW.entitlement_method,
          NEW.inconclusive_reason)
        THEN RAISE EXCEPTION 'exit_v2_baseline_entitlement_evidence_invalid'; END IF;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_plans' THEN
        SELECT issue_batch.* INTO b FROM carry_exit_v2_batches issue_batch
          JOIN carry_exit_v2_cases issue_case ON issue_case.batch_id = issue_batch.id
          WHERE issue_case.id = NEW.case_id;
        IF NOT FOUND OR n > b.issued_at + interval '1 minute'
          OR NEW.target_at <> b.issued_at + make_interval(hours => NEW.horizon_h)
          OR NEW.deadline_at <> NEW.target_at + interval '2 hours'
        THEN RAISE EXCEPTION 'exit_v2_horizon_plan_mismatch'; END IF;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_issue_witness' THEN
        SELECT * INTO b FROM carry_exit_v2_batches WHERE id = NEW.batch_id;
        SELECT xmin::text::bigint INTO issue_xid
          FROM carry_exit_v2_batches WHERE id = NEW.batch_id;
        IF NOT FOUND OR issue_xid = (txid_current() % 4294967296)
          OR n >= b.issued_at + interval '1 hour'
          OR (SELECT count(*) FROM carry_exit_v2_cases WHERE batch_id = b.id)
              <> jsonb_array_length(b.plan_doc->'cases')
          OR (SELECT count(*) FROM carry_exit_v2_plans p
                JOIN carry_exit_v2_cases x ON x.id = p.case_id WHERE x.batch_id = b.id)
              <> 5 * jsonb_array_length(b.plan_doc->'cases')
        THEN RAISE EXCEPTION 'exit_v2_issue_not_visibly_committed_before_first_target'; END IF;
        NEW.plan_sha256 := b.plan_sha256;
        NEW.observed_at := n;
        NEW.observed_case_count := jsonb_array_length(b.plan_doc->'cases');
        NEW.observed_plan_count := 5 * NEW.observed_case_count;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_attempts' THEN
        NEW.observed_at := n;
        IF NEW.slot_at IS DISTINCT FROM date_bin('15 minutes'::interval, n,
          '2000-01-01 00:10:00+00'::timestamptz)
        THEN RAISE EXCEPTION 'exit_v2_attempt_slot_elapsed'; END IF;
        IF NEW.status = 'issued' THEN
          SELECT * INTO b FROM carry_exit_v2_batches WHERE id = NEW.batch_id;
          IF NOT FOUND OR NEW.route_key IS DISTINCT FROM b.route_key
            OR NEW.destination IS DISTINCT FROM b.destination
            OR NEW.asset IS DISTINCT FROM b.asset
            OR NEW.slot_at IS DISTINCT FROM b.slot_at
            OR n > b.issued_at + interval '15 minutes'
            OR n >= b.issued_at + interval '1 hour'
          THEN RAISE EXCEPTION 'exit_v2_attempt_batch_mismatch'; END IF;
        END IF;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_local_mirrors' THEN
        SELECT * INTO b FROM carry_exit_v2_batches WHERE id = NEW.batch_id;
        IF NOT FOUND OR NEW.route_key IS DISTINCT FROM b.route_key
          OR NEW.destination IS DISTINCT FROM b.destination
          OR NEW.asset IS DISTINCT FROM b.asset
          OR NEW.slot_at IS DISTINCT FROM b.slot_at
          OR (SELECT count(*) FROM carry_exit_v2_cases WHERE batch_id = b.id)
              <> jsonb_array_length(b.plan_doc->'cases')
          OR (SELECT count(*) FROM carry_exit_v2_plans p
                JOIN carry_exit_v2_cases x ON x.id = p.case_id WHERE x.batch_id = b.id)
              <> 5 * jsonb_array_length(b.plan_doc->'cases')
        THEN RAISE EXCEPTION 'exit_v2_local_mirror_batch_mismatch'; END IF;
        NEW.mirrored_at := n;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_missing_receipts' THEN
        NEW.recorded_at := n;
        SELECT * INTO plan FROM carry_exit_v2_plans
          WHERE case_id = NEW.case_id AND horizon_h = NEW.horizon_h;
        IF NOT FOUND OR NEW.verified_at > n
          OR NEW.evidence_doc->>'schema' IS DISTINCT FROM 'carry_exit_v2_missing_v1'
          OR NEW.evidence_doc->>'caseId' IS DISTINCT FROM NEW.case_id::text
          OR NEW.evidence_doc->>'horizonH' IS DISTINCT FROM NEW.horizon_h::text
          OR (NEW.evidence_doc->>'targetAt')::timestamptz IS DISTINCT FROM plan.target_at
          OR (NEW.evidence_doc->>'deadlineAt')::timestamptz IS DISTINCT FROM plan.deadline_at
          OR (NEW.evidence_doc->>'attemptedAt')::timestamptz IS DISTINCT FROM NEW.evidence_at
          OR NEW.evidence_doc->>'kind' IS DISTINCT FROM NEW.evidence_kind
          OR NEW.evidence_doc->>'missingReason' IS DISTINCT FROM NEW.missing_reason
          OR nullif(NEW.evidence_doc->>'provider','') IS NULL
          OR length(NEW.evidence_doc->>'provider') > 160
          OR nullif(NEW.evidence_doc->>'source','') IS NULL
          OR length(NEW.evidence_doc->>'source') > 160
          OR nullif(NEW.evidence_doc->>'rpcMethod','') IS NULL
          OR length(NEW.evidence_doc->>'rpcMethod') > 160
          OR jsonb_typeof(NEW.evidence_doc->'request') IS DISTINCT FROM 'object'
          OR jsonb_typeof(NEW.evidence_doc->'response') IS DISTINCT FROM 'object'
          OR NEW.evidence_doc->'request'->>'method'
              IS DISTINCT FROM NEW.evidence_doc->>'rpcMethod'
          OR jsonb_typeof(NEW.evidence_doc->'request'->'params') IS DISTINCT FROM 'array'
          OR NEW.evidence_doc->'response'->>'kind' NOT IN
              ('rpc_error', 'transport_error', 'collector_error')
          OR NEW.evidence_doc->'response'->>'kind' IS NULL
          OR nullif(NEW.evidence_doc->'error'->>'code','') IS NULL
          OR nullif(NEW.evidence_doc->'error'->>'message','') IS NULL
          OR length(NEW.evidence_doc->'error'->>'code') > 160
          OR length(NEW.evidence_doc->'error'->>'message') > 4096
          OR NEW.verifier_doc->>'schema' IS DISTINCT FROM 'carry_exit_v2_missing_verifier_v1'
          OR NEW.verifier_doc->>'caseId' IS DISTINCT FROM NEW.case_id::text
          OR NEW.verifier_doc->>'horizonH' IS DISTINCT FROM NEW.horizon_h::text
          OR NEW.verifier_doc->>'evidenceSha256' IS DISTINCT FROM NEW.evidence_sha256
          OR (NEW.verifier_doc->>'checkedAt')::timestamptz IS DISTINCT FROM NEW.verified_at
          OR NEW.verifier_doc->>'kind' IS DISTINCT FROM NEW.verifier_kind
          OR NEW.verifier_doc->>'finding' IS DISTINCT FROM 'unavailable'
          OR nullif(NEW.verifier_doc->>'provider','') IS NULL
          OR length(NEW.verifier_doc->>'provider') > 160
          OR nullif(NEW.verifier_doc->>'source','') IS NULL
          OR length(NEW.verifier_doc->>'source') > 160
          OR jsonb_typeof(NEW.verifier_doc->'request') IS DISTINCT FROM 'object'
          OR jsonb_typeof(NEW.verifier_doc->'response') IS DISTINCT FROM 'object'
          OR nullif(NEW.verifier_doc->'request'->>'method','') IS NULL
          OR jsonb_typeof(NEW.verifier_doc->'request'->'params') IS DISTINCT FROM 'array'
          OR NEW.verifier_doc->'response'->>'finding' IS DISTINCT FROM 'unavailable'
          OR (NEW.evidence_kind = 'capture_attempt' AND
            (NEW.evidence_at NOT BETWEEN plan.target_at AND plan.deadline_at
              OR NEW.verified_at NOT BETWEEN NEW.evidence_at AND plan.deadline_at
              OR NEW.verifier_kind <> 'rpc_replay'))
          OR (NEW.evidence_kind = 'chain_availability_audit' AND
            (NEW.evidence_at < plan.deadline_at
              OR NEW.evidence_at > n
              OR NEW.verifier_kind <> 'chain_availability_audit'))
        THEN RAISE EXCEPTION 'exit_v2_missing_receipt_invalid'; END IF;
      ELSIF TG_TABLE_NAME = 'carry_exit_v2_scores' THEN
        NEW.recorded_at := n;
        SELECT * INTO c FROM carry_exit_v2_cases WHERE id = NEW.case_id;
        SELECT * INTO b FROM carry_exit_v2_batches WHERE id = c.batch_id;
        SELECT * INTO witness FROM carry_exit_v2_issue_witness WHERE batch_id = b.id;
        IF NOT FOUND OR witness.plan_sha256 IS DISTINCT FROM b.plan_sha256
          OR witness.observed_at >= b.issued_at + interval '1 hour'
        THEN RAISE EXCEPTION 'exit_v2_score_without_timely_issue_witness'; END IF;
        SELECT * INTO attempt FROM carry_exit_v2_attempts WHERE batch_id = b.id;
        IF NOT FOUND OR attempt.status <> 'issued'
        THEN RAISE EXCEPTION 'exit_v2_score_without_issued_attempt'; END IF;
        SELECT * INTO plan FROM carry_exit_v2_plans
          WHERE case_id = NEW.case_id AND horizon_h = NEW.horizon_h;
        IF NOT FOUND OR NEW.target_at <> plan.target_at
          OR NEW.deadline_at <> plan.deadline_at
          OR NEW.predecessor_h <> plan.predecessor_h
          OR (SELECT count(*) FROM carry_exit_v2_cases WHERE batch_id = b.id)
              <> jsonb_array_length(b.plan_doc->'cases')
          OR (SELECT count(*) FROM carry_exit_v2_plans p
                JOIN carry_exit_v2_cases x ON x.id = p.case_id WHERE x.batch_id = b.id)
              <> 5 * jsonb_array_length(b.plan_doc->'cases')
        THEN RAISE EXCEPTION 'exit_v2_score_plan_invalid'; END IF;
        IF NEW.coverage_kind = 'assets'
          AND NEW.required_coverage_raw IS DISTINCT FROM c.assets_raw
        THEN RAISE EXCEPTION 'exit_v2_asset_coverage_not_frozen_q'; END IF;
        IF NEW.coverage_kind = 'assets' AND NEW.status = 'success'
          AND NEW.holder_coverage_raw < c.assets_raw
        THEN RAISE EXCEPTION 'exit_v2_direct_success_without_supplier_balance'; END IF;
        IF NEW.status = 'covered_revert'
          AND NEW.coverage_kind = 'morpho_shares_claim'
          AND NEW.required_coverage_raw < c.assets_raw
        THEN RAISE EXCEPTION 'exit_v2_morpho_claim_below_q'; END IF;
        IF NEW.call_evidence_doc IS NOT NULL AND NOT carry_exit_v2_proof_doc_valid(
          NEW.call_evidence_doc, 'call', b.route_key, b.destination, b.asset,
          b.holder, c.assets_raw, NEW.target_block, NEW.target_hash,
          NEW.coverage_kind, NEW.holder_coverage_raw, NEW.required_coverage_raw,
          NEW.actual_consumed_raw, NEW.simulation_status, NEW.entitlement_method,
          NEW.inconclusive_reason)
        THEN RAISE EXCEPTION 'exit_v2_score_call_evidence_invalid'; END IF;
        IF NEW.status = 'covered_revert' AND
          NEW.call_evidence_doc->'replayEvidenceDoc'->'decoded'->'coveredRevert'
            IS DISTINCT FROM 'true'::jsonb
        THEN RAISE EXCEPTION 'exit_v2_score_revert_not_covered'; END IF;
        IF NEW.entitlement_evidence_doc IS NOT NULL AND NOT carry_exit_v2_proof_doc_valid(
          NEW.entitlement_evidence_doc, 'entitlement', b.route_key, b.destination, b.asset,
          b.holder, c.assets_raw, NEW.target_block, NEW.target_hash,
          NEW.coverage_kind, NEW.holder_coverage_raw, NEW.required_coverage_raw,
          NEW.actual_consumed_raw, NEW.simulation_status, NEW.entitlement_method,
          NEW.inconclusive_reason)
        THEN RAISE EXCEPTION 'exit_v2_score_entitlement_evidence_invalid'; END IF;
        IF NEW.horizon_h = 1 THEN
          IF NEW.predecessor_score_id IS NOT NULL OR
            NEW.predecessor_status IS DISTINCT FROM c.baseline_status OR
            NEW.predecessor_block IS DISTINCT FROM b.baseline_block OR
            NEW.predecessor_hash IS DISTINCT FROM b.baseline_hash OR
            NEW.predecessor_block_at IS DISTINCT FROM b.baseline_block_at
          THEN RAISE EXCEPTION 'exit_v2_predecessor_invalid'; END IF;
        ELSE
          SELECT * INTO prior FROM carry_exit_v2_scores
            WHERE case_id = NEW.case_id AND horizon_h = NEW.predecessor_h;
          IF NOT FOUND OR NEW.predecessor_score_id IS DISTINCT FROM prior.id
            OR NEW.predecessor_status IS DISTINCT FROM prior.status
            OR NEW.predecessor_block IS DISTINCT FROM prior.target_block
            OR NEW.predecessor_hash IS DISTINCT FROM prior.target_hash
            OR NEW.predecessor_block_at IS DISTINCT FROM prior.target_block_at
          THEN RAISE EXCEPTION 'exit_v2_predecessor_invalid'; END IF;
        END IF;
        -- Once the frozen holder loses the position, the original restriction
        -- episode is censored. A restored position requires a new issue batch.
        SELECT EXISTS (
          SELECT 1 FROM carry_exit_v2_scores s
          WHERE s.case_id = NEW.case_id AND s.horizon_h < NEW.horizon_h
            AND s.status = 'holder_attrition'
        ) INTO prior_holder_attrition;
        IF prior_holder_attrition THEN
          IF NEW.status <> 'episode_censored'
          THEN RAISE EXCEPTION 'exit_v2_attrition_episode_censored'; END IF;
        ELSIF c.baseline_status IN ('ineligible', 'inconclusive', 'unavailable') THEN
          IF NEW.status <> 'not_eligible' THEN RAISE EXCEPTION 'exit_v2_ineligible_case'; END IF;
        ELSIF NEW.status IN ('not_eligible', 'episode_censored') THEN
          RAISE EXCEPTION 'exit_v2_required_horizon_skipped';
        END IF;
        IF NEW.status = 'missing' THEN
          SELECT * INTO missing_receipt FROM carry_exit_v2_missing_receipts
            WHERE id = NEW.missing_receipt_id;
          IF NOT FOUND OR missing_receipt.case_id <> NEW.case_id
            OR missing_receipt.horizon_h <> NEW.horizon_h
            OR missing_receipt.missing_reason <> NEW.missing_reason
            OR missing_receipt.verified_at > n
            OR missing_receipt.recorded_at > n
          THEN RAISE EXCEPTION 'exit_v2_missing_evidence_invalid'; END IF;
        END IF;
        IF NEW.status = 'holder_attrition' THEN
          IF NOT ((NEW.coverage_kind IN ('shares', 'morpho_shares_claim')
              AND NEW.holder_coverage_raw = 0
              AND NEW.entitlement_method = 'zero_shares')
            OR (NEW.coverage_kind = 'assets'
              AND NEW.holder_coverage_raw < c.assets_raw
              AND NEW.entitlement_method = 'exact_asset_balance'))
          THEN RAISE EXCEPTION 'exit_v2_attrition_not_proven'; END IF;
        END IF;
        IF NEW.status IN ('success', 'covered_revert', 'holder_attrition', 'inconclusive') THEN
          IF n NOT BETWEEN plan.target_at AND plan.deadline_at
            OR NEW.canonicality_evidence_doc->>'schema'
                IS DISTINCT FROM 'carry_exit_v2_headers_v1'
            OR NEW.canonicality_evidence_doc->>'chainId' IS DISTINCT FROM '1'
            OR NEW.canonicality_evidence_doc->>'finalityTag' IS DISTINCT FROM 'finalized'
            OR nullif(NEW.canonicality_evidence_doc->>'provider','') IS NULL
            OR length(NEW.canonicality_evidence_doc->>'provider') > 160
            OR nullif(NEW.canonicality_evidence_doc->>'source','') IS NULL
            OR length(NEW.canonicality_evidence_doc->>'source') > 160
            OR jsonb_typeof(NEW.canonicality_evidence_doc->'targetHeader')
                IS DISTINCT FROM 'object'
            OR jsonb_typeof(NEW.canonicality_evidence_doc->'parentHeader')
                IS DISTINCT FROM 'object'
            OR jsonb_typeof(NEW.canonicality_evidence_doc->'finalizedHead')
                IS DISTINCT FROM 'object'
            OR (NEW.canonicality_evidence_doc->>'targetAt')::timestamptz
                IS DISTINCT FROM plan.target_at
            OR (NEW.canonicality_evidence_doc->>'observedAt')::timestamptz
                IS DISTINCT FROM NEW.target_observed_at
            OR NEW.canonicality_evidence_doc->'targetHeader'->>'number'
                IS DISTINCT FROM NEW.target_block::text
            OR NEW.canonicality_evidence_doc->'targetHeader'->>'hash'
                IS DISTINCT FROM NEW.target_hash
            OR NEW.canonicality_evidence_doc->'targetHeader'->>'parentHash'
                IS DISTINCT FROM NEW.target_parent_hash
            OR (NEW.canonicality_evidence_doc->'targetHeader'->>'timestamp')::timestamptz
                IS DISTINCT FROM NEW.target_block_at
            OR NEW.canonicality_evidence_doc->'parentHeader'->>'number'
                IS DISTINCT FROM NEW.target_parent_block::text
            OR NEW.canonicality_evidence_doc->'parentHeader'->>'hash'
                IS DISTINCT FROM NEW.target_parent_hash
            OR (NEW.canonicality_evidence_doc->'parentHeader'->>'timestamp')::timestamptz
                IS DISTINCT FROM NEW.target_parent_block_at
            OR nullif(NEW.canonicality_evidence_doc->'finalizedHead'->>'number','') IS NULL
            OR (NEW.canonicality_evidence_doc->'finalizedHead'->>'number')::bigint
                < NEW.target_block
            OR coalesce(NEW.canonicality_evidence_doc->'finalizedHead'->>'hash','')
                !~ '^0x[0-9a-f]{64}$'
            OR nullif(NEW.canonicality_evidence_doc->'finalizedHead'->>'timestamp','') IS NULL
            OR (NEW.canonicality_evidence_doc->'finalizedHead'->>'timestamp')::timestamptz
                < NEW.target_block_at
            OR (NEW.canonicality_evidence_doc->'finalizedHead'->>'timestamp')::timestamptz
                > NEW.target_observed_at + interval '2 minutes'
            OR NEW.target_block <= b.baseline_block
            OR (prior.target_block IS NOT NULL AND NEW.target_block <= prior.target_block)
            OR NEW.target_parent_block <> NEW.target_block - 1
            OR NEW.target_parent_hash IS DISTINCT FROM NEW.parent_header_hash
            OR NEW.target_parent_block_at >= plan.target_at
            OR NEW.target_block_at < plan.target_at
            OR (NEW.predecessor_block_at IS NOT NULL
                AND NEW.predecessor_block_at >= plan.target_at)
            OR NEW.target_block_at > NEW.target_observed_at
            OR NEW.target_observed_at > NEW.captured_at
            OR NEW.captured_at > plan.deadline_at
            OR NEW.captured_at > NEW.recorded_at
            OR NEW.recorded_at > plan.deadline_at
            OR NEW.captured_at > n + interval '1 minute'
            OR NEW.coverage_kind <> c.coverage_kind
          THEN RAISE EXCEPTION 'exit_v2_target_source_invalid'; END IF;
        ELSIF n <= plan.deadline_at THEN
          RAISE EXCEPTION 'exit_v2_terminal_before_close';
        END IF;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'exit_v2_append_only'; END $$`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_issue(p jsonb) RETURNS bigint
    LANGUAGE plpgsql AS $$
    DECLARE doc jsonb := p->'plan'; supplied text := p->>'planSha256';
      digest text; b_id bigint; b_issued_at timestamptz;
      c_id bigint; item jsonb; ord bigint; h integer;
      previous integer;
    BEGIN
      IF doc IS NULL OR jsonb_typeof(doc) <> 'object'
        THEN RAISE EXCEPTION 'exit_v2_plan_required'; END IF;
      digest := encode(sha256(convert_to(doc::text, 'UTF8')), 'hex');
      IF supplied IS DISTINCT FROM digest THEN RAISE EXCEPTION 'exit_v2_plan_hash_mismatch'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(digest, 0));
      SELECT id INTO b_id FROM carry_exit_v2_batches WHERE plan_sha256 = digest;
      IF FOUND THEN
        IF (SELECT count(*) FROM carry_exit_v2_cases WHERE batch_id = b_id)
            <> jsonb_array_length(doc->'cases')
          OR (SELECT count(*) FROM carry_exit_v2_plans p
                JOIN carry_exit_v2_cases c ON c.id = p.case_id WHERE c.batch_id = b_id)
            <> 5 * jsonb_array_length(doc->'cases')
        THEN RAISE EXCEPTION 'exit_v2_incomplete_issue_replay'; END IF;
        RETURN b_id;
      END IF;
      INSERT INTO carry_exit_v2_batches
        (plan_doc, plan_sha256, route_key, slot_at, destination, asset, asset_decimals,
         holder, baseline_block, baseline_hash, baseline_block_at,
         baseline_observed_at, candidate_provenance, candidate_evidence_sha256)
      VALUES (doc, digest, doc->>'routeKey', (doc->>'slotAt')::timestamptz,
        doc->>'destination', doc->>'asset',
        (doc->>'assetDecimals')::smallint, doc->>'holder',
        (doc->>'baselineBlock')::bigint, doc->>'baselineHash',
        (doc->>'baselineBlockAt')::timestamptz,
        (doc->>'baselineObservedAt')::timestamptz,
        doc->>'candidateProvenance', doc->>'candidateEvidenceSha256')
        ON CONFLICT (plan_sha256) DO NOTHING
        RETURNING id, issued_at INTO b_id, b_issued_at;
      IF b_id IS NULL THEN
        SELECT id INTO b_id FROM carry_exit_v2_batches WHERE plan_sha256 = digest;
        IF NOT FOUND THEN RAISE EXCEPTION 'exit_v2_concurrent_issue_retry'; END IF;
        IF (SELECT count(*) FROM carry_exit_v2_cases WHERE batch_id = b_id)
            <> jsonb_array_length(doc->'cases')
          OR (SELECT count(*) FROM carry_exit_v2_plans p
                JOIN carry_exit_v2_cases c ON c.id = p.case_id WHERE c.batch_id = b_id)
            <> 5 * jsonb_array_length(doc->'cases')
        THEN RAISE EXCEPTION 'exit_v2_incomplete_issue_replay'; END IF;
        RETURN b_id;
      END IF;
      FOR item, ord IN SELECT value, ordinality FROM
        jsonb_array_elements(doc->'cases') WITH ORDINALITY LOOP
        INSERT INTO carry_exit_v2_cases
          (batch_id, case_index, assets_raw, baseline_status, coverage_kind,
           holder_coverage_raw, required_coverage_raw, actual_consumed_raw, simulation_status,
           call_evidence_doc, call_evidence_sha256, entitlement_method,
           entitlement_evidence_doc, entitlement_evidence_sha256,
           inconclusive_reason, unavailable_reason)
        VALUES (b_id, ord, (item->>'assetsRaw')::numeric,
          item->>'baselineStatus', item->>'coverageKind',
          nullif(item->>'holderCoverageRaw','')::numeric,
          nullif(item->>'requiredCoverageRaw','')::numeric,
          nullif(item->>'actualConsumedRaw','')::numeric,
          item->>'simulationStatus', nullif(item->'callEvidenceDoc', 'null'::jsonb),
          item->>'callEvidenceSha256',
          item->>'entitlementMethod', nullif(item->'entitlementEvidenceDoc', 'null'::jsonb),
          item->>'entitlementEvidenceSha256',
          item->>'inconclusiveReason',
          item->>'unavailableReason') RETURNING id INTO c_id;
        FOREACH h IN ARRAY ARRAY[1,4,24,48,168] LOOP
          previous := CASE h WHEN 1 THEN 0 WHEN 4 THEN 1 WHEN 24 THEN 4
            WHEN 48 THEN 24 ELSE 48 END;
          INSERT INTO carry_exit_v2_plans
            (case_id,horizon_h,target_at,deadline_at,predecessor_h,conditional_recovery)
          VALUES (c_id,h,
            b_issued_at + make_interval(hours => h),
            b_issued_at + make_interval(hours => h + 2),
            previous,false);
        END LOOP;
      END LOOP;
      RETURN b_id;
    END $$`,
  // The observer calls this through its own autocommit connection after the
  // issue call returns; it cannot witness an uncommitted or partial batch.
  `CREATE OR REPLACE FUNCTION carry_exit_v2_witness_committed_issue(p_batch_id bigint)
    RETURNS timestamptz LANGUAGE plpgsql AS $$
    DECLARE witnessed_at timestamptz;
    BEGIN
      INSERT INTO carry_exit_v2_issue_witness
        (batch_id, plan_sha256, observed_case_count, observed_plan_count)
      VALUES (p_batch_id, repeat('0', 64), 1, 5)
      ON CONFLICT (batch_id) DO NOTHING
      RETURNING observed_at INTO witnessed_at;
      IF witnessed_at IS NULL THEN
        SELECT observed_at INTO witnessed_at FROM carry_exit_v2_issue_witness
          WHERE batch_id = p_batch_id;
      END IF;
      IF witnessed_at IS NULL THEN RAISE EXCEPTION 'exit_v2_issue_witness_unavailable'; END IF;
      RETURN witnessed_at;
    END $$`,
  `CREATE OR REPLACE FUNCTION carry_exit_v2_record_attempt(
      p_route_key text, p_destination text, p_asset text, p_status text,
      p_reason text, p_slot_at timestamptz, p_batch_id bigint DEFAULT NULL) RETURNS bigint
    LANGUAGE plpgsql AS $$
    DECLARE recorded_id bigint; existing carry_exit_v2_attempts%ROWTYPE;
      slot timestamptz := p_slot_at;
    BEGIN
      INSERT INTO carry_exit_v2_attempts
        (route_key, destination, asset, slot_at, status, reason, batch_id)
      VALUES (p_route_key, p_destination, p_asset, slot,
        p_status, p_reason, p_batch_id)
      ON CONFLICT (route_key, slot_at) DO NOTHING
      RETURNING id INTO recorded_id;
      IF recorded_id IS NOT NULL THEN RETURN recorded_id; END IF;
      SELECT * INTO existing FROM carry_exit_v2_attempts
        WHERE route_key = p_route_key AND slot_at = slot;
      IF NOT FOUND OR existing.destination IS DISTINCT FROM p_destination
        OR existing.asset IS DISTINCT FROM p_asset
        OR existing.status IS DISTINCT FROM p_status
        OR existing.reason IS DISTINCT FROM p_reason
        OR existing.batch_id IS DISTINCT FROM p_batch_id
      THEN RAISE EXCEPTION 'exit_v2_attempt_slot_conflict'; END IF;
      RETURN existing.id;
    END $$`,
  // This function deliberately has no current-slot timing gate. It records a
  // fact that becomes true only after the caller fsyncs the local exact-Q
  // mirror, including recovery of older batches after a restart.
  `CREATE OR REPLACE FUNCTION carry_exit_v2_record_local_mirror(
      p_batch_id bigint, p_route_key text, p_destination text, p_asset text,
      p_slot_at timestamptz) RETURNS timestamptz
    LANGUAGE plpgsql AS $$
    DECLARE b carry_exit_v2_batches%ROWTYPE;
      existing carry_exit_v2_local_mirrors%ROWTYPE; recorded_at timestamptz;
    BEGIN
      SELECT * INTO b FROM carry_exit_v2_batches WHERE id = p_batch_id;
      IF NOT FOUND OR b.route_key IS DISTINCT FROM p_route_key
        OR b.destination IS DISTINCT FROM p_destination
        OR b.asset IS DISTINCT FROM p_asset
        OR b.slot_at IS DISTINCT FROM p_slot_at
        OR (SELECT count(*) FROM carry_exit_v2_cases WHERE batch_id = b.id)
            <> jsonb_array_length(b.plan_doc->'cases')
        OR (SELECT count(*) FROM carry_exit_v2_plans p
              JOIN carry_exit_v2_cases c ON c.id = p.case_id WHERE c.batch_id = b.id)
            <> 5 * jsonb_array_length(b.plan_doc->'cases')
      THEN RAISE EXCEPTION 'exit_v2_local_mirror_batch_mismatch'; END IF;
      INSERT INTO carry_exit_v2_local_mirrors
        (batch_id, route_key, destination, asset, slot_at)
      VALUES (p_batch_id, p_route_key, p_destination, p_asset, p_slot_at)
      ON CONFLICT (batch_id) DO NOTHING
      RETURNING mirrored_at INTO recorded_at;
      IF recorded_at IS NOT NULL THEN RETURN recorded_at; END IF;
      SELECT * INTO existing FROM carry_exit_v2_local_mirrors
        WHERE batch_id = p_batch_id;
      IF NOT FOUND OR existing.route_key IS DISTINCT FROM p_route_key
        OR existing.destination IS DISTINCT FROM p_destination
        OR existing.asset IS DISTINCT FROM p_asset
        OR existing.slot_at IS DISTINCT FROM p_slot_at
      THEN RAISE EXCEPTION 'exit_v2_local_mirror_checkpoint_conflict'; END IF;
      RETURN existing.mirrored_at;
    END $$`,
  // Consumers must use these exact DB-derived microsecond strings/epochs. JS
  // Date serialisation truncates PostgreSQL timestamptz microseconds.
  `CREATE OR REPLACE VIEW carry_exit_v2_due AS
    SELECT b.id AS batch_id, c.id AS case_id, p.horizon_h,
      to_char(b.issued_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS issued_at_exact,
      to_char(p.target_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS target_at_exact,
      to_char(p.deadline_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_at_exact,
      (extract(epoch FROM p.target_at) * 1000000)::bigint::text AS target_epoch_us,
      (extract(epoch FROM p.deadline_at) * 1000000)::bigint::text AS deadline_epoch_us
    FROM carry_exit_v2_plans p
      JOIN carry_exit_v2_cases c ON c.id = p.case_id
      JOIN carry_exit_v2_batches b ON b.id = c.batch_id
      JOIN carry_exit_v2_issue_witness w ON w.batch_id = b.id
      JOIN carry_exit_v2_attempts a ON a.batch_id = b.id AND a.status = 'issued'
      LEFT JOIN carry_exit_v2_scores s
        ON s.case_id = p.case_id AND s.horizon_h = p.horizon_h
    WHERE s.case_id IS NULL`,
  // A rate query must start from this preregistered grid, not just observed
  // outcomes. The caller still needs an independently verified RPC audit.
  `CREATE OR REPLACE VIEW carry_exit_v2_coverage AS
    SELECT b.id AS batch_id, c.id AS case_id, p.horizon_h,
      b.route_key, b.destination, b.asset, b.holder, c.assets_raw,
      c.baseline_status, p.conditional_recovery, p.target_at,
      p.deadline_at, w.observed_at AS issue_visible_at,
      (w.batch_id IS NOT NULL AND a.id IS NOT NULL AND w.plan_sha256 = b.plan_sha256
        AND w.observed_at < b.issued_at + interval '1 hour') AS prospectively_admitted,
      coalesce(s.status, 'pending') AS status,
      (c.baseline_status IN ('success', 'covered_revert')
        AND w.batch_id IS NOT NULL AND a.id IS NOT NULL
        AND w.plan_sha256 = b.plan_sha256
        AND w.observed_at < b.issued_at + interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM carry_exit_v2_scores earlier
          WHERE earlier.case_id = c.id AND earlier.horizon_h < p.horizon_h
            AND earlier.status = 'holder_attrition')) AS measurement_eligible,
      (w.batch_id IS NOT NULL AND a.id IS NOT NULL AND w.plan_sha256 = b.plan_sha256
        AND w.observed_at < b.issued_at + interval '1 hour'
        AND coalesce(s.status = 'success', false) AND coalesce(
        (SELECT earlier.status FROM carry_exit_v2_scores earlier
          WHERE earlier.case_id = c.id AND earlier.horizon_h < p.horizon_h
            AND earlier.status IN ('success', 'covered_revert')
          ORDER BY earlier.horizon_h DESC LIMIT 1),
        c.baseline_status) = 'covered_revert') AS recovered_after_restriction,
      s.missing_reason, s.missing_receipt_id, s.recorded_at
    FROM carry_exit_v2_plans p
      JOIN carry_exit_v2_cases c ON c.id = p.case_id
      JOIN carry_exit_v2_batches b ON b.id = c.batch_id
      LEFT JOIN carry_exit_v2_issue_witness w ON w.batch_id = b.id
      LEFT JOIN carry_exit_v2_attempts a ON a.batch_id = b.id AND a.status = 'issued'
      LEFT JOIN carry_exit_v2_scores s
        ON s.case_id = p.case_id AND s.horizon_h = p.horizon_h`,
  `CREATE OR REPLACE VIEW carry_exit_v2_attempt_coverage AS
    SELECT a.route_key, a.destination, a.asset, a.slot_at, a.observed_at,
      a.status, a.reason, a.batch_id,
      (a.status = 'issued' AND w.batch_id IS NOT NULL
        AND w.plan_sha256 = b.plan_sha256
        AND w.observed_at < b.issued_at + interval '1 hour') AS prospectively_admitted
    FROM carry_exit_v2_attempts a
      LEFT JOIN carry_exit_v2_batches b ON b.id = a.batch_id
      LEFT JOIN carry_exit_v2_issue_witness w ON w.batch_id = b.id`,
]

export async function apply(sql) {
  for (const statement of DDL) await sql.query(statement)
  for (const table of [
    'carry_exit_v2_batches',
    'carry_exit_v2_cases',
    'carry_exit_v2_plans',
    'carry_exit_v2_issue_witness',
    'carry_exit_v2_attempts',
    'carry_exit_v2_local_mirrors',
    'carry_exit_v2_missing_receipts',
    'carry_exit_v2_scores',
  ]) {
    await sql.query(`DO $$ BEGIN IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass
      AND tgname = '${table}_insert_guard'
    ) THEN CREATE TRIGGER ${table}_insert_guard BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION carry_exit_v2_guard_insert(); END IF; END $$`)
    await sql.query(`DO $$ BEGIN IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass
      AND tgname = '${table}_immutable'
    ) THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION carry_exit_v2_reject_mutation(); END IF; END $$`)
    await sql.query(`DO $$ BEGIN IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass
      AND tgname = '${table}_truncate'
    ) THEN CREATE TRIGGER ${table}_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION carry_exit_v2_reject_mutation(); END IF; END $$`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  apply(neon(url))
    .then(() => process.stdout.write('carry_exit_v2_ready\n'))
    .catch(() => {
      process.stderr.write('carry_exit_v2_ddl_failed\n')
      process.exitCode = 1
    })
}
