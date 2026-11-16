import { redact } from "./redact.js";

interface AxValue {
  value?: unknown;
}

export interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value?: AxValue }>;
}

export interface AxRendering {
  text: string;
  nodeCount: number;
  truncated: boolean;
}

const passThroughRoles = new Set([
  "none", "presentation", "generic", "InlineTextBox", "LineBreak", "ignored",
]);
const shownProperties = new Set([
  "disabled", "checked", "expanded", "selected", "focused", "required", "invalid", "level", "url",
]);
const textLimit = 120;

function clean(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > textLimit ? `${text.slice(0, textLimit)}...` : text;
}

function propertyLabels(node: AxNode): string {
  const labels: string[] = [];
  for (const property of node.properties ?? []) {
    if (!shownProperties.has(property.name)) {
      continue;
    }
    const value = property.value?.value;
    if (value === true) {
      labels.push(`[${property.name}]`);
    } else if ((value === false && ["checked", "expanded"].includes(property.name)) ||
        typeof value === "string" || typeof value === "number") {
      labels.push(`[${property.name}=${clean(value)}]`);
    }
  }
  return labels.length ? ` ${labels.join("")}` : "";
}

export function renderAxTree(nodes: AxNode[], maxNodes: number): AxRendering {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const lines: string[] = [];
  let truncated = false;

  const stack: Array<{ node: AxNode; depth: number; parentName: string }> = roots
    .map((node) => ({ node, depth: 0, parentName: "" }))
    .reverse();
  while (stack.length) {
    const { node, depth, parentName } = stack.pop()!;
    const role = clean(node.role?.value) || "unknown";
    const name = clean(node.name?.value);
    const passThrough = node.ignored === true || passThroughRoles.has(role) ||
      (role === "StaticText" && name === parentName);
    let childDepth = depth;
    let childParentName = parentName;
    if (!passThrough) {
      if (lines.length >= maxNodes) {
        truncated = true;
        break;
      }
      const value = clean(node.value?.value);
      const label = `${role}${name ? ` "${name}"` : ""}${value ? ` value="${value}"` : ""}`;
      lines.push(`${"  ".repeat(depth)}${label}${propertyLabels(node)}`);
      childDepth = depth + 1;
      childParentName = name;
    }
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is AxNode => child !== undefined);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, depth: childDepth, parentName: childParentName });
    }
  }
  return { text: redact(lines.join("\n")), nodeCount: lines.length, truncated };
}
