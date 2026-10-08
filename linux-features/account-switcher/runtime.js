"use strict";

// Self-contained: the patch embeds this function in the official main bundle.
// Nothing here runs until a user opens the account switcher.
function createAccountSwitcher({ electron, clients, home, reload }) {
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { dialog, safeStorage, shell, Menu } = electron;
  const root = path.join(home, ".community-account-switcher");
  const vaultPath = path.join(root, "accounts.json");
  const authPath = path.join(home, "auth.json");
  class SwitcherError extends Error {}
  let menuOpen = false;
  let busy = false;

  function choose(entries, window) {
    return new Promise(resolve => {
      let selected = null;
      const menu = Menu.buildFromTemplate(entries.map(entry => entry.type === "separator" ? entry : {
        ...entry, click: () => { selected = entry.value; },
      }));
      menu.popup({ ...(window ? { window } : {}), callback: () => resolve(selected) });
    });
  }

  function privatePath(file, directory = false) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
        stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new SwitcherError("Account storage must be owned by you, private, and not a symlink.");
    }
    return stat;
  }

  function readPrivate(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576) {
        throw new SwitcherError("Account storage is not a private regular file.");
      }
      return fs.readFileSync(fd, "utf8");
    } finally { fs.closeSync(fd); }
  }

  function writePrivate(file, value) {
    try { privatePath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temp = `${file}.${crypto.randomUUID()}`;
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
  }

  function encryptionReady() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new SwitcherError("Unlock your system keyring to use the account switcher. Plaintext storage is disabled.");
    }
    fs.mkdirSync(root, { mode: 0o700, recursive: true });
    privatePath(root, true);
  }

  function identity(text) {
    let auth, claims, accessClaims;
    try {
      auth = JSON.parse(text);
      const tokens = auth.tokens;
      if (auth.auth_mode !== "chatgpt" || !tokens ||
          ![tokens.access_token, tokens.refresh_token, tokens.id_token, tokens.account_id].every(v => typeof v === "string" && v.length > 0)) {
        throw new SwitcherError();
      }
      claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8"));
      accessClaims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"));
      const authClaims = accessClaims["https://api.openai.com/auth"];
      if ((authClaims?.chatgpt_account_id ?? authClaims?.account_id) !== tokens.account_id ||
          typeof (authClaims?.user_id ?? authClaims?.chatgpt_user_id) !== "string") throw new SwitcherError();
      if (typeof claims.sub !== "string" || !claims.sub) throw new SwitcherError();
    } catch { throw new SwitcherError("Only complete ChatGPT file logins can be remembered. Sign in with ChatGPT first."); }
    const id = crypto.createHash("sha256").update(JSON.stringify([claims.sub, auth.tokens.account_id])).digest("hex");
    const email = typeof claims.email === "string" ? claims.email : "ChatGPT account";
    const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
    const title = `${email} — ${typeof plan === "string" ? plan : "ChatGPT"} (${auth.tokens.account_id.slice(-6)})`;
    const userId = accessClaims["https://api.openai.com/auth"].user_id ?? accessClaims["https://api.openai.com/auth"].chatgpt_user_id;
    return { id, accountId: auth.tokens.account_id, userId, title: title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 220) };
  }

  function load() {
    encryptionReady();
    let parsed;
    try { parsed = JSON.parse(readPrivate(vaultPath)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || parsed.accounts.length > 20) throw new SwitcherError("Invalid saved account storage.");
    const ids = new Set();
    return parsed.accounts.map(record => {
      if (typeof record.encrypted !== "string") throw new SwitcherError("Invalid saved account storage.");
      const text = safeStorage.decryptString(Buffer.from(record.encrypted, "base64"));
      const info = identity(text);
      if (info.id !== record.id || ids.has(info.id)) throw new SwitcherError("Invalid saved account identity.");
      ids.add(info.id);
      return { ...info, encrypted: record.encrypted };
    });
  }

  function save(accounts) {
    if (accounts.length > 20) throw new SwitcherError("At most 20 accounts can be remembered. Forget an account first.");
    writePrivate(vaultPath, JSON.stringify({ version: 1, accounts }));
  }

  function remember(accounts, text) {
    const info = identity(text);
    const record = { ...info, encrypted: safeStorage.encryptString(text).toString("base64") };
    const next = accounts.filter(account => account.id !== info.id);
    next.push(record);
    next.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    save(next);
    return next;
  }

  async function rpc(client, method, params) {
    const response = await client.sendInternalRequest({ id: `community-account:${crypto.randomUUID()}`, method, params }, { timeoutMs: 15_000 });
    if (response.error || response.result == null) throw new SwitcherError("The app server could not complete the account operation.");
    return response.result;
  }

  async function assertIdle() {
    for (const client of clients()) {
      if (client.getPendingRequestCount() !== 0) throw new SwitcherError("Wait for pending requests and active tasks to finish before switching accounts.");
      let cursor = null;
      const seen = new Set();
      for (;;) {
        const page = await rpc(client, "thread/loaded/list", { cursor, limit: 100 });
        if (!Array.isArray(page.data)) throw new SwitcherError("Unable to verify that tasks are idle.");
        for (const threadId of page.data) {
          const { thread } = await rpc(client, "thread/read", { threadId, includeTurns: false });
          if (!["idle", "notLoaded", "systemError"].includes(thread?.status?.type)) {
            throw new SwitcherError("Finish or stop active tasks before switching accounts.");
          }
        }
        if (page.nextCursor == null) break;
        if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor) || seen.size >= 100) throw new SwitcherError("Unable to verify that tasks are idle.");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
    }
  }

  async function readCurrent(client) {
    const text = readPrivate(authPath);
    const info = identity(text);
    const principal = await client.getAuthenticatedPrincipal();
    if (!info.userId || principal?.accountId !== info.accountId || principal.userId !== info.userId) {
      throw new SwitcherError("The file login does not match the active account. Sign in again before remembering it.");
    }
    return text;
  }

  async function restore(client, text) {
    const info = identity(text);
    writePrivate(authPath, text);
    client.clearAuthTokenCache();
    await client.restart({ intent: "reconnect" });
    await rpc(client, "account/read", { refreshToken: false });
    const principal = await client.getAuthenticatedPrincipal();
    if (principal?.accountId !== info.accountId || principal.userId !== info.userId) {
      throw new SwitcherError("The selected account could not be activated.");
    }
  }

  async function switchTo(client, record, accounts) {
    await assertIdle();
    const previous = await readCurrent(client);
    remember(accounts, previous); // Capture any tokens refreshed since the menu opened.
    const selected = safeStorage.decryptString(Buffer.from(record.encrypted, "base64"));
    try { await restore(client, selected); }
    catch {
      try { await restore(client, previous); }
      catch { throw new SwitcherError("Switch failed and the previous account needs recovery. Your saved accounts are retained."); }
      throw new SwitcherError("Could not switch accounts. The previous account was restored; try signing in again.");
    }
    reload();
  }

  async function add(client, accounts) {
    await assertIdle();
    const previous = await readCurrent(client);
    accounts = remember(accounts, previous);
    if (accounts.length >= 20) throw new SwitcherError("At most 20 accounts can be remembered. Forget an account first.");
    let loginId, completed = false, resolveLogin;
    const completion = new Promise(resolve => { resolveLogin = resolve; });
    let early;
    const stop = client.registerInternalNotificationHandler(message => {
      if (message.method !== "account/login/completed") return;
      if (loginId == null) { early = message.params; return; }
      if (message.params?.loginId === loginId) resolveLogin(message.params);
    });
    const controller = new AbortController();
    try {
      const login = await rpc(client, "account/login/start", { type: "chatgpt", appBrand: "chatgpt", useHostedLoginSuccessPage: true });
      loginId = login.loginId;
      const url = new URL(login.authUrl);
      if (login.type !== "chatgpt" || typeof loginId !== "string" || url.protocol !== "https:" || url.hostname !== "auth.openai.com") throw new SwitcherError("Unsupported ChatGPT login response.");
      if (early?.loginId === loginId) resolveLogin(early);
      await shell.openExternal(url.href);
      const result = await Promise.race([
        completion,
        dialog.showMessageBox({ type: "info", title: "ChatGPT Community", message: "Sign in to another ChatGPT account in your browser.", detail: "Your current login is remembered. Cancel returns to it.", buttons: ["Cancel"], cancelId: 0, signal: controller.signal }).then(() => null),
      ]);
      if (!result?.success) return;
      client.clearAuthTokenCache();
      remember(accounts, await readCurrent(client));
      completed = true;
      reload();
    } finally {
      controller.abort(); stop();
      if (!completed) {
        if (loginId != null) await rpc(client, "account/login/cancel", { loginId }).catch(() => {});
        await restore(client, previous);
      }
    }
  }

  async function open(client, window, locale = "en") {
    if (menuOpen) return;
    menuOpen = true;
    try {
      let accounts = load();
      const current = await readCurrent(client);
      const active = identity(current).id;
      accounts = remember(accounts, current);
      const labels = typeof locale === "string" && locale.startsWith("pl")
        ? ["Przełącz konto ChatGPT", "Dodaj konto…", "Zapomnij zapisane konto…", "Wybierz konto do usunięcia z listy"]
        : typeof locale === "string" && locale.startsWith("zh")
          ? ["切换 ChatGPT 账户", "添加账户…", "忘记已保存的账户…", "选择要忘记的账户"]
          : ["Switch ChatGPT account", "Add account…", "Forget a saved account…", "Choose a login to forget"];
      const selectedId = await choose([
        { label: labels[0], enabled: false },
        { type: "separator" },
        ...accounts.map(record => ({ label: record.title, type: "radio", checked: record.id === active, value: record.id })),
        { type: "separator" },
        { label: labels[1], value: "add" },
        { label: labels[2], value: "forget", enabled: accounts.length > 1 },
      ], window);
      if (selectedId == null || selectedId === active) return;
      if (selectedId === "forget") {
        const candidates = accounts.filter(record => record.id !== active);
        if (!candidates.length) return;
        const forgottenId = await choose([
          { label: labels[3], enabled: false }, { type: "separator" },
          ...candidates.map(record => ({ label: record.title, value: record.id })),
        ], window);
        if (candidates.some(record => record.id === forgottenId)) save(accounts.filter(record => record.id !== forgottenId));
        return;
      }
      busy = true;
      if (selectedId === "add") await add(client, accounts);
      else {
        const selected = accounts.find(record => record.id === selectedId);
        if (selected) await switchTo(client, selected, accounts);
      }
    } catch (error) {
      // Never include upstream error text, decrypted credentials, or OAuth URLs.
      const message = error instanceof SwitcherError ? error.message : "Account operation failed. Check your private credential file and system keyring; no credentials were printed.";
      await dialog.showMessageBox({ type: "error", title: "ChatGPT Community", message: "Account switcher", detail: message, buttons: ["OK"] });
    } finally { busy = false; menuOpen = false; }
  }

  return { open, isBusy: () => busy };
}

module.exports = { createAccountSwitcher };
