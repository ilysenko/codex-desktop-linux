const {
	findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const CHATGPT_SIDEBAR_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const RUNTIME_MARKER = "codexLinuxDeleteChatGptConversation";
const DELETED_IDS = "codexLinuxDeletedChatGptConversationIds";
const NEW_THREAD_ROUTE = "/";
const DELETE_MENU_ID = "delete-chatgpt-conversation";

const ARCHIVE_MESSAGE =
	"archive:{id:`chatgptConversations.sidebar.archive`,defaultMessage:`Archive chat`,description:`Action label to archive a ChatGPT conversation in the sidebar`}";
const DELETE_MESSAGES =
	"delete:{id:`codexLinuxConversationDelete.delete`,defaultMessage:`Delete chat`,description:`Action label to permanently delete a ChatGPT conversation in the sidebar`},deleteConfirm:{id:`codexLinuxConversationDelete.confirm`,defaultMessage:`Delete “{title}”? This can't be undone.`,description:`Confirmation message shown before permanently deleting a ChatGPT conversation`},deleteError:{id:`codexLinuxConversationDelete.error`,defaultMessage:`Failed to delete conversation`,description:`Error shown when permanently deleting a ChatGPT conversation fails`},";
const LOCALIZATION_NEEDLE = `${ARCHIVE_MESSAGE},archiveError:`;
const LOCALIZATION_REPLACEMENT = `${ARCHIVE_MESSAGE},${DELETE_MESSAGES}archiveError:`;
function buildMenuCachePattern(cacheAlias) {
	return new RegExp(
		`((?:${cacheAlias}\\[\\d+\\]!==${JS_IDENT}\\|\\|)*${cacheAlias}\\[\\d+\\]!==${JS_IDENT})` +
			`\\?\\((${JS_IDENT})=async\\(\\)=>\\{([\\s\\S]*?)\\},` +
			`((?:${cacheAlias}\\[\\d+\\]=${JS_IDENT},)*${cacheAlias}\\[(\\d+)\\]=\\2)\\):\\2=${cacheAlias}\\[(\\d+)\\]`,
	);
}

function warn(message) {
	console.warn(`WARN: ${message} - skipping conversation delete feature patch`);
}

function uniqueMatch(source, regex) {
	const globalRegex = regex.global
		? regex
		: new RegExp(regex.source, `${regex.flags}g`);
	globalRegex.lastIndex = 0;
	const matches = [...source.matchAll(globalRegex)];
	return matches.length === 1 ? matches[0] : null;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function propAlias(properties, property) {
	return (
		properties.match(
			new RegExp(`(?:^|,)${property}:(${JS_IDENT})(?:,|$)`),
		)?.[1] ?? null
	);
}

function findUniqueFunction(source, parameterCount, predicate) {
	const regex = new RegExp(`function (${JS_IDENT})\\(([^)]*)\\)\\{`, "g");
	const matches = [];
	for (const match of source.matchAll(regex)) {
		const parameters = match[2].split(",").filter(Boolean);
		if (parameters.length !== parameterCount) {
			continue;
		}
		const openBrace = match.index + match[0].length - 1;
		const closeBrace = findMatchingBrace(source, openBrace);
		if (closeBrace < 0) {
			continue;
		}
		const body = source.slice(openBrace + 1, closeBrace);
		if (predicate(body, parameters)) {
			matches.push(match[1]);
		}
	}
	return matches.length === 1 ? matches[0] : null;
}

function findMethod(source, pattern) {
	return uniqueMatch(source, pattern)?.[0] ?? null;
}

function findSidebarContract(source) {
	const menuMatch = uniqueMatch(
		source,
		new RegExp(
			"\\{id:`archive-chatgpt-conversation`,message:(" +
				JS_IDENT +
				")\\.archive,onSelect:(" +
				JS_IDENT +
				")\\}\\]\\}",
		),
	);
	if (menuMatch == null) {
		return null;
	}

	const functionPattern = new RegExp(
		`function (${JS_IDENT})\\((${JS_IDENT})\\)\\{let (${JS_IDENT})=\\(0,(${JS_IDENT})\\.c\\)\\((\\d+)\\),\\{([^}]*)\\}=\\2,`,
		"g",
	);
	functionPattern.lastIndex = 0;
	const componentMatches = [
		...source.slice(0, menuMatch.index).matchAll(functionPattern),
	];
	const enclosingComponents = componentMatches
		.map((match) => {
			const componentOpenBrace = source.indexOf("{", match.index);
			return {
				match,
				componentOpenBrace,
				componentEnd: findMatchingBrace(source, componentOpenBrace),
			};
		})
		.filter(
			({ componentOpenBrace, componentEnd }) =>
				componentOpenBrace >= 0 && componentEnd >= menuMatch.index,
		);
	if (enclosingComponents.length !== 1) {
		return null;
	}

	const { match: componentMatch, componentEnd } = enclosingComponents[0];
	const componentStart = componentMatch.index;
	const componentSource = source.slice(componentStart, componentEnd + 1);
	const properties = componentMatch[6];
	const conversationAlias = propAlias(properties, "conversation");
	const activeAlias = propAlias(properties, "isActive");
	const pendingAlias = propAlias(properties, "isArchivePending");
	const titleAlias = propAlias(properties, "title");
	const titlePrefixAlias = propAlias(properties, "titlePrefix");
	if (
		[
			conversationAlias,
			activeAlias,
			pendingAlias,
			titleAlias,
			titlePrefixAlias,
		].some((value) => value == null)
	) {
		return null;
	}

	const scopeAlias = uniqueMatch(
		componentSource,
		new RegExp(`\\bscope:(${JS_IDENT})`),
	)?.[1];
	const intlAlias = uniqueMatch(
		componentSource,
		new RegExp(`(${JS_IDENT})\\.formatMessage\\(`, "g"),
	)?.[1];
	const routeAlias = propAlias(properties, "route");
	const navigationCandidates = [
		...componentSource.matchAll(
			new RegExp(`\\b(${JS_IDENT})\\(${routeAlias}\\)`, "g"),
		),
	]
		.map((match) => match[1])
		.filter(
			(alias, index, aliases) =>
				aliases.indexOf(alias) === index &&
				new RegExp(`(?:^|,)${alias}=${JS_IDENT}\\(\\)`).test(componentSource),
		);

	const hookSequence = uniqueMatch(
		componentSource,
		new RegExp(
			`\\b(${JS_IDENT})=${JS_IDENT}\\((${JS_IDENT})\\),(${JS_IDENT})=${JS_IDENT}\\(\\),(${JS_IDENT})=${JS_IDENT}\\(\\),`,
		),
	);
	const resolvedScopeAlias = scopeAlias ?? hookSequence?.[1];
	const resolvedIntlAlias = intlAlias ?? hookSequence?.[3];
	const navigationAlias =
		navigationCandidates.length === 1
			? navigationCandidates[0]
			: hookSequence?.[4];
	if (
		[resolvedScopeAlias, resolvedIntlAlias, navigationAlias].some(
			(value) => value == null,
		)
	) {
		return null;
	}

	const renderGuardMatch = uniqueMatch(
		componentSource,
		new RegExp(
			`titlePrefix:${titlePrefixAlias}\\}=${componentMatch[2]},(${JS_IDENT})=`,
		),
	);
	if (renderGuardMatch == null) {
		return null;
	}

	const cacheMatch = uniqueMatch(
		componentSource,
		buildMenuCachePattern(componentMatch[3]),
	);
	if (cacheMatch == null || cacheMatch[5] !== cacheMatch[6]) {
		return null;
	}

	const listMethod = findMethod(
		source,
		new RegExp(
			`async list\\([^)]*\\)\\{let (${JS_IDENT})=await this\\.request\\.listConversations\\([^;]*\\);return\\{\\.\\.\\.\\1,items:\\1\\.items\\?\\.filter\\((${JS_IDENT})\\)\\?\\?\\[\\]\\}\\}`,
		),
	);
	if (listMethod == null) {
		return null;
	}
	const listMatch = listMethod.match(
		new RegExp(
			`async list\\([^)]*\\)\\{let (${JS_IDENT})=await this\\.request\\.listConversations\\([^;]*\\);return\\{\\.\\.\\.\\1,items:\\1\\.items\\?\\.filter\\((${JS_IDENT})\\)\\?\\?\\[\\]\\}\\}`,
		),
	);
	const listPredicateAlias = listMatch?.[2];
	if (listPredicateAlias == null) {
		return null;
	}

	const batchMethod = findMethod(
		source,
		new RegExp(
			`async getBatch\\([^)]*\\)\\{return\\(await this\\.request\\.getConversationsBatch\\([^)]*\\)\\)\\.filter\\(${listPredicateAlias}\\)\\}`,
		),
	);
	const pinnedMethod = findMethod(
		source,
		new RegExp(
			"async listPinnedConversationItems\\(\\)\\{return\\(await this\\.request\\.listPinnedItems\\(\\{itemType:`conversation`\\}\\)\\)\\.filter\\((" +
				JS_IDENT +
				")\\)\\}",
		),
	);
	const projectMethod = findMethod(
		source,
		new RegExp(
			`async listProjectConversations\\([^)]*\\)\\{let (${JS_IDENT})=await this\\.request\\.listProjectConversations\\([^)]*\\);return\\{cursor:\\1\\.cursor,items:\\1\\.items\\?\\.filter\\(${listPredicateAlias}\\)\\?\\?\\[\\]\\}\\}`,
		),
	);
	const deleteMethod = uniqueMatch(
		source,
		new RegExp(
			"async deleteConversation\\((" +
				JS_IDENT +
				")\\)\\{return this\\.safeDelete\\(`/conversation/id/\\{conversation_id\\}`,\\{parameters:\\{path:\\{conversation_id:\\1\\}\\}\\}\\)\\}",
		),
	)?.[0];
	const clientDeleteMethod = uniqueMatch(
		source,
		new RegExp(
			`async (${JS_IDENT})\\((${JS_IDENT})\\)\\{return this\\.request\\.deleteConversation\\(\\2\\)\\}`,
		),
	)?.[1];
	if (
		batchMethod == null ||
		pinnedMethod == null ||
		projectMethod == null ||
		deleteMethod == null ||
		clientDeleteMethod == null
	) {
		return null;
	}

	const projectSearchKeyAlias = uniqueMatch(
		source,
		new RegExp(`(${JS_IDENT})=${"`"}chatgpt-project-conversation-search${"`"}`),
	)?.[1];
	const listCacheHelper = findUniqueFunction(
		source,
		2,
		(body, [scopeParameter, conversationParameter]) =>
			new RegExp(
				`${escapeRegExp(scopeParameter)}\\.filter\\((${JS_IDENT})=>\\1\\.id!==${escapeRegExp(conversationParameter)}\\)`,
			).test(body) && !body.includes("setQueryData"),
	);
	const projectCacheHelper = findUniqueFunction(
		source,
		2,
		(body, [scopeParameter, conversationParameter]) =>
			body.includes("setQueryData") &&
			new RegExp(
				`${escapeRegExp(scopeParameter)}\\.filter\\((${JS_IDENT})=>\\1\\.id!==${escapeRegExp(conversationParameter)}\\)`,
			).test(body),
	);
	const pinnedCacheHelper = findUniqueFunction(
		source,
		2,
		(body, [scopeParameter, conversationParameter]) =>
			new RegExp(
				`${escapeRegExp(scopeParameter)}\\.set(?:\\?\\.)?\\(${JS_IDENT},(${JS_IDENT})=>\\1\\.filter\\(\\1=>${escapeRegExp(scopeParameter)}\\.get\\(${JS_IDENT},\\1\\)!==${escapeRegExp(conversationParameter)}\\)`,
			).test(body),
	);
	const invalidateCacheHelper =
		projectSearchKeyAlias == null
			? null
			: findUniqueFunction(
					source,
					1,
					(body) =>
						body.includes("invalidateQueries") &&
						body.includes(`queryKey:[${projectSearchKeyAlias}]`),
				);
	if (
		[
			listCacheHelper,
			projectCacheHelper,
			pinnedCacheHelper,
			invalidateCacheHelper,
		].some((value) => value == null)
	) {
		return null;
	}

	return {
		component: {
			name: componentMatch[1],
			argumentAlias: componentMatch[2],
			cacheAlias: componentMatch[3],
			cacheFactory: componentMatch[4],
			cacheSize: Number(componentMatch[5]),
			cacheCallbackAlias: cacheMatch[2],
			conversationAlias,
			activeAlias,
			pendingAlias,
			titleAlias,
			titlePrefixAlias,
			scopeAlias: resolvedScopeAlias,
			intlAlias: resolvedIntlAlias,
			navigationAlias,
			renderGuard: renderGuardMatch[0],
			renderGuardAlias: renderGuardMatch[1],
			cache: cacheMatch,
		},
		localizationAlias: menuMatch[1],
		archiveHandlerAlias: menuMatch[2],
		listPredicateAlias,
		pinnedPredicateAlias: pinnedMethod.match(
			new RegExp(
				"async listPinnedConversationItems\\(\\)\\{return\\(await this\\.request\\.listPinnedItems\\(\\{itemType:`conversation`\\}\\)\\)\\.filter\\((" +
					JS_IDENT +
					")\\)\\}",
			),
		)?.[1],
		methods: {
			listMethod,
			batchMethod,
			pinnedMethod,
			projectMethod,
			deleteMethod,
		},
		cacheHelpers: {
			list: listCacheHelper,
			project: projectCacheHelper,
			pinned: pinnedCacheHelper,
			invalidate: invalidateCacheHelper,
		},
		clientDeleteMethod,
	};
}

function buildRuntimeSource(contract) {
	const { component, localizationAlias, cacheHelpers, clientDeleteMethod } =
		contract;
	return `const ${DELETED_IDS}=new Set;function ${RUNTIME_MARKER}(e,t,n,r,i,o,s){if(t==null||r)return;if(typeof window==="undefined"||typeof window.confirm!=="function"||!window.confirm(o.formatMessage(${localizationAlias}.deleteConfirm,{title:n})))return;if(${DELETED_IDS}.has(t.id))return;${DELETED_IDS}.add(t.id);e.get(${component.deleteTokenAlias}).${clientDeleteMethod}(t.id).then(()=>{i&&typeof s==="function"&&s(${JSON.stringify(NEW_THREAD_ROUTE)}),${cacheHelpers.list}(e.queryClient,t.id),${cacheHelpers.project}(e.queryClient,t.id),${cacheHelpers.pinned}(e,t.id),${cacheHelpers.invalidate}(e.queryClient)}).catch(()=>{${DELETED_IDS}.delete(t.id),e.get(${component.toastTokenAlias}).danger(o.formatMessage(${localizationAlias}.deleteError))})}`;
}

function applyMethodFilter(source, method, replacement) {
	return source.replace(method, replacement);
}

function findContract(source) {
	const contract = findSidebarContract(source);
	if (contract == null) {
		return null;
	}

	const { component } = contract;
	const intlAlias = component.intlAlias;
	const toastTokenAliases = [
		...source.matchAll(
			new RegExp(
				`\\.get\\((${JS_IDENT})\\)\\.danger\\(${intlAlias}\\.formatMessage\\(${JS_IDENT}\\.archiveError\\)`,
				"g",
			),
		),
	]
		.map((match) => match[1])
		.filter((alias, index, aliases) => aliases.indexOf(alias) === index);
	const toastTokenAlias =
		toastTokenAliases.length === 1 ? toastTokenAliases[0] : null;
	const apiTokenAliases = [
		...source.matchAll(
			new RegExp(
				`\\.get\\((${JS_IDENT})\\)\\.(?:getSharedConversation|listPinnedConversationItems|listProjectConversations|getConversation(?:WebSocketUrl)?)\\(`,
				"g",
			),
		),
	]
		.map((match) => match[1])
		.filter((alias, index, aliases) => aliases.indexOf(alias) === index);
	if (toastTokenAlias == null || apiTokenAliases.length !== 1) {
		return null;
	}
	component.toastTokenAlias = toastTokenAlias;
	component.deleteTokenAlias = apiTokenAliases[0];
	return contract;
}

function matchesConversationDeleteAsset(source) {
	return (
		typeof source === "string" &&
		(source.includes(RUNTIME_MARKER) || findContract(source) != null)
	);
}

function applyConversationDeletePatch(source) {
	try {
		if (typeof source !== "string") {
			warn("Asset source is not a string");
			return source;
		}
		if (source.includes(RUNTIME_MARKER)) {
			return source;
		}

		const contract = findContract(source);
		if (contract == null) {
			warn(
				"Could not find unique current ChatGPT sidebar conversation row contract",
			);
			return source;
		}
		const { component } = contract;
		const { listMethod, batchMethod, pinnedMethod, projectMethod } =
			contract.methods;
		const listReplacement = listMethod.replace(
			`filter(${contract.listPredicateAlias})`,
			`filter(e=>!${DELETED_IDS}.has(e?.id)&&${contract.listPredicateAlias}(e))`,
		);
		const batchReplacement = batchMethod.replace(
			`filter(${contract.listPredicateAlias})`,
			`filter(${contract.listPredicateAlias}).filter(e=>!${DELETED_IDS}.has(e?.id))`,
		);
		const pinnedReplacement = pinnedMethod.replace(
			`filter(${contract.pinnedPredicateAlias})`,
			`filter(${contract.pinnedPredicateAlias}).filter(e=>!${DELETED_IDS}.has(e.item?.id))`,
		);
		const projectReplacement = projectMethod.replace(
			`filter(${contract.listPredicateAlias})`,
			`filter(e=>!${DELETED_IDS}.has(e?.id)&&${contract.listPredicateAlias}(e))`,
		);

		const cache = component.cache;
		const cacheBase = component.cacheSize;
		const cacheAlias = component.cacheAlias;
		const cacheCallbackAlias = component.cacheCallbackAlias;
		const cacheDependencies = [
			[cacheBase, component.activeAlias],
			[cacheBase + 1, component.intlAlias],
			[cacheBase + 2, component.navigationAlias],
			[cacheBase + 3, component.titleAlias],
		];
		const cacheGuard = `${cache[1]}${cacheDependencies.map(([slot, alias]) => `||${cacheAlias}[${slot}]!==${alias}`).join("")}`;
		const assignmentPrefix = cache[4].replace(
			`${cacheAlias}[${cache[5]}]=${cacheCallbackAlias}`,
			"",
		);
		const cacheAssignments = `${assignmentPrefix}${cacheDependencies.map(([slot, alias]) => `${cacheAlias}[${slot}]=${alias},`).join("")}${cacheAlias}[${cache[5]}]=${cacheCallbackAlias}`;
		const cacheReplacement = cache[0]
			.replace(cache[1], cacheGuard)
			.replace(cache[4], cacheAssignments);

		const renderGuardReplacement = `titlePrefix:${component.titlePrefixAlias}}=${component.argumentAlias};if(${component.conversationAlias}!=null&&${DELETED_IDS}.has(${component.conversationAlias}.id))return null;let ${component.renderGuardAlias}=`;
		const componentNeedle = `function ${component.name}(${component.argumentAlias}){let ${cacheAlias}=(0,${component.cacheFactory}.c)(${component.cacheSize}),`;
		const componentReplacement = `${buildRuntimeSource(contract)}function ${component.name}(${component.argumentAlias}){let ${cacheAlias}=(0,${component.cacheFactory}.c)(${component.cacheSize + 4}),`;
		const menuReplacement = `{id:${"`"}archive-chatgpt-conversation${"`"},message:${contract.localizationAlias}.archive,onSelect:${contract.archiveHandlerAlias}},{id:${"`"}${DELETE_MENU_ID}${"`"},message:${contract.localizationAlias}.delete,onSelect:()=>${RUNTIME_MARKER}(${component.scopeAlias},${component.conversationAlias},${component.titleAlias},${component.pendingAlias},${component.activeAlias},${component.intlAlias},${component.navigationAlias})}]}`;

		let patched = source.replace(LOCALIZATION_NEEDLE, LOCALIZATION_REPLACEMENT);
		patched = applyMethodFilter(patched, listMethod, listReplacement);
		patched = applyMethodFilter(patched, batchMethod, batchReplacement);
		patched = applyMethodFilter(patched, pinnedMethod, pinnedReplacement);
		patched = applyMethodFilter(patched, projectMethod, projectReplacement);
		patched = patched.replace(component.renderGuard, renderGuardReplacement);
		patched = patched.replace(cache[0], cacheReplacement);
		patched = patched.replace(componentNeedle, componentReplacement);
		patched = patched.replace(
			new RegExp(
				"\\{id:`archive-chatgpt-conversation`,message:" +
					contract.localizationAlias +
					"\\.archive,onSelect:" +
					contract.archiveHandlerAlias +
					"\\}\\]\\}",
			),
			menuReplacement,
		);

		if (
			!patched.includes(RUNTIME_MARKER) ||
			!patched.includes(
				`function ${component.name}(${component.argumentAlias}){let ${cacheAlias}=(0,${component.cacheFactory}.c)(${component.cacheSize + 4}),`,
			) ||
			!patched.includes(renderGuardReplacement) ||
			!patched.includes(listReplacement) ||
			!patched.includes(batchReplacement) ||
			!patched.includes(pinnedReplacement) ||
			!patched.includes(projectReplacement) ||
			!patched.includes(`id:\`${DELETE_MENU_ID}\``)
		) {
			warn("Could not verify delete menu injection");
			return source;
		}
		return patched;
	} catch (error) {
		warn(
			`Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
		);
		return source;
	}
}

const descriptors = [
	{
		id: "chatgpt-sidebar-delete",
		phase: "webview-asset",
		order: 20_910,
		ciPolicy: "optional",
		pattern: CHATGPT_SIDEBAR_ASSET_PATTERN,
		assetMatch: matchesConversationDeleteAsset,
		missingDescription: "ChatGPT sidebar webview bundle",
		skipDescription: "ChatGPT sidebar conversation delete feature patch",
		apply: applyConversationDeletePatch,
	},
];

module.exports = {
	CHATGPT_SIDEBAR_ASSET_PATTERN,
	DELETE_MENU_ID,
	NEW_THREAD_ROUTE,
	RUNTIME_MARKER,
	applyConversationDeletePatch,
	descriptors,
	matchesConversationDeleteAsset,
	findConversationDeleteContract: findContract,
};
