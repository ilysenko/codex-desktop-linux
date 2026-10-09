"use strict";

// Entry point for a disposable official-runtime probe. Never uses real logins.
const electron = require("electron");
const fs = require("node:fs");
const path = require("node:path");

electron.app.whenReady().then(async () => {
  const { createAccountSwitcher } = require(process.env.ACCOUNT_SWITCHER_PROBE_RUNTIME);
  const home = process.env.CODEX_HOME;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: {
    id_token: token({ sub: "native-probe", email: "native-probe@example.invalid" }),
    access_token: token({ "https://api.openai.com/auth": { chatgpt_account_id: "native-probe", user_id: "native-probe" } }),
    refresh_token: "synthetic-probe-secret", account_id: "native-probe",
  } });
  fs.writeFileSync(path.join(home, "auth.json"), auth, { mode: 0o600 });
  const errors = [];
  let menus = 0, openedLogin = 0, selectAdd = false, readyChecks = 0;
  const bundles = path.join(process.env.ACCOUNT_SWITCHER_PROBE_NATIVE_APP, "resources/app.asar/.vite/build");
  const modules = fs.readdirSync(bundles).filter(name => name.endsWith(".js") &&
    ["async sendAppServerRequest(", "registerInternalNotificationHandler(", "getPendingRequestCount("].every(anchor => fs.readFileSync(path.join(bundles, name), "utf8").includes(anchor)));
  if (modules.length !== 1) throw Error("Native connection module contract drifted");
  const connectionModule = require(path.join(bundles, modules[0]));
  const classes = Object.values(connectionModule).filter(value => typeof value === "function"
    && value.prototype?.sendAppServerRequest && value.prototype?.registerInternalNotificationHandler
    && value.prototype?.getPendingRequestCount);
  if (classes.length !== 1) throw Error("Native connection contract drifted");
  const makeClient = id => {
    // Keep upstream's actual request wrappers, pending counts and subscription
    // methods; substitute only transport/identity, without real credentials.
    const client = Object.create(classes[0].prototype);
    Object.assign(client, {
      options: { hostId: id, hostConfig: { id, kind: "local" }, transport: { kind: id === "local" ? "stdio" : "websocket" } },
      connection: id === "local" ? {} : null,
      internalNotificationHandlers: new Set(), internalResponseHandlers: new Map(),
      clientRequestQueue: { size: 0, updatePeakPendingRequestCount() {} },
      backendAuth: { beginAccountChange() {}, finishAccountChange() {} },
      configuration: { handleSuccessfulRequest() {} },
      getAuthenticatedPrincipal: async () => ({ accountId: "native-probe", userId: "native-probe" }),
      ensureReady: async () => { readyChecks++; client.connection = {}; },
      clearAuthTokenCache() {}, restart: async () => {},
      messageDelivery: { sendMessage: request => {
        if (!client.connection) throw Error("Codex app-server is not available");
        // Global cloud work must not be read, cancelled or reconnected by a
        // local account change, even if its catalog reports an active task.
        if (id === "durable") throw Error("Do not request independent durable tasks");
        let result;
        switch (request.method) {
          case "thread/loaded/list": result = { data: [], nextCursor: null }; break;
          case "account/login/start": result = { type: "chatgpt", loginId: "probe-login", authUrl: "https://auth.openai.com/oauth/authorize?probe=1" }; break;
          case "account/login/cancel": result = {}; break;
          case "account/read": result = { account: null }; break;
          default: throw Error("Unexpected probe method");
        }
        queueMicrotask(() => {
          const handler = client.internalResponseHandlers.get(String(request.id));
          client.internalResponseHandlers.delete(String(request.id));
          handler.resolve({ id: request.id, result });
        });
      } },
    });
    return client;
  };
  const client = makeClient("local"), lazy = makeClient("durable");
  const api = {
    // An old implementation triggers the actual missing Owl binding here.
    get safeStorage() { return electron.safeStorage; },
    dialog: { showMessageBox: async options => { if (options.type === "error") errors.push(options.detail); return { response: 0 }; } },
    shell: { openExternal: async () => { openedLogin++; } },
    Menu: { buildFromTemplate: template => ({ popup: ({ callback }) => { menus++; if (selectAdd) template.find(item => item.value === "add").click(); callback(); } }) },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // A fresh instance must retrieve the persisted key and decrypt the vault.
    await createAccountSwitcher({ electron: api, clients: () => [client, lazy], home, reload() {} }).open(client);
  }
  selectAdd = true;
  await createAccountSwitcher({ electron: api, clients: () => [client, lazy], home, reload() {} }).open(client);
  const vault = path.join(home, ".community-account-switcher/accounts.json");
  const encryptedVault = fs.existsSync(vault) && !fs.readFileSync(vault, "utf8").includes("synthetic-probe-secret");
  const cloudUntouched = lazy.connection === null && lazy.getPendingRequestCount() === 0;
  fs.writeFileSync(process.env.ACCOUNT_SWITCHER_PROBE_RESULT, JSON.stringify({ menus, encryptedVault, errors, openedLogin, readyChecks, cloudUntouched }), { mode: 0o600 });
}).catch(() => {
  fs.writeFileSync(process.env.ACCOUNT_SWITCHER_PROBE_RESULT, JSON.stringify({ probeFailed: true }), { mode: 0o600 });
}).finally(() => electron.app.quit()); // Only this disposable probe exits.
