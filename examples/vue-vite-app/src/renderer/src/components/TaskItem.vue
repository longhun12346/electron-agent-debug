<script setup lang="ts">
defineProps<{ task: Task }>();
defineEmits<{ toggle: [id: string]; remove: [id: string] }>();
</script>

<template>
  <li class="task" :class="{ done: task.done }">
    <label>
      <input type="checkbox" :checked="task.done" :aria-label="`Done: ${task.title}`" @change="$emit('toggle', task.id)" />
      <span>{{ task.title }}</span>
    </label>
    <small class="who">{{ task.assignee.name }}</small>
    <button type="button" :aria-label="`Remove: ${task.title}`" @click="$emit('remove', task.id)">Remove</button>
  </li>
</template>

<style scoped>
.task { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #e4e7eb; list-style: none; }
.task label { flex: 1; }
.task.done span { text-decoration: line-through; color: #7b8794; }
.who { color: #627d98; }
</style>
