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
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}
.ui-button--sm { padding: var(--space-1) var(--space-5); font-size: var(--font-size-sm); }
.ui-button--md { padding: var(--space-4) var(--space-6); font-size: var(--font-size-base); }
.ui-button--icon { width: var(--space-9); height: var(--space-9); padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: var(--font-size-lg); }
.ui-button--primary { background: var(--accent); border-color: var(--accent); color: var(--text); }
.ui-button--danger { color: var(--danger); }
.ui-button--ghost { background: transparent; }
.ui-button:hover:not(:disabled) { background: var(--border); }
.ui-button--primary:hover:not(:disabled) { background: var(--accent); }
.ui-button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
