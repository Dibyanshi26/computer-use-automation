import type { Page } from "playwright";

/**
 * A pruned, LLM-friendly view of the page's accessibility tree. We expose
 * only interactable / informative nodes with a stable "ref" the model can
 * act on, rather than raw coordinates or raw HTML. This is deliberately the
 * same abstraction available on native desktop apps (OS accessibility
 * APIs), which is the seam that lets the same agent loop design extend
 * beyond a browser (see REPORT.md, Heterogeneity & multi-tenant).
 */
export interface PerceivedNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
}

export interface PerceivedState {
  url: string;
  title: string;
  nodes: PerceivedNode[];
}

const INTERESTING_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "heading",
  "text",
  "listitem",
  "cell",
  "columnheader",
  "alert",
  "dialog",
]);

export async function perceive(page: Page): Promise<PerceivedState> {
  // ariaSnapshotJSON() is the current, documented way to read the accessibility tree
  // (the older page.accessibility.snapshot() API has been removed from Playwright).
  const roots = (await page.ariaSnapshotJSON()) as any[];
  const nodes: PerceivedNode[] = [];
  let counter = 0;

  function walk(node: any) {
    if (!node) return;
    const role = node.role as string;
    const name = (node.name as string) ?? "";
    if (INTERESTING_ROLES.has(role) && (name.trim().length > 0 || role === "textbox" || role === "combobox")) {
      counter += 1;
      nodes.push({
        ref: `n${counter}`,
        role,
        name: name.trim(),
        value: node.value !== undefined ? String(node.value) : undefined,
        disabled: Boolean(node.disabled),
      });
    }
    for (const child of node.children ?? []) walk(child);
  }
  for (const root of roots ?? []) walk(root);

  return { url: page.url(), title: await page.title(), nodes };
}

/** Renders a PerceivedState as compact text for the LLM prompt. */
export function renderPerceivedState(state: PerceivedState): string {
  const lines = state.nodes.map((n) => {
    const bits = [`[${n.ref}] ${n.role} "${n.name}"`];
    if (n.value) bits.push(`value="${n.value}"`);
    if (n.disabled) bits.push("disabled");
    return bits.join(" ");
  });
  return `URL: ${state.url}\nTitle: ${state.title}\nElements:\n${lines.join("\n")}`;
}
