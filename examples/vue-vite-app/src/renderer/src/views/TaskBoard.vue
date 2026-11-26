<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import TaskItem from "../components/TaskItem.vue";
import { useTasksStore } from "../stores/tasks";

const store = useTasksStore();
const title = ref("");
const query = ref("");
const lastSync = ref("never");
let stopListening = () => {};

onMounted(() => {
  void store.load();
  stopListening = window.api.onSyncDone(({ at }) => { lastSync.value = at; });
});
onBeforeUnmount(() => stopListening());

function sync() {
  window.api.startSync();
}

async function onImport(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.[0]) await store.importFile(input.files[0]);
  input.value = "";
}

async function submit() {
  if (!title.value.trim()) return;
  await store.add(title.value);
  title.value = "";
}
</script>

<template>
  <section>
    <h1>Tasks</h1>
    <p v-if="store.error" class="banner" role="alert">{{ store.error }}</p>
    <form @submit.prevent="submit">
      <input v-model="title" type="text" aria-label="New task" placeholder="What needs doing?" />
      <button type="submit">Add</button>
    </form>
    <input v-model="query" type="search" aria-label="Search tasks" placeholder="Search" @input="store.search(query)" />
    <label>Import <input type="file" accept="application/json" aria-label="Import tasks" @change="onImport" /></label>
    <p>{{ store.openCount }} open of {{ store.tasks.length }}</p>
    <ul>
      <TaskItem v-for="task in store.visible" :key="task.id" :task="task" @toggle="store.toggle" @remove="store.remove" />
    </ul>
    <p>
      <button type="button" @click="sync">Sync</button>
      <span> Last sync: {{ lastSync }}</span>
    </p>
  </section>
</template>

<style scoped>
form { display: flex; gap: 8px; margin: 12px 0; }
form input { flex: 1; }
input[type="search"] { width: 100%; box-sizing: border-box; padding: 6px 8px; }
ul { padding: 0; }
</style>
