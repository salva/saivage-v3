<template>
  <Dialog :visible="true" title-id="image-preview-title" @dismiss="emit('close')">
    <div class="image-preview">
      <header>
        <h2 id="image-preview-title">{{ selection.kind === 'conversation' ? 'Image shown to model' : 'Current source' }}</h2>
        <p v-if="selection.kind === 'conversation'">Recorded model-input snapshot; not proof of delivery or perception</p>
        <p>{{ label }}</p>
        <p v-if="selection.kind === 'conversation'">{{ selection.image.metadata }}</p>
        <div class="controls">
          <button :aria-pressed="mode === 'fit'" @click="mode = 'fit'">Fit</button>
          <button :aria-pressed="mode === 'actual'" @click="mode = 'actual'">1:1</button>
          <template v-if="count > 1">
            <button :disabled="position === 0" @click="emit('navigate', -1)">Previous image</button>
            <button :disabled="position === count - 1" @click="emit('navigate', 1)">Next image</button>
          </template>
          <button @click="load">Refresh image</button>
          <button @click="emit('close')">Close / Return to {{ selection.kind === 'conversation' ? 'conversation' : 'Files' }}</button>
        </div>
      </header>
      <div ref="viewport" class="image-viewport" tabindex="0" aria-label="Image viewport">
        <p v-if="loading" role="status">Loading image…</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
        <img v-if="url" :key="url" :src="url" alt="Selected image" :style="imageStyle" @load="decoded" @error="decodeFailed" />
      </div>
    </div>
  </Dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Dialog from '../components/ui/Dialog.vue';
import { getConversationImage, getFileImage, OperatorApiError } from '../api/client';
import type { PreviewSelection } from '../utils/conversation-images';
const props = withDefaults(defineProps<{ selection: PreviewSelection; position?: number; count?: number }>(), { position: 0, count: 1 });
const emit = defineEmits<{ close: []; navigate: [delta: number] }>();
const viewport = ref<HTMLElement | null>(null);
const url = ref('');
const loading = ref(true);
const error = ref('');
const width = ref(0);
const height = ref(0);
const available = ref({ width: 0, height: 0 });
const mode = ref<'fit' | 'actual'>('fit');
let controller: AbortController | undefined;
let resizeObserver: ResizeObserver | undefined;
const label = computed(() => props.selection.kind === 'conversation'
  ? `Content ${props.selection.image.locator.content_index + 1} · Sent ${props.selection.image.width} × ${props.selection.image.height}`
  : `${props.selection.path}${width.value ? ` · Decoded ${width.value} × ${height.value}` : ''}`);
const imageStyle = computed(() => {
  const scale = mode.value === 'actual' || !width.value ? 1 : Math.min(1, available.value.width / width.value, available.value.height / height.value);
  return { width: `${width.value * scale}px`, height: `${height.value * scale}px`, visibility: width.value ? 'visible' as const : 'hidden' as const };
});
function clearPixels(): void {
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = '';
  width.value = height.value = 0;
}
async function load(): Promise<void> {
  controller?.abort();
  const owner = new AbortController();
  controller = owner;
  clearPixels();
  loading.value = true;
  error.value = '';
  try {
    const blob = props.selection.kind === 'conversation' ? await getConversationImage(props.selection.image.locator, owner.signal) : await getFileImage(props.selection.path, owner.signal);
    if (owner.signal.aborted || controller !== owner) return;
    url.value = URL.createObjectURL(blob);
  } catch (failure) {
    if (owner.signal.aborted || controller !== owner) return;
    loading.value = false;
    error.value = failure instanceof OperatorApiError ? failure.isUnauthorized ? 'Unauthorized: image unavailable' : `Image unavailable: ${failure.message}` : 'Image preview failed';
  }
}
function decoded(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  if (image.getAttribute('src') !== url.value) return;
  width.value = image.naturalWidth;
  height.value = image.naturalHeight;
  loading.value = false;
}
function decodeFailed(event: Event): void {
  if ((event.currentTarget as HTMLImageElement).getAttribute('src') !== url.value) return;
  clearPixels(); loading.value = false; error.value = 'Image decode failed';
}
watch(() => props.selection, () => { mode.value = 'fit'; void load(); void nextTick(() => viewport.value?.scrollTo(0, 0)); }, { immediate: true });
onMounted(async () => {
  await nextTick();
  resizeObserver = new ResizeObserver(() => {
    if (viewport.value) available.value = { width: viewport.value.clientWidth, height: viewport.value.clientHeight };
  });
  if (viewport.value) resizeObserver.observe(viewport.value);
});
onBeforeUnmount(() => { controller?.abort(); clearPixels(); resizeObserver?.disconnect(); });
</script>
<style scoped>
.image-preview { width:min(96vw, 1400px); height:92dvh; background:var(--bg); color:var(--text); display:flex; flex-direction:column; padding:12px; box-sizing:border-box; }
header { flex:none; min-width:0; overflow-wrap:anywhere; }
h2 { margin:0; font-size:18px; } p { margin:4px 0; } .controls { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; }
button { font:inherit; color:var(--text); background:var(--surface-2); border:1px solid var(--border); padding:6px; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
.image-viewport { flex:1; min-height:0; min-width:0; overflow:auto; }
.image-viewport img { display:block; max-width:none; max-height:none; margin:0; }
</style>
