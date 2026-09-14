"use strict";

const marker = "/*preferred-editor-file-links*/";
// Match the unique compiled file-reference dispatch, not minified aliases or filenames.
const anchor = /if\(([$\w]+)&&!([$\w]+)&&!([$\w]+)\)\{([$\w]+)\(\{(scope:[$\w]+,activatePresentationAnnotationOnboarding:!0,artifactNavigationTarget:[$\w]+,path:([$\w]+),line:[$\w]+,column:[$\w]+,cwd:[$\w]+,hostConfig:[$\w]+,hostId:[$\w]+,endLine:[$\w]+,isPreview:[$\w]+,openInSidePanel:[$\w]+,onOpenTargetResolved:[$\w]+)\}\);return\}/g;
const sourcePath = /(?:\.(?:rs|py|pyi|js|jsx|ts|tsx|mjs|cjs|c|h|cc|cpp|hpp|go|java|kt|swift|rb|php|lua|sh|bash|fish|zsh|nix|toml|json|jsonc|ya?ml|xml|ini|conf|cfg|md|mdx|txt|log|lock|sql|css|scss|sass|less|vue|svelte|cmake|proto|graphql|gql)|(?:^|\/)(?:Dockerfile|Containerfile|Makefile|Justfile|README|LICENSE|\.gitignore|\.env))$/i;

function applyPreferredEditorFileLinks(source) {
  const matches = [...source.matchAll(anchor)];
  if (matches.length !== 1) return drift(source);
  const [match] = matches;
  const [, , browserClick, modifiedClick, dispatch, originalArgs, path] = match;
  // With no explicit target, upstream resolves the current per-project/global
  // preference, available applications, remote host and editor launch command.
  const args = originalArgs
    .replace("activatePresentationAnnotationOnboarding:!0,", "")
    .replace(/openInSidePanel:[$\w]+,/, "openInSidePanel:!1,");
  const insertion = `${marker}if(!${browserClick}&&!${modifiedClick}&&${sourcePath}.test(${path})){${dispatch}({${args}});return}`;
  const markerCount = source.split(marker).length - 1;
  if (markerCount !== 0) {
    if (markerCount === 1 && source.slice(match.index - insertion.length, match.index) === insertion) return source;
    return drift(source);
  }
  return source.slice(0, match.index) + insertion + source.slice(match.index);
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
    pattern: /\.js$/,
    assetMatch: source => source.includes("activatePresentationAnnotationOnboarding:!0") && source.includes("data-file-reference"),
    missingDescription: "plain file-reference click handler",
    skipDescription: "source file links using the preferred editor",
    apply: applyPreferredEditorFileLinks,
  }],
};
