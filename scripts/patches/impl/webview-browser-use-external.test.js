"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchLinuxBrowserUseExternalAvailabilityAssets,
} = require("./webview/index.js");

const currentChromeLinuxRegistry =
  "linux:{installations:[{commands:[`google-chrome`,`google-chrome-stable`],userDataDirName:`google-chrome`},{commands:[`chromium`,`chromium-browser`],userDataDirName:`chromium`},{commands:[`google-chrome-beta`],userDataDirName:`google-chrome-beta`},{commands:[`google-chrome-unstable`],userDataDirName:`google-chrome-unstable`},{commands:[`google-chrome-for-testing`],userDataDirName:`google-chrome-for-testing`}],nativeMessagingManifestDirectories:[`.config/google-chrome/NativeMessagingHosts`,`.config/chromium/NativeMessagingHosts`,`.config/google-chrome-beta/NativeMessagingHosts`,`.config/google-chrome-unstable/NativeMessagingHosts`,`.config/google-chrome-for-testing/NativeMessagingHosts`],processNames:[`chrome`],userDataDirectorySegments:[`.config`,`google-chrome`]}";
const currentEdgeLinuxRegistry =
  "linux:{installations:[{commands:[`microsoft-edge`,`microsoft-edge-stable`],userDataDirName:`microsoft-edge`}],nativeMessagingManifestDirectories:[`.config/microsoft-edge/NativeMessagingHosts`],processNames:[`msedge`],userDataDirectorySegments:[`.config`,`microsoft-edge`]}";
const currentBraveLinuxRegistry =
  "linux:{installations:[{commands:[`brave-browser`,`brave-browser-stable`,`brave`],userDataDirName:`BraveSoftware/Brave-Browser`}],nativeMessagingManifestDirectories:[`.config/BraveSoftware/Brave-Browser/NativeMessagingHosts`],processNames:[`brave`,`brave-browser`],userDataDirectorySegments:[`.config`,`BraveSoftware`,`Brave-Browser`]}";
const currentOperaLinuxRegistry =
  "linux:{installations:[{commands:[`opera`,`opera-stable`],userDataDirName:`opera`}],nativeMessagingManifestDirectories:[`.config/opera/NativeMessagingHosts`],processNames:[`opera`],userDataDirectorySegments:[`.config`,`opera`]}";
const currentVivaldiLinuxRegistry =
  "linux:{installations:[{commands:[`vivaldi`,`vivaldi-stable`],userDataDirName:`vivaldi`}],nativeMessagingManifestDirectories:[`.config/vivaldi/NativeMessagingHosts`],processNames:[`vivaldi`,`vivaldi-bin`],userDataDirectorySegments:[`.config`,`vivaldi`]}";

function currentBrowserRegistry(variableName) {
  return `var ${variableName}={chrome:{backendCompatibilityKey:\`chrome\`,displayName:\`Google Chrome\`,${currentChromeLinuxRegistry}},edge:{backendCompatibilityKey:\`chrome\`,displayName:\`Microsoft Edge\`,${currentEdgeLinuxRegistry}},brave:{backendCompatibilityKey:\`chrome\`,displayName:\`Brave\`,${currentBraveLinuxRegistry}},opera:{backendCompatibilityKey:\`chrome\`,displayName:\`Opera\`,${currentOperaLinuxRegistry}},vivaldi:{backendCompatibilityKey:\`chrome\`,displayName:\`Vivaldi\`,${currentVivaldiLinuxRegistry}}};`;
}

function currentMainRegistryFixture() {
  return [
    currentBrowserRegistry("Oy"),
    "function Iy(e){return Object.hasOwn(Oy,e)}",
    "function validateBrowserRegistry(){return Object.keys(Oy).filter(Iy)}",
    "Object.defineProperty(exports,\"Eo\",{enumerable:!0,get:function(){return Oy}}),Object.defineProperty(exports,\"ko\",{enumerable:!0,get:function(){return Iy}});",
  ].join("");
}

function currentMainCallerFixture() {
  return [
    "let n=exports;function dl(e){return installedCommands.has(e)?`/usr/bin/${e}`:null}async function ml(e,t){launches.push([e,t])}",
    "async function mne({browserFamily:e,platform:t=process.platform}){return t===`darwin`?!1:t===`win32`?!1:t===`linux`&&jl(e)!=null}",
    "function Ol({browserFamily:e=`chrome`,extensionId:t,platform:o=process.platform}){return o===`linux`&&n.Eo[e].linux.installations.some(e=>e.commands.includes(t))}",
    "async function hne({browserFamily:e=`chrome`,extensionId:t,platform:o=process.platform}){return o===`linux`&&jl(e,t)!=null}",
    "async function gne({browserFamily:e,platform:t=process.platform,runCommand:n=ml,url:r}){await kl({browserFamily:e,platform:t,runCommand:n,unsupportedPlatformError:`unsupported`,url:r})}",
    "async function kl({browserFamily:e,platform:t,runCommand:r,url:i}){let a=n.Eo[e];if(t===`linux`){let t=jl(e);if(t==null)throw Error(`${a.displayName} is not installed`);await r(t,[i]);return}throw Error(`unsupported`)}",
    "function jl(e,t){let r=n.Eo[e].linux.installations;for(let e of r){let t=Ml(e);if(t!=null)return t}return null}function Ml(e){for(let t of e.commands){let e=dl(t);if(e!=null)return e}return null}",
    "var Cce={parse:e=>e},wce=class{async getInstalledBrowserFamilies(){let e=Object.keys(n.Eo).filter(n.ko);return(await Promise.all(e.map(async e=>({browserFamily:e,installed:await mne({browserFamily:e})})))).flatMap(({browserFamily:e,installed:t})=>t?[e]:[])}async openUrl({browserFamily:e,url:t}){await gne({browserFamily:Cce.parse(e),url:t})}};globalThis.BrowserService=wce;",
  ].join("");
}

function currentRendererFixture() {
  return [
    currentBrowserRegistry("Lu"),
    "function Iu(e){return Object.hasOwn(Lu,e)}",
    "function rendererLinuxRegistry(){return Object.keys(Lu).filter(Iu).map(e=>({browserFamily:e,installations:Lu[e].linux.installations,manifestDirectories:Lu[e].linux.nativeMessagingManifestDirectories,processNames:Lu[e].linux.processNames}))}",
    "function wfi(){return{enabled:!1,featureName:`browser_use_external`,gate:`410065390`}}",
    "function Sfi({isExternalBrowserUseFeatureEnabled:e,isExternalBrowserUseFeatureLoading:t,isExternalBrowserUseGateEnabled:n,runCodexInWsl:r,windowType:i}){return i===`chrome-extension`?`available`:t?`loading`:n?e?r?`wsl-disabled`:`available`:`config-requirement-disabled`:`statsig-disabled`}",
    "globalThis.rendererLinuxRegistry=rendererLinuxRegistry;",
  ].join("");
}

function createCurrentExternalBrowserUseAssets() {
  const extractedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-current-external-browser-use-"),
  );
  const buildDir = path.join(extractedDir, ".vite", "build");
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  const mainPath = path.join(buildDir, "main-DU-1HLYt.js");
  const srcPath = path.join(buildDir, "src-Bn_6ASpg.js");
  const rendererPath = path.join(assetsDir, "app-initial-YjNFxVhk.js");
  fs.writeFileSync(mainPath, currentMainCallerFixture(), "utf8");
  fs.writeFileSync(srcPath, currentMainRegistryFixture(), "utf8");
  fs.writeFileSync(rendererPath, currentRendererFixture(), "utf8");
  return { extractedDir, mainPath, rendererPath, srcPath };
}

function evaluateMainBrowserService(srcSource, mainSource, installedCommandNames) {
  const context = {
    exports: {},
    installedCommands: new Set(installedCommandNames),
    launches: [],
    process: { platform: "linux" },
  };
  vm.runInNewContext(`${srcSource};${mainSource}`, context);
  return { context, service: new context.BrowserService() };
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

test("patches exact-DMG Browser Use availability while preserving native browser registries", async () => {
  const fixture = createCurrentExternalBrowserUseAssets();
  try {
    assert.deepEqual(
      patchLinuxBrowserUseExternalAvailabilityAssets(fixture.extractedDir),
      { matched: 3, changed: 1 },
    );

    const mainSource = fs.readFileSync(fixture.mainPath, "utf8");
    const srcSource = fs.readFileSync(fixture.srcPath, "utf8");
    const rendererSource = fs.readFileSync(fixture.rendererPath, "utf8");

    const braveOnly = evaluateMainBrowserService(srcSource, mainSource, ["brave-browser"]);
    assert.deepEqual(jsonValue(await braveOnly.service.getInstalledBrowserFamilies()), ["brave"]);
    await braveOnly.service.openUrl({ browserFamily: "brave", url: "https://example.com/brave" });
    assert.deepEqual(jsonValue(braveOnly.context.launches), [
      ["/usr/bin/brave-browser", ["https://example.com/brave"]],
    ]);

    const chromeOnly = evaluateMainBrowserService(srcSource, mainSource, ["google-chrome"]);
    assert.deepEqual(jsonValue(await chromeOnly.service.getInstalledBrowserFamilies()), ["chrome"]);
    await chromeOnly.service.openUrl({ browserFamily: "chrome", url: "https://example.com/chrome" });
    assert.deepEqual(jsonValue(chromeOnly.context.launches), [
      ["/usr/bin/google-chrome", ["https://example.com/chrome"]],
    ]);

    const rendererContext = {};
    vm.runInNewContext(rendererSource, rendererContext);
    const rendererRegistry = jsonValue(rendererContext.rendererLinuxRegistry());
    const rendererChrome = rendererRegistry.find(({ browserFamily }) => browserFamily === "chrome");
    const rendererBrave = rendererRegistry.find(({ browserFamily }) => browserFamily === "brave");
    const rendererEdge = rendererRegistry.find(({ browserFamily }) => browserFamily === "edge");
    assert.ok(rendererChrome.installations.some(({ commands }) => commands.includes("google-chrome")));
    assert.ok(rendererChrome.installations.some(({ commands }) => commands.includes("chromium")));
    assert.ok(
      rendererBrave.installations.some(
        ({ userDataDirName }) => userDataDirName === "BraveSoftware/Brave-Browser",
      ),
    );
    assert.ok(
      rendererBrave.manifestDirectories.includes(
        ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      ),
    );
    assert.ok(rendererBrave.processNames.includes("brave"));
    assert.ok(rendererBrave.processNames.includes("brave-browser"));
    assert.deepEqual(rendererEdge.installations[0].commands, [
      "microsoft-edge",
      "microsoft-edge-stable",
    ]);
    assert.match(
      rendererSource,
      /return i===`chrome-extension`\|\|navigator\.userAgent\.includes\(`Linux`\)\?`available`:/,
    );

    const beforeSecondPass = new Map([
      [fixture.srcPath, srcSource],
      [fixture.rendererPath, rendererSource],
    ]);
    assert.deepEqual(
      patchLinuxBrowserUseExternalAvailabilityAssets(fixture.extractedDir),
      { matched: 3, changed: 0 },
    );
    for (const [filePath, source] of beforeSecondPass) {
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
    }
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});

test("leaves every exact-DMG Browser Use asset unchanged when a registry seam drifts", () => {
  const fixture = createCurrentExternalBrowserUseAssets();
  try {
    fs.writeFileSync(
      fixture.rendererPath,
      currentRendererFixture().replace("processNames:[`chrome`]", "processNames:[`chrome`,`chromium`]"),
      "utf8",
    );
    const before = new Map([
      [fixture.mainPath, fs.readFileSync(fixture.mainPath, "utf8")],
      [fixture.srcPath, fs.readFileSync(fixture.srcPath, "utf8")],
      [fixture.rendererPath, fs.readFileSync(fixture.rendererPath, "utf8")],
    ]);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let result;
    try {
      result = patchLinuxBrowserUseExternalAvailabilityAssets(fixture.extractedDir);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(result, {
      matched: 0,
      changed: 0,
      reason: "Could not identify complete current Browser Use external availability and browser registry contract",
    });
    assert.equal(warnings.length, 1);
    for (const [filePath, source] of before) {
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
    }
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});

test("rolls back the exact-DMG Browser Use availability file when its write fails", () => {
  const fixture = createCurrentExternalBrowserUseAssets();
  try {
    const before = new Map([
      [fixture.rendererPath, fs.readFileSync(fixture.rendererPath, "utf8")],
    ]);
    let writeCount = 0;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let result;
    try {
      result = patchLinuxBrowserUseExternalAvailabilityAssets(fixture.extractedDir, {
        writeFileSync(filePath, source, encoding) {
          writeCount += 1;
          if (writeCount === 1) {
            fs.writeFileSync(filePath, "partially-written", encoding);
            throw new Error("simulated renderer write failure");
          }
          fs.writeFileSync(filePath, source, encoding);
        },
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(result, {
      matched: 3,
      changed: 0,
      reason: "Could not write complete current Browser Use external availability assets: simulated renderer write failure",
    });
    assert.equal(warnings.length, 1);
    for (const [filePath, source] of before) {
      assert.equal(fs.readFileSync(filePath, "utf8"), source);
    }
  } finally {
    fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
  }
});
