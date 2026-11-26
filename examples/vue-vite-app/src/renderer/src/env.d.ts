/// <reference types="vite/client" />

interface Task {
  id: string;
  title: string;
  done: boolean;
  assignee?: { name: string };
}

interface Window {
  api: {
    info(): Promise<{ version: string; platform: string; electron: string; noise: number }>;
    listTasks(): Promise<Task[]>;
    addTask(title: string): Promise<Task>;
    toggleTask(id: string): Promise<Task[]>;
    removeTask(id: string): Promise<Task[]>;
    importTasks(bytes: Uint8Array): Promise<Task[]>;
    searchTasks(query: string): Promise<string[] | null>;
    startSync(): void;
    onSyncDone(callback: (payload: { at: string }) => void): () => void;
    getTheme(): string;
    setTheme(value: string): void;
    openSettingsWindow(): Promise<void>;
  };
}
