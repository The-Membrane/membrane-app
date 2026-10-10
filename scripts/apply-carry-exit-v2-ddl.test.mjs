import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, assessExitV2TargetEvidence, DDL } from './apply-carry-exit-v2-ddl.mjs'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './lib/carry-exit-v2-rpc-proof.mjs'

function statement(fragment) {
  const found = DDL.find((entry) => entry.includes(fragment))
  assert.ok(found, `missing DDL: ${fragment}`)
  return found
}

test('a content-addressed batch freezes exact identity and DB issue time', () => {
  const batches = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_batches')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const directLadder = statement('FUNCTION carry_exit_v2_direct_ladder_valid')
  const vaultLadder = statement('FUNCTION carry_exit_v2_vault_ladder_valid')
  assert.match(batches, /plan_doc jsonb NOT NULL/)
  assert.match(batches, /octet_length\(convert_to\(plan_doc::text, 'UTF8'\)\) <= 524288/)
  assert.match(batches, /plan_sha256 text NOT NULL UNIQUE/)
  assert.match(batches, /sha256\(convert_to\(plan_doc::text, 'UTF8'\)\)/)
  for (const field of [
    'route_key',
    'destination',
    'asset',
    'asset_decimals',
    'holder',
    'baseline_block',
    'baseline_hash',
    'baseline_block_at',
    'baseline_observed_at',
    'candidate_provenance',
    'candidate_evidence_sha256',
    'issued_at',
  ])
    assert.match(batches, new RegExp(`${field} [^\n]*NOT NULL`))
  assert.match(guard, /NEW\.baseline_block_at NOT BETWEEN n - interval '30 minutes' AND n/)
  assert.match(guard, /NEW\.issued_at := n/)
  assert.match(guard, /NEW\.plan_doc->'horizons' IS DISTINCT FROM '\[1,4,24,48,168\]'::jsonb/)
  assert.match(guard, /NEW\.plan_doc->>'routeKey' IS DISTINCT FROM NEW\.route_key/)
  assert.match(batches, /UNIQUE \(route_key, slot_at\)/)
  assert.match(guard, /NEW\.slot_at IS DISTINCT FROM date_bin\('15 minutes'::interval, n/)
  assert.match(guard, /NEW\.plan_doc->>'baselineHash' IS DISTINCT FROM NEW\.baseline_hash/)
  assert.match(guard, /NEW\.plan_doc->>'clock' IS DISTINCT FROM 'db_issued_at'/)
  assert.match(
    guard,
    /NEW\.plan_doc->>'endpointSelection' IS DISTINCT FROM 'first_finalized_at_or_after_target'/,
  )
  assert.match(
    guard,
    /NEW\.plan_doc->>'candidateEvidenceSha256' IS DISTINCT FROM NEW\.candidate_evidence_sha256/,
  )
  assert.match(guard, /\(NEW\.plan_doc->'candidateEvidenceDoc'\)::text, 'UTF8'/)
  assert.match(guard, /selectedHolderCommitment'/)
  assert.match(guard, /carry_exit_v2_morpho_candidate_v1/)
  assert.match(guard, /screened\.item->>'sharesRaw'/)
  assert.match(guard, /screened\.item->>'claimRaw'/)
  assert.match(guard, /frozen_holder_claim_and_vault_total_assets_raw/)
  assert.match(guard, /carry_exit_v2_vault_ladder_valid\(/)
  assert.match(vaultLadder, /greatest\(1, div\(claim, 2\)\)/)
  assert.match(vaultLadder, /div\(total, divisors\[i\]\)/)
  assert.match(directLadder, /div\(supplied, divisors\[i\]\)/)
  assert.match(vaultLadder, /vault_0p001pct/)
  assert.match(guard, /carry_exit_v2_direct_candidate_v1/)
  assert.match(guard, /carry_exit_v2_sync_vault_candidate_v1/)
  assert.match(guard, /NEW\.route_key = 'GHO → sGho \[GHO\]'/)
  assert.match(guard, /selectedAssetBalanceRaw/)
  assert.match(guard, /screened\.item->>'assetBalanceRaw'/)
  assert.match(guard, /OR NOT coalesce\(\(/)
  for (const route of CARRY_EXIT_V2_FROZEN_ROUTES.filter((entry) =>
    ['aave', 'spark', 'comet'].includes(entry.kind),
  )) {
    assert.ok(guard.includes(`NEW.route_key = '${route.routeKey}'`))
    assert.ok(guard.includes(`NEW.destination = '${route.destination}'`))
    assert.ok(guard.includes(`NEW.asset = '${route.asset}'`))
  }
})

test('the issue function stores JSON null evidence as SQL NULL', () => {
  const issue = statement('FUNCTION carry_exit_v2_issue')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const proof = statement('FUNCTION carry_exit_v2_proof_doc_valid')
  assert.match(issue, /nullif\(item->'callEvidenceDoc', 'null'::jsonb\)/)
  assert.match(issue, /nullif\(item->'entitlementEvidenceDoc', 'null'::jsonb\)/)
  assert.match(guard, /nullif\(expected->'callEvidenceDoc', 'null'::jsonb\)/)
  assert.match(guard, /nullif\(expected->'entitlementEvidenceDoc', 'null'::jsonb\)/)
  assert.match(proof, /nullif\(p_doc->'withdrawRpc', 'null'::jsonb\) IS NULL/)
})

test('a separate committed observer witnesses the complete issue before H1 admission', () => {
  const witness = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_issue_witness')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const observe = statement('FUNCTION carry_exit_v2_witness_committed_issue')
  const due = statement('CREATE OR REPLACE VIEW carry_exit_v2_due')
  const coverage = statement('CREATE OR REPLACE VIEW carry_exit_v2_coverage')
  assert.match(witness, /batch_id bigint PRIMARY KEY REFERENCES carry_exit_v2_batches\(id\)/)
  assert.match(witness, /observed_at timestamptz NOT NULL/)
  assert.match(witness, /observed_plan_count = 5 \* observed_case_count/)
  assert.match(guard, /ELSIF TG_TABLE_NAME = 'carry_exit_v2_issue_witness'/)
  assert.match(guard, /SELECT xmin::text::bigint INTO issue_xid/)
  assert.match(guard, /issue_xid = \(txid_current\(\) % 4294967296\)/)
  assert.match(guard, /n >= b\.issued_at \+ interval '1 hour'/)
  assert.match(guard, /SELECT count\(\*\) FROM carry_exit_v2_cases WHERE batch_id = b\.id/)
  assert.match(guard, /5 \* jsonb_array_length\(b\.plan_doc->'cases'\)/)
  assert.match(guard, /NEW\.observed_at := n/)
  assert.match(observe, /INSERT INTO carry_exit_v2_issue_witness/)
  assert.match(due, /JOIN carry_exit_v2_issue_witness w ON w\.batch_id = b\.id/)
  assert.match(coverage, /prospectively_admitted/)
  assert.match(coverage, /LEFT JOIN carry_exit_v2_issue_witness w/)
  assert.match(coverage, /AND w\.observed_at < b\.issued_at \+ interval '1 hour'/)
  assert.match(guard, /exit_v2_score_without_timely_issue_witness/)
})

test('held issue, same-transaction witness and late witness cannot enter prospective scores', () => {
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const observe = statement('FUNCTION carry_exit_v2_witness_committed_issue')
  const scoring = guard.slice(guard.indexOf("ELSIF TG_TABLE_NAME = 'carry_exit_v2_scores'"))
  const witnessing = guard.slice(
    guard.indexOf("ELSIF TG_TABLE_NAME = 'carry_exit_v2_issue_witness'"),
    guard.indexOf("ELSIF TG_TABLE_NAME = 'carry_exit_v2_missing_receipts'"),
  )
  // A held issuer transaction is invisible to another connection. A witness
  // attempted in that same transaction must fail even though it sees its own rows.
  assert.match(witnessing, /IF NOT FOUND OR issue_xid = \(txid_current\(\) % 4294967296\)/)
  // No caller supplied timestamp can make an after-H1 observation timely.
  assert.match(witnessing, /n >= b\.issued_at \+ interval '1 hour'/)
  assert.match(witnessing, /NEW\.observed_at := n/)
  // The scorer also refuses unwitnessed rows; the observer API does not issue.
  assert.match(scoring, /SELECT \* INTO witness FROM carry_exit_v2_issue_witness/)
  assert.match(scoring, /witness\.observed_at >= b\.issued_at \+ interval '1 hour'/)
  assert.doesNotMatch(observe, /INSERT INTO carry_exit_v2_batches/)
})

test('route attempt ledger retains unavailable sampling outcomes without holder or Q', () => {
  const attempts = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_attempts')
  const record = statement('FUNCTION carry_exit_v2_record_attempt')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const coverage = statement('CREATE OR REPLACE VIEW carry_exit_v2_attempt_coverage')
  const scores = statement('CREATE OR REPLACE VIEW carry_exit_v2_coverage')
  assert.match(attempts, /UNIQUE \(route_key, slot_at\)/)
  assert.match(attempts, /status IN \('issued', 'unavailable'\)/)
  assert.match(attempts, /'no_eligible_holder', 'zero_or_duplicate_q'/)
  assert.match(attempts, /status = 'unavailable' AND reason IS NOT NULL AND batch_id IS NULL/)
  assert.doesNotMatch(attempts, /^\s*(holder|assets_raw)\s/m)
  assert.match(guard, /NEW\.observed_at := n/)
  assert.match(guard, /NEW\.slot_at IS DISTINCT FROM date_bin\('15 minutes'::interval, n/)
  assert.match(guard, /NEW\.slot_at IS DISTINCT FROM b\.slot_at/)
  assert.match(guard, /NEW\.route_key IS DISTINCT FROM b\.route_key/)
  assert.match(guard, /n > b\.issued_at \+ interval '15 minutes'/)
  assert.match(guard, /n >= b\.issued_at \+ interval '1 hour'/)
  assert.match(guard, /exit_v2_score_without_issued_attempt/)
  assert.match(record, /ON CONFLICT \(route_key, slot_at\) DO NOTHING/)
  assert.match(record, /exit_v2_attempt_slot_conflict/)
  assert.match(coverage, /FROM carry_exit_v2_attempts a/)
  assert.match(coverage, /a\.reason, a\.batch_id/)
  assert.match(scores, /a\.id IS NOT NULL/)
})

test('local mirror checkpoints are batch keyed, identity guarded, old-slot safe, and idempotent', () => {
  const mirrors = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_local_mirrors')
  const record = statement('FUNCTION carry_exit_v2_record_local_mirror')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const mirrorGuard = guard.slice(
    guard.indexOf("ELSIF TG_TABLE_NAME = 'carry_exit_v2_local_mirrors'"),
    guard.indexOf("ELSIF TG_TABLE_NAME = 'carry_exit_v2_missing_receipts'"),
  )
  assert.match(mirrors, /batch_id bigint PRIMARY KEY REFERENCES carry_exit_v2_batches\(id\)/)
  assert.match(mirrors, /UNIQUE \(route_key, slot_at\)/)
  assert.match(mirrors, /mirrored_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/)
  assert.match(record, /SELECT \* INTO b FROM carry_exit_v2_batches WHERE id = p_batch_id/)
  for (const field of ['route_key', 'destination', 'asset', 'slot_at']) {
    assert.match(record, new RegExp(`b\\.${field} IS DISTINCT FROM p_${field}`))
    assert.match(mirrorGuard, new RegExp(`NEW\\.${field} IS DISTINCT FROM b\\.${field}`))
  }
  assert.match(record, /SELECT count\(\*\) FROM carry_exit_v2_cases WHERE batch_id = b\.id/)
  assert.match(record, /5 \* jsonb_array_length\(b\.plan_doc->'cases'\)/)
  assert.match(record, /exit_v2_local_mirror_batch_mismatch/)
  assert.match(record, /INSERT INTO carry_exit_v2_local_mirrors/)
  assert.match(record, /ON CONFLICT \(batch_id\) DO NOTHING/)
  assert.match(record, /exit_v2_local_mirror_checkpoint_conflict/)
  assert.doesNotMatch(record, /date_bin|issued_at \+ interval '15 minutes'/)
  assert.doesNotMatch(mirrorGuard, /date_bin|issued_at \+ interval '15 minutes'/)
  assert.match(mirrorGuard, /NEW\.mirrored_at := n/)
})

test('baseline and scored proofs store bounded content-addressed RPC payloads', () => {
  const cases = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_cases')
  const scores = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_scores')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  const issue = statement('FUNCTION carry_exit_v2_issue')
  for (const table of [cases, scores]) {
    for (const kind of ['call', 'entitlement']) {
      assert.match(table, new RegExp(`${kind}_evidence_doc jsonb CHECK`))
      assert.match(
        table,
        new RegExp(`octet_length\\(convert_to\\(${kind}_evidence_doc::text, 'UTF8'\\)\\) <= 32768`),
      )
      assert.match(
        table,
        new RegExp(
          `${kind}_evidence_sha256 = encode\\([\\s\\S]*sha256\\(convert_to\\(${kind}_evidence_doc::text, 'UTF8'\\)\\), 'hex'\\)`,
        ),
      )
    }
  }
  assert.match(cases, /baseline_status = 'success'[\s\S]*call_evidence_doc IS NOT NULL/)
  assert.match(
    cases,
    /coverage_kind = 'assets' AND actual_consumed_raw IS NULL\s+AND holder_coverage_raw >= assets_raw/,
  )
  assert.match(cases, /baseline_status = 'ineligible'[\s\S]*entitlement_evidence_doc IS NOT NULL/)
  assert.match(scores, /status = 'covered_revert'[\s\S]*call_evidence_doc IS NOT NULL/)
  assert.match(scores, /status = 'holder_attrition'[\s\S]*entitlement_evidence_doc IS NOT NULL/)
  assert.match(
    guard,
    /nullif\(expected->'callEvidenceDoc', 'null'::jsonb\)\s+IS DISTINCT FROM NEW\.call_evidence_doc/,
  )
  assert.match(
    guard,
    /nullif\(expected->'entitlementEvidenceDoc', 'null'::jsonb\)\s+IS DISTINCT FROM NEW\.entitlement_evidence_doc/,
  )
  assert.match(issue, /item->'callEvidenceDoc'/)
  assert.match(issue, /item->'entitlementEvidenceDoc'/)
  assert.match(guard, /NEW\.call_evidence_doc, 'call', b\.route_key, b\.destination, b\.asset/)
  assert.match(guard, /NEW\.entitlement_evidence_doc, 'entitlement', b\.route_key/)
  assert.match(guard, /b\.holder, NEW\.assets_raw, b\.baseline_block, b\.baseline_hash/)
  assert.match(guard, /b\.holder, c\.assets_raw, NEW\.target_block, NEW\.target_hash/)
  assert.match(guard, /exit_v2_direct_success_without_supplier_balance/)
})

test('proof guard requires raw RPC calls and binds identity, Q, caller, block and coverage', () => {
  const rpc = statement('FUNCTION carry_exit_v2_rpc_proof_valid')
  const proof = statement('FUNCTION carry_exit_v2_proof_doc_valid')
  assert.match(rpc, /jsonb_typeof\(p_rpc->'request'\) = 'object'/)
  assert.match(rpc, /jsonb_typeof\(p_rpc->'response'\) = 'object'/)
  assert.match(rpc, /p_rpc->'request'->>'method' = 'eth_call'/)
  assert.match(rpc, /p_rpc->'request'->'params'->0->>'from' = p_holder/)
  assert.match(rpc, /p_rpc->'request'->'params'->0->>'to' = p_rpc->>'callTarget'/)
  assert.match(rpc, /p_rpc->'request'->'params'->1->>'blockHash' = p_block_hash/)
  assert.match(rpc, /p_rpc->'request'->'params'->1->'requireCanonical' = 'true'::jsonb/)
  assert.match(rpc, /p_rpc->'response'->>'id' = p_rpc->'request'->>'id'/)
  assert.match(rpc, /p_rpc->'response'->>'result'\) ~ '\^0x/)
  assert.match(rpc, /jsonb_typeof\(p_rpc->'response'->'error'\) = 'object'/)
  assert.match(rpc, /'code'\) IN \('3', '-32000', '-32015'\)/)
  assert.match(rpc, /execution reverted/)
  assert.match(rpc, /out of gas/)
  for (const pair of [
    ['routeKey', 'p_route_key'],
    ['destination', 'p_destination'],
    ['asset', 'p_asset'],
    ['holder', 'p_holder'],
    ['caller', 'p_holder'],
    ['assetsRaw', 'p_q::text'],
    ['blockNumber', 'p_block::text'],
    ['blockHash', 'p_block_hash'],
    ['coverageKind', 'p_coverage_kind'],
    ['holderCoverageRaw', 'p_holder_raw::text'],
    ['requiredCoverageRaw', 'p_required_raw::text'],
  ]) {
    assert.ok(proof.includes(`p_doc->>'${pair[0]}' = ${pair[1]}`), pair[0])
  }
  assert.match(proof, /p_doc->'holderCoverageRpc'->>'decodedRaw' = p_holder_raw::text/)
  assert.match(proof, /p_doc->'requiredCoverageRpc'->>'decodedRaw' = p_required_raw::text/)
  assert.match(proof, /p_doc->'withdrawRpc'->>'decodedAssetsRaw' = p_q::text/)
  assert.match(proof, /p_doc->'withdrawRpc'->>'decodedConsumedRaw'/)
  assert.match(proof, /carry_exit_v2_rpc_proof_valid\(p_doc->'withdrawRpc'/)
  assert.match(proof, /carry_exit_v2_rpc_proof_valid\(p_doc->'holderCoverageRpc'/)
  assert.match(proof, /carry_exit_v2_rpc_proof_valid\(p_doc->'requiredCoverageRpc'/)
  assert.match(proof, /p_doc->>'verificationStatus' = 'verified'/)
  assert.match(proof, /p_doc->'identityEvidence'->>'holder' = p_holder/)
  assert.match(proof, /p_doc->'identityEvidence'->>'blockHash' = p_block_hash/)
  assert.match(
    proof,
    /p_doc->'replayEvidenceDoc'->>'schema' = 'carry_exit_v2_independent_replay_v1'/,
  )
  assert.match(proof, /p_doc->'replayEvidenceDoc'->'origins'->>'primary'/)
  assert.match(
    proof,
    /p_doc->'replayEvidenceDoc'->'decoded'->>'simulationStatus' = p_simulation_status/,
  )
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  assert.match(guard, /exit_v2_baseline_revert_not_covered/)
  assert.match(guard, /exit_v2_score_revert_not_covered/)
})

test('case constraints preserve fixed Q, actual success and covered revert separately', () => {
  const cases = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_cases')
  assert.match(cases, /UNIQUE \(batch_id, case_index\), UNIQUE \(batch_id, assets_raw\)/)
  assert.match(
    cases,
    /coverage_kind IS DISTINCT FROM 'assets' OR required_coverage_raw = assets_raw/,
  )
  assert.match(cases, /'success', 'covered_revert', 'ineligible', 'inconclusive', 'unavailable'/)
  assert.match(
    cases,
    /baseline_status = 'success'[\s\S]*actual_consumed_raw <= holder_coverage_raw/,
  )
  assert.match(
    cases,
    /baseline_status = 'covered_revert'[\s\S]*holder_coverage_raw >= required_coverage_raw/,
  )
  assert.match(
    cases,
    /coverage_kind = 'morpho_shares_claim' AND required_coverage_raw >= assets_raw/,
  )
  assert.match(
    statement('FUNCTION carry_exit_v2_guard_insert'),
    /NEW\.status = 'covered_revert'[\s\S]*NEW\.coverage_kind = 'morpho_shares_claim'[\s\S]*NEW\.required_coverage_raw < c\.assets_raw/,
  )
  assert.match(
    cases,
    /baseline_status = 'ineligible'[\s\S]*entitlement_method = 'zero_shares'[\s\S]*entitlement_method = 'exact_asset_balance'/,
  )
  assert.match(cases, /coverage_kind = 'assets' AND holder_coverage_raw < assets_raw/)
  assert.match(cases, /entitlement_method = 'morpho_claim_below_q'/)
  assert.match(cases, /required_coverage_raw < assets_raw/)
  assert.match(cases, /baseline_status = 'inconclusive'/)
  assert.match(cases, /baseline_status = 'unavailable'[\s\S]*unavailable_reason IS NOT NULL/)
  assert.match(
    statement('FUNCTION carry_exit_v2_guard_insert'),
    /expected->>'assetsRaw' IS DISTINCT FROM NEW\.assets_raw::text/,
  )
  assert.ok(
    statement('FUNCTION carry_exit_v2_guard_insert').includes(
      "nullif(expected->>'actualConsumedRaw','')::numeric IS DISTINCT FROM NEW.actual_consumed_raw",
    ),
  )
})

test('every case preregisters all five unconditional horizons', () => {
  const plans = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_plans')
  const issue = statement('FUNCTION carry_exit_v2_issue')
  assert.match(plans, /horizon_h IN \(1, 4, 24, 48, 168\)/)
  assert.match(plans, /PRIMARY KEY \(case_id, horizon_h\)/)
  assert.match(plans, /horizon_h = 48 AND predecessor_h = 24 AND NOT conditional_recovery/)
  assert.match(plans, /horizon_h = 168 AND predecessor_h = 48 AND NOT conditional_recovery/)
  assert.match(issue, /previous,false\);/)
  assert.doesNotMatch(issue, /h IN \(48,168\)/)
  assert.match(issue, /FOREACH h IN ARRAY ARRAY\[1,4,24,48,168\]/)
  assert.match(issue, /b_issued_at \+ make_interval\(hours => h\)/)
  assert.match(issue, /b_issued_at \+ make_interval\(hours => h \+ 2\)/)
  assert.match(plans, /deadline_at = target_at \+ interval '2 hours'/)
  assert.match(issue, /sha256\(convert_to\(doc::text, 'UTF8'\)\)/)
  assert.match(issue, /supplied IS DISTINCT FROM digest/)
  assert.match(issue, /pg_advisory_xact_lock\(hashtextextended\(digest, 0\)\)/)
  assert.match(issue, /ON CONFLICT \(plan_sha256\) DO NOTHING/)
  assert.match(issue, /IF b_id IS NULL THEN[\s\S]*exit_v2_incomplete_issue_replay/)
})

test('score constraints bind predecessor, canonical source and terminal missingness', () => {
  const scores = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_scores')
  const guard = statement('FUNCTION carry_exit_v2_guard_insert')
  assert.match(scores, /PRIMARY KEY \(case_id, horizon_h\)/)
  assert.match(scores, /FOREIGN KEY \(case_id, horizon_h\) REFERENCES carry_exit_v2_plans/)
  assert.match(scores, /target_hash text CHECK \(target_hash ~ '\^0x\[0-9a-f\]\{64\}\$'\)/)
  assert.match(
    scores,
    /status = 'covered_revert'[\s\S]*holder_coverage_raw >= required_coverage_raw/,
  )
  assert.match(scores, /status = 'holder_attrition'[\s\S]*entitlement_evidence_sha256 IS NOT NULL/)
  assert.match(guard, /NEW\.status = 'holder_attrition'[\s\S]*NEW\.holder_coverage_raw = 0/)
  assert.match(guard, /NEW\.holder_coverage_raw < c\.assets_raw/)
  assert.match(
    guard,
    /NEW\.coverage_kind = 'assets'[\s\S]*NEW\.required_coverage_raw IS DISTINCT FROM c\.assets_raw/,
  )
  assert.match(guard, /s\.status = 'holder_attrition'[\s\S]*INTO prior_holder_attrition/)
  assert.match(guard, /IF prior_holder_attrition THEN[\s\S]*NEW\.status <> 'episode_censored'/)
  assert.match(scores, /'not_eligible', 'episode_censored'/)
  assert.doesNotMatch(scores, /not_triggered/)
  assert.match(guard, /ELSIF NEW\.status IN \('not_eligible', 'episode_censored'\)/)
  assert.doesNotMatch(guard, /conditional_recovery|not_triggered|latest_signal/)
  assert.doesNotMatch(guard, /NEW\.holder_coverage_raw < NEW\.required_coverage_raw/)
  const receipts = statement('CREATE TABLE IF NOT EXISTS carry_exit_v2_missing_receipts')
  assert.match(receipts, /UNIQUE \(case_id, horizon_h\)/)
  assert.match(receipts, /evidence_doc jsonb NOT NULL/)
  assert.match(receipts, /verifier_doc jsonb NOT NULL/)
  assert.match(receipts, /octet_length\(convert_to\(evidence_doc::text, 'UTF8'\)\) <= 32768/)
  assert.match(receipts, /octet_length\(convert_to\(verifier_doc::text, 'UTF8'\)\) <= 32768/)
  assert.match(
    receipts,
    /evidence_sha256 = encode\(sha256\(convert_to\(evidence_doc::text, 'UTF8'\)\), 'hex'\)/,
  )
  assert.match(
    receipts,
    /verifier_sha256 = encode\(sha256\(convert_to\(verifier_doc::text, 'UTF8'\)\), 'hex'\)/,
  )
  assert.match(receipts, /evidence_sha256 text NOT NULL/)
  assert.match(receipts, /verifier_sha256 text NOT NULL/)
  assert.match(receipts, /missing_reason text NOT NULL/)
  assert.match(scores, /status = 'missing'[\s\S]*missing_receipt_id IS NOT NULL/)
  assert.match(guard, /missing_receipt\.case_id <> NEW\.case_id/)
  assert.match(guard, /missing_receipt\.horizon_h <> NEW\.horizon_h/)
  assert.match(guard, /missing_receipt\.missing_reason <> NEW\.missing_reason/)
  assert.match(guard, /NEW\.verified_at NOT BETWEEN NEW\.evidence_at AND plan\.deadline_at/)
  for (const field of [
    'caseId',
    'horizonH',
    'targetAt',
    'deadlineAt',
    'attemptedAt',
    'provider',
    'source',
    'rpcMethod',
    'request',
    'response',
    'error',
  ]) {
    assert.match(guard, new RegExp(`NEW\\.evidence_doc->(?:'${field}'|>'${field}')`))
  }
  for (const field of ['evidenceSha256', 'checkedAt', 'kind', 'finding', 'request', 'response']) {
    assert.match(guard, new RegExp(`NEW\\.verifier_doc->(?:'${field}'|>'${field}')`))
  }
  assert.match(guard, /evidence_doc->'request'->>'method'[\s\S]*evidence_doc->>'rpcMethod'/)
  assert.match(guard, /evidence_doc->'request'->'params'\) IS DISTINCT FROM 'array'/)
  assert.match(guard, /evidence_doc->'response'->>'kind' NOT IN/)
  assert.match(guard, /evidence_doc->'error'->>'message'/)
  assert.match(guard, /verifier_doc->'response'->>'finding' IS DISTINCT FROM 'unavailable'/)
  const coverage = statement('CREATE OR REPLACE VIEW carry_exit_v2_coverage')
  assert.match(coverage, /measurement_eligible/)
  assert.match(coverage, /recovered_after_restriction/)
  assert.match(coverage, /earlier\.status = 'holder_attrition'/)
  assert.match(coverage, /c\.baseline_status IN \('success', 'covered_revert'\)/)
  assert.match(coverage, /earlier\.status IN \('success', 'covered_revert'\)/)
  assert.match(coverage, /s\.status = 'success'/)
  assert.match(coverage, /FROM carry_exit_v2_plans p/)
  assert.match(coverage, /coalesce\(s\.status, 'pending'\) AS status/)
  assert.match(coverage, /LEFT JOIN carry_exit_v2_scores s/)
  assert.match(
    scores,
    /status = 'missing'[\s\S]*missing_reason IS NOT NULL[\s\S]*target_hash IS NULL/,
  )
  assert.match(guard, /NEW\.predecessor_score_id IS DISTINCT FROM prior\.id/)
  assert.match(guard, /NEW\.predecessor_hash IS DISTINCT FROM prior\.target_hash/)
  assert.match(guard, /NEW\.predecessor_block_at IS DISTINCT FROM prior\.target_block_at/)
  assert.match(guard, /NEW\.target_parent_hash IS DISTINCT FROM NEW\.parent_header_hash/)
  assert.match(guard, /NEW\.target_parent_block_at >= plan\.target_at/)
  assert.match(guard, /NEW\.target_block_at < plan\.target_at/)
  assert.match(guard, /NEW\.captured_at > plan\.deadline_at/)
  assert.match(guard, /NEW\.recorded_at > plan\.deadline_at/)
  assert.match(guard, /NEW\.target_observed_at > NEW\.captured_at/)
  assert.match(guard, /ELSIF n <= plan\.deadline_at THEN/)
  assert.match(guard, /exit_v2_terminal_before_close/)
  assert.match(scores, /canonicality_evidence_sha256 text CHECK/)
  assert.match(scores, /canonicality_evidence_doc jsonb CHECK/)
  assert.match(
    scores,
    /octet_length\(convert_to\(canonicality_evidence_doc::text, 'UTF8'\)\) <= 32768/,
  )
  assert.match(
    scores,
    /canonicality_evidence_sha256 = encode\([\s\S]*sha256\(convert_to\(canonicality_evidence_doc::text, 'UTF8'\)\), 'hex'\)/,
  )
  for (const field of ['targetHeader', 'parentHeader', 'finalizedHead']) {
    assert.match(guard, new RegExp(`jsonb_typeof\\(NEW\\.canonicality_evidence_doc->'${field}'\\)`))
  }
  assert.match(guard, /targetHeader'->>'number'[\s\S]*NEW\.target_block::text/)
  assert.match(guard, /targetHeader'->>'hash'[\s\S]*NEW\.target_hash/)
  assert.match(guard, /targetHeader'->>'parentHash'[\s\S]*NEW\.target_parent_hash/)
  assert.match(guard, /parentHeader'->>'number'[\s\S]*NEW\.target_parent_block::text/)
  assert.match(guard, /parentHeader'->>'hash'[\s\S]*NEW\.target_parent_hash/)
  assert.match(guard, /finalizedHead'->>'number'\)::bigint[\s\S]*< NEW\.target_block/)
  assert.match(guard, /finalizedHead'->>'timestamp',''\) IS NULL/)
  assert.match(guard, /finalizedHead'->>'timestamp'\)::timestamptz\s*< NEW\.target_block_at/)
  assert.match(
    guard,
    /finalizedHead'->>'timestamp'\)::timestamptz\s*> NEW\.target_observed_at \+ interval '2 minutes'/,
  )
})

test('target admission accepts first-block shape after DB issue and rejects early, late or unlinked evidence', () => {
  const valid = {
    issuedAt: '2026-09-29T10:00:00Z',
    horizonH: 1,
    targetAt: '2026-09-29T11:00:00Z',
    deadlineAt: '2026-09-29T13:00:00Z',
    predecessorBlockAt: '2026-09-29T09:58:00Z',
    parentBlockAt: '2026-09-29T10:59:59Z',
    targetBlockAt: '2026-09-29T11:00:12Z',
    capturedAt: '2026-09-29T11:18:00Z',
    recordedAt: '2026-09-29T11:18:02Z',
    parentBlock: '100',
    targetBlock: '101',
    targetHash: `0x${'a'.repeat(64)}`,
    parentHash: `0x${'b'.repeat(64)}`,
    parentHeaderHash: `0x${'b'.repeat(64)}`,
  }
  assert.equal(assessExitV2TargetEvidence(valid), true)
  assert.equal(assessExitV2TargetEvidence({ ...valid, targetAt: '2026-09-29T10:58:00Z' }), false)
  assert.equal(assessExitV2TargetEvidence({ ...valid, parentBlockAt: valid.targetAt }), false)
  assert.equal(
    assessExitV2TargetEvidence({ ...valid, targetBlockAt: '2026-09-29T10:59:59Z' }),
    false,
  )
  assert.equal(
    assessExitV2TargetEvidence({
      ...valid,
      capturedAt: '2026-09-29T13:00:01Z',
      recordedAt: '2026-09-29T13:00:02Z',
    }),
    false,
  )
  assert.equal(assessExitV2TargetEvidence({ ...valid, parentHeaderHash: valid.targetHash }), false)
  assert.equal(assessExitV2TargetEvidence({ ...valid, parentBlock: '99' }), false)
  assert.equal(assessExitV2TargetEvidence({ ...valid, predecessorBlockAt: valid.targetAt }), false)
  const micro = {
    ...valid,
    issuedAt: '2026-09-29T10:00:00.123456Z',
    targetAt: '2026-09-29T11:00:00.123456Z',
    deadlineAt: '2026-09-29T13:00:00.123456Z',
  }
  assert.equal(assessExitV2TargetEvidence(micro), true)
  assert.equal(
    assessExitV2TargetEvidence({ ...micro, targetAt: '2026-09-29T11:00:00.123Z' }),
    false,
  )
  assert.equal(
    assessExitV2TargetEvidence({ ...micro, deadlineAt: '2026-09-29T13:00:00.123Z' }),
    false,
  )
  const due = statement('CREATE OR REPLACE VIEW carry_exit_v2_due')
  assert.match(due, /issued_at_exact/)
  assert.match(due, /target_at_exact/)
  assert.match(due, /deadline_at_exact/)
  assert.match(due, /HH24:MI:SS\.US/)
  // A missing H1 point has no predecessor block time for H4; its immutable H1 score is still required by SQL.
  assert.equal(
    assessExitV2TargetEvidence({
      ...valid,
      horizonH: 4,
      targetAt: '2026-09-29T14:00:00Z',
      deadlineAt: '2026-09-29T16:00:00Z',
      predecessorBlockAt: null,
      parentBlockAt: '2026-09-29T13:59:59Z',
      targetBlockAt: '2026-09-29T14:00:12Z',
      capturedAt: '2026-09-29T14:18:00Z',
      recordedAt: '2026-09-29T14:18:02Z',
    }),
    true,
  )
})

test('apply installs append-only protections on all eight v2 tables without touching H1 ledgers', async () => {
  const statements = []
  await apply({
    query: async (statement) => {
      statements.push(statement)
      return []
    },
  })
  assert.equal(statements.length, DDL.length + 8 * 3)
  assert.equal(
    statements.filter((entry) => entry.includes('_insert_guard BEFORE INSERT')).length,
    8,
  )
  assert.equal(
    statements.filter((entry) => entry.includes('_immutable BEFORE UPDATE OR DELETE')).length,
    8,
  )
  assert.equal(statements.filter((entry) => entry.includes('_truncate BEFORE TRUNCATE')).length, 8)
  for (const suffix of ['insert_guard', 'immutable', 'truncate'])
    assert.ok(
      statements.some((entry) => entry.includes(`carry_exit_v2_local_mirrors_${suffix}`)),
      `missing local mirror ${suffix} trigger`,
    )
  assert.ok(
    statements.every((entry) => !/ALTER TABLE carry_(morpho|direct|susds|usd3)_exit_/.test(entry)),
  )
})
