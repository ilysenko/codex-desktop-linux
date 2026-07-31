"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  delegatePatchMarker,
  patchDelegationMarker,
  patchDelegationState,
} = require("./composition-delegation.js");

test("delegates one owner marker to one enabled feature", () => {
  const ownerMarker = "/*owner*/";
  const delegated = delegatePatchMarker(
    `before${ownerMarker}after`,
    ownerMarker,
    "owner-patch",
    "sample-feature",
  );
  const marker = patchDelegationMarker("owner-patch", "sample-feature");

  assert.equal(delegated, `before${marker}after`);
  assert.deepEqual(
    patchDelegationState(delegated, "owner-patch", {
      allowedFeatureIds: ["sample-feature"],
      enabledFeatureIds: ["sample-feature"],
    }),
    { state: "enabled", featureId: "sample-feature" },
  );
  assert.deepEqual(
    patchDelegationState(delegated, "owner-patch", {
      allowedFeatureIds: ["sample-feature"],
    }),
    { state: "disabled", featureId: "sample-feature" },
  );
});

test("rejects missing, duplicate, and competing patch delegations", () => {
  const ownerMarker = "/*owner*/";
  const marker = patchDelegationMarker("owner-patch", "sample-feature");

  assert.equal(
    delegatePatchMarker(
      "without-owner",
      ownerMarker,
      "owner-patch",
      "sample-feature",
    ),
    null,
  );
  assert.equal(
    delegatePatchMarker(
      `${ownerMarker}${ownerMarker}`,
      ownerMarker,
      "owner-patch",
      "sample-feature",
    ),
    null,
  );
  assert.equal(
    delegatePatchMarker(
      `${ownerMarker}${marker}`,
      ownerMarker,
      "owner-patch",
      "sample-feature",
    ),
    null,
  );
  assert.deepEqual(
    patchDelegationState(
      `${marker}${marker}`,
      "owner-patch",
      {
        allowedFeatureIds: ["sample-feature"],
        enabledFeatureIds: ["sample-feature"],
      },
    ),
    { state: "invalid", featureId: null },
  );
  assert.deepEqual(
    patchDelegationState(`${ownerMarker}${marker}`, "owner-patch", {
      allowedFeatureIds: ["sample-feature"],
      enabledFeatureIds: ["sample-feature"],
      ownerMarker,
    }),
    { state: "invalid", featureId: "sample-feature" },
  );
});

test("rejects an enabled feature that is not authorized for the owner", () => {
  const marker = patchDelegationMarker("owner-patch", "unrelated-feature");

  assert.deepEqual(
    patchDelegationState(marker, "owner-patch", {
      allowedFeatureIds: ["sample-feature"],
      enabledFeatureIds: ["sample-feature", "unrelated-feature"],
    }),
    { state: "invalid", featureId: "unrelated-feature" },
  );
});
