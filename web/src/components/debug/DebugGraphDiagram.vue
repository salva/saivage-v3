<template>
  <div class="graph-inspector">
    <div class="graph-canvas" data-testid="debug-graph-svg">
      <svg :viewBox="`0 0 ${layout.width} ${layout.height}`" role="img" :aria-labelledby="`${titleId} ${descriptionId}`">
        <title :id="titleId">{{ graph.card_type }} compiled workflow</title>
        <desc :id="descriptionId">Lifecycle entries lead to named-agent nodes and the DONE, BLOCKED, and FAILED terminal states. Every labeled edge is keyboard selectable.</desc>
        <defs><marker :id="markerId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>

        <g v-for="(entry, index) in graph.entries" :key="entry.entry">
          <path class="graph-link entry-link" :d="entryPath(index, entry.node_id)" :marker-end="`url(#${markerId})`" />
          <g class="graph-element graph-entry" role="button" tabindex="0" :aria-label="entryDescription(entry)" @click="select('entry', index)" @keydown.enter.prevent="select('entry', index)" @keydown.space.prevent="select('entry', index)">
            <rect x="20" :y="entryY(index)" width="180" height="48" rx="7" />
            <text x="110" :y="entryY(index) + 29" text-anchor="middle">{{ entry.entry }}</text>
          </g>
        </g>

        <g v-for="(edge, index) in graph.edges" :key="`${edge.source_node_id}:${edge.outcome}:${index}`" class="graph-edge-group" role="button" tabindex="0" :aria-label="edgeDescription(edge)" @click="select('edge', index)" @keydown.enter.prevent="select('edge', index)" @keydown.space.prevent="select('edge', index)">
          <path class="graph-link" :class="{ cycle: isCycle(edge), 'runtime-edge': edge.runtime_owned }" :d="edgePath(edge)" :marker-end="`url(#${markerId})`" />
          <text class="edge-label" :x="edgeLabel(edge).x" :y="edgeLabel(edge).y">{{ edge.outcome }}</text>
        </g>

        <g v-for="(node, index) in graph.nodes" :key="node.node_id" class="graph-element graph-node" role="button" tabindex="0" :aria-label="nodeDescription(node)" @click="select('node', index)" @keydown.enter.prevent="select('node', index)" @keydown.space.prevent="select('node', index)">
          <rect :x="nodePoint(node.node_id).x" :y="nodePoint(node.node_id).y" width="230" height="112" rx="9" />
          <text :x="nodePoint(node.node_id).x + 12" :y="nodePoint(node.node_id).y + 23" class="node-title">{{ node.node_id }} · {{ node.agent_name }}</text>
          <text :x="nodePoint(node.node_id).x + 12" :y="nodePoint(node.node_id).y + 44">route: {{ node.model.route }}</text>
          <text :x="nodePoint(node.node_id).x + 12" :y="nodePoint(node.node_id).y + 63">tools: {{ node.tools.length }}</text>
          <text :x="nodePoint(node.node_id).x + 12" :y="nodePoint(node.node_id).y + 82">records: {{ requirementLabel(node) }}</text>
          <text :x="nodePoint(node.node_id).x + 12" :y="nodePoint(node.node_id).y + 101">children: {{ childLabel(node) }}</text>
        </g>

        <g v-for="(terminal, index) in graph.terminals" :key="terminal.terminal" class="graph-element graph-terminal" role="button" tabindex="0" :aria-label="`${terminal.terminal} terminal node`" @click="select('terminal', index)" @keydown.enter.prevent="select('terminal', index)" @keydown.space.prevent="select('terminal', index)">
          <rect :x="layout.terminalX" :y="terminalY(index)" width="150" height="54" rx="27" />
          <text :x="layout.terminalX + 75" :y="terminalY(index) + 33" text-anchor="middle">{{ terminal.terminal }}</text>
        </g>
      </svg>
    </div>
    <aside class="graph-details" aria-live="polite">
      <h5>Graph details</h5>
      <dl class="graph-summary">
        <dt>Permitted children</dt><dd>{{ graph.permitted_child_types.join(', ') || 'none' }}</dd>
        <dt>Records</dt><dd><span v-for="record in graph.records" :key="record.name">{{ record.name }} · {{ record.schema }} · writers {{ record.writers.join(', ') }}<template v-if="record.bootstrap"> · bootstrap</template><br></span></dd>
      </dl>
      <h5>Selected element details</h5>
      <pre>{{ detailJson }}</pre>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type DeepReadonly } from 'vue';
import type { DebugGraph } from '../../api/types';

type Graph = DeepReadonly<DebugGraph>;
const props = defineProps<{ graph: Graph }>();
type Selection = { kind: 'entry' | 'node' | 'edge' | 'terminal'; index: number };
const selection = ref<Selection>({ kind: 'node', index: 0 });
const titleId = computed(() => `debug-graph-title-${props.graph.card_type}`);
const descriptionId = computed(() => `${titleId.value}-description`);
const markerId = computed(() => `${titleId.value}-arrow`);

const layout = computed(() => {
  const layers = new Map<string, number>();
  const queue: string[] = [];
  for (const entry of props.graph.entries) if (!layers.has(entry.node_id)) { layers.set(entry.node_id, 0); queue.push(entry.node_id); }
  while (queue.length) {
    const source = queue.shift()!;
    const nextLayer = (layers.get(source) ?? 0) + 1;
    for (const edge of props.graph.edges) {
      if (edge.runtime_owned || edge.source_node_id !== source || edge.target.kind !== 'node' || layers.has(edge.target.node_id)) continue;
      layers.set(edge.target.node_id, nextLayer);
      queue.push(edge.target.node_id);
    }
  }
  const points = new Map<string, { x: number; y: number; layer: number }>();
  props.graph.nodes.forEach((node, index) => {
    const layer = layers.get(node.node_id) ?? 0;
    points.set(node.node_id, { x: 280 + layer * 300, y: 70 + index * 150, layer });
  });
  const maximumLayer = Math.max(0, ...Array.from(points.values(), (point) => point.layer));
  return { points, terminalX: 280 + (maximumLayer + 1) * 300, width: 780 + maximumLayer * 300, height: Math.max(560, props.graph.nodes.length * 150 + 100) };
});

watch(() => props.graph.card_type, () => { selection.value = { kind: 'node', index: 0 }; });
function select(kind: Selection['kind'], index: number): void { selection.value = { kind, index }; }
function nodePoint(nodeId: string) { return layout.value.points.get(nodeId)!; }
function entryY(index: number): number { return 60 + index * 75; }
function terminalY(index: number): number { return 90 + index * 160; }
function entryPath(index: number, targetId: string): string { const target = nodePoint(targetId); return `M 200 ${entryY(index) + 24} C 235 ${entryY(index) + 24}, 245 ${target.y + 56}, ${target.x} ${target.y + 56}`; }
function targetPoint(edge: Graph['edges'][number]): { x: number; y: number } { if (edge.target.kind === 'node') { const point = nodePoint(edge.target.node_id); return { x: point.x, y: point.y + 56 }; } const terminal = edge.target.terminal; const index = props.graph.terminals.findIndex((candidate) => candidate.terminal === terminal); return { x: layout.value.terminalX, y: terminalY(index) + 27 }; }
function edgePath(edge: Graph['edges'][number]): string { const source = nodePoint(edge.source_node_id); const target = targetPoint(edge); const sx = source.x + 230; const sy = source.y + 56; if (edge.target.kind === 'node' && edge.target.node_id === edge.source_node_id) return `M ${sx - 25} ${source.y} C ${sx + 50} ${source.y - 65}, ${source.x - 50} ${source.y - 65}, ${source.x + 25} ${source.y}`; return `M ${sx} ${sy} C ${(sx + target.x) / 2} ${sy}, ${(sx + target.x) / 2} ${target.y}, ${target.x} ${target.y}`; }
function edgeLabel(edge: Graph['edges'][number]): { x: number; y: number } { const source = nodePoint(edge.source_node_id); const target = targetPoint(edge); return { x: (source.x + 230 + target.x) / 2, y: (source.y + 56 + target.y) / 2 - 7 }; }
function isCycle(edge: Graph['edges'][number]): boolean { return edge.target.kind === 'node' && nodePoint(edge.target.node_id).layer <= nodePoint(edge.source_node_id).layer; }
function requirementLabel(node: Graph['nodes'][number]): string { return node.requirements.length ? node.requirements.map((item) => `${item.record_name}:${item.kind}`).join(', ') : 'none'; }
function childLabel(node: Graph['nodes'][number]): string { const values = [...new Set([...node.child_creation_types, ...node.child_activation_types])]; return values.length ? values.join(', ') : 'none'; }
function nodeDescription(node: Graph['nodes'][number]): string { return `${node.node_id} node, agent ${node.agent_name}, model route ${node.model.route}, ${node.tools.length} tools, requirements ${requirementLabel(node)}`; }
function entryDescription(entry: Graph['entries'][number]): string { return `${entry.entry} lifecycle entry targets ${entry.node_id}${entry.prompt_reference ? ` with prompt ${entry.prompt_reference}` : ''}`; }
function edgeDescription(edge: Graph['edges'][number]): string { const target = edge.target.kind === 'node' ? edge.target.node_id : edge.target.terminal; const exports = edge.export_records.length ? `, exports ${edge.export_records.join(', ')}` : ''; const promotion = edge.promotion ? `, promotion ${edge.promotion.kind}${edge.promotion.kind === 'latest-node' ? ` ${edge.promotion.node_id}` : ''}` : ''; return `${edge.runtime_owned ? 'Runtime-owned ' : ''}${edge.outcome} edge from ${edge.source_node_id} to ${target}${exports}${promotion}`; }
const selectedDetail = computed(() => {
  const selected = selection.value;
  if (selected.kind === 'entry') return props.graph.entries[selected.index];
  if (selected.kind === 'node') return props.graph.nodes[selected.index];
  if (selected.kind === 'edge') return props.graph.edges[selected.index];
  return props.graph.terminals[selected.index];
});
const detailJson = computed(() => JSON.stringify(selectedDetail.value, null, 2));
</script>

<style scoped>
.graph-inspector { display:grid; grid-template-columns:minmax(0, 1fr) minmax(260px, 34%); gap:14px; align-items:start; }
.graph-canvas { overflow:auto; border:1px solid var(--border); border-radius:8px; background:var(--surface-1); min-height:420px; }
svg { display:block; min-width:720px; width:100%; height:auto; }
.graph-link { fill:none; stroke:var(--border-strong); stroke-width:1.8; }
.graph-link.cycle { stroke:var(--warn); stroke-dasharray:7 5; }
.graph-link.runtime-edge { stroke:var(--danger); stroke-dasharray:3 5; }
marker path { fill:var(--border-strong); }
.graph-element { cursor:pointer; outline:none; }
.graph-element rect { fill:var(--bg); stroke:var(--border-strong); stroke-width:1.5; }
.graph-element:focus rect, .graph-element:hover rect { stroke:var(--accent-2); stroke-width:3; }
.graph-entry rect { fill:var(--entry-user-bg); }
.graph-terminal rect { fill:var(--surface-3); }
text { fill:var(--text); font-size:12px; font-family:'SF Mono', monospace; pointer-events:none; }
.node-title { fill:var(--accent-2); font-weight:700; }
.edge-label { fill:var(--text-muted); font-size:10px; text-anchor:middle; }
.graph-edge-group { cursor:pointer; outline:none; }
.graph-edge-group:focus .graph-link, .graph-edge-group:hover .graph-link { stroke:var(--accent-2); stroke-width:3.5; }
.graph-details { border:1px solid var(--border); border-radius:8px; background:var(--surface-1); padding:12px; position:sticky; top:0; }
.graph-details h5 { margin:0 0 10px; color:var(--text-muted); text-transform:uppercase; font-size:11px; }
.graph-summary { margin:0 0 18px; font-size:11px; }
.graph-summary dt { color:var(--text-muted); font-weight:700; margin-top:8px; }
.graph-summary dd { margin:3px 0 0; color:var(--text); }
.graph-details pre { margin:0; color:var(--text); font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; }
@media (max-width: 900px) { .graph-inspector { grid-template-columns:1fr; } .graph-details { position:static; } }
</style>
