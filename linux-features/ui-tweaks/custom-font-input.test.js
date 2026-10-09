"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyWebviewAssetPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const {
  MODE_MESSAGE_ID, RUNTIME_MARKER, applyCustomFontInputPatch,
  customFontInputEnabled, descriptors, fontPickerContract,
} = require("./patches/custom-font-input.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/official-font-picker.js"), "utf8");
const enabledContext = { feature: { settings: { tweaks: { appearance: { customFontInput: { enabled: true } } } } } };
const uiStack = '"IBM Plex Sans", "Noto Sans CJK SC", "Noto Sans", sans-serif';
const codeStack = '"JetBrains Mono", "Noto Sans Mono CJK SC", monospace';
const families = [
  { family: "IBM Plex Sans", faces: [{ postscriptName: "IBMPlexSans", styleName: "Regular", isMonospaced: false }] },
  { family: "JetBrains Mono", faces: [{ postscriptName: "JetBrainsMono-Regular", styleName: "Regular", isMonospaced: true }] },
];

function allNodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(allNodes);
  if (tree == null || typeof tree !== "object") return [];
  return [tree, ...allNodes(tree.props?.children)];
}

function createRenderer(source, options = {}) {
  const data = Object.hasOwn(options, "data") ? options.data : families;
  const { slot = "ui", rename = {} } = options;
  const states = [];
  const cache = [];
  const changes = [];
  let stateIndex = 0;
  let cacheSize = null;
  const makeElement = (type, props) => ({ type, props });
  const context = {
    Symbol,
    Ja: { c: (size) => {
      if (cacheSize == null) {
        cacheSize = size;
        cache.push(...Array(size).fill(Symbol.for("react.memo_cache_sentinel")));
      }
      assert.equal(size, cacheSize);
      return cache;
    } },
    Ya: { useState: (initial) => {
      const index = stateIndex++;
      if (index >= states.length) states[index] = initial;
      return [states[index], (value) => { states[index] = value; }];
    } },
    L: () => ({ data, isPending: false }), Wa: {},
    Y: { jsx: makeElement, jsxs: makeElement, Fragment: "Fragment" },
    N: "Translation", J: { chromeThemeSystemFont: { id: "system-font" }, chromeThemeRegularFontStyle: { id: "regular" } },
    I: { Input: "Input", Item: "Item", CheckboxItem: "CheckboxItem", Section: "Section", Separator: "Separator" },
    Kn: "Button", cn: "Menu", Zt: "Selected", g: "Spinner",
    Va: () => null, Ha: (value) => value?.split(",")[0].trim() || null,
    ki: (value) => value, Ai: () => {},
  };
  for (const [from, to] of Object.entries(rename)) {
    if (Object.hasOwn(context, from)) context[to] = context[from];
  }
  const functions = vm.runInNewContext(`${source}; ({picker:${rename.Ka ?? "Ka"},merge:CVs,css:gOs})`, context);
  let theme = {
    accent: "#123456", semanticColors: { skill: "#123456" },
    fonts: { ui: null, code: null, content: null },
  };
  const props = {
    ariaLabel: `${slot} font`, styleAriaLabel: `${slot} font style`, value: null,
    monospaceOnly: slot === "code",
    onChange: (value, face) => {
      changes.push({ value, face });
      theme = functions.merge(theme, { fonts: { [slot]: value, [`${slot}Face`]: face } });
      props.value = value;
      props.selectedThemeFontFace = face;
    },
  };
  const renderer = {
    changes, props, functions,
    get theme() { return theme; },
    render() { stateIndex = 0; return allNodes(functions.picker(props)); },
    open() {
      this.render().find((node) => node.type === "Menu").props.onOpenChange(true);
      return this.render();
    },
    switchMode() {
      const toggle = this.render().find((node) => node.type === "CheckboxItem");
      assert(toggle);
      toggle.props.onSelect();
      return this.render();
    },
    enter(value) {
      this.render().find((node) => node.type === "Input").props.onChange({ target: { value } });
      return this.render();
    },
  };
  return renderer;
}

test("custom font input is independently disabled by default and respects local overrides", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(manifest.tweaks.appearance.customFontInput.enabled, false);
  assert.equal(customFontInputEnabled({ feature: { manifest } }), false);
  assert.equal(customFontInputEnabled(enabledContext), true);
  assert.equal(customFontInputEnabled({ feature: { manifest: { tweaks: { appearance: { customFontInput: { enabled: true } } } }, settings: { tweaks: { appearance: { customFontInput: { enabled: false } } } } } }), false);
  assert.equal(applyCustomFontInputPatch(fixture), fixture);
});

test("explicit font input switch preserves installed fonts and invalidates the compiled React cache", () => {
  const patched = applyCustomFontInputPatch(fixture, enabledContext);
  assert.equal(fontPickerContract(patched)?.state, "applied");
  assert.equal(applyCustomFontInputPatch(patched, enabledContext), patched);
  const renderer = createRenderer(patched);
  let nodes = renderer.open();
  let toggle = nodes.find((node) => node.type === "CheckboxItem");
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.indicator, "switch");
  assert.equal(toggle.props.closeOnSelect, false);
  assert.equal(toggle.props.children.props.id, MODE_MESSAGE_ID);
  assert(nodes.some((node) => node.type === "Item" && node.props.children === "IBM Plex Sans"));
  assert(!nodes.some((node) => node.type === "Input"));
  nodes = renderer.switchMode();
  assert(nodes.some((node) => node.type === "Input"));
  assert.equal(nodes.find((node) => node.type === "CheckboxItem").props.checked, true);
  assert.equal(renderer.changes.length, 0);
  nodes = renderer.switchMode();
  assert(!nodes.some((node) => node.type === "Input"));
  assert(nodes.some((node) => node.type === "Item" && node.props.children === "IBM Plex Sans"));
  assert.equal(renderer.changes.length, 0);
});

test("UI, code, and content fallback stacks use the upstream commit path and clear selected faces", () => {
  const patched = applyCustomFontInputPatch(fixture, enabledContext);
  for (const slot of ["ui", "code", "content"]) {
    const stack = slot === "code" ? codeStack : uiStack;
    const renderer = createRenderer(patched, { slot });
    renderer.props.selectedThemeFontFace = { family: "Old", fullName: "Old", postscriptName: "Old" };
    renderer.open();
    renderer.switchMode();
    let nodes = renderer.enter(`  ${stack}  `);
    if (slot === "code") {
      nodes.find((node) => node.type === "Item" && node.props.children?.props?.id === "settings.general.appearance.chromeTheme.customFontValue").props.onSelect();
    } else {
      let prevented = false;
      nodes.find((node) => node.type === "Input").props.onKeyDown({ key: "Enter", preventDefault() { prevented = true; } });
      assert(prevented);
    }
    assert.equal(renderer.changes.at(-1).value, stack);
    assert.equal(renderer.changes.at(-1).face, undefined);
    assert.equal(renderer.theme.fonts[slot], stack);
    assert.equal(renderer.theme.fonts[`${slot}Face`], undefined);
    assert.equal(renderer.theme.accent, "#123456");
    const fallback = slot === "code" ? "--font-mono-default" : "--font-sans-default";
    assert.equal(renderer.functions.css(stack, fallback), `${stack}, var(${fallback})`);
    renderer.open();
    nodes = renderer.enter("  ");
    nodes.find((node) => node.type === "Input").props.onKeyDown({ key: "Enter", preventDefault() {} });
    assert.equal(renderer.theme.fonts[slot], null);
  }
});

test("code font list keeps upstream monospace filtering and System resets custom input", () => {
  const renderer = createRenderer(applyCustomFontInputPatch(fixture, enabledContext), { slot: "code" });
  let nodes = renderer.open();
  assert(!nodes.some((node) => node.type === "Item" && node.props.children === "IBM Plex Sans"));
  assert(nodes.some((node) => node.type === "Item" && node.props.children === "JetBrains Mono"));
  renderer.switchMode();
  nodes = renderer.enter(codeStack);
  nodes.find((node) => node.type === "Input").props.onKeyDown({ key: "Enter", preventDefault() {} });
  nodes = renderer.open();
  nodes.find((node) => node.type === "Item" && node.props.children?.props?.id === "system-font").props.onSelect();
  assert.equal(renderer.theme.fonts.code, null);
  assert.equal(renderer.theme.fonts.codeFace, undefined);
});

test("separate theme pickers keep input modes and font edits independent", () => {
  const patched = applyCustomFontInputPatch(fixture, enabledContext);
  const light = createRenderer(patched);
  const dark = createRenderer(patched);
  light.open();
  dark.open();
  light.switchMode();
  const nodes = light.enter(uiStack);
  nodes.find((node) => node.type === "Input").props.onKeyDown({ key: "Enter", preventDefault() {} });
  assert.equal(light.theme.fonts.ui, uiStack);
  assert.equal(dark.theme.fonts.ui, null);
  assert.equal(dark.render().find((node) => node.type === "CheckboxItem").props.checked, false);
  assert(!dark.render().some((node) => node.type === "Input"));
});

test("unavailable font enumeration retains automatic manual input and disables only the mode switch", () => {
  const patched = applyCustomFontInputPatch(fixture, enabledContext);
  for (const data of [undefined, null, []]) {
    const renderer = createRenderer(patched, { data });
    const nodes = renderer.open();
    assert(nodes.some((node) => node.type === "Input"));
    const toggle = nodes.find((node) => node.type === "CheckboxItem");
    assert.equal(toggle.props.checked, true);
    assert.equal(toggle.props.disabled, true);
    toggle.props.onSelect();
    assert(renderer.render().some((node) => node.type === "Input"));
  }
});

test("font input patch captures compiler aliases rather than requiring fixed minified symbols", () => {
  const rename = { Ka: "FontSelector", Ja: "MemoRuntime", Ya: "ReactRuntime", Y: "JsxRuntime", I: "MenuRuntime", N: "MessageRuntime" };
  let renamed = fixture;
  for (const [from, to] of Object.entries(rename)) renamed = renamed.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  const patched = applyCustomFontInputPatch(renamed, enabledContext);
  assert.equal(fontPickerContract(patched)?.state, "applied");
  const renderer = createRenderer(patched, { rename });
  renderer.open();
  assert(renderer.switchMode().some((node) => node.type === "Input"));
});

test("font input patch rejects missing, duplicate, and partially patched contracts without changing bytes", () => {
  const broken = [
    "unrelated source",
    fixture + fixture,
    fixture.replace("f==null||f.length===0", "f==null"),
    fixture.replace(".c)(42)", ".c)(43)"),
    fixture.replace("t[15]=C}else", "t[15]=C,t[42]=true}else"),
    fixture + `/*${RUNTIME_MARKER}*/`,
    applyCustomFontInputPatch(fixture, enabledContext).replace("indicator:`switch`", "indicator:`checkmark`"),
  ];
  const previous = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    for (const source of broken) assert.equal(applyCustomFontInputPatch(source, enabledContext), source);
  } finally { console.warn = previous; }
  assert.equal(warnings.length, broken.length);
});

test("font input descriptor discovers semantic contracts and rejects ambiguous asset candidates", () => {
  for (const count of [1, 2]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "custom-font-input-"));
    try {
      const assets = path.join(root, "webview/assets");
      fs.mkdirSync(assets, { recursive: true });
      const targets = Array.from({ length: count }, (_, index) => path.join(assets, `renamed-settings-${index}.js`));
      for (const target of targets) fs.writeFileSync(target, fixture);
      fs.writeFileSync(path.join(assets, "unrelated.js"), "unrelated source");
      const report = createPatchReport();
      applyWebviewAssetPatchDescriptors(root, normalizePatchDescriptors(descriptors), enabledContext, report);
      for (const target of targets) {
        assert.equal(fs.readFileSync(target, "utf8") !== fixture, count === 1);
      }
      assert.equal(report.patches[0].status === "applied", count === 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("font input switch applies to the current signed official font picker", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
  const candidates = fs.readdirSync(assets).filter((name) => name.endsWith(".js"))
    .map((name) => fs.readFileSync(path.join(assets, name), "utf8"))
    .filter(descriptors[0].assetMatch);
  assert.equal(candidates.length, 1);
  const [source] = candidates;
  assert.equal(applyCustomFontInputPatch(source), source);
  const patched = applyCustomFontInputPatch(source, enabledContext);
  assert.notEqual(patched, source);
  assert.equal(fontPickerContract(patched)?.state, "applied");
  assert.equal(applyCustomFontInputPatch(patched, enabledContext), patched);
});
