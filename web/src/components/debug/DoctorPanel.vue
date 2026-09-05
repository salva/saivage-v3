<template>
  <div class="debug-tab-content">
    <section class="debug-section">
      <div class="debug-section-header">
        <h4 class="debug-section-title">Doctor Diagnostics</h4>
        <button class="sv-fetch-btn" :disabled="doctorLoading" @click="emit('fetch')">Fetch</button>
      </div>
      <ViewState v-if="doctorLoading" state="loading" title="Running diagnostics..." />
      <ViewState v-else-if="doctorError" state="error" title="Failed to load" :message="doctorError" />
      <ViewState
        v-else-if="doctorStatus === null && doctorChecks.length === 0"
        state="empty"
        title="No diagnostics run yet."
        message="Click Fetch to run the doctor checks."
      />
      <template v-else>
        <div class="doctor-status-banner" :class="doctorStatus === 'ok' ? 'doctor-ok' : 'doctor-issues'">
          <span class="doctor-status-icon">{{ doctorStatus === 'ok' ? '✓' : '⚠' }}</span>
          <span class="doctor-status-text">
            {{ doctorStatus === 'ok' ? 'All checks passed' : 'Issues found' }} ({{ doctorChecks.length }} checks)
          </span>
        </div>
        <div class="doctor-checks-list">
          <div
            v-for="check in doctorChecks"
            :key="check.name"
            class="doctor-check-item"
            :class="check.passed ? 'check-passed' : 'check-failed'"
          >
            <span class="check-icon">{{ check.passed ? '✓' : '✗' }}</span>
            <div class="check-body">
              <span class="check-name">{{ check.name }}</span>
              <span v-if="check.details" class="doctor-check-sep" aria-hidden="true">·</span>
              <span v-if="check.details" class="check-details">{{ check.details }}</span>
            </div>
          </div>
        </div>
        <div v-if="doctorIssues.length > 0" class="doctor-issues">
          <h5 class="doctor-issues-title">Issues ({{ doctorIssues.length }})</h5>
          <div
            v-for="(issue, idx) in doctorIssues"
            :key="idx"
            class="doctor-issue-item"
            :class="'issue-' + issue.severity"
          >
            <span class="issue-severity-badge" :class="'iss-' + issue.severity">{{ issue.severity }}</span>
            <span class="issue-message">{{ issue.message }}</span>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { DoctorCheck, DoctorIssue } from '../../api/types';
import ViewState from '../ui/ViewState.vue';

defineProps<{
  doctorStatus: 'ok' | 'issues_found' | null;
  doctorChecks: readonly DoctorCheck[];
  doctorIssues: readonly DoctorIssue[];
  doctorLoading: boolean;
  doctorError: string | null;
}>();

const emit = defineEmits<{ fetch: [] }>();
</script>

<style scoped>
.doctor-check-sep {
  color: var(--text-muted);
  font-weight: 400;
  margin: 0 6px;
}
</style>
