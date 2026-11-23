import { z } from "zod";
import { defineTool, toolResult } from "./definition.js";

const ref = z.string().regex(/^e\d+$/u, "ref 形如 e12，取自 electron_dom_snapshot 的 [ref=…]");

const clickSchema = z.object({
  ref,
  doubleClick: z.boolean().optional(),
});

const typeSchema = z.object({
  ref,
  text: z.string().max(10_000),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
});

const afterAction = "返回 afterSeq（操作前的时间线位置），把它传给 electron_wait_for 的 log.afterSeq 或 electron_logs 的 afterSeq，" +
  "等待并查看操作引起的结果；工具本身不等待。ELECTRON_DEBUG_ALLOW_EVAL=0 时不可用。";

export const interactionTools = [
  defineTool({
    name: "electron_click",
    title: "Click an element in the renderer",
    description:
      "点击当前 renderer target 里 electron_dom_snapshot 标了 [ref=…] 的元素，用真实鼠标事件（isTrusted 为 true）。" +
      "先滚动到可见处，点击元素中心；中心被其他元素挡住时返回 ELEMENT_COVERED 而不点击，禁用时返回 ELEMENT_DISABLED，" +
      "页面重新加载或元素已移除时返回 REF_STALE（重新取快照）。" + afterAction,
    inputSchema: clickSchema,
    handler: async (manager, input) => {
      const result = await manager.inspector.click(input);
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_type",
    title: "Type text into an element in the renderer",
    description:
      "向 electron_dom_snapshot 标了 [ref=…] 的文本框、textarea 或 contenteditable 输入文字：聚焦后默认全选已有内容并替换" +
      "（clear 为 false 时追加到末尾），用 Input.insertText 写入，产生真实的 input 事件，支持中文，受控组件（如 React）也能收到。" +
      "submit 为 true 时最后按 Enter。不是可编辑元素时立即返回 ELEMENT_NOT_EDITABLE。返回输入后的 value（密码框脱敏）。" +
      "不产生输入法组合事件（composition）。" + afterAction,
    inputSchema: typeSchema,
    handler: async (manager, input) => {
      const result = await manager.inspector.type(input);
      return toolResult(result, !result.ok);
    },
  }),
];
