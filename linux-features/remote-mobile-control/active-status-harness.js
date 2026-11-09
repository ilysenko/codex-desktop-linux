"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const data = require("./active-status-contracts.json");

const ATOM_FIELDS = Object.freeze({
  nX: "resumeState",
  hf: "streamRole",
  F9: "threadRuntimeStatus",
  VY: "latestTurnStatus",
});

function freezeValues(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, "value")) freezeValues(descriptor.value, seen);
  }
  return Object.freeze(value);
}

// The selected native indicator runs against one explicitly supplied store.
// Compiler memo slots, selector reads and JSX element construction are mocked.
function createIndicatorHarness({ indicatorSource, initialStates = {} }) {
  assert.equal(typeof indicatorSource, "string");
  const componentName = /^function ([A-Za-z_$][\w$]*)\(/u.exec(indicatorSource)?.[1];
  assert.ok(componentName);
  const states = new Map();
  const hooks = [], memoSizes = [], jsxCalls = [], classNameCalls = [];
  const effects = { stateWrites: [], preferences: [], requests: [] };
  const atoms = Object.freeze(Object.fromEntries(Object.keys(ATOM_FIELDS).map(name => [name, Symbol(name)])));
  const atomNames = new Map(Object.entries(atoms).map(([name, atom]) => [atom, name]));
  const memo = Array(13).fill(Symbol.for("react.memo_cache_sentinel"));
  const Tooltip = Symbol("controlled Tooltip component");

  function setState(conversationId, state) {
    states.set(conversationId, freezeValues({ ...state }));
  }
  const entries = initialStates instanceof Map ? initialStates : Object.entries(initialStates);
  for (const [conversationId, state] of entries) setState(conversationId, state);

  function forbidden(bucket, operation) {
    return (...args) => {
      effects[bucket].push({ operation, args });
      throw Error(`Unexpected ${operation} in the finite status indicator`);
    };
  }
  function readAtom(atom, conversationId) {
    const name = atomNames.get(atom);
    assert.ok(name, "the indicator must read a selected native atom");
    const value = states.get(conversationId)?.[ATOM_FIELDS[name]];
    hooks.push({ atom: name, conversationId, value });
    return value;
  }
  function jsx(type, props) {
    const result = Object.freeze({ type, props: Object.freeze({ ...props }) });
    jsxCalls.push(result);
    return result;
  }
  const scope = {
    n: Object.freeze({ jsx }),
    o: Object.freeze({ c(size) { assert.equal(size, 13); memoSizes.push(size); return memo; } }),
    i: Object.freeze({ _U: readAtom, set: forbidden("stateWrites", "atom write") }),
    m: atoms,
    r: Object.freeze({ A(...parts) {
      for (const part of parts) assert.ok(part == null || typeof part === "string");
      classNameCalls.push(parts);
      return parts.filter(Boolean).join(" ");
    } }),
    Y: Object.freeze({ m: Tooltip }),
    localStorage: Object.freeze({
      getItem: forbidden("preferences", "preference read"),
      setItem: forbidden("preferences", "preference write"),
      removeItem: forbidden("preferences", "preference removal"),
    }),
    fetch: forbidden("requests", "request"),
  };
  const component = vm.runInNewContext('"use strict";' + data.maps + indicatorSource + `;${componentName}`, scope);

  return {
    setState,
    effects,
    hooks,
    Tooltip,
    render(conversationId, className) {
      const start = { hooks: hooks.length, memo: memoSizes.length, jsx: jsxCalls.length, classNames: classNameCalls.length };
      const props = Object.freeze({ conversationId, className });
      const output = component(props);
      return {
        output,
        props,
        hooks: hooks.slice(start.hooks),
        memoSizes: memoSizes.slice(start.memo),
        jsxCalls: jsxCalls.slice(start.jsx),
        classNameCalls: classNameCalls.slice(start.classNames),
      };
    },
  };
}

module.exports = { ATOM_FIELDS, createIndicatorHarness };
