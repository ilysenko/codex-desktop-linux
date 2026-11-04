"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const {
  MARKDOWN_STYLESHEET_NEEDLES,
  SIDEBAR_ASSET_NEEDLES,
  TAB_ASSET_NEEDLES,
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationPerformancePatch,
  applyLinuxMarkdownAnimationStylesheetPatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxMarkdownAnimationPerformanceContract,
} = require("./implementation.js");

// Shapes below follow the signed 26.1029.61003 rspack webview.
function currentAppShellTabLayoutFixture() {
  return 'function tabs(){let map=new Map,Qe=(e,t)=>{let{key:n}=e,r=map.get(n);return null==r?null:(0,a.jsx)(t_.i,{...t,activateOnClick:!0,animateLayout:!r.isWorkspaceHome&&t.animateLayout,animateExit:!r.isWorkspaceHome&&t.animateExit,closeButtonTabIndex:-1,controller:x.It,dragActivator:"tab",tab:r,shortcutHint:null})};return Qe}';
}

function currentSidebarFixture() {
  return '(0,r.jsxs)("div",{...cU.rW.sidebarScroll,className:(0,s.A)("relative isolate flex [contain:layout_paint] browser:gap-5",bi.A.headerFadeMask,V?bi.A.withoutFooterFade:"vertical-scroll-fade-mask",t&&"pointer-events-none"),ref:T,onScroll:e=>{let t=J.current;(null==t||e.timeStamp-t>=250)&&(J.current=e.timeStamp);let{scrollTop:n}=e.currentTarget;G||v(n)},children:[]})';
}

function currentMarkdownStylesheetFixture() {
  return ".MarkdownRoot-rZKhxa[data-markdown-animated] :is(.FadeIn-RqQvGR,.HorizontalRule-ByOEk_,.ListItem-ncLgmg,.TableRow-ENsaGm,.Blockquote-EqEEot){opacity:1;animation:fade-in-HYTrVJ var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) both;animation-delay:var(--fade-delay,0s)}.MarkdownRoot-rZKhxa[data-markdown-animated] .FadeListDecoration-F9SN5z::marker{animation:fade-in-marker-re9IOT var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) forwards;animation-delay:var(--fade-delay,0s)}.MarkdownRoot-rZKhxa.AdaptiveStreaming-uuYOZc .FadeIn-RqQvGR,.MarkdownRoot-rZKhxa.AdaptiveStreaming-uuYOZc .FadeListDecoration-F9SN5z::marker{--duration:var(--animation-duration-streaming-text)}.MarkdownRoot-rZKhxa[data-markdown-animated] .ImageEnter-TCwnvk{transform-origin:50%;animation:.18s ease-out both image-enter-VfEUgK}";
}

function withExtractedApp(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linux-performance-workarounds-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, "webview", "assets", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("linux-performance-workarounds remains an opt-in renderer-only feature", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id, phase }) => [id, phase]),
    [
      ["sidebar-scroll", "webview-asset"],
      ["app-shell-tab-layout", "webview-asset"],
      ["markdown-animation", "extracted-app:post-webview"],
    ],
  );
  assert.deepEqual(descriptors[0].assetNeedles, SIDEBAR_ASSET_NEEDLES);
  assert.deepEqual(descriptors[1].assetNeedles, TAB_ASSET_NEEDLES);
  assert.ok(descriptors.every(({ pattern }) => pattern == null));
  for (const needle of SIDEBAR_ASSET_NEEDLES) assert.ok(currentSidebarFixture().includes(needle), needle);
  for (const needle of TAB_ASSET_NEEDLES) assert.ok(currentAppShellTabLayoutFixture().includes(needle), needle);
  for (const needle of MARKDOWN_STYLESHEET_NEEDLES) assert.ok(currentMarkdownStylesheetFixture().includes(needle), needle);
});

test("sidebar workaround locates the current semantic container after asset moves", () => {
  const source = currentSidebarFixture();
  assert.equal(descriptors[0].assetMatch(source), true);
  const patched = descriptors[0].apply(source);
  assert.match(patched, /,style:\{animationName:"none",animationTimeline:"auto","--bottom-fade":"calc\(var\(--spacing\) \* 10\)"\},ref:T,onScroll:/u);
  assert.doesNotThrow(() => new Function(patched));
  assert.equal(descriptors[0].assetMatch(patched), true);
  assert.equal(descriptors[0].apply(patched), patched);
});

test("sidebar workaround fails closed for duplicate or drifted containers", () => {
  const source = currentSidebarFixture();
  for (const drifted of [
    source + source,
    source.replace("[contain:layout_paint]", "[contain:paint]"),
    source.replace("let{scrollTop:n}=e.currentTarget;", ""),
  ]) {
    assert.equal(descriptors[0].assetMatch(drifted), false);
    const result = captureWarnings(() => descriptors[0].apply(drifted));
    assert.equal(result.value, drifted);
  }
});

test("current app-shell tab workaround disables tab layout animation", () => {
  const source = currentAppShellTabLayoutFixture();
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), true);
  const patched = applyLinuxAppShellTabLayoutPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /animateLayout:!1,animateExit:!r\.isWorkspaceHome&&t\.animateExit,closeButtonTabIndex:-1,controller:x\.It,dragActivator:"tab"/u);
  assert.doesNotThrow(() => new Function(patched));
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(patched), true);
  assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(patched), patched);
});

test("app-shell tab workaround fails closed for missing, duplicate, mixed, and partial owners", () => {
  const owner = currentAppShellTabLayoutFixture();
  const patched = applyLinuxAppShellTabLayoutPerformancePatch(owner);
  const renamed = owner.replaceAll("Qe", "Xe").replaceAll("map", "tabsById");
  const cases = [
    owner.replace('dragActivator:"tab"', 'dragActivator:"panel"'),
    owner + renamed,
    patched + renamed,
    owner.replace("animateExit:!r.isWorkspaceHome&&t.animateExit", "animateExit:t.animateExit"),
  ];
  for (const source of cases) {
    assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), false);
    assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(source), source);
  }
});

test("current Markdown animation workaround disables streaming fades", () => {
  const source = currentMarkdownStylesheetFixture();

  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(source), true);
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /\.Blockquote-EqEEot\)\{opacity:1;animation:none\}/u);
  assert.match(patched, /FadeListDecoration-F9SN5z::marker\{animation:none\}/u);
  assert.match(patched, /AdaptiveStreaming-uuYOZc \.FadeIn-RqQvGR/u);
  assert.match(patched, /ImageEnter-TCwnvk\{transform-origin:50%;animation:\.18s ease-out both image-enter-VfEUgK\}/u);
  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(patched), true);
  assert.equal(applyLinuxMarkdownAnimationPerformancePatch(patched), patched);
});

test("Markdown animation workaround fails closed without the image rule or with duplicates", () => {
  const source = currentMarkdownStylesheetFixture();
  for (const drifted of [
    source.replace("both image-enter-VfEUgK", "both image-pop-VfEUgK"),
    source + source,
    source.replace("fade-in-marker-re9IOT", "fade-in-list-re9IOT"),
  ]) {
    assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(drifted), false);
    const result = captureWarnings(() => applyLinuxMarkdownAnimationPerformancePatch(drifted));
    assert.equal(result.value, drifted);
    assert.equal(result.warnings.length, 1);
  }
});

test("Markdown stylesheet descriptor patches every async CSS copy of the module", () => {
  const source = currentMarkdownStylesheetFixture();
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  withExtractedApp({
    "async/2e1cf03fbc98.css": `.Other-a1{color:red}${source}`,
    "async/709e2416485c.css": source,
    "async/0ac173e0555e.css": ".MarkdownRoot-rZKhxa[data-markdown-animated]{color:red}",
    "async/24191.7b05d5cf83.js": source,
  }, (root) => {
    const read = (name) => fs.readFileSync(path.join(root, "webview/assets", name), "utf8");
    assert.deepEqual(applyLinuxMarkdownAnimationStylesheetPatch(root), {
      changed: true,
      assetNames: ["async/2e1cf03fbc98.css", "async/709e2416485c.css"],
    });
    assert.equal(read("async/2e1cf03fbc98.css"), `.Other-a1{color:red}${patched}`);
    assert.equal(read("async/709e2416485c.css"), patched);
    assert.equal(read("async/24191.7b05d5cf83.js"), source);
    assert.deepEqual(applyLinuxMarkdownAnimationStylesheetPatch(root), { changed: false, assetNames: [] });
  });
  withExtractedApp({ "async/a.css": patched, "async/b.css": source }, (root) => {
    assert.deepEqual(applyLinuxMarkdownAnimationStylesheetPatch(root), { changed: true, assetNames: ["async/b.css"] });
  });
});

test("Markdown stylesheet descriptor writes nothing when any copy drifted or none exists", () => {
  const source = currentMarkdownStylesheetFixture();
  const drifted = source.replace("both image-enter-VfEUgK", "both image-pop-VfEUgK");
  for (const files of [{}, { "async/a.css": source, "async/b.css": drifted }, { "async/a.css": source + source }]) {
    withExtractedApp(files, (root) => {
      const result = captureWarnings(() => applyLinuxMarkdownAnimationStylesheetPatch(root));
      assert.deepEqual(result.value, { changed: false, assetNames: [] });
      assert.equal(result.warnings.length, 1);
      for (const [name, contents] of Object.entries(files)) {
        assert.equal(fs.readFileSync(path.join(root, "webview/assets", name), "utf8"), contents);
      }
    });
  }
});

test(
  "every workaround matches the signed release exactly once",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const root = process.env.CODEX_SIGNED_EXTRACTED_APP;
    const assetsDir = path.join(root, "webview", "assets");
    for (const descriptor of descriptors.filter(({ assetNeedles }) => assetNeedles != null)) {
      const owners = findWebviewAssetsContaining(root, descriptor.assetNeedles)
        .filter((name) => descriptor.assetMatch(fs.readFileSync(path.join(assetsDir, name), "utf8")));
      assert.equal(owners.length, 1, descriptor.id);
      const source = fs.readFileSync(path.join(assetsDir, owners[0]), "utf8");
      const patched = descriptor.apply(source);
      assert.notEqual(patched, source, descriptor.id);
      assert.equal(descriptor.apply(patched), patched, descriptor.id);
    }
    const stylesheets = ["", "async"].flatMap((directory) =>
      fs.readdirSync(path.join(assetsDir, directory))
        .filter((name) => name.endsWith(".css"))
        .map((name) => fs.readFileSync(path.join(assetsDir, directory, name), "utf8")))
      .filter((source) => MARKDOWN_STYLESHEET_NEEDLES.every((needle) => source.includes(needle)));
    assert.ok(stylesheets.length > 0);
    assert.ok(stylesheets.every((source) => matchesLinuxMarkdownAnimationPerformanceContract(source)));
  },
);
