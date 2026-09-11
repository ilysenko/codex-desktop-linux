import { pathToFileURL } from "node:url";
import { installLinuxComputerUse } from "./native-client.mjs";

// Use the upstream browser factory without starting its macOS native client.
export async function setupLinuxComputerUse({ browser, factoryPath }) {
  const { create_tinysky_alt } = await import(pathToFileURL(factoryPath).href);
  const cua = await create_tinysky_alt({ browser, computer: false });
  globalThis.cua = cua;
  installLinuxComputerUse(cua);
  cua.initialize = cua.getState;
}
