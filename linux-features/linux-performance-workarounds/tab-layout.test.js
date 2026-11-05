"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { applyLinuxAppShellTabLayoutPerformancePatch: apply, matchesLinuxAppShellTabLayoutPerformanceContract: matches } = require("./implementation.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const descriptor = require("./patch.js").filter(row => row.id === "app-shell-tab-layout");
const ID = "[A-Za-z_$][\\w$]*";

const fixture = 'function strip(entries){let selected,presented,renaming,layout,motion,position,width,transition,widths;' +
  'let rendered=entries.map((entry,index)=>{let active=selected===entry.id,next=entries[index+1],separator=index<entries.length-1&&!active&&selected!==next?.id,view=entry.render({' +
  'disabled:entry.disabled,isActive:active,isClosable:entry.isClosable,isPresented:presented===entry.id,isRenaming:renaming===entry.id,' +
  'animateLayout:layout,animateExit:motion&&!position,animatePosition:motion&&position,animateWidth:width,layoutTransition:transition,targetWidth:widths[index],' +
  'onActionsWidthChange:value=>{setWidths(previous=>{if((previous[entry.key]??0)===value)return previous;let next={...previous};return 0===value?delete next[entry.key]:next[entry.key]=value,next})},' +
  'onRenamingChange:value=>{value&&clearPending(null),setRenaming(previous=>value?{id:entry.id,key:entry.key}:previous?.id===entry.id&&previous.key===entry.key?null:previous)},' +
  'trailingDecoration:(0,ui.jsx)("div",{"aria-hidden":!0,"data-app-shell-tab-separator":entry.id,"data-app-shell-tab-separator-index":index,className:(0,classes.A)("separator",separator?"show":"hide") }),' +
  'tabButtonProps:{"aria-controls":(0,controller.aria)(entry.key),"aria-keyshortcuts":entry.isClosable?"Delete":void 0,id:(0,controller.dom)(entry.key),tabIndex:entry.disabled||selected!==entry.id?-1:0}});' +
  'return null==view?null:(0,react.cloneElement)(view,{key:entry.key})});' +
  'return (0,ui.jsx)("div",{"data-app-shell-tab-strip-controller":controller,children:rendered})}';

function mapFragment(source) {
  const call = new RegExp(`(?<entry>${ID})\\.render\\(\\{disabled:\\k<entry>\\.disabled,isActive:`, "u").exec(source);
  assert.ok(call);
  const heads = [...source.slice(0, call.index).matchAll(new RegExp(`(?<list>${ID})\\.map\\(\\((?<entry>${ID}),(?<index>${ID})\\)=>\\{`, "gu"))];
  const head = heads.at(-1);
  assert.ok(head);
  const open = head.index + head[0].length - 1, end = findMatchingBrace(source, open) + 1;
  assert.ok(end > call.index);
  const text = source.slice(head.index + head[0].indexOf("((") + 1, end);
  const read = pattern => {
    const result = pattern.exec(text);
    assert.ok(result, pattern.source);
    return result.slice(1);
  };
  const entry = escapeRegExp(head.groups.entry);
  const [selected] = read(new RegExp(`let ${ID}=(${ID})===${entry}\\.id`, "u"));
  const [presented] = read(new RegExp(`isPresented:(${ID})===${entry}\\.id`, "u"));
  const [renaming] = read(new RegExp(`isRenaming:(${ID})===${entry}\\.id`, "u"));
  const [layout, motion, position, width, transition, widths] = read(new RegExp(
    `animateLayout:(${ID}|!1),animateExit:(${ID})&&!(${ID}),animatePosition:\\2&&\\3,animateWidth:(${ID}),layoutTransition:(${ID}),targetWidth:(${ID})\\[`, "u"));
  const [jsx] = read(new RegExp(`trailingDecoration:\\(0,(${ID})\\.jsx\\)`, "u"));
  const [classes] = read(new RegExp(`className:\\(0,(${ID})\\.A\\)`, "u"));
  const [clone] = read(new RegExp(`\\(0,(${ID})\\.cloneElement\\)`, "u"));
  const [controller, aria] = read(new RegExp(`"aria-controls":\\(0,(${ID})\\.(${ID})\\)`, "u"));
  const [dom] = read(new RegExp(`id:\\(0,${escapeRegExp(controller)}\\.(${ID})\\)`, "u"));
  const [setWidths] = read(new RegExp(`onActionsWidthChange:${ID}=>\\{(${ID})\\(`, "u"));
  const [, clearPending, setRenaming] = read(new RegExp(`onRenamingChange:(${ID})=>\\{\\1&&(${ID})\\(null\\),(${ID})\\(`, "u"));
  return { text, list: head.groups.list, selected, presented, renaming, layout, motion, position, width, transition, widths,
    jsx, classes, clone, controller, aria, dom, setWidths, clearPending, setRenaming };
}

function executeMap(text, bindings, flags, entries, transition) {
  let widths = { first: 10 }, renaming = null;
  const events = [], renders = [], context = {};
  Object.assign(context, {
    [bindings.list]: entries, [bindings.selected]: "first", [bindings.presented]: "second", [bindings.renaming]: "first",
    [bindings.layout]: flags.layout, [bindings.motion]: flags.motion, [bindings.position]: flags.position, [bindings.width]: flags.width,
    [bindings.transition]: transition, [bindings.widths]: [120, 100],
    [bindings.jsx]: { jsx: (type, props) => ({ type, props }) },
    [bindings.classes]: { A: (...values) => values.join(" ") },
    [bindings.clone]: { cloneElement: (element, props) => ({ ...element, ...props }) },
    [bindings.controller]: { [bindings.aria]: key => "aria-" + key, [bindings.dom]: key => "tab-" + key },
    [bindings.setWidths]: update => { widths = update(widths); },
    [bindings.clearPending]: value => events.push(value),
    [bindings.setRenaming]: update => { renaming = update(renaming); },
  });
  for (const entry of entries) entry.render = function(props) { renders.push(this); return this.hidden ? null : { props, onClose: this.onClose, controller: this.controller }; };
  const callback = vm.runInNewContext("(" + text + ")", context);
  const values = entries.map(callback);
  return { values, renders, state: () => JSON.stringify({ widths, renaming, events }) };
}

function assertRenderPreservation(source) {
  const patched = apply(source), before = mapFragment(source);
  const restored = patched.replace("animateLayout:!1", "animateLayout:" + before.layout);
  assert.equal(restored, source);
  const afterText = mapFragment(patched).text;
  assert.equal(afterText, before.text.replace("animateLayout:" + before.layout, "animateLayout:!1"));
  const controller = {}, close = () => {};
  const entries = [
    { id: "first", key: "first", disabled: false, isClosable: true, controller, onClose: close },
    { id: "second", key: "second", disabled: true, isClosable: false, controller, onClose: close },
  ];
  for (const layout of [false, true]) for (const motion of [false, true]) for (const position of [false, true]) for (const width of [false, true]) {
    const flags = { layout, motion, position, width }, transition = {};
    const a = executeMap(before.text, before, flags, entries, transition);
    const b = executeMap(afterText, before, flags, entries, transition);
    for (let index = 0; index < entries.length; index++) {
      const original = a.values[index], current = b.values[index];
      assert.equal(current.props.animateLayout, false);
      for (const key of ["disabled", "isActive", "isClosable", "isPresented", "isRenaming", "animateExit", "animatePosition", "animateWidth", "layoutTransition", "targetWidth"]) assert.equal(current.props[key], original.props[key], key);
      for (const key of ["trailingDecoration", "tabButtonProps"]) assert.equal(JSON.stringify(current.props[key]), JSON.stringify(original.props[key]), key);
      assert.equal(current.onClose, close);
      assert.equal(current.controller, controller);
      assert.equal(a.renders[index], entries[index]);
      assert.equal(b.renders[index], entries[index]);
      original.props.onActionsWidthChange(0); current.props.onActionsWidthChange(0);
      original.props.onRenamingChange(true); current.props.onRenamingChange(true);
      assert.equal(a.state(), b.state());
      original.props.onRenamingChange(false); current.props.onRenamingChange(false);
      assert.equal(a.state(), b.state());
    }
  }
  entries[0].hidden = true;
  assert.equal(executeMap(before.text, before, { layout: true }, entries, {}).values[0], null);
  assert.equal(executeMap(afterText, before, { layout: true }, entries, {}).values[0], null);
  assert.equal(apply(patched), patched);
}

test("current tab render flags change only layout while preserving native controls", () => {
  assertRenderPreservation(fixture);
  assert.equal(matches(fixture.replaceAll("entries", "tabs$").replaceAll("entry", "item$")), true);
});

test("incoherent tab, motion, separator and keyboard bindings refuse unchanged", () => {
  const cases = [
    fixture.replace("isClosable:entry.isClosable", "isClosable:other.isClosable"),
    fixture.replace("animatePosition:motion&&position", "animatePosition:motion&&other"),
    fixture.replace("targetWidth:widths[index]", "targetWidth:widths[other]"),
    fixture.replace('"data-app-shell-tab-separator-index":index', '"data-app-shell-tab-separator-index":other'),
    fixture.replace('"aria-keyshortcuts":entry.isClosable?"Delete"', '"aria-keyshortcuts":entry.isClosable?"Enter"'),
    fixture.replace("tabIndex:entry.disabled||selected", "tabIndex:entry.disabled||presented"),
    fixture.replace("onRenamingChange:", "otherCallback:"),
    fixture.replace("data-app-shell-tab-strip-controller", "other-controller"),
    fixture + fixture.replace("function strip", "function anotherStrip"),
    fixture + apply(fixture).replace("function strip", "function anotherStrip"),
    fixture + fixture.replace("animateWidth:width", "animateWidth:!1").replace("function strip", "function anotherStrip"),
    "const note=" + JSON.stringify(fixture) + ";",
  ];
  for (const source of cases) {
    assert.equal(matches(source), false);
    assert.equal(captureWarnings(() => apply(source)).value, source);
  }
});

test("tab controller markers belong to the same module as its render callback", () => {
  const source = 'export const __rspack_esm_ids=[1];export const __webpack_modules__={One(){' +
    fixture.replace('"data-app-shell-tab-strip-controller"', '"other-controller"') +
    '},Other(){const marker="data-app-shell-tab-strip-controller"}};';
  assert.equal(matches(source), false);
  assert.equal(apply(source), source);
});

test("normal descriptor repeats and refuses duplicate or drifted assets before writes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tab-layout-current-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets/async"), file = path.join(assets, "moved.js");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(file, fixture);
  for (const expected of ["applied", "already-applied"]) {
    const report = createPatchReport(); applyWebviewAssetPatchDescriptors(root, descriptor, {}, report);
    assert.equal(report.patches[0].status, expected);
  }
  const patched = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(assets, "duplicate.js"), fixture);
  const duplicate = createPatchReport(); captureWarnings(() => applyWebviewAssetPatchDescriptors(root, descriptor, {}, duplicate));
  assert.equal(duplicate.patches[0].status, "skipped-optional");
  assert.equal(fs.readFileSync(file, "utf8"), patched);
  fs.rmSync(path.join(assets, "duplicate.js"));
  const drifted = fixture.replace("animatePosition:motion&&position", "animatePosition:motion&&other");
  fs.writeFileSync(file, drifted);
  const drift = createPatchReport(); captureWarnings(() => applyWebviewAssetPatchDescriptors(root, descriptor, {}, drift));
  assert.equal(drift.patches[0].status, "skipped-optional");
  assert.equal(fs.readFileSync(file, "utf8"), drifted);
});

test("actual signed tab render callback preserves all non-layout behavior", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP, assets = path.join(app, "webview/assets");
  const owners = findWebviewAssetsContaining(app, descriptor[0].assetNeedles).filter(name => matches(fs.readFileSync(path.join(assets, name), "utf8")));
  assert.equal(owners.length, 1);
  const source = fs.readFileSync(path.join(assets, owners[0]), "utf8");
  assertRenderPreservation(source);
  assert.equal(fs.readFileSync(path.join(assets, owners[0]), "utf8"), source);
});
