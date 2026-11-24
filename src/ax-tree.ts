
interface AxValue {
  value?: unknown;
}

export interface AxNode {
  nodeId: string;
  backendDOMNodeId?: number;
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
  /** Number of nodes tagged with a ref; only present when refs were requested. */
  refCount?: number;
}

/** Gives the ref of an interactive node, or undefined to leave it untagged. */
export type RefAssigner = (node: AxNode, role: string, name: string) => string | undefined;

// Roles an agent can click or type into. Containers, text and landmarks get no ref: a ref on them would only invite
// clicks that land on whatever happens to be in their centre.
export const interactiveRoles = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "treeitem", "textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox", "ComboBoxSelect",
  "ComboBoxMenuButton", "PopUpButton", "DisclosureTriangle",
]);

const passThroughRoles = new Set([
  "none", "presentation", "generic", "InlineTextBox", "LineBreak", "ignored",
]);
const shownProperties = new Set([
  "disabled", "checked", "expanded", "selected", "focused", "required", "invalid", "level", "url",
]);
const defaultTextLimit = 120;

function clean(value: unknown, limit = defaultTextLimit): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function propertyLabels(node: AxNode, limit: number): string {
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
      labels.push(`[${property.name}=${clean(value, limit)}]`);
    }
  }
  return labels.length ? ` ${labels.join("")}` : "";
}

export interface RenderOptions {
  /** Keep only nodes that get a ref, plus headings for orientation. */
  interactive?: boolean;
  /** Longest name, value or property shown before it is cut with `...` (default 120). */
  maxText?: number;
}

// Headings stay in an interactive rendering so the elements can be told apart by the section they are in.
const landmarkRoles = new Set(["heading"]);

export function renderAxTree(
  nodes: AxNode[],
  maxNodes: number,
  assignRef?: RefAssigner,
  options: RenderOptions = {},
): AxRendering {
  const limit = options.maxText ?? defaultTextLimit;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const lines: string[] = [];
  let truncated = false;
  let refCount = 0;

  const stack: Array<{ node: AxNode; depth: number; parentName: string }> = roots
    .map((node) => ({ node, depth: 0, parentName: "" }))
    .reverse();
  while (stack.length) {
    const { node, depth, parentName } = stack.pop()!;
    const role = clean(node.role?.value) || "unknown";
    const name = clean(node.name?.value, limit);
    // Text already in the name of its parent (a link or button usually names itself after its text) adds nothing.
    const passThrough = node.ignored === true || passThroughRoles.has(role) ||
      (role === "StaticText" && name !== "" && parentName.includes(name)) ||
      (options.interactive === true && !landmarkRoles.has(role) &&
        !(interactiveRoles.has(role) && node.backendDOMNodeId !== undefined));
    let childDepth = depth;
    let childParentName = parentName;
    if (!passThrough) {
      if (lines.length >= maxNodes) {
        truncated = true;
        break;
      }
      const value = clean(node.value?.value, limit);
      const label = `${role}${name ? ` "${name}"` : ""}${value ? ` value="${value}"` : ""}`;
      const ref = assignRef && interactiveRoles.has(role) && node.backendDOMNodeId !== undefined
        ? assignRef(node, role, name)
        : undefined;
      if (ref !== undefined) refCount += 1;
      lines.push(`${"  ".repeat(depth)}${label}${propertyLabels(node, limit)}${ref !== undefined ? ` [ref=${ref}]` : ""}`);
      childDepth = depth + 1;
      childParentName = name;
    } else if (name !== "" && !passThroughRoles.has(role) && node.ignored !== true) {
      // A node left out of an interactive rendering still names its text children.
      childParentName = name;
    }
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is AxNode => child !== undefined);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, depth: childDepth, parentName: childParentName });
    }
  }
  return {
    text: lines.join("\n"),
    nodeCount: lines.length,
    truncated,
    ...(assignRef ? { refCount } : {}),
  };
}
