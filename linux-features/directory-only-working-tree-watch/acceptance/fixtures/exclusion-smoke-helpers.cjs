"use strict";

const path = require("node:path");

function hasInvalidatedPathAtOrBelow(
  batches,
  excludedPath,
  exclusionGeneration,
) {
  const descendantPrefix = `${excludedPath}${path.sep}`;
  return batches.some((batch) => {
    if (
      exclusionGeneration !== undefined &&
      batch.exclusionGeneration !== exclusionGeneration
    ) {
      return false;
    }
    return batch.invalidatedPaths.some((candidate) =>
      candidate === excludedPath || candidate.startsWith(descendantPrefix));
  });
}

module.exports = { hasInvalidatedPathAtOrBelow };
