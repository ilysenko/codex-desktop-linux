"use strict";

// A parent is a prerequisite, its children are features requiring it. Retain
// shared edges; render only expanded paths so diamonds do not grow eagerly.
function buildFeatureTree(catalog, locale = "en") {
  const nodes = new Map(catalog.features.map((feature) => [feature.id, feature]));
  const collator = new Intl.Collator(locale.replaceAll("_", "-"), {
    numeric: true, sensitivity: "base", ...(locale.startsWith("zh") ? { collation: "pinyin" } : {}),
  });
  const compare = (a, b) => collator.compare(nodes.get(a).title ?? a, nodes.get(b).title ?? b)
    || (a < b ? -1 : a > b ? 1 : 0);
  for (const feature of catalog.features) for (const id of feature.requires) {
    if (!nodes.has(id)) nodes.set(id, {
      id, title: id, description: "", requires: [], conflicts: [], enabled: null, missing: true,
    });
  }
  const children = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const feature of catalog.features) for (const id of new Set(feature.requires)) children.get(id).push(feature.id);
  const ids = [...nodes.keys()].sort();
  const roots = ids.filter((id) => !nodes.get(id).requires.length), covered = new Set();
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
  for (const id of ids) if (!covered.has(id)) { roots.push(id); visit(id); }
  // Subfeatures belong to their feature, rather than representing another
  // package dependency. Count each subfeature, replacing its grouping parent.
  const units = (feature) => feature.subfeatures?.length ? feature.subfeatures : [feature];
  for (const feature of catalog.features) for (const item of feature.subfeatures ?? []) {
    const id = `${feature.id}/${item.id}`;
    nodes.set(id, { ...item, id, owner: feature.id, kind: "subfeature", origin: feature.origin, requires: [], conflicts: [] });
    children.set(id, []);
    children.get(feature.id).push(id);
  }
  roots.sort(compare);
  for (const ids of children.values()) ids.sort(compare);
  const counted = catalog.features.flatMap(units);
  return { nodes, children, roots,
    total: counted.length, enabled: counted.filter((item) => item.enabled).length };
}

// Embedded with the upstream settings row, button, theme and active locale.
function renderCommunityFeaturesInGuiSettings({ React, Row, Button, Section, Stack, locale, platform, catalog, buildTree = buildFeatureTree, resources, translate }) {
  const h = React.createElement, language = translate(locale, resources);
  const words = language.messages, format = language.format;
  const tree = buildTree({ ...catalog, features: catalog.features.map(language.feature) }, language.locale);
  const [expanded, setExpanded] = React.useState(false);
  const [opened, setOpened] = React.useState(() => new Set());
  const [selected, setSelected] = React.useState(null);
  const [focused, setFocused] = React.useState(tree.roots[0]);
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
  const installedCount = (feature) => feature.enabled ? feature.subfeatures.filter(item => item.enabled).length : 0;
  const status = (feature) => feature.enabled === null ? words.missing : feature.enabled ? words.enabled : words.available;
  const statusLabel = (text, installed) => h("span", {
    className: "text-xs text-secondary",
    style: { flexShrink: 0, fontWeight: installed ? 600 : 400,
      color: installed ? "var(--color-text-success)" : undefined },
  }, text);
  const renderNode = ({ id, key, parent, level, ancestors = [] }) => {
    const feature = tree.nodes.get(id), cycle = ancestors.includes(id);
    const children = cycle ? [] : tree.children.get(id);
    const subfeatures = children.filter((child) => tree.nodes.get(child)?.kind === "subfeature");
    const dependents = children.filter((child) => tree.nodes.get(child)?.kind !== "subfeature");
    const sectioned = subfeatures.length > 0;
    const hasChildren = children.length > 0, open = hasChildren && opened.has(key);
    const label = feature.title, active = selected?.key === key;
    const renderChildren = (ids) => ids.map((child) => renderNode({ id: child, key: `${key}/${child}`, parent: key, level: level + 1, ancestors: id ? [...ancestors, id] : ancestors }));
    const childGroup = (ids, message, summary) => {
      const label = format(message, { count: ids.length });
      return h("div", { key: message, role: "group", "aria-label": summary ? format("featureLabel", { name: label, status: summary.text }) : label },
        h("div", { className: "text-xs text-secondary", "aria-hidden": true,
          style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px 2px" } },
          h("span", { style: { flex: 1 } }, label), summary && statusLabel(summary.text, summary.installed)),
        renderChildren(ids));
    };
    return h("div", {
      key, role: "treeitem", "aria-level": level, "aria-expanded": hasChildren ? open : undefined,
      "aria-selected": active, "aria-label": format("featureLabel", { name: label, status: status(feature) }),
      "data-path": key, "data-parent": parent, "data-feature": id,
      tabIndex: focused === key ? 0 : -1, className: "focus-visible:outline-auto",
      onFocus: (event) => { if (event.target === event.currentTarget) select(id, key); },
    },
    h("div", {
      className: "text-sm text-default",
      style: { display: "flex", alignItems: "center", gap: "8px", minHeight: "34px", padding: "5px 8px", borderRadius: "6px", background: active ? "var(--color-background-secondary-soft-hover)" : undefined },
      onClick: (event) => { event.currentTarget.closest('[role="treeitem"]').focus(); select(id, key); },
      onDoubleClick: () => { if (hasChildren) toggle(key); },
    },
    h("span", {
      "aria-hidden": true, title: hasChildren ? format(open ? "collapse" : "expand", { name: label }) : undefined,
      style: { width: "14px", flexShrink: 0, cursor: hasChildren ? "pointer" : undefined },
      onClick: hasChildren ? (event) => {
        event.stopPropagation(); event.currentTarget.closest('[role="treeitem"]').focus(); select(id, key); toggle(key);
      } : undefined,
    }, hasChildren ? open ? "▾" : "▸" : ""),
    icon(hasChildren),
    h("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontWeight: 400 }, title: feature.description }, label),
    feature?.requires.length > 1 && h("span", { className: "text-xs text-secondary" }, words.multiple),
    cycle && h("span", { className: "text-xs text-secondary" }, words.cycle),
    statusLabel(status(feature), feature.enabled === true)),
    open && h("div", { role: sectioned ? undefined : "group", style: { marginInlineStart: "15px", paddingInlineStart: "12px", borderInlineStart: "1px solid var(--color-border)" } },
      sectioned ? [childGroup(subfeatures, "subfeatureGroup", {
        text: format("subfeatureStatus", { enabled: installedCount(feature), total: subfeatures.length }),
        installed: installedCount(feature) > 0,
      }), dependents.length > 0 && childGroup(dependents, "dependentGroup")] : renderChildren(children)),
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
        tree.roots.map((id) => renderNode({ id, key: id, level: 1 })),
        catalog.features.length === 0 && h("p", { className: "text-sm text-secondary" }, words.empty)),
        h("div", { role: "region", "aria-label": words.select, style: { borderTop: "1px solid var(--color-border)", minHeight: "60px" } },
          feature ? h(Row, { label: feature.title, description: detail, control: statusLabel(status(feature), feature.enabled === true), size: "compact", verticalAlignment: "start" })
            : h("p", { className: "text-xs text-secondary", style: { padding: "14px 16px" } }, words.select)),
        catalog.sourceCommit && h("p", { className: "text-xs text-secondary", style: { padding: "4px 16px 8px" } },
          format("snapshot", { revision: catalog.sourceCommit.slice(0, 12) })),
      ),
    )),
  );
}

module.exports = { buildFeatureTree, renderCommunityFeaturesInGuiSettings };
