"use strict";

function applyMainBundlePatch(source) {
  const marker = "codexLinuxExampleFeatureDisabled()";
  if (!source.includes(marker)) {
    console.warn("WARN: Example Linux feature marker not found — skipping example feature patch");
    return source;
  }
  return source.replace(marker, "codexLinuxExampleFeatureEnabled()");
}

module.exports = {
  descriptors: [
    {
      id: "example-feature-main-bundle",
      phase: "main-bundle",
      order: 20_000,
      ciPolicy: "optional",
      apply: applyMainBundlePatch,
    },
  ],
};
