"use strict";

// A parent is a prerequisite, its children are features requiring it. Retain
// shared edges; render only expanded paths so diamonds do not grow eagerly.
function buildFeatureTree(catalog) {
  const nodes = new Map(catalog.features.map((feature) => [feature.id, feature]));
  for (const feature of catalog.features) for (const id of feature.requires) {
    if (!nodes.has(id)) nodes.set(id, {
      id, title: id, description: "", requires: [], conflicts: [], enabled: null, missing: true,
    });
  }
  const children = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const feature of catalog.features) for (const id of new Set(feature.requires)) children.get(id).push(feature.id);
  for (const ids of children.values()) ids.sort();
  const independent = [...nodes.keys()].filter((id) => !nodes.get(id).requires.length && !children.get(id).length).sort();
  const families = [...nodes.keys()].filter((id) => nodes.get(id).requires.length || children.get(id).length).sort();
  const roots = families.filter((id) => !nodes.get(id).requires.length), covered = new Set();
  const visit = (id) => {
    const pending = [id];
    while (pending.length) {
      const current = pending.pop();
      if (covered.has(current)) continue;
      covered.add(current); pending.push(...children.get(current));
    }
  };
  roots.forEach(visit);
  // A disabled/local cycle has no natural root. Expose its component once;
  // rendering stops when a path reaches an ancestor again.
  for (const id of families) if (!covered.has(id)) { roots.push(id); visit(id); }
  // Subfeatures belong to their feature, rather than representing another
  // package dependency. Count each subfeature, replacing its grouping parent.
  const units = (feature) => feature.subfeatures?.length ? feature.subfeatures : [feature];
  const count = (ids) => catalog.features.filter((feature) => ids.includes(feature.id))
    .reduce((total, feature) => total + units(feature).length, 0);
  for (const feature of catalog.features) for (const item of feature.subfeatures ?? []) {
    const id = `${feature.id}/${item.id}`;
    nodes.set(id, { ...item, id, owner: feature.id, kind: "subfeature", origin: feature.origin, requires: [], conflicts: [] });
    children.set(id, []);
    children.get(feature.id).push(id);
  }
  const counted = catalog.features.flatMap(units);
  return { nodes, children, roots, independent,
    familyCount: count(families), independentCount: count(independent),
    total: counted.length, enabled: counted.filter((item) => item.enabled).length };
}

// Embedded with the upstream settings row, button, theme and active locale.
function renderCommunityFeaturesInGuiSettings({ React, Row, Button, Section, Stack, locale, platform, catalog, buildTree = buildFeatureTree, resources, translate }) {
  const h = React.createElement, language = translate(locale, resources);
  const words = language.messages, format = language.format;
  const tree = buildTree({ ...catalog, features: catalog.features.map(language.feature) });
  const [expanded, setExpanded] = React.useState(false);
  const [opened, setOpened] = React.useState(() => new Set(["dependencies", ...tree.roots.map((id) => `dependencies/${id}`)]));
  const [selected, setSelected] = React.useState(null);
  const [focused, setFocused] = React.useState(tree.roots.length ? "dependencies" : "independent");
  const panelId = React.useId();
  if (platform !== "linux") return null;

  const toggle = (key, value) => setOpened((previous) => {
    const next = new Set(previous);
    if (value ?? !next.has(key)) next.add(key); else next.delete(key);
    return next;
  });
  const select = (id, key) => { setFocused(key); setSelected(id ? { id, key } : null); };
  const icon = (folder) => h("svg", {
    width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
    strokeWidth: 1.2, "aria-hidden": true, style: { flexShrink: 0 },
  }, h("path", { d: folder ? "M1.5 4V3A1 1 0 0 1 2.5 2h4l1.5 2h5.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" : "M3 1.5h6l4 4v9H3Zm6 0v4h4" }));
  const installedCount = (feature) => !feature.enabled ? 0 : feature.subfeatures?.length
    ? feature.subfeatures.filter(item => item.enabled).length : 1;
  const status = (feature) => feature.enabled === null ? words.missing : feature.subfeatures?.length
    ? format("subfeatureStatus", { enabled: installedCount(feature), total: feature.subfeatures.length })
    : feature.enabled ? words.enabled : words.available;
  const statusLabel = (feature) => {
    const installed = installedCount(feature) > 0;
    return h("span", {
      className: "text-xs text-secondary",
      style: { flexShrink: 0, fontWeight: installed ? 600 : 400,
        color: installed ? "var(--color-text-success)" : undefined },
    }, status(feature));
  };
  const renderNode = ({ id, key, parent, level, ancestors = [], collection, ids, count }) => {
    const feature = id ? tree.nodes.get(id) : null, cycle = id != null && ancestors.includes(id);
    const children = ids ?? (cycle ? [] : tree.children.get(id));
    const hasChildren = children.length > 0, open = hasChildren && opened.has(key);
    const label = feature?.title ?? collection, active = selected?.key === key;
    return h("div", {
      key, role: "treeitem", "aria-level": level, "aria-expanded": hasChildren ? open : undefined,
      "aria-selected": active, "aria-label": feature ? format("featureLabel", { name: label, status: status(feature) }) : label,
      "data-path": key, "data-parent": parent, "data-feature": id,
      tabIndex: focused === key ? 0 : -1, className: "focus-visible:outline-auto",
      onFocus: (event) => { if (event.target === event.currentTarget) select(id, key); },
    },
    h("div", {
      className: "text-sm text-default",
      style: { display: "flex", alignItems: "center", gap: "8px", minHeight: "34px", padding: "5px 8px", borderRadius: "6px", background: active ? "var(--color-background-secondary-soft-hover)" : undefined },
      onClick: (event) => { event.currentTarget.closest('[role="treeitem"]').focus(); select(id, key); if (!feature && hasChildren) toggle(key); },
      onDoubleClick: () => { if (feature && hasChildren) toggle(key); },
    },
    h("span", {
      "aria-hidden": true, title: hasChildren ? format(open ? "collapse" : "expand", { name: label }) : undefined,
      style: { width: "14px", flexShrink: 0, cursor: hasChildren ? "pointer" : undefined },
      onClick: hasChildren ? (event) => {
        event.stopPropagation(); event.currentTarget.closest('[role="treeitem"]').focus(); select(id, key); toggle(key);
      } : undefined,
    }, hasChildren ? open ? "▾" : "▸" : ""),
    icon(hasChildren || !feature),
    h("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontWeight: feature ? 400 : 600 }, title: feature?.description }, label),
    !feature && h("span", { className: "text-xs text-secondary" }, String(count ?? ids.length)),
    feature?.kind === "subfeature" && h("span", { className: "text-xs text-secondary" }, words.subfeature),
    feature?.requires.length > 1 && h("span", { className: "text-xs text-secondary" }, words.multiple),
    cycle && h("span", { className: "text-xs text-secondary" }, words.cycle),
    feature && statusLabel(feature)),
    open && h("div", { role: "group", style: { marginInlineStart: "15px", paddingInlineStart: "12px", borderInlineStart: "1px solid var(--color-border)" } },
      children.map((child) => renderNode({ id: child, key: `${key}/${child}`, parent: key, level: level + 1, ancestors: id ? [...ancestors, id] : ancestors }))),
    );
  };
  const onKeyDown = (event) => {
    const item = event.target.closest('[role="treeitem"]');
    if (!item) return;
    const items = [...event.currentTarget.querySelectorAll('[role="treeitem"]')], index = items.indexOf(item);
    const key = item.dataset.path, open = item.getAttribute("aria-expanded");
    let target;
    switch (event.key) {
      case "ArrowDown": target = items[Math.min(index + 1, items.length - 1)]; break;
      case "ArrowUp": target = items[Math.max(index - 1, 0)]; break;
      case "Home": target = items[0]; break;
      case "End": target = items.at(-1); break;
      case "ArrowRight": if (open === "false") toggle(key, true); else if (open === "true") target = items[index + 1]; break;
      case "ArrowLeft": if (open === "true") toggle(key, false); else target = items.find((node) => node.dataset.path === item.dataset.parent); break;
      case "Enter": case " ": select(item.dataset.feature, key); if (open != null) toggle(key); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation(); target?.focus();
  };
  const feature = selected && tree.nodes.get(selected.id);
  const names = (ids) => ids.map((id) => tree.nodes.get(id)?.title ?? id).join(words.separator);
  const detail = feature && h("div", { className: "flex flex-col gap-1" },
    feature.description && h("div", null, feature.description),
    h("div", null, h("code", { title: words.id }, feature.id), feature.origin === "local" ? ` · ${words.local}` : null),
    feature.kind === "subfeature" && h("div", null, format("owner", { name: names([feature.owner]) })),
    feature.requires.length > 0 && h("div", null, format("requires", { names: names(feature.requires) })),
    feature.conflicts.length > 0 && h("div", null, format("conflicts", { names: names(feature.conflicts) })),
  );
  return h(Section, null,
    h(Section.Header, { title: words.title }),
    h(Section.Content, null, h(Stack, null,
      h(Row, {
        label: words.list, description: format("summary", { enabled: tree.enabled, total: tree.total }),
        control: h(Button, {
          color: "secondary", size: "toolbar", onClick: () => setExpanded((value) => !value),
          "aria-expanded": expanded, "aria-controls": expanded ? panelId : undefined,
        }, expanded ? words.hide : words.show),
      }),
      expanded && h("div", { id: panelId, role: "region", "aria-label": words.title },
        h("p", { id: `${panelId}-hint`, className: "text-xs text-secondary", style: { padding: "4px 16px 8px" } }, words.note),
        h("div", {
          role: "tree", "aria-label": words.tree, "aria-describedby": `${panelId}-hint`, onKeyDown,
          style: { maxHeight: "24rem", overflowY: "auto", padding: "0 12px 8px" },
        },
        tree.roots.length > 0 && renderNode({ key: "dependencies", collection: words.families, ids: tree.roots, count: tree.familyCount, level: 1 }),
        tree.independent.length > 0 && renderNode({ key: "independent", collection: words.independent, ids: tree.independent, count: tree.independentCount, level: 1 }),
        catalog.features.length === 0 && h("p", { className: "text-sm text-secondary" }, words.empty)),
        h("div", { role: "region", "aria-label": words.select, style: { borderTop: "1px solid var(--color-border)", minHeight: "60px" } },
          feature ? h(Row, { label: feature.title, description: detail, control: statusLabel(feature), size: "compact", verticalAlignment: "start" })
            : h("p", { className: "text-xs text-secondary", style: { padding: "14px 16px" } }, words.select)),
        catalog.sourceCommit && h("p", { className: "text-xs text-secondary", style: { padding: "4px 16px 8px" } },
          format("snapshot", { revision: catalog.sourceCommit.slice(0, 12) })),
      ),
    )),
  );
}

module.exports = { buildFeatureTree, renderCommunityFeaturesInGuiSettings };
