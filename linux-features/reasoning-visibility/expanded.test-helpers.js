"use strict";
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {reasoningComponent}=require("./expanded.js");
const fixture=fs.readFileSync(path.join(__dirname,"fixtures/current-reasoning-component.js"),"utf8").trim();

function nodes(tree, predicate) {
  const found = [], seen = new Set();
  function visit(value) {
    if (value == null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (predicate(value)) found.push(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(tree);
  return found;
}

function harness(source, { enabled = true, resume = null } = {}) {
  const values = [], references = [], caches = [];
  let stateIndex = 0, refIndex = 0, cacheIndex = 0, currentResume = resume;
  const React = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], next => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    },
    useRef(initial) { const index = refIndex++; return references[index] ??= { current: initial }; },
    useEffectEvent: callback => callback,
    useEffect: callback => callback(),
    Children: { toArray: value => Array.isArray(value) ? value : [value] },
    isValidElement: () => true,
  };
  const context = vm.createContext({
    localStorage: { getItem: () => enabled ? "1" : null },
    i: { c(size) { return caches[cacheIndex++] ??= Array(size).fill(Symbol.for("react.memo_cache_sentinel")); } },
    c: { _U: () => currentResume }, ex: { nX: "resume" }, u: React,
    aA: { k2: content => content }, a: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" },
    p: { A: "LocalizedMessage" }, aT: () => "elapsed",
    Y: { A: (...classes) => classes.filter(Boolean).join(" ") }, aI: "heading", ak: "list", aN: () => null,
    aj: { K: "NativeMarkdown" }, ez: { N: "ActivityLabel" }, tx: { A: "NativeDisclosure" },
    ab: { t: "NativeScroll" }, tg: { j: "BodyFrame" }, aC: { Q: "NativeCollapse" }, tv: { n: "ActivityItem" },
    Date: class extends Date { static now() { return 1000; } },
  });
  const component = /^function ([\w$]+)\(/.exec(reasoningComponent(source).text)[1];
  if (source.includes("export const __webpack_modules__=")) {
    vm.runInContext(source.replace(/export const __rspack_esm_ids=/gu,"const __rspack_esm_ids=").replace("export const __webpack_modules__=", "globalThis.factories=") + ";globalThis.Component=factories.Owner()", context);
  } else vm.runInContext(`${source};globalThis.Component=${component}`, context);
  return {
    setResume(value) { currentResume = value; },
    render(item) {
      stateIndex = refIndex = cacheIndex = 0;
      const tree = context.Component({ item, conversationId: "conversation", cwd: "/project", hostId: "local", hideCodeBlocks: false });
      const visible = nodes(tree, value => value.type === "NativeCollapse")[0]?.props.expanded !== false;
      return { tree,
        scroll: visible ? nodes(tree, value => value.type === "NativeScroll")[0]?.props : undefined,
        markdown: visible ? nodes(tree, value => value.type === "NativeMarkdown")[0]?.props : undefined,
        disclosure: nodes(tree, value => value.type === "NativeDisclosure")[0]?.props.externalDisclosure,
      };
    },
  };
}


module.exports={fixture,harness,nodes};
