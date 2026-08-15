{ lib }:
let
  featuresRoot = ../linux-features;
  compatibility = builtins.fromJSON (builtins.readFile (featuresRoot + "/compatibility.json"));
  entries = builtins.readDir featuresRoot;
  featureDirectories = lib.filter
    (name: entries.${name} == "directory" && builtins.pathExists (featuresRoot + "/${name}/feature.json"))
    (builtins.attrNames entries);
  manifests = map
    (name:
      let manifest = builtins.fromJSON (builtins.readFile (featuresRoot + "/${name}/feature.json"));
      in if manifest.id == name then manifest
      else throw "Linux feature directory '${name}' contains mismatched id '${manifest.id}'")
    featureDirectories;
  manifestIds = map (manifest: manifest.id) manifests;
  internalFeatureIds = lib.sort builtins.lessThan (
    map (manifest: manifest.id) (lib.filter (manifest: manifest.internal or false) manifests)
  );
  supportedFeatureIds =
    if builtins.length manifestIds == builtins.length (lib.unique manifestIds)
    then lib.filter (featureId: !(lib.elem featureId internalFeatureIds))
      (lib.sort builtins.lessThan manifestIds)
    else throw "Duplicate Linux feature IDs were discovered";
  manifestById = lib.listToAttrs (map (manifest: {
    name = manifest.id;
    value = manifest;
  }) manifests);
  aliases = compatibility.aliases;
  retiredFeatureIds = compatibility.retired;

  sortAndDeduplicate = featureIds:
    lib.sort builtins.lessThan (lib.unique featureIds);

  expandFeature = stack: featureId:
    if lib.elem featureId stack then
      throw "Linux feature dependency cycle: ${lib.concatStringsSep " -> " (stack ++ [ featureId ])}"
    else if !(lib.elem featureId supportedFeatureIds) then
      [ featureId ]
    else
      let manifest = manifestById.${featureId};
      in lib.concatMap (expandFeature (stack ++ [ featureId ])) (manifest.requires or [ ])
        ++ [ featureId ];

  normalize = featureIds:
    if !builtins.isList featureIds then
      throw "Nix Linux feature IDs must be provided as a list"
    else if !(lib.all builtins.isString featureIds) then
      throw "Nix Linux feature IDs must all be strings"
    else
      let
        canonical = map (featureId: aliases.${featureId} or featureId) featureIds;
        selected = sortAndDeduplicate (lib.filter
          (featureId: !(lib.elem featureId retiredFeatureIds))
          canonical);
        normalized = sortAndDeduplicate (lib.concatMap (expandFeature [ ]) selected);
        unsupported = lib.filter (featureId: !(lib.elem featureId supportedFeatureIds)) normalized;
        dependencyErrors = lib.concatMap
          (featureId:
            let manifest = manifestById.${featureId};
            in
              map (conflict: "'${featureId}' conflicts with '${conflict}'")
                (lib.filter (conflict: lib.elem conflict normalized) (manifest.conflicts or [ ])))
          (lib.filter (featureId: lib.elem featureId supportedFeatureIds) normalized);
      in
      if unsupported != [ ] then
        throw "Unsupported Nix Linux feature IDs: ${lib.concatStringsSep ", " unsupported}"
      else if dependencyErrors != [ ] then
        throw "Invalid Nix Linux feature selection: ${lib.concatStringsSep "; " dependencyErrors}"
      else
        normalized;
  normalizeAll = featureIds:
    if !builtins.isList featureIds then
      throw "Nix Linux feature IDs must be provided as a list"
    else if !(lib.all builtins.isString featureIds) then
      throw "Nix Linux feature IDs must all be strings"
    else
      let
        canonical = map (featureId: aliases.${featureId} or featureId) featureIds;
        normalized = sortAndDeduplicate (lib.filter
          (featureId: !(lib.elem featureId retiredFeatureIds))
          canonical);
        unsupported = lib.filter (featureId: !(lib.elem featureId manifestIds)) normalized;
      in
      if unsupported != [ ] then
        throw "Unsupported internal Nix Linux feature IDs: ${lib.concatStringsSep ", " unsupported}"
      else
        normalized;
in
{
  inherit internalFeatureIds normalize normalizeAll retiredFeatureIds supportedFeatureIds;

  # Keep explicitly retired IDs valid while rejecting arbitrary unknown IDs
  # and dependency conflicts during option checking, even for custom packages.
  optionType = lib.types.addCheck (lib.types.listOf lib.types.str)
    (featureIds: (builtins.tryEval (builtins.deepSeq (normalize featureIds) true)).success);
}
