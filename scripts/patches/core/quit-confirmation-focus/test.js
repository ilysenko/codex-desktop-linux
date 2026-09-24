#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { corePatchDescriptors } = require("../../runner.js");

test("the retired Quit confirmation core patch stays absent", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "patch.js")), false);
  assert.deepEqual(corePatchDescriptors(), []);
});
