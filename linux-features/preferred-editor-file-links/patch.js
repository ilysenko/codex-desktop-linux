"use strict";

const marker = "/*preferred-editor-file-links*/";
// Match the unique compiled file-reference dispatch, not minified aliases or
// filenames. Upstream compiles the click branches into one conditional chain
// whose last branch opens the internal side panel:
// `…:!panel||browser||modified?!modified||preview(path)&&panel?open({…,modifiedClick:modified,openInSidePanel:panel,…}):copy():open({…side panel…})`.
const I = "[$\\w]+";
const anchor = new RegExp(
  String.raw`:!(${I})\|\|(${I})\|\|(${I})\?!\3\|\|\(0,${I}\.${I}\)\((${I})\)&&\1\?(\(0,${I}\.openWorkspaceFile\))` +
    String.raw`\(\{[^()]*?modifiedClick:\3,openInSidePanel:\1,onOpenTargetResolved:${I}\}\):${I}\(\):\5` +
    String.raw`\(\{(scope:${I},activatePresentationAnnotationOnboarding:!0,artifactNavigationTarget:${I},path:\4,line:${I},column:${I},cwd:${I},hostConfig:${I},hostId:${I},endLine:${I},isPreview:${I},openInSidePanel:\1,onOpenTargetResolved:${I})\}\)`,
  "g",
);
const sourcePath = /(?:\.(?:rs|py|pyi|js|jsx|ts|tsx|mjs|cjs|c|h|cc|cpp|hpp|go|java|kt|swift|rb|php|lua|sh|bash|fish|zsh|nix|toml|json|jsonc|ya?ml|xml|ini|conf|cfg|md|mdx|txt|log|lock|sql|css|scss|sass|less|vue|svelte|cmake|proto|graphql|gql)|(?:^|\/)(?:Dockerfile|Containerfile|Makefile|Justfile|README|LICENSE|\.gitignore|\.env))$/i;

function applyPreferredEditorFileLinks(source) {
  const matches = [...source.matchAll(anchor)];
  if (matches.length !== 1) return drift(source);
  const [match] = matches;
  const [, , browserClick, modifiedClick, path, dispatch, originalArgs] = match;
  // Insert a new conditional branch directly before the upstream branch that
  // chooses between external/modified opening and the internal side panel.
  const index = match.index + 1;
  // With no explicit target, upstream resolves the current per-project/global
  // preference, available applications, remote host and editor launch command.
  const args = originalArgs
    .replace("activatePresentationAnnotationOnboarding:!0,", "")
    .replace(/openInSidePanel:[$\w]+,/, "openInSidePanel:!1,");
  const insertion = `${marker}!${browserClick}&&!${modifiedClick}&&${sourcePath}.test(${path})?${dispatch}({${args}}):`;
  const markerCount = source.split(marker).length - 1;
  if (markerCount !== 0) {
    if (markerCount === 1 && source.slice(index - insertion.length, index) === insertion) return source;
    return drift(source);
  }
  return source.slice(0, index) + insertion + source.slice(index);
}

function drift(source) {
  console.warn("[preferred-editor-file-links] File-reference click contract changed or is ambiguous. Disable preferred-editor-file-links and rebuild, or update its patch for the current official package.");
  return source;
}

module.exports = {
  applyPreferredEditorFileLinks,
  descriptors: [{
    id: "plain-file-click",
    phase: "webview-asset",
    order: 21000,
    ciPolicy: "optional",
    assetNeedles: ["activatePresentationAnnotationOnboarding:!0,artifactNavigationTarget:", "openWorkspaceFile"],
    missingDescription: "plain file-reference click handler",
    skipDescription: "source file links using the preferred editor",
    apply: applyPreferredEditorFileLinks,
  }],
};
