<template>
  <button
    :type="type"
    class="ui-button"
    :class="[`ui-button--${variant}`, `ui-button--${size}`]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  type?: 'button' | 'submit' | 'reset';
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'icon';
  disabled?: boolean;
}>(), {
  type: 'button',
  variant: 'default',
  size: 'md',
  disabled: false,
});
</script>

<style scoped>
.ui-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-3);
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s, opacity 0.15s;
}
.ui-button--sm { padding: 3px 10px; font-size: 11px; }
.ui-button--md { padding: 6px 16px; font-size: 13px; }
.ui-button--icon { width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
.ui-button--primary { background: var(--accent); border-color: var(--accent); color: var(--text); }
.ui-button--danger { color: var(--danger); }
.ui-button--ghost { background: transparent; }
.ui-button:hover:not(:disabled) { background: var(--border); }
.ui-button--primary:hover:not(:disabled) { background: var(--accent); }
.ui-button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
