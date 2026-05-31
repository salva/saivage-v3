import { describe, expect, it } from '@jest/globals';
import {
  normalizeSanitizedClearanceReport,
  validateSanitizedClearanceReport,
} from '../../src/schemas/sanitized-clearance-report.js';

function correctedClearanceAbsentReport() {
  return {
    stage_id: 'await-operator-clearance-smoketest-escalation-08',
    bootstrap_state_exists: true,
    phase: 'smoke-test',
    smoke_test_status: 'escalated',
    smoke_test_attempts: 3,
    clearance_present: false,
    clearance_keys_present: [],
    action_taken: 'policy_halt_no_clearance',
    health_checked: false,
    systemd_checked: false,
    health: null,
    services: {},
    state_mutated: false,
    supervision_or_capability_work_dispatched: false,
    forbidden_actions_performed: {
      printed_raw_bootstrap_state: false,
      printed_or_persisted_secret_values: false,
      ran_health_without_clearance: false,
      ran_systemd_without_clearance: false,
      mutated_runtime_state: false,
    },
  };
}

function correctedClearanceAbsentAliasReport() {
  const { clearance_present: _clearancePresent, ...report } = correctedClearanceAbsentReport();
  return {
    ...report,
    clearance_absent: true,
  };
}

describe('sanitized clearance report validation', () => {
  it('rejects clearance-absent reports with contradictory forbidden-action booleans', () => {
    const contradictory = {
      ...correctedClearanceAbsentReport(),
      health_checked: true,
      systemd_checked: true,
      state_mutated: true,
      supervision_or_capability_work_dispatched: true,
      forbidden_actions_performed: {
        ...correctedClearanceAbsentReport().forbidden_actions_performed,
        ran_health_without_clearance: true,
        ran_systemd_without_clearance: true,
        mutated_runtime_state: true,
      },
    };

    const result = validateSanitizedClearanceReport(contradictory);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        'health_checked must be false when clearance_present=false',
        'systemd_checked must be false when clearance_present=false',
        'state_mutated must be false when clearance_present=false',
        'supervision_or_capability_work_dispatched must be false when clearance_present=false',
        'forbidden_actions_performed.ran_health_without_clearance must be false when clearance_present=false',
        'forbidden_actions_performed.ran_systemd_without_clearance must be false when clearance_present=false',
        'forbidden_actions_performed.mutated_runtime_state must be false when clearance_present=false',
      ]),
    );
  });

  it('rejects clearance_absent=true reports with contradictory forbidden-action booleans', () => {
    const contradictory = {
      ...correctedClearanceAbsentAliasReport(),
      health_checked: true,
      systemd_checked: true,
      state_mutated: true,
      supervision_or_capability_work_dispatched: true,
      forbidden_actions_performed: {
        ...correctedClearanceAbsentAliasReport().forbidden_actions_performed,
        ran_health_without_clearance: true,
        ran_systemd_without_clearance: true,
        mutated_runtime_state: true,
      },
    };

    const result = validateSanitizedClearanceReport(contradictory);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        'health_checked must be false when clearance_absent=true',
        'systemd_checked must be false when clearance_absent=true',
        'state_mutated must be false when clearance_absent=true',
        'supervision_or_capability_work_dispatched must be false when clearance_absent=true',
        'forbidden_actions_performed.ran_health_without_clearance must be false when clearance_absent=true',
        'forbidden_actions_performed.ran_systemd_without_clearance must be false when clearance_absent=true',
        'forbidden_actions_performed.mutated_runtime_state must be false when clearance_absent=true',
      ]),
    );
  });

  it('normalizes clearance-absent contradictions to a consistent safe no-action state', () => {
    const contradictory = {
      ...correctedClearanceAbsentReport(),
      health_checked: true,
      systemd_checked: true,
      state_mutated: true,
      supervision_or_capability_work_dispatched: true,
      forbidden_actions_performed: {
        ran_health_without_clearance: true,
        ran_systemd_without_clearance: true,
        mutated_runtime_state: true,
      },
    };

    const result = normalizeSanitizedClearanceReport(contradictory);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      clearance_present: false,
      health_checked: false,
      systemd_checked: false,
      state_mutated: false,
      supervision_or_capability_work_dispatched: false,
      forbidden_actions_performed: {
        ran_health_without_clearance: false,
        ran_systemd_without_clearance: false,
        mutated_runtime_state: false,
      },
    });
    expect(contradictory.health_checked).toBe(true);
  });

  it('normalizes clearance_absent=true contradictions to a consistent safe no-action state', () => {
    const contradictory = {
      ...correctedClearanceAbsentAliasReport(),
      health_checked: true,
      systemd_checked: true,
      state_mutated: true,
      supervision_or_capability_work_dispatched: true,
      forbidden_actions_performed: {
        ran_health_without_clearance: true,
        ran_systemd_without_clearance: true,
        mutated_runtime_state: true,
      },
    };

    const result = normalizeSanitizedClearanceReport(contradictory);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      clearance_absent: true,
      health_checked: false,
      systemd_checked: false,
      state_mutated: false,
      supervision_or_capability_work_dispatched: false,
      forbidden_actions_performed: {
        ran_health_without_clearance: false,
        ran_systemd_without_clearance: false,
        mutated_runtime_state: false,
      },
    });
    expect(contradictory.health_checked).toBe(true);
  });

  it('accepts a corrected clearance-absent report that states no forbidden actions occurred', () => {
    const result = validateSanitizedClearanceReport(correctedClearanceAbsentReport());

    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it('accepts a corrected clearance_absent=true report that states no forbidden actions occurred', () => {
    const result = validateSanitizedClearanceReport(correctedClearanceAbsentAliasReport());

    expect(result).toEqual({ ok: true, diagnostics: [] });
  });
});
