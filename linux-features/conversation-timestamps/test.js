#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
	loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
	APP_INITIAL_ASSET_PATTERN,
	COMPOSER_CONTROLLER_ASSET_PATTERN,
	LOCAL_CONVERSATION_TURN_ASSET_PATTERN,
	SUBAGENT_ACTIVITY_ASSET_PATTERN,
	applyAppInitialTimestampPatch,
	applyComposerControllerTimestampPatch,
	applyLocalAssistantDataPatch,
	applyLocalAssistantTimestampPatch,
	applySubagentActivityTimestampPatch,
	descriptors,
} = require("./patch.js");

const APP_INITIAL_FIXTURE = [
	"function ZWr(e){return{markdown:_.length===0?f:vb(f),role:a,...e.id==null?{}:{serverMessageId:e.id},sourcesFooterReferences:u,...g==null?{}:{targetedReplyLabel:g},turnId:VN(e),wholeMessageDilContentReferenceIndex:c==null?void 0:s.length,writingBlockIndexes:CFr(f)}}",
	"function rGr({imageAssetPointers:e,isStreamingAssistantMessage:t,message:n}){return n.role===`user`?{message:n.markdown,messageId:n.id,referencesPriorConversation:!1,sentAtMs:null,targetedReplyLabel:n.targetedReplyLabel,type:`user-message`}:{messageId:n.id,phase:`final_answer`,sentAtMs:null,structuredOutput:void 0,type:`assistant-message`}}",
	"function zWr(e,{isStreaming:t}){let n=VWr($Ur(e.items,{isStreaming:t})).map(({item:e})=>e);return n}",
].join("");

const COMPOSER_CONTROLLER_FIXTURE = [
	"function rw(){return (0,dw.jsx)(ic,{alwaysShowActions:b,turnId:x,copyText:S,getCopyHtml:d,forkDisabled:C,forkLabel:w,isForking:T,sentAtMs:n.sentAtMs,threadId:s,hasArtifacts:a,additionalActions:E,onFork:D})}",
	"function renderUser(){return (0,dw.jsx)(lc,{message:u.message,sentAtMs:u.sentAtMs,hasExternalAttachments:C,hostId:c,onEditMessage:p,threadId:f,turnId:v})}",
	'function renderAssistant(u){if(u.type===`assistant-message`){let i;return t[64]!==r||t[65]!==g||t[66]!==n?(i=(0,dw.jsxs)(`div`,{ref:r,"data-content-search-unit-key":g,children:[e,n]}),t[64]=r,t[65]=g,t[66]=n,t[67]=i):i=t[67],i}}',
].join("");

const SUBAGENT_ACTIVITY_FIXTURE = [
	"function Jb(e){let {sentAtMs:g,showTimestampWithoutActions:b,timestampHoverOnly:x}=e;return (0,Ih.jsx)(`span`,{className:J(`ms-1.5 flex h-full items-center`,x?`opacity-0 group-hover:opacity-100`:`opacity-0 group-focus-within:opacity-100 group-hover:opacity-100`),children:(0,Ih.jsx)(wh,{sentAtMs:g})})}",
	"function Mh(e){let {message:n,sentAtMs:r,collapsedLineCount:i,alwaysShowActions:a,compactActions:o,hideActions:s,messageStatus:c,messageStatusIcon:l,messageReaction:u,leadingActions:d,hookStats:f,threadDetailLevel:p,referencesPriorConversation:m,reviewMode:h,pullRequestFixMode:g,autoResolveSync:_,hasExternalAttachments:v,commentCount:y,onEditMessage:b,threadId:x,turnId:S,cwd:C,hostId:w}=e,T=false;let q=false;return (0,Ih.jsx)(`div`,{className:J(`me-1 ms-1 flex items-center gap-2`,T?void 0:`opacity-0 group-focus-within:opacity-100 group-hover:opacity-100`),children:(0,Ih.jsx)(`span`,{className:`flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100`,children:(0,Ih.jsx)(wh,{sentAtMs:r})})})}",
	"function renderLocalUser(){return (0,$.jsx)(Mh,{message:e,sentAtMs:n.sentAtMs,hostId:v,alwaysShowActions:w==null&&ne,compactActions:q,hideActions:le,})}",
	"function renderLocalAssistant(e){let n=e.item,i;let action=(0,$.jsx)(Jb,{alwaysShowActions:!0,sentAtMs:n.sentAtMs,showTimestampWithoutActions:!1});switch(n.type){case`assistant-message`:{return e?(i=foo(),t[181]=i):i=t[181],i}case`generated-image`:return i;default:return null}}",
].join("");

const LOCAL_CONVERSATION_TURN_FIXTURE =
	"function renderLocalTurn(){let m={finalAssistantStartedAtMs:null,turnStartedAtMs:1700000000000,items:[]},h=false,Ke=null,Ne=null,Re=null,fe=false;let R=(0,Q.useMemo)(()=>{let e=h?Tr(m.items,Ke,Ne):m.items.filter(e=>e.type!==`subagent-activity`),t=ht(Re)?e.map(e=>{if(e.type!==`assistant-message`)return e;let t=Mn(e.content,Re);return t===e.content?e:{...e,content:t}}):e;return fe?Eo(t):t},[h,Ke,!1,!1,!1,be,fe,Ne,Re,p,m.items]);return R}";
const LOCAL_ASSISTANT_FIXTURE = SUBAGENT_ACTIVITY_FIXTURE;

function renameIdentifiers(source, replacements) {
	let renamed = source;
	for (const [from, to] of replacements) {
		const escaped = from.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
		renamed = renamed.replace(
			new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g"),
			to,
		);
	}
	return renamed;
}

const RENAMED_APP_INITIAL_FIXTURE = renameIdentifiers(APP_INITIAL_FIXTURE, [
	["ZWr", "normalizeMessage"],
	["zWr", "groupMessages"],
	["VWr", "groupRenderItems"],
	["$Ur", "collectRenderItems"],
	["e", "sourceItem"],
	["f", "markdownText"],
	["a", "messageRole"],
	["g", "replyLabel"],
	["u", "footerReferences"],
	["c", "referenceIndex"],
	["s", "sourceItems"],
	["CFr", "writingBlockIndexes"],
	["VN", "turnIdentifier"],
	["t", "streamingAssistant"],
]);
const RENAMED_LOCAL_DATA_FIXTURE = renameIdentifiers(
	LOCAL_CONVERSATION_TURN_FIXTURE,
	[["m", "turnState"]],
);
const RENAMED_LOCAL_ASSISTANT_FIXTURE = renameIdentifiers(
	LOCAL_ASSISTANT_FIXTURE,
	[
		["n", "assistantItem"],
		["t", "renderCache"],
		["i", "renderedAssistant"],
	],
);

function withFeatureConfig(enabled, callback) {
	const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "conversation-timestamps-"),
	);
	process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
	try {
		fs.writeFileSync(
			process.env.CODEX_LINUX_FEATURES_CONFIG,
			JSON.stringify({ enabled }),
			"utf8",
		);
		return callback();
	} finally {
		if (originalConfig == null) {
			delete process.env.CODEX_LINUX_FEATURES_CONFIG;
		} else {
			process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function captureWarnings(callback) {
	const originalWarn = console.warn;
	const warnings = [];
	console.warn = (message) => warnings.push(message);
	try {
		return { value: callback(), warnings };
	} finally {
		console.warn = originalWarn;
	}
}

function assertSyntax(source) {
	new vm.Script(source);
}

test("feature is disabled until selected", () => {
	const featuresRoot = path.resolve(__dirname, "..");
	withFeatureConfig([], () => {
		assert.equal(
			loadLinuxFeaturePatchDescriptors({ featuresRoot }).some((descriptor) =>
				descriptor.id.startsWith("feature:conversation-timestamps:"),
			),
			false,
		);
	});
	withFeatureConfig(["conversation-timestamps"], () => {
		assert.deepEqual(
			loadLinuxFeaturePatchDescriptors({ featuresRoot })
				.filter((descriptor) =>
					descriptor.id.startsWith("feature:conversation-timestamps:"),
				)
				.map((descriptor) => descriptor.id),
			[
				"feature:conversation-timestamps:message-times",
				"feature:conversation-timestamps:assistant-times",
				"feature:conversation-timestamps:user-times",
				"feature:conversation-timestamps:local-assistant-data",
				"feature:conversation-timestamps:local-assistant-times",
			],
		);
	});
});

test("message normalization preserves ChatGPT create time", () => {
	const patched = applyAppInitialTimestampPatch(APP_INITIAL_FIXTURE);

	assert.notEqual(patched, APP_INITIAL_FIXTURE);
	assert.match(
		patched,
		/sentAtMs:typeof e\.create_time===`number`&&Number\.isFinite\(e\.create_time\)\?e\.create_time\*1e3:null/,
	);
	assert.match(patched, /sentAtMs:n\.sentAtMs\?\?null/);
	assert.match(patched, /sentAtMs:n\.sentAtMs\?\?null.*structuredOutput/);
	assert.doesNotMatch(
		patched,
		/VWr\\(\\$Ur\\(e\\.items,\\{isStreaming:t\\}\\)\\)/,
	);
	assert.match(
		patched,
		/\$Ur\(e\.items,\{isStreaming:t\}\)\.map\(\(\{item:e\}\)=>e\)/,
	);
	assertSyntax(patched);
	assert.equal(applyAppInitialTimestampPatch(patched), patched);
});

test("message normalization discovers renamed aliases", () => {
	const patched = applyAppInitialTimestampPatch(RENAMED_APP_INITIAL_FIXTURE);

	assert.notEqual(patched, RENAMED_APP_INITIAL_FIXTURE);
	assert.match(
		patched,
		/sentAtMs:typeof sourceItem\.create_time===`number`&&Number\.isFinite\(sourceItem\.create_time\)/,
	);
});

test("ChatGPT assistant timestamps use centered separator row", () => {
	const patched = applyComposerControllerTimestampPatch(
		COMPOSER_CONTROLLER_FIXTURE,
	);

	assert.match(patched, /showTimestampWithoutActions:!1,timestampHoverOnly:!0/);
	assert.match(patched, /flex w-full justify-center/);
	assert.match(
		patched,
		/showTimestampWithoutActions:!0,timestampHoverOnly:!1,sentAtMs:u\.sentAtMs/,
	);
	assert.match(patched, /sentAtMs:u\.sentAtMs,timestampHoverOnly:!1/);
	assertSyntax(patched);
	assert.equal(applyComposerControllerTimestampPatch(patched), patched);
});

test("shared user timestamp renderer gets explicit visibility props", () => {
	const patched = applySubagentActivityTimestampPatch(
		SUBAGENT_ACTIVITY_FIXTURE,
	);

	assert.match(
		patched,
		/hostId:w,timestampHoverOnly:codexLinuxTimestampHoverOnly\}=e/,
	);
	assert.match(
		patched,
		/className:J\(`me-1 ms-1 flex items-center gap-2`,T\|\|codexLinuxTimestampHoverOnly===!1\?void 0:/,
	);
	assert.match(
		patched,
		/className:codexLinuxTimestampHoverOnly===!1\?void 0:`flex opacity-0/,
	);
	assert.match(patched, /sentAtMs:n\.sentAtMs,timestampHoverOnly:!1,hostId:v/);
	assert.match(
		patched,
		/className:J\(`ms-1\.5 flex h-full items-center`,x\?`opacity-0 group-hover:opacity-100`:b\?void 0:/,
	);
	assertSyntax(patched);
	assert.equal(applySubagentActivityTimestampPatch(patched), patched);
});

test("local assistant timestamp data discovers renamed state alias", () => {
	const patched = applyLocalAssistantDataPatch(RENAMED_LOCAL_DATA_FIXTURE);

	assert.notEqual(patched, RENAMED_LOCAL_DATA_FIXTURE);
	assert.match(
		patched,
		/codexLinuxAssistantTimestamp=turnState\.finalAssistantStartedAtMs\?\?turnState\.turnStartedAtMs\?\?null/,
	);
});

test("local assistant timestamp data fills missing historical times", () => {
	const patched = applyLocalAssistantDataPatch(LOCAL_CONVERSATION_TURN_FIXTURE);

	assert.match(
		patched,
		/codexLinuxAssistantTimestamp=m\.finalAssistantStartedAtMs\?\?m\.turnStartedAtMs\?\?null/,
	);
	assert.match(patched, /sentAtMs:codexLinuxAssistantTimestamp/);
	assertSyntax(patched);
	assert.equal(applyLocalAssistantDataPatch(patched), patched);
});

test("local assistant timestamps use centered separator row", () => {
	const patched = applyLocalAssistantTimestampPatch(LOCAL_ASSISTANT_FIXTURE);

	assert.match(patched, /t\[181\]=i\):i=t\[181\],n\.sentAtMs==null\?i/);
	assert.match(patched, /flex w-full justify-center/);
	assert.match(patched, /sentAtMs:n\.sentAtMs/);
	assertSyntax(patched);
	assert.equal(applyLocalAssistantTimestampPatch(patched), patched);
});

test("local assistant timestamps discover renamed item aliases", () => {
	const patched = applyLocalAssistantTimestampPatch(
		RENAMED_LOCAL_ASSISTANT_FIXTURE,
	);

	assert.notEqual(patched, RENAMED_LOCAL_ASSISTANT_FIXTURE);
	assert.match(patched, /assistantItem\.sentAtMs==null\?renderedAssistant:/);
	assert.match(patched, /sentAtMs:assistantItem\.sentAtMs/);
});

test("drift leaves each asset unchanged and warns", () => {
	for (const [source, apply, marker] of [
		[
			APP_INITIAL_FIXTURE.replace(
				"sourcesFooterReferences:u",
				"sourcesFooterReferences:",
			),
			applyAppInitialTimestampPatch,
			/ChatGPT message timestamp/,
		],
		[
			APP_INITIAL_FIXTURE.replace(
				"VWr($Ur(e.items,{isStreaming:t})).map(({item:e})=>e)",
				"drifted",
			),
			applyAppInitialTimestampPatch,
			/ChatGPT message timestamp/,
		],
		[
			COMPOSER_CONTROLLER_FIXTURE.replace("onEditMessage:p", "onEdit:p"),
			applyComposerControllerTimestampPatch,
			/ChatGPT timestamp visibility/,
		],
		[
			COMPOSER_CONTROLLER_FIXTURE.replace(
				"data-content-search-unit-key",
				"data-content-search-key",
			),
			applyComposerControllerTimestampPatch,
			/ChatGPT timestamp visibility/,
		],
		[
			SUBAGENT_ACTIVITY_FIXTURE.replace(
				"className:J(`me-1 ms-1 flex items-center gap-2`",
				"className:J(`timestamp-row`",
			),
			applySubagentActivityTimestampPatch,
			/ChatGPT and local user timestamp markers/,
		],
		[
			SUBAGENT_ACTIVITY_FIXTURE.replace(
				"children:(0,Ih.jsx)(wh,{sentAtMs:r})",
				"children:null",
			),
			applySubagentActivityTimestampPatch,
			/ChatGPT and local user timestamp markers/,
		],
		[
			SUBAGENT_ACTIVITY_FIXTURE.replace(
				"sentAtMs:n.sentAtMs,hostId:v",
				"sentAtMs:n.sentAt,hostId:v",
			),
			applySubagentActivityTimestampPatch,
			/ChatGPT and local user timestamp markers/,
		],
		[
			LOCAL_CONVERSATION_TURN_FIXTURE.replace(
				"finalAssistantStartedAtMs",
				"finalAssistantStartedAt",
			),
			applyLocalAssistantDataPatch,
			/local Codex assistant timestamp data/,
		],
		[
			LOCAL_ASSISTANT_FIXTURE.replace(
				"case`generated-image`",
				"case`generated`",
			),
			applyLocalAssistantTimestampPatch,
			/local Codex assistant timestamp/,
		],
	]) {
		const { value, warnings } = captureWarnings(() => apply(source));
		assert.equal(value, source);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], marker);
	}
});

test("ambiguous asset matches remain unpatched", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "conversation-timestamps-ambiguous-"),
	);
	try {
		const assetsDir = path.join(tempDir, "webview", "assets");
		fs.mkdirSync(assetsDir, { recursive: true });
		fs.writeFileSync(
			path.join(assetsDir, "app-initial-first.js"),
			APP_INITIAL_FIXTURE,
			"utf8",
		);
		fs.writeFileSync(
			path.join(assetsDir, "app-initial-second.js"),
			APP_INITIAL_FIXTURE,
			"utf8",
		);
		const { value, warnings } = captureWarnings(() =>
			patchUniqueAssetFile(
				tempDir,
				descriptors[0].pattern,
				descriptors[0].assetMatch,
				descriptors[0].apply,
				"missing",
				"ambiguous",
			),
		);
		assert.deepEqual(value, { matched: 2, changed: 0, assetName: null });
		assert.equal(warnings.length, 1);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("descriptors discover bundles without hash pinning", () => {
	assert.equal(APP_INITIAL_ASSET_PATTERN.test("app-initial-BYOVlUBL.js"), true);
	assert.equal(
		APP_INITIAL_ASSET_PATTERN.test("app-initial-renamed-hash.js"),
		true,
	);
	assert.equal(APP_INITIAL_ASSET_PATTERN.test("app-main-Biw83Aiz.js"), false);
	assert.equal(
		COMPOSER_CONTROLLER_ASSET_PATTERN.test(
			"use-chatgpt-composer-controller-renamed.js",
		),
		true,
	);
	assert.equal(
		SUBAGENT_ACTIVITY_ASSET_PATTERN.test(
			"subagent-activity-chip-group-renamed.js",
		),
		true,
	);
	assert.equal(
		LOCAL_CONVERSATION_TURN_ASSET_PATTERN.test(
			"local-conversation-thread-renamed.js",
		),
		true,
	);
	assert.equal(
		LOCAL_CONVERSATION_TURN_ASSET_PATTERN.test("app-initial-BYOVlUBL.js"),
		false,
	);

	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "conversation-timestamps-assets-"),
	);
	try {
		const assetsDir = path.join(tempDir, "webview", "assets");
		fs.mkdirSync(assetsDir, { recursive: true });
		const fixtures = [
			["app-initial-BYOVlUBL.js", APP_INITIAL_FIXTURE, descriptors[0]],
			[
				"use-chatgpt-composer-controller-Dukh57hy.js",
				COMPOSER_CONTROLLER_FIXTURE,
				descriptors[1],
			],
			[
				"subagent-activity-chip-group-Bh3GoWs-.js",
				SUBAGENT_ACTIVITY_FIXTURE,
				descriptors[2],
			],
			[
				"local-conversation-thread-renamed.js",
				LOCAL_CONVERSATION_TURN_FIXTURE,
				descriptors[3],
			],
			[
				"subagent-activity-chip-group-Bh3GoWs-.js",
				LOCAL_ASSISTANT_FIXTURE,
				descriptors[4],
			],
		];
		for (const [name, source, descriptor] of fixtures) {
			const assetPath = path.join(assetsDir, name);
			fs.writeFileSync(assetPath, source, "utf8");
			const result = patchUniqueAssetFile(
				tempDir,
				descriptor.pattern,
				descriptor.assetMatch,
				descriptor.apply,
				"missing",
				"ambiguous",
			);
			assert.deepEqual(result, {
				matched: 1,
				changed: 1,
				assetName: name,
			});
			assert.notEqual(fs.readFileSync(assetPath, "utf8"), source);
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
