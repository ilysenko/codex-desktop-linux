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
  let menus = 0;
  const client = { getAuthenticatedPrincipal: async () => ({ accountId: "native-probe", userId: "native-probe" }) };
  const api = {
    // An old implementation triggers the actual missing Owl binding here.
    get safeStorage() { return electron.safeStorage; },
    dialog: { showMessageBox: async options => { errors.push(options.detail); return { response: 0 }; } },
    shell: electron.shell,
    Menu: { buildFromTemplate: () => ({ popup: ({ callback }) => { menus++; callback(); } }) },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // A fresh instance must retrieve the persisted key and decrypt the vault.
    await createAccountSwitcher({ electron: api, clients: () => [client], home, reload() {} }).open(client);
  }
  const vault = path.join(home, ".community-account-switcher/accounts.json");
  const encryptedVault = fs.existsSync(vault) && !fs.readFileSync(vault, "utf8").includes("synthetic-probe-secret");
  fs.writeFileSync(process.env.ACCOUNT_SWITCHER_PROBE_RESULT, JSON.stringify({ menus, encryptedVault, errors }), { mode: 0o600 });
}).catch(() => {
  fs.writeFileSync(process.env.ACCOUNT_SWITCHER_PROBE_RESULT, JSON.stringify({ probeFailed: true }), { mode: 0o600 });
}).finally(() => electron.app.quit()); // Only this disposable probe exits.
