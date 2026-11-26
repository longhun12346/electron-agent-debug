import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface Task {
  id: string;
  title: string;
  done: boolean;
  assignee?: { name: string };
}

const seed: Task[] = [
  { id: "t1", title: "Write the release notes", done: false, assignee: { name: "Mei" } },
  { id: "t2", title: "Review the pull request", done: true, assignee: { name: "Arjun" } },
];

// Tasks live in one JSON file under the user data directory.
export class TaskStore {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  list(): Task[] {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Task[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.save(seed);
        return seed;
      }
      throw error;
    }
  }

  add(title: string, withAssignee: boolean): Task {
    const task: Task = { id: randomUUID(), title: title.trim(), done: false };
    if (withAssignee) task.assignee = { name: "Me" };
    this.save([...this.list(), task]);
    return task;
  }

  toggle(id: string): Task[] {
    const tasks = this.list().map((task) => (task.id === id ? { ...task, done: !task.done } : task));
    this.save(tasks);
    return tasks;
  }

  remove(id: string): Task[] {
    const tasks = this.list().filter((task) => task.id !== id);
    this.save(tasks);
    return tasks;
  }

  private save(tasks: Task[]): void {
    writeFileSync(this.file, JSON.stringify(tasks, null, 2));
  }
}
