"use strict";

// Serialized into each qualified settings factory. Only effort is community
// owned; the model continues to come from the native Copilot preference.
function createCopilotEffortPreferences(react, useCatalog) {
  const prefix = "codex-linux:copilot-effort:v1:";
  const changed = "codex-linux-copilot-effort-changed";
  function key(hostId, profile, model) {
    if (typeof hostId !== "string" || typeof model !== "string" || model.length === 0 ||
        profile != null && typeof profile !== "string") return null;
    return prefix + globalThis.JSON.stringify([hostId, profile ?? null, model]);
  }
  function read(storageKey) {
    if (storageKey == null) return null;
    try { return globalThis.localStorage.getItem(storageKey); }
    catch { return null; }
  }
  function subscribe(listener) {
    const storage = event => {
      if (event.key == null || event.key.startsWith(prefix)) listener();
    };
    globalThis.addEventListener("storage", storage);
    globalThis.addEventListener(changed, listener);
    return () => {
      globalThis.removeEventListener("storage", storage);
      globalThis.removeEventListener(changed, listener);
    };
  }
  return {
    useSelection(copilot, hostId, native) {
      const catalog = useCatalog({enabled: copilot, hostId,
        additionalAvailableModels: native.model == null ? undefined : new globalThis.Set([native.model])});
      const storageKey = copilot ? key(hostId, native.profile, native.model) : null;
      const effort = react.useSyncExternalStore(subscribe, () => read(storageKey), () => null);
      const model = catalog.data?.models?.find(item => item.model === native.model);
      if (!copilot || typeof effort !== "string" ||
          !model?.supportedReasoningEfforts?.some(item => item.reasoningEffort === effort)) return native;
      return {...native, reasoningEffort: effort};
    },
    async save(hostId, profile, model, effort, writeModel) {
      const storageKey = key(hostId, profile, model);
      if (storageKey == null || typeof effort !== "string" || effort.length === 0) {
        throw new globalThis.Error("Invalid Copilot effort preference");
      }
      // Separate native default queues may share a host/model (for example,
      // two composer windows). A delayed older success must not replace a
      // newer effort intent. The native model request and its errors stay native.
      const pendingKey = storageKey + ":pending";
      let token, preparationError;
      try {
        token = globalThis.crypto.randomUUID();
        globalThis.localStorage.setItem(pendingKey, token);
      } catch (error) { preparationError = error; }
      const result = await writeModel();
      if (preparationError) throw preparationError;
      if (globalThis.localStorage.getItem(pendingKey) === token) {
        globalThis.localStorage.setItem(storageKey, effort);
        globalThis.localStorage.removeItem(pendingKey);
        globalThis.dispatchEvent(new globalThis.Event(changed));
      }
      return result;
    },
  };
}

module.exports = {createCopilotEffortPreferences};
