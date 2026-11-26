<script setup lang="ts">
import { onMounted } from "vue";

onMounted(async () => {
  const { noise } = await window.api.info();
  for (let n = 1; n <= noise; n += 1) console.debug(`[hmr] hot update ${n}`);
});
</script>

<template>
  <header class="top">
    <strong>Task Board</strong>
    <nav>
      <RouterLink to="/">Tasks</RouterLink>
      <RouterLink to="/activity">Activity</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
    </nav>
  </header>
  <main>
    <RouterView />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; color: #1f2933; background: #f5f7fa; }
.top { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: #fff; border-bottom: 1px solid #d9e2ec; }
.top nav a { margin-left: 16px; color: #3e4c59; text-decoration: none; }
.top nav a.router-link-active { color: #0b69a3; font-weight: 600; }
main { max-width: 640px; margin: 24px auto; padding: 0 16px; }
button { padding: 6px 12px; border: 1px solid #9fb3c8; border-radius: 4px; background: #fff; cursor: pointer; }
input[type="text"] { padding: 6px 8px; border: 1px solid #9fb3c8; border-radius: 4px; }
.banner { padding: 8px 12px; border-radius: 4px; background: #ffe3e3; color: #a61b1b; }
</style>
