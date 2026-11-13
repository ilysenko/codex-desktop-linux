"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { fixture, chunk, carrier, renderModelProvider, renderChatOptions, renderInlineMenu, findNodes, keyboardEvent, keyboardNode } = require("./model-picker-inline-list.test-helpers.js");
const audit = require("./patches/model-picker-inline-list.js");
const picker = require("./patches/model-picker-model-list.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { extractedAppPatch } = require("../../scripts/patches/descriptor.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");

const kinds = ["workRenderer", "workRendererPeer", "dropdownRenderer", "inlineRenderer"];
const nativeCarrier = carrier(["workRenderer", "dropdownRenderer", "inlineRenderer"]);
const assets = {
  "work.current.js": chunk("workRenderer"),
  "async/work-peer.current.js": chunk("workRendererPeer"),
  "async/menu.current.js": carrier(["dropdownRenderer", "inlineRenderer"]),
};
const disabled = { feature: { settings: { tweaks: { modelPicker: { showModelsByDefault: { enabled: false } } } } } };

function rows(menu) { return findNodes(menu.output, node => node.type === "NativeMenuItem"); }
function rowEvent() { return { preventDefault() {} }; }
function withApp(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-inline-list-"));
  const directory = path.join(root, "webview/assets");
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source, { mode: 0o644 });
  }
  const read = name => fs.readFileSync(path.join(directory, name), "utf8");
  const snapshot = () => Object.fromEntries(Object.keys(files).map(name => {
    const file = path.join(directory, name), stat = fs.statSync(file);
    return [name, { source: read(name), mode: stat.mode, inode: stat.ino }];
  }));
  try { return callback({ root, read, snapshot }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const kind of kinds) test(`${kind} is a retained current native factory`, () => {
  const item = fixture[kind];
  assert.equal(crypto.createHash("sha256").update(item.moduleSource).digest("hex"), item.provenance.moduleSha256);
  const [copy] = rspackModuleFactories(chunk(kind), `${kind}.js`);
  assert.equal(audit.inspectInlineModelList(copy).state, "native");
});

for (const kind of ["workRenderer", "workRendererPeer"]) {
  test(`${kind} supplies native inline model rows with valid effort submission`, () => {
    const provider = renderModelProvider(kind, {}, ["high"]);
    const menu = renderInlineMenu({ ...provider.output.props, active: true });
    const models = rows(menu).filter(row => row.key != null);
    assert.deepEqual(models.map(row => row.key), ["model-a", "model-b", "locked"]);
    assert.equal(findNodes(menu.output, node => node.type === "NativeSubmenu").length, 0);
    assert.equal(models[1].props.role, "menuitemradio");
    assert.equal(models[1].props.children.props.displayName, "Model B");
    assert.equal(models[0].props["aria-checked"], true);
    assert.equal(models[0].props.rightIconAsset, "NativeSelectedIcon");
    models[1].props.onSelect(rowEvent());
    assert.deepEqual(provider.events, [["before", "model-b"], ["select", "model-b", "high"], ["complete"], ["view", "simple"]]);
  });

  test(`${kind} retains disabled explanations and native selection guards`, () => {
    const original = renderModelProvider(kind);
    const reason = { id: "disabled-model", defaultMessage: "Unavailable for this account" };
    const modelOptions = original.props.models.map(model => ({ model, disabledReason: model.model === "model-b" ? reason : null }));
    const provider = renderModelProvider(kind, { modelOptions });
    const menu = renderInlineMenu({ ...provider.output.props, active: true });
    const blocked = rows(menu).find(row => row.key === "model-b");
    assert.equal(blocked.props.disabled, true);
    assert.equal(blocked.props.tooltipText.props.defaultMessage, reason.defaultMessage);
    assert.equal(blocked.props.tooltipOnBeforeOpen, undefined);
    blocked.props.onSelect(rowEvent());
    assert.deepEqual(provider.events, [["view", "simple"]]);
    const saving = renderModelProvider(kind, { daybreak: { isSaving: true } });
    renderInlineMenu({ ...saving.output.props, active: true }).output;
    saving.modelListConfig.options.find(option => option.id === "model-b").onSelect();
    assert.deepEqual(saving.events, []);
    const denied = renderModelProvider(kind, { onBeforeSelectModel: () => false });
    denied.modelListConfig.options.find(option => option.id === "model-b").onSelect();
    assert.deepEqual(denied.events, []);
  });

  test(`${kind} typed native wrapper retains its callback context and model configuration`, () => {
    const onCloseAutoFocus = () => {};
    const provider = renderModelProvider(kind, { modelPickerTriggerConfig: null, onCloseAutoFocus });
    assert.equal(provider.nativeRoot.type, "NativeSubmenu");
    assert.equal(provider.output.type, "NativeAdvancedView");
    assert.equal(provider.nativeRoot.props.onOpenChange, provider.props.onOpenChange);
    assert.equal(provider.nativeRoot.props.onCloseAutoFocus, provider.props.onCloseAutoFocus);
    assert.equal(provider.output.props.modelListConfig, provider.modelListConfig);
    provider.modelListConfig.options.find(option => option.id === "model-b").onSelect();
    assert.deepEqual(provider.events, [["before", "model-b"], ["select", "model-b", "low"], ["complete"]]);
  });
}

test("native default-index rows and older models retain their grouping and callbacks", () => {
  const events = [];
  const option = (id, group) => ({ id, group, label: id, onSelect: () => events.push(id) });
  const menu = renderInlineMenu({ active: true, menuView: "advanced", powerSelections: [],
    modelListConfig: { options: [option("first"), option("older", "older"), option("last")],
      defaultOption: { index: 1, onSelect: () => events.push("default") } },
    onToggleMenuView: view => events.push(view) });
  assert.deepEqual(rows(menu).filter(row => row.key != null).map(row => row.key), ["first", "last", "older"]);
  const older = findNodes(menu.output, node => node.type === "NativeOlderSubmenu");
  assert.equal(older.length, 1);
  assert.equal(older[0].props.children[0].key, "older");
  rows(menu).find(row => row.key == null).props.onSelect(rowEvent());
  older[0].props.children[0].props.onSelect(rowEvent());
  assert.deepEqual(events, ["default", "simple", "older", "simple"]);
});

test("Chat native model rows forward the resolved model, effort and version", () => {
  const provider = renderChatOptions();
  const events = [];
  const menu = renderInlineMenu({ active: true, menuView: "advanced", powerSelections: [],
    modelListConfig: provider.modelListConfig, onToggleMenuView: value => events.push(["view", value]) });
  const models = rows(menu);
  assert.deepEqual(models.map(row => row.key), ["version-a", "version-b", "version-limited"]);
  assert.equal(models[1].props.children, "Third-party Model B");
  assert.equal(models[1].props.SubText.props.children, "Model B description");
  assert.equal(models[2].props.disabled, true);
  assert.equal(models[2].props.tooltipText.props.description, "Usage limit reached");
  models[1].props.onSelect(rowEvent());
  assert.deepEqual(provider.events.find(event => event[0] === "select"),
    ["select", { slug: "model-b", thinkingEffort: "high", versionId: "version-b" }]);
  assert.deepEqual(events, [["view", "simple"]]);
});

test("current native extra-model merge excludes existing slugs through its Set projection", () => {
  const { modelListConfig } = renderChatOptions({
    fallbackOptions: [{ slug: "limited", title: "Limited fallback", thinkingEffort: "medium" }],
    extraModels: [
      { slug: "limited", title: "Duplicate limited model", thinkingEffort: "low" },
      { slug: "addon", title: "Additional model", thinkingEffort: "high" },
    ],
  });
  assert.equal(modelListConfig.options.filter(option => option.id === "limited:medium").length, 1);
  assert.equal(modelListConfig.options.some(option => option.id === "limited:low"), false);
  assert.equal(modelListConfig.options.some(option => option.id === "addon:high"), true);
});

test("selected, locked and rate-limited rows retain their native metadata and actions", () => {
  const events = [];
  const option = (id, extra = {}) => ({ id, label: id, onSelect: () => events.push(["select", id]), ...extra });
  const menu = renderInlineMenu({ active: true, menuView: "advanced", powerSelections: [],
    modelListConfig: { options: [option("selected", { selected: true }), option("locked", { selected: true, isLocked: true }),
      option("limited", { isRateLimited: true, disabled: true, subText: "Usage limit", tooltipText: "Try later", focusableWhenDisabled: true })] },
    onConfirmCurrentSelection: () => events.push(["confirm"]), onToggleMenuView: value => events.push(["view", value]) });
  const [selected, locked, limited] = rows(menu);
  selected.props.onSelect(rowEvent());
  locked.props.onSelect(rowEvent());
  assert.deepEqual(events, [["confirm"], ["view", "simple"], ["select", "locked"], ["view", "simple"]]);
  assert.equal(locked.props.rightIcon.type, "NativeLockIcon");
  assert.match(locked.props["aria-describedby"], /native-model-description-/);
  assert.notEqual(limited.props["aria-describedby"], locked.props["aria-describedby"]);
  assert.equal(limited.props.disabled, true);
  assert.equal(limited.props.focusableWhenDisabled, true);
  assert.equal(limited.props.SubText, "Usage limit");
  assert.equal(limited.props.tooltipText, "Try later");
});

test("native keyboard navigation skips disabled and hidden rows and respects slider focus", () => {
  const menu = renderInlineMenu({ active: true, menuView: "advanced", powerSelections: [], modelListConfig: { options: [] } });
  const first = keyboardNode(menu, "first"), blocked = keyboardNode(menu, "blocked", { disabled: true });
  const hidden = keyboardNode(menu, "hidden", { hidden: true }), last = keyboardNode(menu, "last");
  const nodes = [first, blocked, hidden, last];
  assert.deepEqual(keyboardEvent(menu, nodes, first, "ArrowDown"), { prevented: true, stopped: true });
  assert.equal(last.focusCalls.length, 1);
  keyboardEvent(menu, nodes, first, "ArrowUp");
  assert.equal(last.focusCalls.length, 2);
  keyboardEvent(menu, nodes, last, "Tab", true);
  assert.equal(first.focusCalls.length, 1);
  const slider = keyboardNode(menu, "slider", { slider: true });
  assert.deepEqual(keyboardEvent(menu, nodes, slider, "ArrowDown"), { prevented: false, stopped: false });
  keyboardEvent(menu, nodes, first, "Enter");
  assert.equal(menu.refs[2].current, "advanced");
  menu.output.props.onPointerDownCapture();
  assert.equal(menu.refs[2].current, null);
});

test("native focus restoration and delegated tooltip Tab navigation remain reachable", () => {
  const menu = renderInlineMenu({ active: true, menuView: "advanced", powerSelections: [], modelListConfig: { options: [] } });
  const first = keyboardNode(menu, "first"), selected = keyboardNode(menu, "selected");
  const tooltip = keyboardNode(menu, "tooltip", {
    getAttribute: name => name === "aria-describedby" ? "keyboard-help" : null,
    ownerDocument: { getElementById: id => ({ hasAttribute: name => id === "keyboard-help" && name === "data-tooltip-keyboard-navigation" }) },
  });
  assert.deepEqual(keyboardEvent(menu, [first, selected, tooltip], tooltip, "Tab"), { prevented: true, stopped: true });
  keyboardEvent(menu, [first, selected], selected, "Enter");
  menu.refs[1].current = { querySelector: selector => selector.includes("aria-checked") ? selected : first };
  menu.context.document.activeElement = menu.context.document.body;
  const restoreFocus = menu.layoutEffects.find(effect => effect.toString().includes("aria-checked"));
  assert.ok(restoreFocus);
  restoreFocus();
  assert.equal(menu.refs[2].current, null);
  assert.equal(selected.focusCalls.length, 1);
  assert.equal(selected.focusCalls[0].preventScroll, false);
});

test("simple view keeps native model rows hidden and retains its slider surface", () => {
  const menu = renderInlineMenu({ active: true, menuView: "simple", powerSelections: [], modelListConfig: { options: [] } });
  const tracks = findNodes(menu.output, node => node.props?.className === "NativeViewTrack");
  assert.equal(tracks.length, 2);
  const modelTrack = tracks.find(track => track.props.children?.props?.className === "NativeViewPanel" &&
    findNodes(track, node => node.props?.className === "NativeModelListMotion").length > 0);
  assert.equal(modelTrack.props["aria-hidden"], true);
  assert.equal(modelTrack.props.inert, true);
  assert.equal(findNodes(menu.output, node => node.type === "NativeSimpleSlider")[0].props.active, true);
});

test("native capability audits preserve every selected file, mode and inode without writes", () => {
  withApp(assets, ({ root, snapshot }) => {
    const before = snapshot(), originalWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = () => { writes++; throw new Error("native audit attempted a write"); };
    try {
      assert.equal(audit.auditInlineModelListSource(nativeCarrier), nativeCarrier);
      assert.equal(audit.auditInlineModelListSource(nativeCarrier), nativeCarrier);
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = audit.auditInlineModelList(root);
        assert.equal(result.changed, false);
        assert.equal(result.nativePhysicalCopies, 4);
      }
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(writes, 0);
    assert.deepEqual(snapshot(), before);
  });
});

test("normal inline descriptor records native already-applied twice and disabled before discovery", () => {
  const descriptor = extractedAppPatch(picker.descriptors.find(item => item.id === "model-picker-inline-model-list"));
  withApp(assets, ({ root, snapshot }) => {
    const before = snapshot();
    for (let repeat = 0; repeat < 2; repeat++) {
      const report = createPatchReport();
      applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, descriptor.phase);
      assert.equal(report.patches.length, 1);
      assert.equal(report.patches[0].status, "already-applied");
    }
    assert.deepEqual(snapshot(), before);
  });
  assert.equal(picker.applyInlineModelListPatch("unrelated source", disabled), "unrelated source");
  assert.deepEqual(picker.applyInlineModelListToApp("/missing-disabled-inline", disabled), { matched: 0, changed: 0 });
  const report = createPatchReport();
  applyExtractedAppPatchDescriptors("/missing-disabled-inline", [descriptor], disabled, report, descriptor.phase);
  assert.equal(report.patches[0].status, "skipped-disabled");
});

test("readonly audits refuse incomplete, duplicate and unknown native cohorts without modifying files", () => {
  const brokenPeer = chunk("workRendererPeer", `${fixture.workRendererPeer.moduleSource}\n/*changed native peer*/`);
  const cases = [
    { "work.current.js": chunk("workRenderer") },
    { ...assets, "async/menu.current.js": carrier(["dropdownRenderer", "inlineRenderer", "inlineRenderer"]) },
    { ...assets, "async/work-peer.current.js": brokenPeer },
    { ...assets, "async/menu.current.js": carrier(["dropdownRenderer", "inlineRenderer"], {
      inlineRenderer: { moduleSource: fixture.inlineRenderer.moduleSource.replace(
        `for(let ${fixture.testAliases.inlineRows.e} of(${fixture.testAliases.inlineRows.j}=[],${fixture.testAliases.inlineRows.A}=[],${fixture.testAliases.inlineRows.em}.options))`,
        `for(let ${fixture.testAliases.inlineRows.e} of(${fixture.testAliases.inlineRows.j}=[],${fixture.testAliases.inlineRows.A}=[],other.options))`) },
    }) },
  ];
  for (const files of cases) withApp(files, ({ root, snapshot }) => {
    const before = snapshot();
    assert.throws(() => audit.auditInlineModelList(root));
    assert.deepEqual(snapshot(), before);
  });
  const wrongLoader = carrier(["workRenderer", "dropdownRenderer", "inlineRenderer"], { workRenderer: { params: ["e", "l", "wrongLoader"] } });
  assert.throws(() => audit.auditInlineModelListSource(wrongLoader));
  assert.throws(() => audit.auditInlineModelListSource(chunk("inlineRenderer")));
});
