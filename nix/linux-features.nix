{ lib }:
let
  supportedFeatureIds = [
    "appshots"
    "global-dictation"
    "mcp-helper-reaper"
    "node-repl-reaper"
    "open-target-discovery"
    "persistent-status-panel"
    "pet-overlay"
    "remote-mobile-control"
  ];

  sortAndDeduplicate = featureIds:
    lib.sort builtins.lessThan (lib.unique featureIds);

  normalize = featureIds:
    if !builtins.isList featureIds then
      throw "Nix Linux feature IDs must be provided as a list"
    else if !(lib.all builtins.isString featureIds) then
      throw "Nix Linux feature IDs must all be strings"
    else
      let
        normalized = sortAndDeduplicate featureIds;
        unsupported = lib.filter (featureId: !(lib.elem featureId supportedFeatureIds)) normalized;
      in
      if unsupported != [ ] then
        throw "Unsupported Nix Linux feature IDs: ${lib.concatStringsSep ", " unsupported}"
      else
        normalized;
in
{
  inherit normalize supportedFeatureIds;

  optionType = lib.types.listOf (lib.types.enum supportedFeatureIds);
}
