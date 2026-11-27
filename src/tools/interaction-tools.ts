import { z } from "zod";
import { errorResult } from "../errors.js";
import { refPattern, type ElementTarget } from "../interaction.js";
import { defineTool, toolResult } from "./definition.js";

// An element is given by ref, or by role and name; all three stay optional so --tools shows one flat object.
const element = {
  ref: z.string().regex(refPattern, "ref 形如 kqx12，取自 electron_dom_snapshot 的 [ref=…]").optional(),
  role: z.string().min(1).max(100).optional(),
  name: z.string().max(500).optional(),
};

const clickSchema = z.strictObject({
  ...element,
  doubleClick: z.boolean().optional(),
});

const typeSchema = z.strictObject({
  ...element,
  text: z.string().max(10_000),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
});

function elementTarget(input: { ref?: string; role?: string; name?: string }): ElementTarget | undefined {
  if (input.ref !== undefined) {
    return input.role === undefined && input.name === undefined ? { ref: input.ref } : undefined;
  }
  return input.role !== undefined && input.name !== undefined ? { role: input.role, name: input.name } : undefined;
}

const invalidTarget = () => toolResult(errorResult({
  code: "INVALID_ARGUMENT",
  message: "需要 ref，或同时提供 role 和 name（二选一）",
  retryable: false,
}), true);

const locating = "元素用 ref（取自 electron_dom_snapshot 的 [ref=…]）或 role 加 name 指定，二选一。" +
  "role 和 name 与快照行里显示的一致（如 role \"button\"、name \"Save\"），按完全一致在整个页面里查找，不受快照行数上限影响；" +
  "匹配到多个时返回 ELEMENT_AMBIGUOUS 并列出候选，没有时返回 ELEMENT_NOT_FOUND。" +
  "批处理模式每次执行都是新进程，上一次执行的 ref 无效（REF_NOT_FOUND），改用 role 和 name。";

const afterAction = "返回 afterSeq（操作前的时间线位置），把它传给 electron_wait_for 的 log.afterSeq 或 electron_logs 的 afterSeq，" +
  "等待并查看操作引起的结果；工具本身不等待。ELECTRON_DEBUG_ALLOW_EVAL=0 时不可用。";

export const interactionTools = [
  defineTool({
    name: "electron_click",
    title: "Click an element in the renderer",
    description:
      "点击当前 renderer target 里的元素，用真实鼠标事件（isTrusted 为 true）。" + locating +
      "先滚动到可见处，点击元素中心；中心被其他元素挡住时返回 ELEMENT_COVERED 而不点击，禁用时返回 ELEMENT_DISABLED，" +
      "页面重新加载或元素已移除时返回 REF_STALE（重新取快照）。" + afterAction,
    inputSchema: clickSchema,
    handler: async (manager, input) => {
      const target = elementTarget(input);
      if (!target) return invalidTarget();
      const result = await manager.inspector.click({ ...target, doubleClick: input.doubleClick });
      return toolResult(result, !result.ok);
    },
  }),
  defineTool({
    name: "electron_type",
    title: "Type text into an element in the renderer",
    description:
      "向文本框、textarea 或 contenteditable 输入文字。" + locating + "聚焦后默认全选已有内容并替换" +
      "（clear 为 false 时追加到末尾），用 Input.insertText 写入，产生真实的 input 事件，支持中文，受控组件（如 React）也能收到。" +
      "submit 为 true 时最后按 Enter。不是可编辑元素时立即返回 ELEMENT_NOT_EDITABLE。返回输入后的 value（密码框不回显）。" +
      "不产生输入法组合事件（composition）。" + afterAction,
    inputSchema: typeSchema,
    handler: async (manager, input) => {
      const target = elementTarget(input);
      if (!target) return invalidTarget();
      const result = await manager.inspector.type({ ...target, text: input.text, clear: input.clear, submit: input.submit });
      return toolResult(result, !result.ok);
    },
  }),
];
