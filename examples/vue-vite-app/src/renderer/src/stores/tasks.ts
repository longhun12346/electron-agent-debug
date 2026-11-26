import { defineStore } from "pinia";
import { computed, ref } from "vue";

export const useTasksStore = defineStore("tasks", () => {
  const tasks = ref<Task[]>([]);
  const loading = ref(false);
  const error = ref("");

  // Ids that match the search box, or null while it is empty.
  const matches = ref<string[] | null>(null);
  const visible = computed(() => (matches.value === null ? tasks.value : tasks.value.filter((task) => matches.value!.includes(task.id))));
  const openCount = computed(() => tasks.value.filter((task) => !task.done).length);

  async function load() {
    loading.value = true;
    error.value = "";
    try {
      tasks.value = await window.api.listTasks();
    } catch (cause) {
      error.value = "Could not load tasks";
      console.error("load tasks failed", cause);
    } finally {
      loading.value = false;
    }
  }

  async function search(query: string) {
    matches.value = await window.api.searchTasks(query);
  }

  async function add(title: string) {
    const task = await window.api.addTask(title);
    tasks.value.push(task);
  }

  async function toggle(id: string) {
    tasks.value = await window.api.toggleTask(id);
  }

  async function importFile(file: File) {
    tasks.value = await window.api.importTasks(new Uint8Array(await file.arrayBuffer()));
  }

  async function remove(id: string) {
    tasks.value = await window.api.removeTask(id);
  }

  return { tasks, loading, error, visible, openCount, load, search, add, importFile, toggle, remove };
});
