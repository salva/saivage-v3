<template>
  <div class="debug-layout">
    <div class="debug-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="debug-tab"
        :class="{ active: localActiveTab === tab.id }"
        @click="setTab(tab.id)"
      >{{ tab.label }}</button>
    </div>

    <div class="debug-content">
      <div v-if="localActiveTab === 'state'" class="debug-tab-content">
        <div v-if="loading" class="debug-loading">Loading state...</div>
        <div v-else-if="error" class="debug-error">{{ error }}</div>
        <template v-else>
          <section class="debug-section">
            <h4 class="debug-section-title">Runtime State</h4>
            <div v-if="debugRuntime?.status === 'frozen'" class="freeze-banner">
              <div class="freeze-banner-text">
                <strong>❄ Runtime Frozen</strong>
                <span class="freeze-reason">{{ debugRuntime.frozen_reason || 'No reason provided' }}</span>
              </div>
            </div>
            <div v-if="debugRuntime" class="debug-grid">
              <div class="dg-item"><span class="dg-key">Status:</span><span class="dg-value">{{ debugRuntime.status }}</span></div>
              <div class="dg-item"><span class="dg-key">PID:</span><span class="dg-value">{{ debugRuntime.pid }}</span></div>
              <div class="dg-item"><span class="dg-key">Started:</span><span class="dg-value">{{ fmtDate(debugRuntime.started_at) }}</span></div>
              <div class="dg-item"><span class="dg-key">Paused:</span><span class="dg-value">{{ debugRuntime.paused ? 'Yes' : 'No' }}</span></div>
              <div v-if="debugRuntime?.status === 'frozen'" class="dg-item">
                <span class="dg-key">Frozen:</span>
                <span class="dg-value freeze-value">Yes</span>
              </div>
              <div class="dg-item"><span class="dg-key">Current Card:</span><span class="dg-value mono">{{ debugRuntime.current_card_id || 'none' }}</span></div>
              <div class="dg-item"><span class="dg-key">Agent Session:</span><span class="dg-value mono">{{ debugRuntime.current_agent_session_id || 'none' }}</span></div>
              <div class="dg-item"><span class="dg-key">Running Procs:</span><span class="dg-value">{{ debugRuntime.running_processes?.length || 0 }}</span></div>
            </div>
            <div v-else class="debug-empty">No runtime state.</div>
          </section>

          <section class="debug-section">
            <h4 class="debug-section-title">Cards ({{ debugTotalCards }} total)</h4>
            <div class="card-summary-bars">
              <div v-for="entry in cardStatusEntries" :key="entry.status" class="csb-row">
                <span class="csb-label">{{ entry.status }}</span>
                <div class="csb-track"><div class="csb-fill" :class="'s-' + entry.status" :style="{ width: (entry.count / maxStatusCount) * 100 + '%' }"></div></div>
                <span class="csb-count">{{ entry.count }}</span>
              </div>
            </div>
            <div class="debug-card-list">
              <div v-for="card in debugCards" :key="card.id" class="dc-item" :class="'dc-' + card.status">
                <span class="dc-type">{{ card.type[0].toUpperCase() }}</span>
                <span class="dc-title">{{ card.title }}</span>
                <span class="dc-status" :class="'s-' + card.status">{{ card.status }}</span>
                <span class="dc-priority">P{{ card.priority }}</span>
                <span v-if="card.depends_on.length" class="dc-deps">{{ card.depends_on.length }}</span>
              </div>
            </div>
            <div v-if="debugCards.length === 0" class="debug-empty">No cards.</div>
          </section>
        </template>
      </div>

      <div v-if="localActiveTab === 'operator'" class="debug-tab-content">
        <section class="debug-section">
          <div class="debug-section-header operator-header">
            <div>
              <h4 class="debug-section-title">Runtime Diagnostics</h4>
              <p class="operator-subtitle">Inspect runtime state here. Use Dashboard → Runtime Console for project start/stop commands, run and activation observability, command errors, and recovery state.</p>
            </div>
            <div class="operator-actions-inline">
              <button class="sv-fetch-btn" :disabled="operatorPanelBusy" @click="refreshOperatorControl">Refresh</button>
            </div>
          </div>

          <div v-if="operatorLastFetchedAt" class="operator-freshness" role="status">
            Last refreshed {{ fmtDate(operatorLastFetchedAt) }}
            <span v-if="operatorDataFreshnessLabel === 'stale'">(stale)</span>
          </div>
          <div v-else class="operator-freshness" role="status">Not refreshed yet.</div>

          <div v-if="operatorWarningBannerMessage" class="operator-banner operator-banner-warning" role="status">
            {{ operatorWarningBannerMessage }}
          </div>
          <div v-if="operatorUnauthorized" class="operator-banner operator-banner-error" role="alert">
            Unauthorized. Provide a valid Saivage API token and refresh the page.
          </div>
          <div v-else-if="runtimeControlError && !operatorWarningBannerMessage" class="operator-banner operator-banner-error" role="alert">
            {{ runtimeControlError }}
          </div>
          <div v-if="runtimeControlSuccess" class="operator-banner operator-banner-success" role="status">
            {{ runtimeControlSuccess }}
          </div>

          <div v-if="loading && !debugRuntime" class="debug-loading">Loading runtime control state...</div>
          <div v-else class="operator-runtime-card">
            <div class="operator-runtime-summary">
              <div class="dg-item"><span class="dg-key">Status:</span><span class="operator-status-badge" :class="'status-' + runtimeStatusTone">{{ runtimeStatusLabel }}</span></div>
              <div class="dg-item"><span class="dg-key">Dispatch:</span><span class="dg-value">{{ runtimeDispatchLabel }}</span></div>
              <div class="dg-item"><span class="dg-key">Current Card:</span><span class="dg-value mono">{{ debugRuntime?.current_card_id || 'none' }}</span></div>
              <div class="dg-item"><span class="dg-key">Agent Session:</span><span class="dg-value mono">{{ debugRuntime?.current_agent_session_id || 'none' }}</span></div>
            </div>

            <div v-if="debugRuntime?.status === 'frozen'" class="freeze-banner operator-freeze-guidance" role="alert">
              <div class="freeze-banner-text">
                <strong>Runtime is frozen.</strong>
                <span class="freeze-reason">Generic resume is disabled; use the documented resume-from-freeze workflow after reviewing the freeze manifest.</span>
              </div>
            </div>

            <div v-if="!debugRuntime" class="debug-empty operator-empty-runtime">
              Runtime state is unavailable. Open Dashboard → Runtime Console to start project execution or inspect recovery state.
            </div>

            <div class="operator-runtime-guidance" role="note">
              DebugView is diagnostic-only. Runtime Console owns execution controls, command errors, root runs, child activation edges, and recovery state.
            </div>

            <div v-if="!debugRuntime" class="operator-help-text">Runtime diagnostics are unavailable because runtime state is not initialized. Open Dashboard → Runtime Console to start project execution or inspect recovery state.</div>
            <div v-else-if="debugRuntime.status === 'frozen'" class="operator-help-text">Frozen runtime recovery is coordinated from Runtime Console after reviewing the freeze manifest.</div>
          </div>
        </section>

        <NotificationsPanel />

        <section class="debug-section">
          <div class="debug-section-header operator-header">
            <div>
              <h4 class="debug-section-title">Actionable runtime issues</h4>
              <p class="operator-subtitle">Tool and runtime precondition failures are reported in Runtime Console with next-action guidance.</p>
            </div>
          </div>
          <div class="debug-empty">Open Dashboard → Runtime Console for command errors, activation failures, and recovery state.</div>
        </section>

        <section class="debug-section">
          <div class="debug-section-header operator-header">
            <div>
              <h4 class="debug-section-title">Operator Notes ({{ operatorNotesTotal }})</h4>
              <p class="operator-subtitle">Inspect current unhandled notes and acknowledge or delete them through the notes API.</p>
            </div>
            <div class="operator-actions-inline">
              <button class="sv-fetch-btn" :disabled="operatorPanelBusy" @click="refreshNotes">Refresh</button>
              <button class="sv-fetch-btn operator-danger-button" :disabled="clearNotesDisabled" @click="confirmClearNotes">{{ operatorClearLoading ? 'Clearing...' : 'Clear all' }}</button>
            </div>
          </div>

          <div v-if="operatorNotesLoading && operatorNotesTotal === 0" class="debug-loading">Loading operator notes...</div>
          <div v-else-if="operatorNotesError && operatorNotesTotal === 0" class="debug-error">{{ operatorNotesError }}</div>
          <div v-else-if="operatorNotes.length === 0" class="debug-empty">No unhandled operator notes.</div>
          <div v-else class="operator-notes-list">
            <article v-for="entry in operatorNotes" :key="entry.note_id" class="operator-note-card">
              <div class="operator-note-header">
                <span class="operator-note-kind">{{ entry.kind }}</span>
                <span class="operator-note-author">{{ entry.note?.author || 'unknown author' }}</span>
                <span class="operator-note-time">{{ fmtDate(entry.timestamp) }}</span>
              </div>
              <div class="operator-note-body">
                {{ entry.note?.content || 'Note details unavailable after reconciliation. Refresh notes.' }}
              </div>
              <div class="operator-note-meta">
                <span class="mono">Card {{ entry.card_id }}</span>
                <span class="mono">Note {{ entry.note_id }}</span>
              </div>
              <div class="operator-note-actions">
                <button class="operator-button" :disabled="noteButtonsDisabled(entry.note_id)" :aria-label="`Acknowledge note ${entry.note_id}`" @click="debugStore.acknowledgeOperatorNote(entry.note_id)">
                  {{ operatorNoteActionLoading[entry.note_id] === 'acknowledge' ? 'Acknowledging...' : 'Acknowledge' }}
                </button>
                <button class="operator-button operator-danger-button" :disabled="noteButtonsDisabled(entry.note_id)" :aria-label="`Delete note ${entry.note_id}`" @click="debugStore.deleteOperatorNote(entry.note_id)">
                  {{ operatorNoteActionLoading[entry.note_id] === 'delete' ? 'Deleting...' : 'Delete' }}
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>

      <div v-if="localActiveTab === 'errors'" class="debug-tab-content">
        <div v-if="loading" class="debug-loading">Loading errors...</div>
        <div v-else-if="error" class="debug-error">{{ error }}</div>
        <div v-else-if="errorsTotal === 0 && errors.length === 0" class="debug-empty">No errors recorded.</div>
        <div v-else class="errors-list">
          <div v-for="entry in errorSourceEntries" :key="entry.source" class="error-source-group">
            <h4 class="error-source-title">{{ entry.source }} ({{ entry.errors.length }})</h4>
            <div v-for="err in entry.errors" :key="err.timestamp + err.message" class="error-item" :class="'sev-' + err.severity">
              <div class="error-header">
                <span class="error-severity-badge" :class="'sev-' + err.severity">{{ err.severity }}</span>
                <span class="error-type">{{ err.type }}</span>
                <span class="error-time">{{ fmtDate(err.timestamp) }}</span>
              </div>
              <div class="error-message">{{ err.message }}</div>
              <CodeBlock v-if="err.details" :code="err.details" language="text" copyable wrap />
            </div>
          </div>
        </div>
      </div>

      <div v-if="localActiveTab === 'timeline'" class="debug-tab-content">
        <div v-if="loading" class="debug-loading">Loading timeline...</div>
        <div v-else-if="error" class="debug-error">{{ error }}</div>
        <template v-else>
          <div class="timeline-filter">
            <label class="timeline-filter-label" for="timeline-kind-filter">Event kinds</label>
            <select id="timeline-kind-filter" v-model="selectedTimelineKinds" class="timeline-filter-select" multiple aria-label="Filter timeline event kinds">
              <option v-for="kind in timelineKindOptions" :key="kind" :value="kind">{{ kind }}</option>
            </select>
            <span class="timeline-filter-help">No selection shows all event kinds.</span>
            <button v-if="selectedTimelineKinds.length > 0" class="filter-chip" @click="selectedTimelineKinds = []">Show all</button>
          </div>
          <div v-if="filteredTimeline.length === 0" class="debug-empty">No timeline events.</div>
          <div v-else class="timeline-list">
            <div v-for="event in filteredTimeline" :key="timelineKey(event)" class="tl-event">
              <span class="tl-event-type">{{ formatEventKind(event.kind) }}</span>
              <span v-if="event.card_id" class="tl-event-card mono">Card: {{ event.card_id }}</span>
              <span v-if="event.goal_id" class="tl-event-card mono">Goal: {{ event.goal_id }}</span>
              <span v-if="event.session_id" class="tl-event-card mono">Session: {{ event.session_id }}</span>
              <span class="tl-event-time">{{ fmtDate(event.timestamp) }}</span>
              <CodeBlock v-if="Object.keys(timelineDetails(event)).length" :code="formatJson(timelineDetails(event))" language="json" copyable />
            </div>
          </div>
        </template>
      </div>

      <div v-if="localActiveTab === 'mcp'" class="debug-tab-content">
        <div v-if="mcpStore.loading" class="debug-loading">Loading MCP tools...</div>
        <div v-else-if="mcpStore.error" class="debug-error">{{ mcpStore.error }}</div>
        <div v-else-if="mcpStore.serverCount === 0" class="debug-empty">No MCP servers configured or running.</div>
        <div v-else class="mcp-content">
          <section class="debug-section">
            <h4 class="debug-section-title">Summary</h4>
            <div class="debug-grid">
              <div class="dg-item"><span class="dg-key">Servers:</span><span class="dg-value">{{ mcpStore.serverCount }}</span></div>
              <div class="dg-item"><span class="dg-key">Tools:</span><span class="dg-value">{{ mcpStore.toolCount }}</span></div>
              <div class="dg-item"><span class="dg-key">Invocations:</span><span class="dg-value">{{ mcpStore.totalInvocations }} ({{ mcpStore.totalErrors }} errors)</span></div>
              <div v-if="mcpStore.lastRefreshed" class="dg-item"><span class="dg-key">Last Refreshed:</span><span class="dg-value">{{ fmtDate(mcpStore.lastRefreshed) }}</span></div>
            </div>
          </section>
          <section v-for="server in mcpStore.servers" :key="server.name" class="debug-section">
            <h4 class="debug-section-title">
              {{ server.name }}
              <span class="mcp-server-badge" :class="'mcp-status-' + server.status">{{ server.status }}</span>
              <span class="mcp-server-transport">{{ server.transport }}</span>
              <span class="mcp-tool-count">{{ server.toolCount }} tools</span>
            </h4>
            <div v-if="server.tools.length === 0" class="debug-empty" style="padding:8px;font-size:12px;">No tools discovered.</div>
            <div v-for="tool in server.tools" :key="tool.name" class="mcp-tool-card">
              <div class="mcp-tool-name-row">
                <span class="mcp-tool-name">{{ tool.name }}</span>
                <span class="mcp-tool-desc">{{ tool.description || 'No description' }}</span>
              </div>
              <div class="mcp-tool-stats">
                <span class="mcp-stat-item" title="Total invocations"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1"/><line x1="6" y1="3" x2="6" y2="7" stroke="currentColor" stroke-width="1"/><line x1="4" y1="9" x2="8" y2="9" stroke="currentColor" stroke-width="1"/></svg>{{ tool.stats.total }}</span>
                <span class="mcp-stat-item mcp-stat-success" title="Successful invocations">✓ {{ tool.stats.success }}</span>
                <span class="mcp-stat-item mcp-stat-error" title="Failed invocations">✗ {{ tool.stats.error }}</span>
                <span v-if="tool.stats.lastInvokedAt" class="mcp-stat-item mcp-stat-time" title="Last invoked">{{ fmtDate(tool.stats.lastInvokedAt) }}</span>
              </div>
            </div>
          </section>
          <section v-if="Object.keys(mcpStore.invocationStats).length > 0" class="debug-section">
            <h4 class="debug-section-title">All Invocation Stats</h4>
            <div class="mcp-stats-table">
              <div class="mcp-stats-header">
                <span class="mcp-stats-cell">Key</span>
                <span class="mcp-stats-cell">Total</span>
                <span class="mcp-stats-cell">Success</span>
                <span class="mcp-stats-cell">Error</span>
                <span class="mcp-stats-cell">Last</span>
              </div>
              <div v-for="(stats, key) in mcpStore.invocationStats" :key="key" class="mcp-stats-row">
                <span class="mcp-stats-cell mono">{{ key }}</span>
                <span class="mcp-stats-cell">{{ stats.total }}</span>
                <span class="mcp-stats-cell mcp-stat-success">{{ stats.success }}</span>
                <span class="mcp-stats-cell mcp-stat-error">{{ stats.error }}</span>
                <span class="mcp-stats-cell mcp-stat-time">{{ stats.lastInvokedAt ? fmtDate(stats.lastInvokedAt) : '-' }}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div v-if="localActiveTab === 'processes'" class="debug-tab-content">
        <div class="debug-section-header operator-header">
          <div>
            <h4 class="debug-section-title">Processes</h4>
            <p class="operator-subtitle">Inspect Saivage-managed process records using redacted commands and contained log references.</p>
          </div>
          <div class="operator-actions-inline">
            <button class="sv-fetch-btn" :disabled="processesLoading" @click="debugStore.fetchProcesses()">Refresh</button>
          </div>
        </div>

        <div v-if="processUnauthorized" class="operator-banner operator-banner-error" role="alert">Unauthorized. Provide a valid Saivage API token and refresh the page.</div>
        <div v-else-if="processControlError" class="operator-banner" :class="processStale ? 'operator-banner-warning' : 'operator-banner-error'" :role="processStale ? 'status' : 'alert'">{{ processControlError }}</div>
        <div v-if="processControlSuccess" class="operator-banner operator-banner-success" role="status">{{ processControlSuccess }}</div>
        <div v-if="processStale && !processControlError" class="operator-banner operator-banner-warning" role="status">Process state may be stale. Refresh to reconcile with server state.</div>

        <div v-if="processesLoading" class="debug-loading">Loading processes...</div>
        <div v-else-if="processesError" class="debug-error">{{ processesError }}</div>
        <div v-else-if="processes.length === 0" class="debug-empty">No Saivage-managed processes found.</div>
        <div v-else class="processes-list">
          <div v-for="proc in sortedProcesses" :key="proc.id" class="process-card">
            <div class="process-header">
              <span class="process-id mono">{{ proc.id }}</span>
              <span class="process-status-badge" :class="'ps-' + proc.status">{{ proc.status }}</span>
              <span class="process-time">Started {{ fmtDate(proc.started_at) }}</span>
            </div>
            <div class="process-details">
              <div class="pd-row"><span class="pd-key">Command:</span><span class="pd-value mono wrap">{{ proc.command }}</span></div>
              <div class="pd-row"><span class="pd-key">Card:</span><span class="pd-value mono">{{ proc.card_id }}</span></div>
              <div class="pd-row"><span class="pd-key">Session:</span><span class="pd-value mono">{{ proc.session_id || 'none' }}</span></div>
              <div class="pd-row"><span class="pd-key">Owner:</span><span class="pd-value mono">{{ proc.owner || 'unknown' }}</span></div>
              <div class="pd-row"><span class="pd-key">Working directory:</span><span class="pd-value mono wrap">{{ proc.cwd || 'Unavailable or unsafe to display' }}</span></div>
              <div v-if="proc.ended_at" class="pd-row"><span class="pd-key">Ended:</span><span class="pd-value">{{ fmtDate(proc.ended_at) }}</span></div>
              <div class="pd-row"><span class="pd-key">Exit code:</span><span class="pd-value mono">{{ proc.exit_code ?? '-' }}</span></div>
              <div v-if="proc.timed_out" class="pd-row"><span class="pd-key">Timed out:</span><span class="pd-value">Yes</span></div>
            </div>

            <div class="process-availability" :class="availabilityClass(proc)">
              <div class="process-subtitle">Control: {{ availabilityLabel(proc) }}</div>
              <div class="process-availability-reason">{{ proc.control.terminate_reason }}</div>
            </div>

            <div class="process-logs">
              <div class="process-subtitle">Logs</div>
              <div v-if="!proc.control.can_view_logs" class="process-empty-note">No safe log references are available for this process.</div>
              <div v-else>
                <div v-for="logEntry in processLogEntries(proc)" :key="logEntry.key" class="pd-row">
                  <span class="pd-key">{{ logEntry.label }}:</span>
                  <span v-if="logEntry.value" class="pd-value mono wrap">{{ logEntry.value }} <button class="process-link-button" @click="browseProcessLog(logEntry.value)">Browse</button></span>
                  <span v-else class="pd-value">Not available</span>
                </div>
              </div>
            </div>

            <div class="process-controls">
              <button v-if="showTerminateButton(proc)" class="operator-button operator-danger-button" :disabled="Boolean(processTerminateLoading[proc.id]) || processUnauthorized" :aria-label="`Terminate live-attached process ${proc.id}`" @click="confirmTerminateProcess(proc.id)">
                {{ processTerminateLoading[proc.id] ? 'Terminating...' : 'Terminate process' }}
              </button>
              <div v-else class="process-empty-note">{{ terminateUnavailableCopy(proc) }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="localActiveTab === 'supervision'" class="debug-tab-content">
        <section class="debug-section">
          <div class="debug-section-header"><h4 class="debug-section-title">Doctor Diagnostics</h4><button class="sv-fetch-btn" :disabled="doctorLoading" @click="debugStore.fetchDoctor()">Fetch</button></div>
          <div v-if="doctorLoading" class="debug-loading" style="padding:16px;">Running diagnostics...</div>
          <div v-else-if="doctorError" class="debug-error" style="padding:16px;">{{ doctorError }}</div>
          <div v-else-if="doctorStatus === null && doctorChecks.length === 0" class="debug-empty" style="padding:16px;">No diagnostics run yet. Click Fetch to check card/index consistency.</div>
          <template v-else>
            <div class="doctor-status-banner" :class="doctorStatus === 'ok' ? 'doctor-ok' : 'doctor-issues'"><span class="doctor-status-icon">{{ doctorStatus === 'ok' ? '✓' : '⚠' }}</span><span class="doctor-status-text">{{ doctorStatus === 'ok' ? 'All checks passed' : 'Issues found' }} ({{ doctorChecks.length }} checks)</span></div>
            <div class="doctor-checks-list"><div v-for="check in doctorChecks" :key="check.name" class="doctor-check-item" :class="check.passed ? 'check-passed' : 'check-failed'"><span class="check-icon">{{ check.passed ? '✓' : '✗' }}</span><div class="check-body"><span class="check-name">{{ check.name }}</span><span v-if="check.details" class="check-details">{{ check.details }}</span></div></div></div>
            <div v-if="doctorIssues.length > 0" class="doctor-issues"><h5 class="doctor-issues-title">Issues ({{ doctorIssues.length }})</h5><div v-for="(issue, idx) in doctorIssues" :key="idx" class="doctor-issue-item" :class="'issue-' + issue.severity"><span class="issue-severity-badge" :class="'iss-' + issue.severity">{{ issue.severity }}</span><span class="issue-message">{{ issue.message }}</span></div></div>
          </template>
        </section>

        <section class="debug-section">
          <div class="debug-section-header"><h4 class="debug-section-title">Content Supervision</h4><button class="sv-fetch-btn" :disabled="supervisionLoading" @click="debugStore.fetchSupervision()">Fetch</button></div>
          <div v-if="supervisionLoading" class="debug-loading" style="padding:16px;">Loading supervision data...</div>
          <div v-else-if="supervisionError" class="debug-error" style="padding:16px;">{{ supervisionError }}</div>
          <div v-else-if="supervisionStats === null" class="debug-empty" style="padding:16px;">No supervision data loaded yet. Click Fetch to load.</div>
          <template v-else>
            <div class="sv-stats-grid"><div class="sv-stat-card sv-stat-total"><span class="sv-stat-num">{{ supervisionStats.total }}</span><span class="sv-stat-label">Total Reviews</span></div><div class="sv-stat-card sv-stat-blocked"><span class="sv-stat-num">{{ supervisionStats.blocked }}</span><span class="sv-stat-label">Blocked</span></div><div class="sv-stat-card sv-stat-passed"><span class="sv-stat-num">{{ supervisionStats.passed }}</span><span class="sv-stat-label">Passed</span></div><div class="sv-stat-card sv-stat-sanitized"><span class="sv-stat-num">{{ supervisionStats.sanitized }}</span><span class="sv-stat-label">Sanitized</span></div></div>
            <div v-if="Object.keys(supervisionStats.byRisk).length" class="sv-sub-section"><h5 class="sv-sub-title">By Risk</h5><div class="sv-pills"><span v-for="(count, risk) in supervisionStats.byRisk" :key="risk" class="sv-pill" :class="'risk-' + risk">{{ risk }}: {{ count }}</span></div></div>
            <div v-if="Object.keys(supervisionStats.bySourceKind).length" class="sv-sub-section"><h5 class="sv-sub-title">By Source</h5><div class="sv-pills"><span v-for="(count, kind) in supervisionStats.bySourceKind" :key="kind" class="sv-pill sv-pill-kind">{{ kind }}: {{ count }}</span></div></div>
            <div v-if="supervisionReviews.length > 0" class="sv-sub-section"><h5 class="sv-sub-title">Recent Reviews ({{ supervisionReviews.length }})</h5><div class="sv-review-list"><div v-for="review in supervisionReviews.slice(0, 20)" :key="review.id" class="sv-review-item" :class="'sv-review-' + review.status"><span class="sv-review-status-badge" :class="'sv-st-' + review.status">{{ review.status }}</span><div class="sv-review-body"><span class="sv-review-summary">{{ review.summary }}</span><div class="sv-review-meta"><span class="sv-review-source">{{ review.source_ref }}</span><span class="sv-review-risk" :class="'risk-' + review.risk">{{ review.risk }}</span><span class="sv-review-time">{{ fmtDate(review.created_at) }}</span></div></div></div></div></div>
            <div v-if="supervisionQuarantine.length > 0" class="sv-sub-section"><h5 class="sv-sub-title">Quarantine Index ({{ supervisionQuarantine.length }})</h5><div class="sv-quarantine-list"><div v-for="entry in supervisionQuarantine" :key="entry.quarantine_id" class="sv-q-item"><div class="sv-q-header"><span class="sv-q-id mono">{{ entry.quarantine_id.slice(0, 12) }}...</span><span class="sv-q-risk" :class="'risk-' + entry.risk">{{ entry.risk }}</span></div><div class="sv-q-meta"><span class="sv-q-source mono">{{ entry.source_ref }}</span><span class="sv-q-time">{{ fmtDate(entry.created_at) }}</span></div><button class="sv-q-browse-btn" @click="browseQuarantineItem(entry.quarantine_id)">Browse in Files</button></div></div></div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useDebugStore } from '../stores/debug';
import { formatTimestamp, isRecentTimestamp } from '../utils/timestamp';
import { redactObservabilityValue } from '../utils/observabilityRedaction';
import { useMcpStore } from '../stores/mcp';
import { formatJson } from '../utils/format-json';
import CodeBlock from '../components/code/CodeBlock.vue';
import type { DebugError, DebugTimelineEvent, ProcessView } from '../api/types';
import NotificationsPanel from '../components/cards/NotificationsPanel.vue';

const debugStore = useDebugStore();
const mcpStore = useMcpStore();
const router = useRouter();
const {
  debugRuntime, debugCards, debugTotalCards,
  errors, errorsTotal, errorsBySource,
  sortedTimeline, loading, error,
  processes, processesLoading, processesError,
  processTerminateLoading, processControlError, processControlSuccess, processUnauthorized, processStale,
  doctorStatus, doctorChecks, doctorIssues, doctorLoading, doctorError,
  supervisionReviews, supervisionQuarantine, supervisionStats,
  supervisionLoading, supervisionError,
  operatorNotes, operatorNotesTotal, operatorNotesLoading, operatorNotesError,
  runtimeControlLoading, runtimeControlError, runtimeControlSuccess,
  operatorNoteActionLoading, operatorClearLoading, operatorLastFetchedAt,
  operatorStale, operatorUnauthorized, operatorPartialWarning, operatorDataFreshnessLabel,
} = storeToRefs(debugStore);

type TabId = 'state' | 'operator' | 'errors' | 'timeline' | 'mcp' | 'processes' | 'supervision';
const tabs = [
  { id: 'state' as const, label: 'State' },
  { id: 'operator' as const, label: 'Operator Control' },
  { id: 'errors' as const, label: 'Errors' },
  { id: 'timeline' as const, label: 'Timeline' },
  { id: 'processes' as const, label: 'Processes' },
  { id: 'supervision' as const, label: 'Supervision' },
  { id: 'mcp' as const, label: 'MCP' },
];

const localActiveTab = ref<TabId>('state');
const runtimeStatusLabel = computed(() => !debugRuntime.value ? 'Unavailable' : debugRuntime.value.status === 'frozen' ? 'Frozen' : debugRuntime.value.status === 'paused' ? 'Paused' : debugRuntime.value.status === 'running' ? 'Running' : debugRuntime.value.status === 'idle' ? 'Idle' : 'Error');
const runtimeStatusTone = computed(() => !debugRuntime.value ? 'unavailable' : debugRuntime.value.status);
const runtimeDispatchLabel = computed(() => !debugRuntime.value ? 'Unknown' : debugRuntime.value.paused ? 'Paused' : 'Dispatch active');
const operatorPanelBusy = computed(() => operatorNotesLoading.value || runtimeControlLoading.value !== null || operatorClearLoading.value);
const operatorWarningBannerMessage = computed(() => {
  if (!operatorStale.value && !operatorPartialWarning.value) return null;
  if (runtimeControlError.value) return runtimeControlError.value;
  if (operatorPartialWarning.value) return operatorPartialWarning.value;
  return 'This panel may be stale. Refresh to reconcile with server state.';
});
const clearNotesDisabled = computed(() => operatorUnauthorized.value || operatorNotes.value.length === 0 || operatorClearLoading.value || Object.keys(operatorNoteActionLoading.value).length > 0);
const sortedProcesses = computed(() => [...processes.value].sort((a, b) => { if (a.status === 'running' && b.status !== 'running') return -1; if (a.status !== 'running' && b.status === 'running') return 1; return new Date(b.started_at).getTime() - new Date(a.started_at).getTime(); }));
const selectedTimelineKinds = ref<string[]>([]);
const timelineKindOptions = computed(() => Array.from(new Set(sortedTimeline.value.map((event) => event.kind))).sort());
const filteredTimeline = computed(() => selectedTimelineKinds.value.length === 0 ? sortedTimeline.value : sortedTimeline.value.filter((event) => selectedTimelineKinds.value.includes(event.kind)));

function noteButtonsDisabled(noteId: string): boolean { return operatorUnauthorized.value || operatorClearLoading.value || Boolean(operatorNoteActionLoading.value[noteId]); }
async function refreshOperatorControl(): Promise<void> { await debugStore.fetchOperatorControl().catch(() => {}); }
async function refreshNotes(): Promise<void> { await debugStore.fetchNotes().catch(() => {}); }
async function confirmClearNotes(): Promise<void> { if (!window.confirm('Clear all unhandled operator notes?')) return; await debugStore.clearOperatorNotes(); }
async function confirmTerminateProcess(processId: string): Promise<void> { if (!window.confirm(`Terminate process ${processId}? This sends a termination request to a live Saivage-managed process attached to this server. The server will re-check availability before signaling.`)) return; await debugStore.terminateOperatorProcess(processId); }
function setTab(tab: TabId): void {
  localActiveTab.value = tab;
  if (tab === 'state') debugStore.fetchState().catch(() => {});
  else if (tab === 'operator') debugStore.fetchOperatorControl().catch(() => {});
  else if (tab === 'errors') debugStore.fetchErrors().catch(() => {});
  else if (tab === 'timeline') debugStore.fetchTimeline().catch(() => {});
  else if (tab === 'processes') debugStore.fetchProcesses().catch(() => {});
  else if (tab === 'supervision') { debugStore.fetchDoctor().catch(() => {}); debugStore.fetchSupervision().catch(() => {}); }
  else if (tab === 'mcp') mcpStore.fetchMcpData().catch(() => {});
}
function browseQuarantineItem(quarantineId: string): void { router.push({ name: 'files', query: { path: '.saivage-work/quarantine/' + quarantineId } }); }
function browseProcessLog(path: string): void { router.push({ name: 'files', query: { path } }); }
function processLogEntries(proc: ProcessView): Array<{ key: string; label: string; value: string | null }> { return [{ key: 'combined', label: 'Combined', value: proc.logs.combined }, { key: 'stdout', label: 'Stdout', value: proc.logs.stdout }, { key: 'stderr', label: 'Stderr', value: proc.logs.stderr }]; }
function showTerminateButton(proc: ProcessView): boolean { return !processUnauthorized.value && proc.control.can_terminate && proc.control.terminate_status === 'live-attached'; }
function availabilityLabel(proc: ProcessView): string { return proc.control.terminate_status === 'live-attached' ? 'Live-attached' : proc.control.terminate_status === 'stale-not-attached' ? 'Degraded — not attached' : proc.control.terminate_status === 'already-ended' ? 'Ended' : 'Unknown'; }
function availabilityClass(proc: ProcessView): string { return proc.control.terminate_status === 'live-attached' ? 'process-availability-live' : proc.control.terminate_status === 'stale-not-attached' ? 'process-availability-warning' : proc.control.terminate_status === 'already-ended' ? 'process-availability-ended' : 'process-availability-unknown'; }
function terminateUnavailableCopy(proc: ProcessView): string {
  switch (proc.control.terminate_status) {
    case 'stale-not-attached': return 'Termination unavailable: this record is marked running, but no live server-owned process is attached. Refresh, then inspect host process state before manual cleanup.';
    case 'already-ended': return 'Process has ended; termination is unavailable.';
    case 'unknown': return 'Termination availability is unknown. Refresh and inspect server status before manual cleanup.';
    default: return 'Termination is unavailable for this process.';
  }
}
interface CardStatusEntry { status: string; count: number }
const cardStatusEntries = computed<CardStatusEntry[]>(() => { const counts: Record<string, number> = {}; for (const card of debugCards.value) counts[card.status] = (counts[card.status] || 0) + 1; return Object.entries(counts).map(([status, count]) => ({ status, count })); });
const maxStatusCount = computed(() => Math.max(...cardStatusEntries.value.map((e) => e.count), 1));
interface ErrorSourceEntry { source: string; errors: DebugError[] }
const errorSourceEntries = computed<ErrorSourceEntry[]>(() => { const entries: ErrorSourceEntry[] = []; for (const [source, errs] of errorsBySource.value) entries.push({ source, errors: errs }); return entries; });
function fmtDate(ts: string): string { return formatTimestamp(ts, isRecentTimestamp(ts) ? 'relative' : 'absolute'); }
function formatEventKind(kind: string): string { return kind.replace(/_/g, ' '); }
function timelineKey(event: DebugTimelineEvent): string { return String(event.id || `${event.timestamp}:${event.kind}:${event.card_id || event.goal_id || event.session_id || ''}`); }
function timelineDetails(event: DebugTimelineEvent): Record<string, unknown> { const details: Record<string, unknown> = {}; for (const [key, value] of Object.entries(event)) { if (['id', 'kind', 'timestamp', 'card_id', 'goal_id', 'session_id'].includes(key)) continue; if (value === undefined || value === null) continue; details[key] = value; } return redactObservabilityValue(details); }

onMounted(async () => { debugStore.setupWsListener(); await debugStore.fetchAll(); mcpStore.fetchMcpData().catch(() => {}); mcpStore.startPolling(15000); });
onUnmounted(() => { mcpStore.stopPolling(); });
</script>

<style scoped>
.debug-layout { height:100%; display:flex; flex-direction:column; overflow:hidden; }
.debug-tabs { display:flex; gap:2px; padding:8px 12px; background:#161b22; border-bottom:1px solid #30363d; flex-shrink:0; flex-wrap:wrap; }
.debug-tab { padding:5px 16px; font-size:12px; font-weight:500; color:#8b949e; background:none; border:none; border-radius:4px; cursor:pointer; font-family:inherit; transition:all .15s; }
.debug-tab:hover { color:#c9d1d9; background:#21262d; }
.debug-tab.active { background:#30363d; color:#f0f6fc; }
.debug-content { flex:1; overflow-y:auto; }
.debug-tab-content { padding:16px; }
.debug-loading,.debug-empty,.debug-error { padding:32px; text-align:center; color:#8b949e; font-size:13px; }
.debug-error { color:#f85149; }
.debug-section { margin-bottom:24px; }
.debug-section-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.debug-section-title { font-size:12px; font-weight:600; color:#8b949e; text-transform:uppercase; letter-spacing:.03em; margin:0; }
.debug-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:6px; }
.dg-item { display:flex; gap:8px; }
.dg-key { font-size:12px; color:#8b949e; }
.dg-value { font-size:12px; color:#c9d1d9; }
.dg-value.mono, .mono { font-family:'SF Mono',monospace; font-size:11px; color:#58a6ff; }
.freeze-banner { display:flex; align-items:center; gap:10px; padding:12px 16px; background:#1a1d2e; border:1px solid #5a4fcf; border-radius:8px; margin-bottom:12px; }
.freeze-banner-text { font-size:14px; color:#c9d1d9; display:flex; flex-direction:column; gap:2px; }
.freeze-reason { font-size:12px; color:#8b949e; font-style:italic; }
.freeze-value { color:#7c6ff0; font-weight:600; }
.operator-header { align-items:flex-start; gap:16px; }
.operator-subtitle { margin:6px 0 0; font-size:12px; color:#8b949e; }
.operator-actions-inline { display:flex; gap:8px; flex-wrap:wrap; }
.operator-freshness { margin-bottom:10px; font-size:12px; color:#8b949e; }
.operator-banner { margin-bottom:10px; padding:10px 12px; border-radius:6px; font-size:12px; line-height:1.5; }
.operator-banner-success { background:#1a2418; border:1px solid #254025; color:#7ee787; }
.operator-banner-warning { background:#241f18; border:1px solid #5e4b16; color:#e3b341; }
.operator-banner-error { background:#241818; border:1px solid #5a2525; color:#ff938a; }
.operator-runtime-card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:16px; }
.operator-runtime-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; margin-bottom:12px; }
.operator-freeze-guidance { margin-top:4px; }
.operator-empty-runtime { padding:20px 0; }
.operator-runtime-buttons, .operator-note-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
.operator-button { padding:7px 14px; font-size:12px; color:#c9d1d9; background:#21262d; border:1px solid #30363d; border-radius:6px; cursor:pointer; font-family:inherit; transition:all .15s; }
.operator-button:hover:not(:disabled) { background:#30363d; color:#f0f6fc; }
.operator-button:disabled, .operator-danger-button:disabled, .sv-fetch-btn:disabled { opacity:.5; cursor:not-allowed; }
.operator-danger-button { color:#ff938a; }
.operator-help-text { margin-top:10px; font-size:12px; color:#8b949e; }
.operator-status-badge { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; }
.operator-status-badge.status-running { background:#1a2418; color:#7ee787; }
.operator-status-badge.status-paused { background:#1c2738; color:#58a6ff; }
.operator-status-badge.status-idle { background:#21262d; color:#c9d1d9; }
.operator-status-badge.status-error { background:#241818; color:#f85149; }
.operator-status-badge.status-frozen { background:#1a1d2e; color:#b7a7ff; }
.operator-status-badge.status-unavailable { background:#21262d; color:#8b949e; }
.operator-notes-list { display:flex; flex-direction:column; gap:10px; }
.operator-note-card, .process-card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:12px; }
.operator-note-header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
.operator-note-kind { font-size:10px; font-weight:600; text-transform:uppercase; border-radius:999px; padding:2px 8px; background:#1c2738; color:#58a6ff; }
.operator-note-author { font-size:12px; color:#c9d1d9; }
.operator-note-time { margin-left:auto; font-size:11px; color:#8b949e; }
.operator-note-body { font-size:13px; color:#c9d1d9; white-space:pre-wrap; word-break:break-word; margin-bottom:8px; }
.operator-note-meta { display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:#8b949e; margin-bottom:10px; }
.card-summary-bars { display:flex; flex-direction:column; gap:4px; margin-bottom:12px; }
.csb-row { display:grid; grid-template-columns:80px 1fr 40px; gap:8px; align-items:center; }
.csb-label { font-size:11px; color:#8b949e; text-transform:capitalize; text-align:right; }
.csb-track { height:6px; background:#21262d; border-radius:3px; overflow:hidden; }
.csb-fill { height:100%; border-radius:3px; }
.csb-fill.s-drafting { background:#484f58; }
.csb-fill.s-backlog { background:#8b949e; }
.csb-fill.s-active { background:#58a6ff; }
.csb-fill.s-running { background:#3fb950; }
.csb-fill.s-blocked { background:#d29922; }
.csb-fill.s-done { background:#7ee787; }
.csb-fill.s-failed { background:#f85149; }
.csb-fill.s-cancelled { background:#484f58; }
.csb-count { font-size:11px; color:#c9d1d9; font-family:'SF Mono',monospace; }
.debug-card-list { display:flex; flex-direction:column; gap:2px; }
.dc-item { display:flex; align-items:center; gap:8px; padding:4px 8px; border-radius:4px; font-size:12px; }
.dc-item:hover { background:#161b22; }
.dc-type { width:18px; text-align:center; font-family:'SF Mono',monospace; font-size:10px; font-weight:600; color:#8b949e; }
.dc-title { flex:1; color:#c9d1d9; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-status { font-size:10px; font-weight:600; padding:1px 5px; border-radius:4px; text-transform:uppercase; }
.dc-status.s-drafting { color:#8b949e; background:#21262d; }
.dc-status.s-backlog { color:#c9d1d9; background:#21262d; }
.dc-status.s-active,.dc-status.s-running { color:#58a6ff; background:#1c2738; }
.dc-status.s-blocked { color:#d29922; background:#241f18; }
.dc-status.s-done { color:#7ee787; background:#1a2418; }
.dc-status.s-failed { color:#f85149; background:#241818; }
.dc-status.s-cancelled { color:#484f58; background:#21262d; }
.dc-priority { font-size:10px; color:#8b949e; font-family:'SF Mono',monospace; }
.dc-deps { font-size:10px; color:#484f58; }
.errors-list { display:flex; flex-direction:column; gap:16px; }
.error-source-title { font-size:12px; font-weight:600; color:#8b949e; margin:0 0 6px 0; }
.error-item { padding:8px 12px; background:#161b22; border:1px solid #21262d; border-radius:6px; margin-bottom:6px; border-left:3px solid transparent; }
.error-item.sev-error { border-left-color:#f85149; }
.error-item.sev-warning { border-left-color:#d29922; }
.error-item.sev-info { border-left-color:#58a6ff; }
.error-header { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.error-severity-badge { font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; text-transform:uppercase; }
.error-severity-badge.sev-error { background:#241818; color:#f85149; }
.error-severity-badge.sev-warning { background:#241f18; color:#d29922; }
.error-severity-badge.sev-info { background:#1c2738; color:#58a6ff; }
.error-type { font-size:11px; color:#c9d1d9; font-family:'SF Mono',monospace; }
.error-time { font-size:10px; color:#484f58; margin-left:auto; }
.error-message { font-size:13px; color:#c9d1d9; }
.timeline-filter { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; padding:10px; background:#161b22; border:1px solid #21262d; border-radius:6px; }
.timeline-filter-label { font-size:12px; color:#8b949e; font-weight:600; }
.timeline-filter-select { min-width:220px; max-width:340px; min-height:76px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:6px; font-family:inherit; font-size:12px; }
.timeline-filter-help { font-size:11px; color:#8b949e; }
.timeline-list { display:flex; flex-direction:column; }
.tl-event { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid #21262d; font-size:12px; flex-wrap:wrap; }
.tl-event-type { font-family:'SF Mono',monospace; font-size:11px; color:#58a6ff; font-weight:500; }
.tl-event-card { font-size:10px; color:#8b949e; }
.tl-event-time { font-size:10px; color:#484f58; margin-left:auto; }
.mcp-server-badge { font-size:10px; font-weight:600; padding:1px 5px; border-radius:4px; text-transform:uppercase; margin-left:8px; }
.mcp-server-badge.mcp-status-running { background:#1a2418; color:#7ee787; }
.mcp-server-badge.mcp-status-stopped { background:#21262d; color:#8b949e; }
.mcp-server-badge.mcp-status-error { background:#241818; color:#f85149; }
.mcp-server-transport { font-size:10px; color:#484f58; margin-left:6px; font-family:'SF Mono',monospace; }
.mcp-tool-count { font-size:10px; color:#8b949e; margin-left:6px; }
.mcp-tool-card { padding:8px 12px; background:#161b22; border:1px solid #21262d; border-radius:6px; margin-bottom:6px; }
.process-header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
.process-status-badge { font-size:10px; font-weight:600; padding:2px 8px; border-radius:999px; text-transform:uppercase; }
.process-status-badge.ps-running { background:#1a2418; color:#7ee787; }
.process-status-badge.ps-exited { background:#1c2738; color:#58a6ff; }
.process-status-badge.ps-failed { background:#241818; color:#f85149; }
.process-status-badge.ps-killed { background:#241f18; color:#d29922; }
.process-time { margin-left:auto; font-size:11px; color:#8b949e; }
.process-details, .process-logs { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
.process-subtitle { font-size:11px; font-weight:600; color:#8b949e; text-transform:uppercase; }
.process-availability { margin-bottom:12px; padding:10px 12px; border-radius:6px; border:1px solid #30363d; }
.process-availability-live { background:#1a2418; border-color:#254025; color:#7ee787; }
.process-availability-warning, .process-availability-unknown { background:#241f18; border-color:#5e4b16; color:#e3b341; }
.process-availability-ended { background:#161b22; border-color:#30363d; color:#8b949e; }
.process-availability-reason { margin-top:4px; font-size:12px; line-height:1.5; color:inherit; }
.pd-row { display:flex; gap:8px; align-items:flex-start; }
.pd-key { min-width:120px; font-size:12px; color:#8b949e; }
.pd-value { font-size:12px; color:#c9d1d9; }
.wrap { word-break:break-word; white-space:pre-wrap; }
.process-link-button, .sv-fetch-btn, .sv-q-browse-btn { margin-left:8px; padding:4px 8px; font-size:11px; color:#58a6ff; background:#0d1117; border:1px solid #30363d; border-radius:4px; cursor:pointer; }
.process-empty-note { font-size:12px; color:#8b949e; line-height:1.5; }
.process-controls { margin-top:8px; }
</style>
