import { createRouter, createWebHashHistory } from "vue-router";
import Activity from "./views/Activity.vue";
import Settings from "./views/Settings.vue";
import TaskBoard from "./views/TaskBoard.vue";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "tasks", component: TaskBoard },
    { path: "/activity", name: "activity", component: Activity },
    { path: "/settings", name: "settings", component: Settings },
  ],
});

router.afterEach((to) => {
  document.title = to.name === "settings" ? "Settings - Task Board" : "Task Board";
});

export default router;
