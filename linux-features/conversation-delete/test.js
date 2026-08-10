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
const {
	CHATGPT_SIDEBAR_ASSET_PATTERN,
	DELETE_MENU_ID,
	NEW_THREAD_ROUTE,
	RUNTIME_MARKER,
	applyConversationDeletePatch,
	descriptors,
} = require("./patch.js");

const SIDEBAR_FIXTURE = [
	"var OW={newChat:{id:`chatgptConversations.newChat`,defaultMessage:`New chat`,description:`Fallback title`},archive:{id:`chatgptConversations.sidebar.archive`,defaultMessage:`Archive chat`,description:`Action label to archive a ChatGPT conversation in the sidebar`},archiveError:{id:`chatgptConversations.sidebar.archiveError`,defaultMessage:`Failed to archive conversation`,description:`Archive error`}};",
	"var uBr=e=>true,lBr=e=>true;var yBr=class{async list({}){let l=await this.request.listConversations();return{...l,items:l.items?.filter(uBr)??[]}}async getBatch(e,t){return(await this.request.getConversationsBatch(e,t)).filter(uBr)}async listPinnedConversationItems(){return(await this.request.listPinnedItems({itemType:`conversation`})).filter(lBr)}async listProjectConversations({cursor:e=null,limit:t=5,ownedOnly:n=!0,projectId:r}){let i=await this.request.listProjectConversations({cursor:e,limit:t,ownedOnly:n,projectId:r});return{cursor:i.cursor,items:i.items?.filter(uBr)??[]}}};",
	"/* function y0(e,t){ */;/* function KDa( */;/* safeDelete(`/conversation/id/{conversation_id}`, */",
	"var archiveAction=()=>{},renameAction=()=>{};function VBc(e){let t=(0,w5.c)(83),{conversation:n,isActive:o,isArchivePending:w,route:p,title:v}=e,E=Fo(Q),D=Vd(),O=AC(),ae=archiveAction,re=renameAction,k=false,L=OW.archive;let oe;t[27]!==n||t[28]!==ae||t[29]!==re||t[30]!==w||t[31]!==k||t[32]!==L||t[33]!==E?(oe=async()=>{return[{id:`archive-chatgpt-conversation`,message:OW.archive,onSelect:ae}]},t[27]=n,t[28]=ae,t[29]=re,t[30]=w,t[31]=k,t[32]=L,t[33]=E,t[34]=oe):oe=t[34];return oe}",
].join("");

function captureWarnings(fn) {
	const originalWarn = console.warn;
	const warnings = [];
	console.warn = (message) => warnings.push(message);
	try {
		return { value: fn(), warnings };
	} finally {
		console.warn = originalWarn;
	}
}

function withFeatureConfig(enabled, fn) {
	const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "conversation-delete-"),
	);
	process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
	try {
		fs.writeFileSync(
			process.env.CODEX_LINUX_FEATURES_CONFIG,
			JSON.stringify({ enabled }),
		);
		return fn();
	} finally {
		if (originalConfig == null) {
			delete process.env.CODEX_LINUX_FEATURES_CONFIG;
		} else {
			process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

test("feature is disabled until selected", () => {
	const featuresRoot = path.resolve(__dirname, "..");
	withFeatureConfig([], () => {
		assert.equal(
			loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
				(descriptor) =>
					descriptor.id ===
					"feature:conversation-delete:chatgpt-sidebar-delete",
			),
			false,
		);
	});
	withFeatureConfig(["conversation-delete"], () => {
		assert.equal(
			loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
				(descriptor) =>
					descriptor.id ===
					"feature:conversation-delete:chatgpt-sidebar-delete",
			),
			true,
		);
	});
});

test("descriptor targets current ChatGPT sidebar asset family", () => {
	assert.match("app-initial-Biw83Aiz.js", CHATGPT_SIDEBAR_ASSET_PATTERN);
	assert.doesNotMatch("app-main-Biw83Aiz.js", CHATGPT_SIDEBAR_ASSET_PATTERN);
	assert.doesNotMatch(
		"chatgpt-conversation-page-BG0Dyleu.js",
		CHATGPT_SIDEBAR_ASSET_PATTERN,
	);
	assert.equal(descriptors.length, 1);
});

test("patch adds confirmed delete action and is idempotent", () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);

	assert.notEqual(patched, SIDEBAR_FIXTURE);
	assert.match(patched, new RegExp(RUNTIME_MARKER));
	assert.match(patched, /codexLinuxConversationDelete\.delete/);
	assert.match(patched, /id:`delete-chatgpt-conversation`/);
	assert.match(patched, /e\.get\(zN\)\.delete\(t\.id\)/);
	assert.match(patched, /window\.confirm/);
	assert.match(patched, /KDa\(e\.queryClient,t\.id\)/);
	assert.match(patched, new RegExp(`s\\("${NEW_THREAD_ROUTE}"\\)`));
	assert.match(
		patched,
		/codexLinuxDeletedChatGptConversationIds\.add\(t\.id\)/,
	);
	assert.match(
		patched,
		/codexLinuxDeletedChatGptConversationIds\.has\(e\?\.id\)/,
	);
	assert.match(patched, /O=AC\(\)/);
	assert.equal(applyConversationDeletePatch(patched), patched);
});

test("drift leaves source unchanged and warns", () => {
	const source = SIDEBAR_FIXTURE.replace(
		"function VBc",
		"function ChangedSidebarRow",
	);
	const { value, warnings } = captureWarnings(() =>
		applyConversationDeletePatch(source),
	);

	assert.equal(value, source);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ChatGPT sidebar conversation row/);
});

test("runtime calls upstream delete without body and updates active navigation", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const toastToken = {};
	const calls = [];
	const removed = [];
	const navigated = [];
	const context = {
		KDa: (...args) => removed.push(args),
		OW: {
			deleteConfirm: {
				id: "confirm",
				defaultMessage: "Delete {title}?",
			},
			deleteError: {
				id: "error",
				defaultMessage: "Delete failed",
			},
		},
		yv: toastToken,
		zN: deleteToken,
		window: {
			confirm: (message) => {
				assert.equal(message, "Delete “Example chat”? This can't be undone.");
				return true;
			},
		},
	};
	const scope = {
		queryClient: {},
		get(token) {
			assert.equal(token === deleteToken || token === toastToken, true);
			if (token === deleteToken) {
				return {
					delete(...args) {
						calls.push(args);
						return Promise.resolve();
					},
				};
			}
			return {
				danger() {
					throw new Error("unexpected error toast");
				},
			};
		},
	};

	vm.runInNewContext(
		`${patched};globalThis.deleteChat= ${RUNTIME_MARKER};`,
		context,
	);
	await context.deleteChat(
		scope,
		{ id: "conversation-123" },
		"Example chat",
		false,
		true,
		{
			formatMessage(message, values) {
				return message.defaultMessage.replace("{title}", values.title);
			},
		},
		(route) => navigated.push(route),
	);

	assert.deepEqual(calls, [["conversation-123"]]);
	assert.deepEqual(removed, [[scope.queryClient, "conversation-123"]]);
	assert.deepEqual(navigated, [NEW_THREAD_ROUTE]);

	const client = new context.yBr();
	client.request = {
		listConversations: async () => ({
			items: [{ id: "conversation-123" }, { id: "conversation-456" }],
		}),
	};
	const listed = await client.list({});
	assert.deepEqual(listed.items, [{ id: "conversation-456" }]);
});

test("active deletion uses upstream new-chat state handler", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const started = [];
	const context = {
		KDa() {},
		y0(scope) {
			started.push(scope);
		},
		OW: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		yv: {},
		zN: deleteToken,
		window: { confirm: () => true },
	};
	const scope = {
		queryClient: {},
		get(token) {
			assert.equal(token, deleteToken);
			return { delete: () => Promise.resolve() };
		},
	};

	vm.runInNewContext(
		`${patched};globalThis.deleteChat= ${RUNTIME_MARKER};`,
		context,
	);
	await context.deleteChat(
		scope,
		{ id: "conversation-123" },
		"Example chat",
		false,
		true,
		{
			formatMessage: (message) => message.defaultMessage,
		},
		() => {
			throw new Error("fallback navigator should not run");
		},
	);

	assert.deepEqual(started, [scope]);
});

test("compiled menu cache refreshes delete callback when active state changes", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const cache = [];
	const deleteToken = {};
	const toastToken = {};
	const deleted = [];
	const navigated = [];
	const scope = {
		queryClient: {},
		get(token) {
			if (token === deleteToken) {
				return {
					delete(id) {
						deleted.push(id);
						return Promise.resolve();
					},
				};
			}
			assert.equal(token, toastToken);
			return { danger: () => assert.fail("unexpected error toast") };
		},
	};
	const intl = {
		formatMessage(message, values) {
			return message.defaultMessage.replace("{title}", values?.title ?? "");
		},
	};
	const context = {
		w5: {
			c(size) {
				assert.equal(size, 84);
				return cache;
			},
		},
		Q: {},
		OW: {
			archive: "Archive chat",
			deleteConfirm: {
				defaultMessage: "Delete {title}?",
			},
			deleteError: { defaultMessage: "Delete failed" },
		},
		Fo: () => scope,
		Vd: () => intl,
		AC: () => (route) => navigated.push(route),
		archiveAction: () => {},
		renameAction: () => {},
		KDa() {},
		yv: toastToken,
		zN: deleteToken,
		window: { confirm: () => true },
	};

	vm.runInNewContext(`${patched};globalThis.renderSidebar=VBc;`, context);

	const conversation = { id: "conversation-123" };
	const firstMenu = await context.renderSidebar({
		conversation,
		isActive: false,
		isArchivePending: false,
		route: "/chat/conversation-123",
		title: "Example chat",
	})();
	await firstMenu.find((item) => item.id === DELETE_MENU_ID).onSelect();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(deleted, ["conversation-123"]);
	assert.deepEqual(navigated, []);

	const secondMenu = await context.renderSidebar({
		conversation,
		isActive: true,
		isArchivePending: false,
		route: "/chat/conversation-123",
		title: "Example chat",
	})();
	await secondMenu.find((item) => item.id === DELETE_MENU_ID).onSelect();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(deleted, ["conversation-123", "conversation-123"]);
	assert.deepEqual(navigated, [NEW_THREAD_ROUTE]);
});

test("project conversation refetch filters deleted tombstone", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const context = {
		KDa() {},
		OW: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		yv: {},
		zN: deleteToken,
		window: { confirm: () => true },
	};
	const scope = {
		queryClient: {},
		get(token) {
			assert.equal(token, deleteToken);
			return { delete: () => Promise.resolve() };
		},
	};

	vm.runInNewContext(
		`${patched};globalThis.deleteChat= ${RUNTIME_MARKER};`,
		context,
	);
	await context.deleteChat(
		scope,
		{ id: "conversation-123" },
		"Example chat",
		false,
		false,
		{
			formatMessage: (message) => message.defaultMessage,
		},
	);

	const client = new context.yBr();
	client.request = {
		listProjectConversations: async () => ({
			cursor: null,
			items: [{ id: "conversation-123" }, { id: "conversation-456" }],
		}),
	};
	const listed = await client.listProjectConversations({
		projectId: "project-123",
	});
	assert.equal(listed.cursor, null);
	assert.deepEqual(listed.items, [{ id: "conversation-456" }]);
});

test("cancelled confirmation does not call delete", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	let calls = 0;
	const context = {
		KDa() {
			throw new Error("cache should not change");
		},
		OW: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		yv: {},
		zN: deleteToken,
		window: { confirm: () => false },
	};
	const scope = {
		queryClient: {},
		get(token) {
			assert.equal(token, deleteToken);
			return {
				delete() {
					calls += 1;
					return Promise.resolve();
				},
			};
		},
	};

	vm.runInNewContext(
		`${patched};globalThis.deleteChat= ${RUNTIME_MARKER};`,
		context,
	);
	await context.deleteChat(
		scope,
		{ id: "conversation-123" },
		"Example chat",
		false,
		false,
		{
			formatMessage: (message) => message.defaultMessage,
		},
	);

	assert.equal(calls, 0);
});
