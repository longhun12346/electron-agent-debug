<script setup lang="ts">
import { ref } from "vue";

// The history of changes, newest last. Long enough that the button at the bottom is off screen.
const entries = ref(Array.from({ length: 1500 }, (_, n) => ({ id: n, text: `row ${n}: task list changed` })));
</script>

<template>
  <section>
    <h1>Activity</h1>
    <ul>
      <li v-for="entry in entries" :key="entry.id">{{ entry.text }}</li>
    </ul>
    <p>
      <button type="button" @click="entries = []">Clear history</button>
      <span> {{ entries.length }} entries</span>
    </p>
  </section>
</template>
