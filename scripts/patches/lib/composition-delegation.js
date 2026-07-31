"use strict";

const PATCH_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DELEGATION_MARKER_PATTERN =
  /\/\*codexLinuxPatchDelegated:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)\*\//gu;

function assertId(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} must match ${pattern}`);
  }
  return value;
}

function patchDelegationMarker(ownerPatchId, featureId) {
  const owner = assertId(ownerPatchId, PATCH_ID_PATTERN, "ownerPatchId");
  const feature = assertId(featureId, FEATURE_ID_PATTERN, "featureId");
  return `/*codexLinuxPatchDelegated:${owner}:${feature}*/`;
}

function patchDelegations(source, ownerPatchId) {
  const owner = assertId(ownerPatchId, PATCH_ID_PATTERN, "ownerPatchId");
  return [...source.matchAll(DELEGATION_MARKER_PATTERN)]
    .filter((match) => match[1] === owner)
    .map((match) => ({ marker: match[0], featureId: match[2] }));
}

function patchDelegationState(
  source,
  ownerPatchId,
  {
    allowedFeatureIds = [],
    enabledFeatureIds = [],
    ownerMarker = null,
  } = {},
) {
  const delegations = patchDelegations(source, ownerPatchId);
  if (delegations.length === 0) {
    return { state: "none", featureId: null };
  }
  if (
    typeof ownerMarker === "string" &&
    ownerMarker.length > 0 &&
    source.includes(ownerMarker)
  ) {
    return {
      state: "invalid",
      featureId: delegations.length === 1 ? delegations[0].featureId : null,
    };
  }
  if (delegations.length !== 1) {
    return { state: "invalid", featureId: null };
  }

  const [{ featureId }] = delegations;
  const allowed = new Set(
    Array.isArray(allowedFeatureIds) ? allowedFeatureIds : [],
  );
  if (!allowed.has(featureId)) {
    return { state: "invalid", featureId };
  }
  const enabled = new Set(
    Array.isArray(enabledFeatureIds) ? enabledFeatureIds : [],
  );
  return {
    state: enabled.has(featureId) ? "enabled" : "disabled",
    featureId,
  };
}

function delegatePatchMarker(
  source,
  ownerMarker,
  ownerPatchId,
  featureId,
) {
  const delegatedMarker = patchDelegationMarker(ownerPatchId, featureId);
  const ownerMarkerCount = source.split(ownerMarker).length - 1;
  const delegations = patchDelegations(source, ownerPatchId);
  if (
    ownerMarkerCount === 0 &&
    delegations.length === 1 &&
    delegations[0].marker === delegatedMarker
  ) {
    return source;
  }
  if (ownerMarkerCount !== 1 || delegations.length !== 0) {
    return null;
  }
  return source.replace(ownerMarker, delegatedMarker);
}

module.exports = {
  delegatePatchMarker,
  patchDelegationMarker,
  patchDelegationState,
  patchDelegations,
};
