"use strict";

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const sidebarPattern = new RegExp(
  String.raw`function (${identifier})\(e\)\{"use forget";let t=\(0,${identifier}\.c\)\(\d+\),\{catalogPageScope:n,catalogSourcesReady:r,codexFeaturesAllowed:i,conversationSections:a,unreadsOnly:o,sidebarMode:s,workCloudSidebarContentVisible:c,workLocalSidebarContentVisible:l\}=e`,
  "g",
);
const hookAnchor = "u=a!==void 0&&a,d=o!==void 0&&o,f=ml(Z),{accountId:p,authMethod:m}=Ao()";
const layoutAnchor = "yt=Hl(xO,gt.activeConversationId??gt.activeServerConversationId),bt=pt;";
const titleActionPattern = /titleActions:(\(0,M3\.jsx\)\(xra,\{chatGptProjectCrudStatus:gt\.projectCrudStatus,menuRef:S,mode:`project`,sidebarMode:s,onCreateChatGptProject:gt\.handleCreateProjectOpen\}\)),titleActionsOnHover:!0,children:/g;
const atomName = "codexLinuxProjectSourceFilterAtom";
const hookName = "codexLinuxProjectSourceMode";
const componentName = "codexLinuxProjectSourceFilter";
const storageKey = "codex-linux-project-source-filter-v1";

function count(source, needle) {
  return source.split(needle).length - 1;
}

function filterComponent() {
  return `var ${atomName};function codexLinuxGetProjectSourceFilterAtom(){return ${atomName}??(${atomName}=us(\`${storageKey}\`,\`all\`))}function ${componentName}(){let e=ml(Z),t=Q(codexLinuxGetProjectSourceFilterAtom()),n=cs(),r=t===\`chatgpt\`||t===\`codex\`?t:\`all\`,i={all:{id:\`codexLinux.projectSource.all\`,defaultMessage:\`All\`,description:\`Show all project sources in the Projects sidebar\`},chatgpt:{id:\`codexLinux.projectSource.chatgpt\`,defaultMessage:\`ChatGPT\`,description:\`Show ChatGPT projects in the Projects sidebar\`},codex:{id:\`codexLinux.projectSource.codex\`,defaultMessage:\`Work\`,description:\`Show local and connected Codex projects in the Projects sidebar\`}},a=[\`all\`,\`chatgpt\`,\`codex\`].map(t=>({id:\`codex-linux-project-source-\${t}\`,type:\`radio\`,checked:r===t,message:Pu(i[t]),onSelect:()=>e.set(codexLinuxGetProjectSourceFilterAtom(),t)})),o=n.formatMessage({id:\`codexLinux.projectSource.label\`,defaultMessage:\`Filter projects by source\`,description:\`Accessible label for the Projects sidebar source filter\`});return(0,M3.jsx)(Vs,{trigger:\`click\`,align:\`start\`,items:a,children:(0,M3.jsx)(Th,{color:\`secondary\`,variant:r===\`all\`?\`transparent\`:\`ghost\`,selected:r!==\`all\`,pill:!1,uniform:!0,"aria-label":o,"aria-pressed":r!==\`all\`,children:n.formatMessage(i[r])})})}`;
}

function warnAndPreserve(source) {
  console.warn("WARN: Could not find unique current Projects sidebar source filter insertion points - skipping project source filter feature patch");
  return source;
}

function applyProjectSourceFilterPatch(source) {
  if (count(source, `function ${componentName}(){`) === 1 &&
      count(source, `var ${atomName};`) === 1 &&
      count(source, `${hookName}=Q(codexLinuxGetProjectSourceFilterAtom())`) === 1 &&
      count(source, `bt=s===\`chatgpt\`&&ae===\`project\`&&${hookName}!==\`all\``) === 1 &&
      count(source, `titleActions:s===\`chatgpt\`?(0,M3.jsxs)`) === 1) return source;

  const components = [...source.matchAll(sidebarPattern)];
  const actions = [...source.matchAll(titleActionPattern)];
  if (components.length !== 1 || actions.length !== 1 ||
      count(source, hookAnchor) !== 1 || count(source, layoutAnchor) !== 1 ||
      source.includes(`function ${componentName}(){`) ||
      source.includes(`var ${atomName};`)) return warnAndPreserve(source);

  const componentStart = components[0].index;
  const nextComponent = new RegExp(
    String.raw`function ${identifier}\(e\)\{let\{key:t\}=e;return t\}`,
  ).exec(source.slice(componentStart));
  const componentEnd = nextComponent == null ? -1 : componentStart + nextComponent.index;
  if (componentEnd < 0 || componentEnd - componentStart > 35_000) return warnAndPreserve(source);
  const component = source.slice(componentStart, componentEnd);
  if (count(component, hookAnchor) !== 1 || count(component, layoutAnchor) !== 1 ||
      count(component, actions[0][0]) !== 1) return warnAndPreserve(source);

  const action = actions[0][1];
  return source
    .replace(components[0][0], `${filterComponent()}${components[0][0]}`)
    .replace(hookAnchor, hookAnchor.replace(",f=ml(Z),", `,f=ml(Z),${hookName}=Q(codexLinuxGetProjectSourceFilterAtom()),`))
    .replace(layoutAnchor, layoutAnchor.replace("bt=pt", `bt=s===\`chatgpt\`&&ae===\`project\`&&${hookName}!==\`all\`?{...pt,projectKeys:pt.projectKeys.filter(e=>${hookName}===\`chatgpt\`?e.startsWith(\`chatgpt:project:\`):e.startsWith(\`codex:project:\`))}:pt`))
    .replace(actions[0][0], `titleActions:s===\`chatgpt\`?(0,M3.jsxs)(\`div\`,{className:\`flex items-center gap-1\`,children:[(0,M3.jsx)(${componentName},{}),${action}]}):${action},titleActionsOnHover:s!==\`chatgpt\`,children:`);
}

const descriptors = [{
  id: "projects-sidebar-source-filter",
  phase: "webview-asset",
  order: 20_900,
  ciPolicy: "optional",
  pattern: /^app-initial-[A-Za-z0-9_-]+\.js$/,
  missingDescription: "Projects sidebar webview bundle",
  skipDescription: "project source filter feature patch",
  apply: applyProjectSourceFilterPatch,
}];

module.exports = { applyProjectSourceFilterPatch, descriptors };
