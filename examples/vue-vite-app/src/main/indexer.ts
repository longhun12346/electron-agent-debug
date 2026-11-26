// Search index for the task list. It lives in a utility process so that typing in the search box never blocks the main process.
interface Entry { id: string; title: string }

let entries: Entry[] = [];
let generation = 0;

// Handy to inspect from a debugger.
(globalThis as Record<string, unknown>).indexer = { size: () => entries.length, generation: () => generation };

process.parentPort.on("message", ({ data }) => {
  if (data.type === "index") {
    entries = data.entries;
    generation += 1;
    console.log(`indexer: ${entries.length} tasks (generation ${generation})`);
  } else if (data.type === "search") {
    const needle = String(data.query).toLowerCase();
    const ids = entries.filter((entry) => entry.title.toLowerCase().includes(needle)).map((entry) => entry.id);
    process.parentPort.postMessage({ id: data.id, ids });
  }
});

console.log("indexer ready");
