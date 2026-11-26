<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

const info = ref<{ version: string; platform: string; electron: string } | null>(null);
// The theme is read synchronously, so the page never flashes the wrong one.
const theme = ref(window.api.getTheme());

onMounted(async () => { info.value = await window.api.info(); });
watch(theme, (value) => {
  window.api.setTheme(value);
  document.documentElement.dataset.theme = value;
}, { immediate: true });
</script>

<template>
  <section>
    <h1>Settings</h1>
    <label>
      Theme
      <select v-model="theme" aria-label="Theme">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    <dl v-if="info">
      <dt>App version</dt><dd>{{ info.version }}</dd>
      <dt>Electron</dt><dd>{{ info.electron }} on {{ info.platform }}</dd>
    </dl>
  </section>
</template>
