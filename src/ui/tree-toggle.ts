const TREE_TOGGLE_EXPANDED_ICON = "▾";
const TREE_TOGGLE_COLLAPSED_ICON = "▸";

function buildTreeToggleAriaLabel(expanded: boolean, nodeLabel: string): string {
  return `${expanded ? "Collapse" : "Expand"} ${nodeLabel}`;
}

export function setTreeToggleState(
  toggleEl: HTMLButtonElement,
  expanded: boolean,
  nodeLabel: string
): void {
  toggleEl.setAttribute("aria-expanded", String(expanded));
  toggleEl.setAttribute("aria-label", buildTreeToggleAriaLabel(expanded, nodeLabel));
  toggleEl.textContent = expanded ? TREE_TOGGLE_EXPANDED_ICON : TREE_TOGGLE_COLLAPSED_ICON;
}

export function isTreeToggleExpanded(toggleEl: HTMLElement): boolean {
  return toggleEl.getAttribute("aria-expanded") === "true";
}

export function createTreeToggleSpacer(containerEl: HTMLElement): void {
  containerEl.createEl("span", {
    cls: "fmo-tree-toggle-spacer",
    attr: { "aria-hidden": "true" }
  });
}
