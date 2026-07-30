"use strict";

class PatchIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PatchIntegrityError";
    this.code = "PATCH_INTEGRITY_FAILURE";
  }
}

function isPatchIntegrityError(error) {
  return error instanceof PatchIntegrityError ||
    error?.code === "PATCH_INTEGRITY_FAILURE";
}

module.exports = {
  PatchIntegrityError,
  isPatchIntegrityError,
};
