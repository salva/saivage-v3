<template>
  <div class="stale-warning-ribbon" role="status">
    <strong>Card update available.</strong>
    <span>This card changed after the current detail snapshot loaded. Refresh card history before trusting the completion state.</span>
  </div>
</template>

<script setup lang="ts">
</script>

<style scoped>
.stale-warning-ribbon {
  margin: 0 0 12px 0;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid #5e4b16;
  background: #241f18;
  color: #e3b341;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
</style>
