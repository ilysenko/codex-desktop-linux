"use strict";

const authority = require("../../scripts/patches/lib/javascript-binding-authority.js");

module.exports = {
  prepare: authority.prepareBindingAuthority,
  prove: authority.proveBindingAuthority,
  MAX_UNIT: authority.MAX_UNIT,
  MAX_SLASH_FACTORY: authority.MAX_FACTORY_BYTES,
};
