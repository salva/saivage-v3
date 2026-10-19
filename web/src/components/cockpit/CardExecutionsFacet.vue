<template>
  <section class="executions-facet" aria-label="Card executions" data-testid="card-executions">
    <header><h2>Executions</h2><button type="button" @click="refresh">Refresh evidence</button></header>
    <p>Retained non-LLM observations, not live status. External effects remain unknown. Agent work remains in Conversations.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading">Loading execution evidence…</p>
    <p v-else-if="!error && rows.length === 0">No retained execution evidence. This does not mean no operation ran.</p>
    <div class="executions-columns">
      <section aria-label="Chronological execution rows">
        <ol><li v-for="row in rows" :key="row.row_id"><button type="button" :aria-pressed="detail?.invocation_id === row.invocation_id" @click="select(row.invocation_id)">{{ row.timestamp }} · {{ row.operation }} v{{ row.contract_version }} · {{ row.binding.kind === 'node' ? `node ${row.binding.node_id}` : 'after_activation_commit hook' }} · {{ row.kind }}<span v-if="row.disposition"> · {{ row.disposition }}</span></button></li></ol>
        <button v-if="cursor" type="button" :disabled="loading" @click="loadMore">More rows</button>
      </section>
      <article v-if="detail" aria-label="Execution detail" data-testid="execution-detail">
        <h3>{{ detail.operation }} · contract v{{ detail.contract_version }}</h3>
        <p>{{ detail.provider.kind }}: {{ detail.provider.name }}</p>
        <p>{{ detail.completion }}</p>
        <dl>
          <dt>Invocation</dt><dd>{{ detail.invocation_id }}</dd>
          <dt>Binding</dt><dd v-if="detail.binding.kind === 'node'">node {{ detail.binding.node_id }} · ordinal {{ detail.binding.ordinal }}</dd><dd v-else>card hook {{ detail.binding.hook }} · committed {{ detail.binding.status }} · artifact {{ detail.binding.committed_card_artifact.entry_id }} v{{ detail.binding.committed_card_artifact.version }}</dd>
          <dt>Activation</dt><dd>{{ detail.binding.activation_id }}</dd>
          <dt>Started</dt><dd>{{ detail.started_at }}</dd><dt>Finished</dt><dd>{{ detail.finished_at ?? 'No completion retained' }}</dd>
          <dt>Disposition / outcome</dt><dd>{{ detail.disposition ?? 'unknown' }} / {{ detail.outcome ?? 'none retained' }}</dd>
          <dt>Summary</dt><dd>{{ detail.summary ?? 'none retained' }}</dd>
          <dt>Leader exit</dt><dd>{{ detail.leader_exit ? JSON.stringify(detail.leader_exit) : 'not observed' }}</dd>
          <dt>Leader error</dt><dd>{{ detail.leader_error ? JSON.stringify(detail.leader_error) : 'not observed' }}</dd>
          <dt>Timeout</dt><dd>{{ detail.timeout_reason ?? 'none retained' }}</dd><dt>Interruption</dt><dd>{{ detail.interruption ?? 'none retained' }}</dd>
          <dt>Group / capture facts</dt><dd><pre>{{ detail.process ? JSON.stringify(detail.process, null, 2) : 'none retained' }}</pre></dd>
        </dl>
        <template v-if="detail.shell"><h4>Command facts (not a workspace snapshot)</h4><pre>{{ detail.shell.script }}</pre><p>Cwd: {{ detail.shell.cwd }}</p><pre>Argv: {{ JSON.stringify(detail.shell.argv) }}</pre></template>
        <h4>Selected inputs / retained fields</h4><pre>{{ JSON.stringify({ input: detail.input, values: detail.values }, null, 2) }}</pre>
        <h4>Observed process starts</h4><ul><li v-for="process in detail.processes" :key="process.process_id">{{ process.process_id }} · {{ process.timestamp }}</li></ul><p v-if="detail.processes_truncated">Additional starts omitted from bounded detail.</p>
        <h4>Selected files</h4><ul><li v-for="file in detail.files" :key="file.key"><button type="button" @click="preview(file.key)">{{ file.label }}</button> · {{ file.source === 'current' ? 'mutable current workspace source (not historical content)' : 'captured output' }} <span v-if="file.observed_at">· observed {{ file.observed_at }} · {{ file.size }} bytes</span> <button type="button" @click="download(file.key)">Download redacted text</button></li></ul>
        <p v-for="path in detail.absent_artifacts" :key="path">Absent artifact: {{ path }} (no file link)</p>
        <pre v-if="previewContent !== null" data-testid="execution-file-preview">{{ previewContent }}</pre>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { listCardExecutions, getCardExecution, getCardExecutionFile, downloadCardExecutionFile } from '../../api/client';
import type { OperatorApiSuccess } from '../../api/contracts';
const props = defineProps<{ cardId: string }>();
const rows = ref<OperatorApiSuccess<'cards.executions.list'>['rows']>([]);
const detail = ref<OperatorApiSuccess<'cards.executions.get'> | null>(null);
const cursor = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const previewContent = ref<string | null>(null);
let lifetime = new AbortController();
let selection = new AbortController();
let fileRequest = new AbortController();
function message(caught: unknown) { return caught instanceof Error ? caught.message : 'Execution evidence unavailable.'; }
async function loadMore() {
  const signal = lifetime.signal;
  loading.value = true;
  error.value = null;
  try { const result = await listCardExecutions(props.cardId, cursor.value ?? undefined, signal); if (!signal.aborted) { rows.value.push(...result.rows); cursor.value = result.next_cursor; } }
  catch (caught) { if (!signal.aborted) error.value = message(caught); }
  finally { if (!signal.aborted) loading.value = false; }
}
function refresh() { lifetime.abort(); selection.abort(); fileRequest.abort(); lifetime = new AbortController(); rows.value = []; detail.value = null; cursor.value = null; previewContent.value = null; void loadMore(); }
async function select(invocationId: string) {
  selection.abort(); fileRequest.abort(); selection = new AbortController(); const signal = selection.signal;
  detail.value = null; previewContent.value = null; error.value = null;
  try { const result = await getCardExecution(props.cardId, invocationId, signal); if (!signal.aborted) detail.value = result; }
  catch (caught) { if (!signal.aborted) error.value = message(caught); }
}
async function preview(key: string) {
  if (!detail.value) return;
  fileRequest.abort(); fileRequest = new AbortController(); const signal = fileRequest.signal;
  previewContent.value = null; error.value = null;
  try { const result = await getCardExecutionFile(props.cardId, detail.value.invocation_id, key, signal); if (!signal.aborted) previewContent.value = result.content; }
  catch (caught) { if (!signal.aborted) error.value = message(caught); }
}
async function download(key: string) {
  if (!detail.value) return;
  const signal = selection.signal;
  try { const blob = await downloadCardExecutionFile(props.cardId, detail.value.invocation_id, key, signal); if (signal.aborted) return; const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'execution-output.txt'; link.click(); URL.revokeObjectURL(url); }
  catch (caught) { if (!signal.aborted) error.value = message(caught); }
}
watch(() => props.cardId, refresh, { immediate: true });
onBeforeUnmount(() => { lifetime.abort(); selection.abort(); fileRequest.abort(); });
</script>

<style scoped>
.executions-facet { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.executions-columns { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(0, 2fr); gap: 20px; }
li { margin-bottom: 10px; overflow-wrap: anywhere; }
button { text-align: left; }
pre, dd { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 8px; }
dt { font-weight: 600; }
@media (max-width: 900px) { .executions-columns { grid-template-columns: 1fr; } }
</style>
