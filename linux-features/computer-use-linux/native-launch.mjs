import { fileURLToPath } from "node:url";

export function linuxNativeEnvironment({ browser, computer }, banner) {
  if (!computer) return { NODE_REPL_JS_BANNER: banner };
  const client = new URL("./native-client.mjs", import.meta.url).href;
  return {
    NODE_REPL_TRUSTED_RPC_ENABLED: "1",
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
      ...(browser ? { browser: "@oai/browser-desktop/service" } : {}),
      sky: fileURLToPath(new URL("./native-service.mjs", import.meta.url)),
    }),
    NODE_REPL_JS_BANNER:
      `await (await import("@oai/cua/tinyskyAlt")).setupCUA(${JSON.stringify({ browser, computer: false })});\n` +
      `await (await import(${JSON.stringify(client)})).installLinuxComputerUse(cua);`,
  };
}
