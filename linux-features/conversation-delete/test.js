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
	"var SG={newChat:{id:`chatgptConversations.newChat`,defaultMessage:`New chat`,description:`Fallback title`},archive:{id:`chatgptConversations.sidebar.archive`,defaultMessage:`Archive chat`,description:`Action label to archive a ChatGPT conversation in the sidebar`},archiveError:{id:`chatgptConversations.sidebar.archiveError`,defaultMessage:`Failed to archive conversation`,description:`Archive error`}};",
	"var aBr=e=>true,iBr=e=>e?.item_type===`conversation`&&aBr(e.item);var requestClient=class{async deleteConversation(e){return this.safeDelete(`/conversation/id/{conversation_id}`,{parameters:{path:{conversation_id:e}}})}},mBr=class{async list({}){let l=await this.request.listConversations();return{...l,items:l.items?.filter(aBr)??[]}}async getBatch(e,t){return(await this.request.getConversationsBatch(e,t)).filter(aBr)}async listPinnedConversationItems(){return(await this.request.listPinnedItems({itemType:`conversation`})).filter(iBr)}async listProjectConversations({cursor:e=null,limit:t=5,ownedOnly:n=!0,projectId:r}){let i=await this.request.listProjectConversations({cursor:e,limit:t,ownedOnly:n,projectId:r});return{cursor:i.cursor,items:i.items?.filter(aBr)??[]}}async setArchived(e,t){return this.request.setConversationArchived(e,t)}async delete(e){return this.request.deleteConversation(e)}};",
	"function IEa(e,t){return e.get(GN).setArchived(t,!0).then(()=>{GEa(e.queryClient,t)})}",
	"function cVc(e){let t=(0,w5.c)(83),{conversation:n,conversationId:r,conversationOrigin:i,isActive:o,isArchivePending:s,route:p,title:v}=e,E=Fo(Q),D=Vd(),O=LC();E.get(kv).info(D.formatMessage({id:`chatgptConversations.sidebar.archiveAriaLabel`,defaultMessage:`Archive chat`}));let ae=archiveAction,oe;t[27]!==n||t[28]!==ae||t[29]!==s||t[30]!==E?(oe=async()=>{return[{id:`archive-chatgpt-conversation`,message:SG.archive,onSelect:ae}]},t[27]=n,t[28]=ae,t[29]=s,t[30]=E,t[34]=oe):oe=t[34];let ue=()=>{r!=null&&O(p)};let I=n!=null;let ye=oe;if(!I)return ye;let be;return be=ye}",
].join("");

function renameIdentifiers(source, replacements) {
	let renamed = source;
	for (const [from, to] of replacements) {
		renamed = renamed.replace(new RegExp(`\\b${from}\\b`, "g"), to);
	}
	return renamed;
}

const RENAMED_SIDEBAR_FIXTURE = renameIdentifiers(SIDEBAR_FIXTURE, [
	["SG", "localizationBundle"],
	["aBr", "conversationFilter"],
	["iBr", "pinnedFilter"],
	["mBr", "conversationClient"],
	["GN", "conversationApiToken"],
	["GEa", "evictCaches"],
	["IEa", "archiveConversation"],
	["w5", "cacheFactory"],
	["Fo", "scopeFactory"],
	["Vd", "intlFactory"],
	["LC", "navigationFactory"],
	["kv", "toastToken"],
	["Q", "scopeContext"],
	["cVc", "ConversationRow"],
	["archiveAction", "archiveHandler"],
	["oe", "menuCallback"],
	["t", "cacheSlots"],
	["E", "scopeValue"],
	["D", "intlValue"],
	["O", "navigate"],
	["o", "activeState"],
	["s", "archivePending"],
	["r", "conversationKey"],
	["p", "routeValue"],
	["v", "titleValue"],
	["n", "conversationValue"],
]);

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

test("descriptor targets ChatGPT sidebar asset family without hash pinning", () => {
	assert.match("app-initial-BYOVlUBL.js", CHATGPT_SIDEBAR_ASSET_PATTERN);
	assert.match("app-initial-renamed-hash.js", CHATGPT_SIDEBAR_ASSET_PATTERN);
	assert.doesNotMatch("app-main-Biw83Aiz.js", CHATGPT_SIDEBAR_ASSET_PATTERN);
	assert.doesNotMatch(
		"chatgpt-conversation-page-BG0Dyleu.js",
		CHATGPT_SIDEBAR_ASSET_PATTERN,
	);
	assert.equal(descriptors.length, 1);
	assert.equal(descriptors[0].assetMatch(SIDEBAR_FIXTURE), true);
	assert.equal(descriptors[0].assetMatch("var unrelatedAsset=true;"), false);
});

test("patch adds confirmed delete action and is idempotent", () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);

	assert.notEqual(patched, SIDEBAR_FIXTURE);
	assert.match(patched, new RegExp(RUNTIME_MARKER));
	assert.match(patched, /codexLinuxConversationDelete\.delete/);
	assert.match(patched, /id:`delete-chatgpt-conversation`/);
	assert.match(patched, /e\.get\(GN\)\.delete\(t\.id\)/);
	assert.match(patched, /window\.confirm/);
	assert.match(patched, /GEa\(e\.queryClient,t\.id\)/);
	assert.match(patched, new RegExp(`s\\("${NEW_THREAD_ROUTE}"\\)`));
	assert.match(
		patched,
		/codexLinuxDeletedChatGptConversationIds\.add\(t\.id\)/,
	);
	assert.match(
		patched,
		/codexLinuxDeletedChatGptConversationIds\.has\(e\?\.id\)/,
	);
	assert.match(
		patched,
		/codexLinuxDeletedChatGptConversationIds\.delete\(t\.id\)/,
	);
	assert.match(
		patched,
		/n!=null&&codexLinuxDeletedChatGptConversationIds\.has\(n\.id\)/,
	);
	assert.match(patched, /O=LC\(\)/);
	assert.equal(applyConversationDeletePatch(patched), patched);
});

test("discovers renamed minified aliases without hash coupling", () => {
	const patched = applyConversationDeletePatch(RENAMED_SIDEBAR_FIXTURE);

	assert.notEqual(patched, RENAMED_SIDEBAR_FIXTURE);
	assert.match(patched, /get\(conversationApiToken\)\.delete\(t\.id\)/);
	assert.match(patched, /evictCaches\(e\.queryClient,/);
	assert.match(patched, /id:`delete-chatgpt-conversation`/);
});

test("ambiguous semantic match leaves source unchanged and warns", () => {
	const source = SIDEBAR_FIXTURE.replace(
		"{id:`archive-chatgpt-conversation`,message:SG.archive,onSelect:ae}",
		"{id:`archive-chatgpt-conversation`,message:SG.archive,onSelect:ae},{id:`archive-chatgpt-conversation`,message:SG.archive,onSelect:ae}",
	);
	const { value, warnings } = captureWarnings(() =>
		applyConversationDeletePatch(source),
	);

	assert.equal(value, source);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ChatGPT sidebar conversation row/);
});

test("localization drift leaves source unchanged and warns", () => {
	const source = SIDEBAR_FIXTURE.replace("archiveError:", "archiveFailure:");
	const { value, warnings } = captureWarnings(() =>
		applyConversationDeletePatch(source),
	);

	assert.equal(value, source);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ChatGPT sidebar localization markers/);
});

test("endpoint drift leaves source unchanged and warns", () => {
	const source = SIDEBAR_FIXTURE.replace(
		"/conversation/id/{conversation_id}",
		"/conversation/id/{conversation}",
	);
	const { value, warnings } = captureWarnings(() =>
		applyConversationDeletePatch(source),
	);

	assert.equal(value, source);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ChatGPT conversation delete API client/);
});

test("runtime calls upstream delete without body and updates active navigation", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const toastToken = {};
	const calls = [];
	const removed = [];
	const navigated = [];
	const context = {
		GEa: (...args) => removed.push(args),
		SG: {
			deleteConfirm: {
				id: "confirm",
				defaultMessage: "Delete {title}?",
			},
			deleteError: {
				id: "error",
				defaultMessage: "Delete failed",
			},
		},
		kv: toastToken,
		GN: deleteToken,
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

	const client = new context.mBr();
	client.request = {
		listConversations: async () => ({
			items: [{ id: "conversation-123" }, { id: "conversation-456" }],
		}),
		getConversationsBatch: async () => [
			{ id: "conversation-123" },
			{ id: "conversation-456" },
		],
		listPinnedItems: async () => [
			{ item_type: "conversation", item: { id: "conversation-123" } },
			{ item_type: "conversation", item: { id: "conversation-456" } },
		],
	};
	const listed = await client.list({});
	assert.deepEqual(listed.items, [{ id: "conversation-456" }]);
	assert.deepEqual(await client.getBatch([], {}), [{ id: "conversation-456" }]);
	assert.deepEqual(await client.listPinnedConversationItems(), [
		{ item_type: "conversation", item: { id: "conversation-456" } },
	]);
});

test("tombstone hides pending delete and rolls back on failure", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const toastToken = {};
	const errors = [];
	const evicted = [];
	let rejectDelete;
	const context = {
		GEa: (...args) => evicted.push(args),
		SG: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		kv: toastToken,
		GN: deleteToken,
		window: { confirm: () => true },
	};
	const scope = {
		queryClient: {},
		get(token) {
			if (token === deleteToken) {
				return {
					delete() {
						return new Promise((_, reject) => {
							rejectDelete = reject;
						});
					},
				};
			}
			assert.equal(token, toastToken);
			return {
				danger(message) {
					errors.push(message);
				},
			};
		},
	};

	vm.runInNewContext(
		`${patched};globalThis.deleteChat= ${RUNTIME_MARKER};`,
		context,
	);
	context.deleteChat(
		scope,
		{ id: "conversation-123" },
		"Example chat",
		false,
		false,
		{
			formatMessage(message, values) {
				return message.defaultMessage.replace("{title}", values?.title ?? "");
			},
		},
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(typeof rejectDelete, "function");

	const client = new context.mBr();
	client.request = {
		listConversations: async () => ({
			items: [{ id: "conversation-123" }, { id: "conversation-456" }],
		}),
	};
	const pending = await client.list({});
	assert.deepEqual(pending.items, [{ id: "conversation-456" }]);
	assert.deepEqual(evicted, []);

	rejectDelete(new Error("expected test failure"));
	await new Promise((resolve) => setImmediate(resolve));
	const restored = await client.list({});
	assert.deepEqual(restored.items, [
		{ id: "conversation-123" },
		{ id: "conversation-456" },
	]);
	assert.deepEqual(errors, ["Failed to delete conversation"]);
	assert.deepEqual(evicted, []);
});

test("active deletion navigates to new chat route", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const navigated = [];
	const context = {
		GEa() {},
		SG: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		kv: {},
		GN: deleteToken,
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
		(route) => navigated.push(route),
	);

	assert.deepEqual(navigated, [NEW_THREAD_ROUTE]);
});

test("compiled menu cache refreshes delete callback when active state changes", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const cache = [];
	const deleteToken = {};
	const toastToken = {};
	const deleted = [];
	const navigated = [];
	let deleteCalls = 0;
	let rejectFirstDelete;
	const scope = {
		queryClient: {},
		get(token) {
			if (token === deleteToken) {
				return {
					delete(id) {
						deleted.push(id);
						deleteCalls += 1;
						if (deleteCalls === 1) {
							return new Promise((_, reject) => {
								rejectFirstDelete = reject;
							});
						}
						return Promise.resolve();
					},
				};
			}
			assert.equal(token, toastToken);
			return { danger() {}, info() {} };
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
				assert.equal(size, 85);
				return cache;
			},
		},
		Q: {},
		SG: {
			archive: "Archive chat",
			delete: "Delete chat",
			deleteConfirm: {
				defaultMessage: "Delete {title}?",
			},
			deleteError: { defaultMessage: "Delete failed" },
		},
		Fo: () => scope,
		Vd: () => intl,
		LC: () => (route) => navigated.push(route),
		archiveAction: () => {},
		renameAction: () => {},
		GEa() {},
		kv: toastToken,
		GN: deleteToken,
		window: { confirm: () => true },
	};

	vm.runInNewContext(`${patched};globalThis.renderSidebar=cVc;`, context);

	const conversation = { id: "conversation-123" };
	const firstMenu = await context.renderSidebar({
		conversation,
		conversationOrigin: false,
		isActive: false,
		isArchivePending: false,
		route: "/chat/conversation-123",
		title: "Example chat",
	})();
	const taskMenu = await context.renderSidebar({
		conversation,
		conversationOrigin: true,
		isActive: false,
		isArchivePending: false,
		route: "/chat/conversation-123",
		title: "Example chat",
	})();
	assert.equal(
		taskMenu.some((item) => item.id === DELETE_MENU_ID),
		false,
	);
	firstMenu.find((item) => item.id === DELETE_MENU_ID).onSelect();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(deleteCalls, 1);
	assert.deepEqual(navigated, []);
	assert.equal(typeof rejectFirstDelete, "function");
	rejectFirstDelete(new Error("expected test failure"));
	await new Promise((resolve) => setImmediate(resolve));

	const secondMenu = await context.renderSidebar({
		conversation,
		conversationOrigin: false,
		isActive: true,
		isArchivePending: false,
		route: "/chat/conversation-123",
		title: "Example chat",
	})();
	await secondMenu.find((item) => item.id === DELETE_MENU_ID).onSelect();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(deleted, ["conversation-123", "conversation-123"]);
	assert.deepEqual(navigated, [NEW_THREAD_ROUTE]);
	assert.equal(
		context.renderSidebar({
			conversation,
			isActive: true,
			isArchivePending: false,
			route: "/chat/conversation-123",
			title: "Example chat",
		}),
		null,
	);
});

test("project conversation refetch filters deleted tombstone", async () => {
	const patched = applyConversationDeletePatch(SIDEBAR_FIXTURE);
	const deleteToken = {};
	const context = {
		GEa() {},
		SG: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		kv: {},
		GN: deleteToken,
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

	const client = new context.mBr();
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
		GEa() {
			throw new Error("cache should not change");
		},
		SG: {
			deleteConfirm: { defaultMessage: "Delete {title}?" },
			deleteError: { defaultMessage: "Delete failed" },
		},
		kv: {},
		GN: deleteToken,
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
