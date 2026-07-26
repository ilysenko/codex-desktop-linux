"use strict";

const MAX_WRAPPER_TEXT_LENGTH = 4096;
const MAX_WRAPPER_ARGS = 64;
const WRAPPER_PROPERTY = "codexLinuxSshCommandWrapper";
const WRAPPER_TEXT_PROPERTY = "codexLinuxSshCommandWrapperText";
const MAIN_MARKER = "function codexLinuxSshCommandWrapperArgs(";
const WEBVIEW_MARKER = "function codexLinuxParseSshCommandWrapper(";

function wrapperError(message) {
  const error = new Error(message);
  error.code = "invalidSshCommandWrapper";
  return error;
}

function parseCommandWrapper(input) {
  if (typeof input !== "string") {
    throw wrapperError("Remote command wrapper must be text");
  }
  if (input.length > MAX_WRAPPER_TEXT_LENGTH) {
    throw wrapperError(`Remote command wrapper must be at most ${MAX_WRAPPER_TEXT_LENGTH} characters`);
  }
  if (input.includes("\0") || /[\r\n]/u.test(input)) {
    throw wrapperError("Remote command wrapper cannot contain NUL or newlines");
  }

  const args = [];
  let value = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else value += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        index += 1;
        if (index >= input.length) throw wrapperError("Remote command wrapper has a trailing escape");
        const escaped = input[index];
        value += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
      } else {
        value += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      index += 1;
      if (index >= input.length) throw wrapperError("Remote command wrapper has a trailing escape");
      value += input[index];
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
        if (args.length > MAX_WRAPPER_ARGS) {
          throw wrapperError(`Remote command wrapper must have at most ${MAX_WRAPPER_ARGS} arguments`);
        }
      }
      continue;
    }
    if (/[;&|<>]/u.test(char)) {
      throw wrapperError(`Remote command wrapper contains an unquoted shell operator: ${char}`);
    }
    value += char;
    started = true;
  }
  if (quote != null) throw wrapperError("Remote command wrapper has an unterminated quote");
  if (started) args.push(value);
  if (args.length > MAX_WRAPPER_ARGS) {
    throw wrapperError(`Remote command wrapper must have at most ${MAX_WRAPPER_ARGS} arguments`);
  }
  if (args.length > 0 && args[0].length === 0) {
    throw wrapperError("Remote command wrapper executable cannot be empty");
  }
  return args;
}

function quoteShellArg(value) {
  if (typeof value !== "string" || value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatCommandWrapper(args) {
  const valid = validateCommandWrapperArgs(args);
  return valid.map(quoteShellArg).join(" ");
}

function validateCommandWrapperArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_WRAPPER_ARGS) {
    throw wrapperError("Remote command wrapper argv is invalid");
  }
  let totalLength = 0;
  const result = value.map((arg) => {
    if (typeof arg !== "string" || /[\0\r\n]/u.test(arg)) {
      throw wrapperError("Remote command wrapper argv is invalid");
    }
    totalLength += arg.length;
    return arg;
  });
  if (totalLength > MAX_WRAPPER_TEXT_LENGTH) {
    throw wrapperError("Remote command wrapper argv is too long");
  }
  if (result.length > 0 && result[0].length === 0) {
    throw wrapperError("Remote command wrapper executable cannot be empty");
  }
  return result;
}

function wrapRemoteCommand(command, args) {
  const valid = validateCommandWrapperArgs(args);
  if (valid.length === 0) return command;
  return `exec ${valid.map(quoteShellArg).join(" ")} ${quoteShellArg(command)}`;
}

function replaceRequired(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    console.warn(`WARN: Could not find ${label} - skipping SSH command-wrapper patch`);
    return null;
  }
  return source.replace(needle, replacement);
}

function mainHelperSource() {
  return [
    "function codexLinuxSshCommandWrapperArgs(e){if(e==null)return[];if(!Array.isArray(e)||e.length>64)throw Error(`Invalid SSH remote command wrapper`);let t=0,n=e.map(e=>{if(typeof e!=`string`||/[\\0\\r\\n]/u.test(e))throw Error(`Invalid SSH remote command wrapper`);if(t+=e.length,t>4096)throw Error(`Invalid SSH remote command wrapper`);return e});if(n.length>0&&n[0].length===0)throw Error(`Invalid SSH remote command wrapper`);return n}",
    "function codexLinuxSshCommandWrapperQuote(e){return e.length>0&&/^[A-Za-z0-9_@%+=:,./-]+$/u.test(e)?e:`'${e.replaceAll(`'`,`'\\\\''`)}'`}",
    "function codexLinuxSshWrapRemoteCommand(e,t){let n=codexLinuxSshCommandWrapperArgs(t);return n.length===0?e:`exec ${n.map(codexLinuxSshCommandWrapperQuote).join(` `)} ${codexLinuxSshCommandWrapperQuote(e)}`}",
  ].join("");
}

function applyMainBundlePatch(source) {
  if (source.includes(MAIN_MARKER)) return source;

  let patched = source;
  const helperNeedle = "function Gx(";
  const helperIndex = patched.indexOf(helperNeedle);
  if (helperIndex < 0) {
    console.warn("WARN: Could not find SSH login-shell helper - skipping SSH command-wrapper patch");
    return source;
  }
  patched = `${patched.slice(0, helperIndex)}${mainHelperSource()}${patched.slice(helperIndex)}`;

  const replacements = [
    [
      "Gx(e,s)]",
      `codexLinuxSshWrapRemoteCommand(Gx(e,s),this.options.sshConnection.${WRAPPER_PROPERTY})]`,
      "SSH management command",
    ],
    [
      "Gx(t,i)]",
      `codexLinuxSshWrapRemoteCommand(Gx(t,i),this.options.sshConnection.${WRAPPER_PROPERTY})]`,
      "SSH app-server proxy command",
    ],
    [
      "return t?{sshConnection:{alias:t.sshAlias,host:t.sshHost,port:t.sshPort,identity:t.identity}}:null",
      `return t?{sshConnection:{alias:t.sshAlias,host:t.sshHost,port:t.sshPort,identity:t.identity,${WRAPPER_PROPERTY}:t.${WRAPPER_PROPERTY}}}:null`,
      "SSH transport host mapping",
    ],
    [
      "function Wre(e){let t=e.alias?.trim();return t?`alias:${t}`:[`direct`,e.host,String(e.port??``),e.identity?.trim()??``].join(`",
      `function Wre(e){let t=e.alias?.trim(),n=JSON.stringify(codexLinuxSshCommandWrapperArgs(e.${WRAPPER_PROPERTY}));return t?\`alias:\${t}:\${n}\`:[\`direct\`,e.host,String(e.port??\`\`),e.identity?.trim()??\`\`,n].join(\``,
      "SSH startup-gate identity",
    ],
    [
      "displayName:e.displayName,autoConnect:!1})",
      `displayName:e.displayName,${WRAPPER_PROPERTY}:e.${WRAPPER_PROPERTY},autoConnect:!1})`,
      "saved alias runtime mapping",
    ],
    [
      "sshPort:e.sshPort,identity:e.identity}]),...t.filter",
      `sshPort:e.sshPort,identity:e.identity,${WRAPPER_PROPERTY}:e.${WRAPPER_PROPERTY}}]),...t.filter`,
      "saved hostname runtime mapping",
    ],
    [
      "sshPort:e.sshPort,identity:e.identity}:{hostId:e.hostId,connectionAnalyticsId:e.connectionAnalyticsId,displayName:e.displayName,source:`discovered`,alias:e.alias,hostname:null,sshPort:null,identity:null}",
      `sshPort:e.sshPort,identity:e.identity,${WRAPPER_PROPERTY}:e.${WRAPPER_PROPERTY}}:{hostId:e.hostId,connectionAnalyticsId:e.connectionAnalyticsId,displayName:e.displayName,source:\`discovered\`,alias:e.alias,hostname:null,sshPort:null,identity:null,${WRAPPER_PROPERTY}:e.${WRAPPER_PROPERTY}}`,
      "current saved connection normalization",
    ],
    [
      "sshPort:t.sshPort,identity:t.identity}:{hostId:t.hostId,connectionAnalyticsId:t.connectionAnalyticsId,displayName:t.displayName,source:`discovered`,alias:n,hostname:null,sshPort:null,identity:null}",
      `sshPort:t.sshPort,identity:t.identity,${WRAPPER_PROPERTY}:t.${WRAPPER_PROPERTY}}:{hostId:t.hostId,connectionAnalyticsId:t.connectionAnalyticsId,displayName:t.displayName,source:\`discovered\`,alias:n,hostname:null,sshPort:null,identity:null,${WRAPPER_PROPERTY}:t.${WRAPPER_PROPERTY}}`,
      "legacy saved connection normalization",
    ],
    [
      "identity:e.identity}};return e.homeDir",
      `identity:e.identity,${WRAPPER_PROPERTY}:e.${WRAPPER_PROPERTY}}};return e.homeDir`,
      "SSH host metadata",
    ],
    [
      "var O$=n.mu({sshAlias:n._u().nullable(),sshHost:n._u(),sshPort:n.pu().nullable(),identity:n._u().nullable()});",
      `var O$=n.mu({sshAlias:n._u().nullable(),sshHost:n._u(),sshPort:n.pu().nullable(),identity:n._u().nullable(),${WRAPPER_PROPERTY}:n.ou(n._u()).optional()});`,
      "SSH host metadata schema",
    ],
    [
      "sshPort:e.sshPort,identity:e.identity,codexCliCommand:[]",
      `sshPort:e.sshPort,identity:e.identity,${WRAPPER_PROPERTY}:e.${WRAPPER_PROPERTY},codexCliCommand:[]`,
      "SSH host configuration",
    ],
  ];

  for (const [needle, replacement, label] of replacements) {
    const next = replaceRequired(patched, needle, replacement, label);
    if (next == null) return source;
    patched = next;
  }
  return patched;
}

function webviewHelperSource() {
  return [
    "function codexLinuxParseSshCommandWrapper(e){if(typeof e!=`string`||e.length>4096||/[\\0\\r\\n]/u.test(e))throw Error(`invalid`);let t=[],n=``,r=null,i=!1;for(let a=0;a<e.length;a++){let o=e[a];if(r===`'`){o===`'`?r=null:n+=o,i=!0;continue}if(r===`\\\"`){if(o===`\\\"`)r=null;else if(o===`\\\\`){if(++a>=e.length)throw Error(`invalid`);let t=e[a];n+=`$\\\\\\\"`.includes(t)?t:`\\\\${t}`}else n+=o;i=!0;continue}if(o===`'`||o===`\\\"`){r=o,i=!0;continue}if(o===`\\\\`){if(++a>=e.length)throw Error(`invalid`);n+=e[a],i=!0;continue}if(/\\s/u.test(o)){if(i&&(t.push(n),n=``,i=!1,t.length>64))throw Error(`invalid`);continue}if(/[;&|<>]/u.test(o))throw Error(`invalid`);n+=o,i=!0}if(r!=null)throw Error(`invalid`);if(i&&t.push(n),t.length>64||t.length>0&&t[0].length===0)throw Error(`invalid`);return t}",
    "function codexLinuxFormatSshCommandWrapper(e){return Array.isArray(e)?e.map(e=>typeof e==`string`&&e.length>0&&/^[A-Za-z0-9_@%+=:,./-]+$/u.test(e)?e:`'${String(e??``).replaceAll(`'`,`'\\\\''`)}'`).join(` `):``}",
  ].join("");
}

function applyWebviewPatch(source) {
  if (source.includes(WEBVIEW_MARKER)) return source;
  if (!source.includes("function Pi(){return{displayName:") || !source.includes("function Bi(e){")) {
    console.warn("WARN: Could not find remote-connections settings editor - skipping SSH command-wrapper patch");
    return source;
  }

  let patched = source.replace("function Pi(){", `${webviewHelperSource()}function Pi(){`);
  const replacements = [
    [
      "authMode:`none`,identity:``}}",
      `authMode:\`none\`,identity:\`\`,${WRAPPER_TEXT_PROPERTY}:\`\`}}`,
      "new connection draft",
    ],
    [
      "authMode:e.identity==null?`none`:`identity`,identity:e.identity??``}}",
      `authMode:e.identity==null?\`none\`:\`identity\`,identity:e.identity??\`\`,${WRAPPER_TEXT_PROPERTY}:codexLinuxFormatSshCommandWrapper(e.${WRAPPER_PROPERTY})}}`,
      "saved connection draft",
    ],
    [
      "identity:e.authMode===`identity`?e.identity.trim():null}:{hostId:",
      `identity:e.authMode===\`identity\`?e.identity.trim():null,${WRAPPER_PROPERTY}:codexLinuxParseSshCommandWrapper(e.${WRAPPER_TEXT_PROPERTY})}:{hostId:`,
      "hostname connection save",
    ],
    [
      "sshPort:null,identity:null}}function Li(",
      `sshPort:null,identity:null,${WRAPPER_PROPERTY}:codexLinuxParseSshCommandWrapper(e.${WRAPPER_TEXT_PROPERTY})}}function Li(`,
      "alias connection save",
    ],
    [
      "let r=[],i=e.displayName.trim();",
      `let r=[],i=e.displayName.trim();try{codexLinuxParseSshCommandWrapper(e.${WRAPPER_TEXT_PROPERTY})}catch{r.push(\`invalidSshCommandWrapper\`)}`,
      "wrapper validation",
    ],
    [
      "children:[D,k,A]",
      `children:[D,k,A,(0,q.jsx)(_.Field,{name:\`${WRAPPER_TEXT_PROPERTY}\`,children:e=>(0,q.jsx)(Wi,{label:(0,q.jsxs)(q.Fragment,{children:[(0,q.jsx)(U,{id:\`settings.remoteConnections.dialog.field.commandWrapper\`,defaultMessage:\`Remote command wrapper\`,description:\`Label for the optional SSH remote command wrapper field\`}),\` \`,(0,q.jsx)(\`span\`,{className:\`font-normal text-token-text-secondary\`,children:(0,q.jsx)(U,{id:\`settings.remoteConnections.dialog.field.commandWrapper.optional\`,defaultMessage:\`(optional)\`,description:\`Marker for the optional SSH remote command wrapper field\`})})]}),description:(0,q.jsx)(U,{id:\`settings.remoteConnections.dialog.field.commandWrapper.description\`,defaultMessage:\`Runs every Codex SSH operation through this argv command and appends the generated remote command as its final argument.\`,description:\`Description for the SSH remote command wrapper field\`}),placeholder:\`ssh -T target-host --\`,value:e.state.value,onChange:e.handleChange,onBlur:e.handleBlur,disabled:l})})]`,
      "wrapper settings field",
    ],
    [
      "function Gi(e){switch(e){",
      "function Gi(e){switch(e){case`invalidSshCommandWrapper`:return(0,q.jsx)(U,{id:`settings.remoteConnections.dialog.field.commandWrapper.error`,defaultMessage:`Enter a valid command (quotes and escapes are supported; shell operators are not)`,description:`Error for an invalid SSH remote command wrapper`});",
      "wrapper validation message",
    ],
  ];
  for (const [needle, replacement, label] of replacements) {
    const next = replaceRequired(patched, needle, replacement, label);
    if (next == null) return source;
    patched = next;
  }
  return patched;
}

module.exports = {
  MAX_WRAPPER_ARGS,
  MAX_WRAPPER_TEXT_LENGTH,
  applyMainBundlePatch,
  applyWebviewPatch,
  formatCommandWrapper,
  parseCommandWrapper,
  quoteShellArg,
  validateCommandWrapperArgs,
  wrapRemoteCommand,
  descriptors: [
    {
      id: "main-bundle-ssh-command-wrapper",
      phase: "main-bundle",
      order: 20700,
      ciPolicy: "opt-in",
      apply: applyMainBundlePatch,
    },
    {
      id: "webview-ssh-command-wrapper-settings",
      phase: "webview-asset",
      order: 20710,
      ciPolicy: "opt-in",
      pattern: /^remote-connections-settings-[^.]+\.js$/u,
      missingDescription: "remote-connections settings webview bundle",
      skipDescription: "SSH command-wrapper settings patch",
      apply: applyWebviewPatch,
    },
  ],
};
