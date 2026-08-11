const {
	findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const BACKTICK = "`";
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

function warn(message) {
	console.warn(`WARN: ${message} - skipping conversation delete feature patch`);
}

function countOccurrences(source, needle) {
	return source.split(needle).length - 1;
}

function uniqueMatch(source, regex) {
	const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
	const matches = [...source.matchAll(new RegExp(regex.source, flags))];
	return matches.length === 1 ? matches[0] : null;
}

function findFunctionBlockContaining(source, index) {
	const declarations = [
		...source.matchAll(new RegExp(`function ${JS_IDENT}\\([^)]*\\)\\{`, "g")),
	];
	for (let i = declarations.length - 1; i >= 0; i -= 1) {
		const declaration = declarations[i];
		if (declaration.index >= index) {
			continue;
		}
		const closeBrace = findMatchingBrace(
			source,
			declaration.index + declaration[0].length - 1,
		);
		if (closeBrace >= index) {
			return {
				start: declaration.index,
				end: closeBrace + 1,
				text: source.slice(declaration.index, closeBrace + 1),
			};
		}
	}
	return null;
}

function findMethodBlock(classSource, methodName) {
	const methodMatch = uniqueMatch(
		classSource,
		new RegExp(`(?:async\\s+)?${methodName}\\([^)]*\\)\\{`),
	);
	if (methodMatch == null) {
		return null;
	}
	const closeBrace = findMatchingBrace(
		classSource,
		methodMatch.index + methodMatch[0].length - 1,
	);
	if (closeBrace === -1) {
		return null;
	}
	return {
		start: methodMatch.index,
		end: closeBrace + 1,
		text: classSource.slice(methodMatch.index, closeBrace + 1),
	};
}

function findSidebarContract(source) {
	const archiveItemMatch = uniqueMatch(
		source,
		new RegExp(
			`\\{id:${BACKTICK}archive-chatgpt-conversation${BACKTICK},message:(${JS_IDENT})\\.archive,onSelect:(${JS_IDENT})\\}`,
		),
	);
	if (archiveItemMatch == null) {
		return null;
	}
	const block = findFunctionBlockContaining(source, archiveItemMatch.index);
	if (block == null) {
		return null;
	}
	const openingMatch = block.text.match(
		new RegExp(
			`^function (${JS_IDENT})\\(e\\)\\{let (${JS_IDENT})=\\(0,(${JS_IDENT})\\.c\\)\\((\\d+)\\),\\{conversation:(${JS_IDENT}),`,
		),
	);
	if (openingMatch == null) {
		return null;
	}
	const propsEnd = block.text.indexOf("}=e");
	if (propsEnd === -1) {
		return null;
	}
	const propsText = block.text.slice(0, propsEnd + 2);
	const propAlias = (name) =>
		propsText.match(new RegExp(`${name}:(${JS_IDENT})`))?.[1] ?? null;
	const conversationIdAlias = propAlias("conversationId");
	const activeAlias = propAlias("isActive");
	const archivePendingAlias = propAlias("isArchivePending");
	const routeAlias = propAlias("route");
	const titleAlias = propAlias("title");
	if (
		conversationIdAlias == null ||
		activeAlias == null ||
		archivePendingAlias == null ||
		routeAlias == null ||
		titleAlias == null
	) {
		return null;
	}

	const renderGuardMatch = uniqueMatch(
		block.text,
		new RegExp(
			`let (${JS_IDENT})=${JS_IDENT};if\\(!(${JS_IDENT})\\)return \\1;let ${JS_IDENT};return`,
		),
	);
	const toastMatch = uniqueMatch(
		block.text,
		new RegExp(`(${JS_IDENT})\\.get\\((${JS_IDENT})\\)\\.info\\(`),
	);
	const intlMatch = uniqueMatch(
		block.text,
		new RegExp(
			`(${JS_IDENT})\\.formatMessage\\(\\{id:${BACKTICK}chatgptConversations\\.sidebar\\.archiveAriaLabel`,
		),
	);
	const navigateMatch = uniqueMatch(
		block.text,
		new RegExp(
			`${conversationIdAlias}!=null&&(${JS_IDENT})\\(${routeAlias}\\)`,
		),
	);
	if (
		renderGuardMatch == null ||
		toastMatch == null ||
		intlMatch == null ||
		navigateMatch == null
	) {
		return null;
	}

	const asyncMatches = [
		...block.text.matchAll(
			new RegExp(`\\((${JS_IDENT})=async\\(\\)=>\\{`, "g"),
		),
	].filter(
		(match) =>
			match.index < archiveItemMatch.index - block.start &&
			block.text
				.slice(match.index, archiveItemMatch.index - block.start)
				.includes("return["),
	);
	if (asyncMatches.length !== 1) {
		return null;
	}
	const menuAlias = asyncMatches[0][1];
	const guardQuestion = block.text.lastIndexOf("?", asyncMatches[0].index);
	if (
		guardQuestion === -1 ||
		!block.text.startsWith(`(${menuAlias}=async()=>{`, guardQuestion + 1)
	) {
		return null;
	}
	const assignmentMatch = uniqueMatch(
		block.text.slice(archiveItemMatch.index - block.start),
		new RegExp(`\\):${menuAlias}=${openingMatch[2]}\\[\\d+\\]`),
	);
	if (assignmentMatch == null) {
		return null;
	}
	const assignmentClose =
		archiveItemMatch.index - block.start + assignmentMatch.index;
	const assignmentPrefixStart = block.text.lastIndexOf("},", assignmentClose);
	if (
		assignmentPrefixStart === -1 ||
		assignmentPrefixStart < asyncMatches[0].index
	) {
		return null;
	}
	const assignmentEnd = assignmentClose + assignmentMatch[0].length;

	return {
		block,
		functionName: openingMatch[1],
		hookSlotsAlias: openingMatch[2],
		hookCacheAlias: openingMatch[3],
		hookCacheSize: Number(openingMatch[4]),
		conversationAlias: openingMatch[5],
		conversationIdAlias,
		activeAlias,
		archivePendingAlias,
		routeAlias,
		titleAlias,
		scopeAlias: toastMatch[1],
		toastTokenAlias: toastMatch[2],
		intlAlias: intlMatch[1],
		navigateAlias: navigateMatch[1],
		archiveMessageAlias: archiveItemMatch[1],
		archiveActionAlias: archiveItemMatch[2],
		archiveItemText: archiveItemMatch[0],
		renderGuardText: renderGuardMatch[0],
		menuAlias,
		guardQuestion,
		guardStart: block.text.lastIndexOf(";", guardQuestion) + 1,
		assignmentPrefixStart,
		assignmentText: block.text.slice(assignmentPrefixStart, assignmentEnd),
	};
}

function findServiceContract(source) {
	const deleteApiMatch = uniqueMatch(
		source,
		new RegExp(
			`async (${JS_IDENT})\\(${JS_IDENT}\\)\\{return this\\.safeDelete\\(${BACKTICK}/conversation/id/\\{conversation_id\\}${BACKTICK},\\{parameters:\\{path:\\{conversation_id:${JS_IDENT}\\}\\}\\}\\)\\}`,
		),
	);
	const serviceTokenMatches = [
		...source.matchAll(
			new RegExp(`e\\.get\\((${JS_IDENT})\\)\\.setArchived\\(`, "g"),
		),
	];
	const serviceTokenAliases = new Set(
		serviceTokenMatches.map((match) => match[1]),
	);
	if (
		deleteApiMatch == null ||
		serviceTokenMatches.length === 0 ||
		serviceTokenAliases.size !== 1
	) {
		return null;
	}
	return {
		deleteMethodName: deleteApiMatch[1],
		serviceTokenAlias: serviceTokenMatches[0][1],
	};
}

function findCacheEvictionContract(source) {
	const setArchivedMatch = uniqueMatch(source, /\.setArchived\([^)]*,!0\)/);
	if (setArchivedMatch == null) {
		return null;
	}
	const archiveBlock = findFunctionBlockContaining(
		source,
		setArchivedMatch.index,
	);
	if (archiveBlock == null) {
		return null;
	}
	const afterSetArchived = archiveBlock.text.slice(
		setArchivedMatch.index - archiveBlock.start,
	);
	const cacheCalls = [
		...afterSetArchived.matchAll(
			new RegExp(`(${JS_IDENT})\\(e\\.queryClient,${JS_IDENT}\\)`, "g"),
		),
	];
	if (cacheCalls.length !== 1) {
		return null;
	}
	return { cacheEvictionAlias: cacheCalls[0][1] };
}

function findConversationClientContract(source) {
	const listRequestMatch = uniqueMatch(
		source,
		/this\.request\.listConversations\(/,
	);
	if (listRequestMatch == null) {
		return null;
	}
	const classStart = source.lastIndexOf("class{", listRequestMatch.index);
	if (classStart === -1) {
		return null;
	}
	const classEnd = findMatchingBrace(source, classStart + "class".length);
	if (classEnd === -1 || classEnd < listRequestMatch.index) {
		return null;
	}
	const classText = source.slice(classStart, classEnd + 1);
	const methods = {};
	for (const methodName of [
		"list",
		"getBatch",
		"listPinnedConversationItems",
		"listProjectConversations",
	]) {
		const method = findMethodBlock(classText, methodName);
		if (method == null) {
			return null;
		}
		const filterMatch = uniqueMatch(
			method.text,
			new RegExp(`\\.filter\\((${JS_IDENT})\\)`),
		);
		if (filterMatch == null) {
			return null;
		}
		methods[methodName] = {
			...method,
			filterAlias: filterMatch[1],
		};
	}
	return {
		start: classStart,
		end: classEnd + 1,
		text: source.slice(classStart, classEnd + 1),
		methods,
	};
}

function matchesChatGptSidebarContract(source) {
	return (
		typeof source === "string" &&
		countOccurrences(source, ARCHIVE_MESSAGE) === 1 &&
		source.includes("archive-chatgpt-conversation")
	);
}

function discoverContracts(source) {
	const sidebar = findSidebarContract(source);
	const service = findServiceContract(source);
	const cache = findCacheEvictionContract(source);
	const client = findConversationClientContract(source);
	const missing = [];
	if (countOccurrences(source, LOCALIZATION_NEEDLE) !== 1) {
		missing.push("ChatGPT sidebar localization markers");
	}
	if (sidebar == null) missing.push("ChatGPT sidebar conversation row");
	if (service == null) {
		missing.push("ChatGPT conversation delete API client");
	}
	if (cache == null) missing.push("ChatGPT conversation cache helper");
	if (client == null) {
		missing.push(
			"ChatGPT conversation list, batch, pinned, or project response filter",
		);
	}
	return { sidebar, service, cache, client, missing };
}

function buildRuntimeSource({
	serviceTokenAlias,
	deleteMethodName,
	cacheEvictionAlias,
	toastTokenAlias,
	archiveMessageAlias,
}) {
	return `const ${DELETED_IDS}=new Set;function ${RUNTIME_MARKER}(e,t,n,r,i,o,s){if(t==null||r)return;if(typeof window==="undefined"||typeof window.confirm!=="function"||!window.confirm(o.formatMessage(${archiveMessageAlias}.deleteConfirm,{title:n})))return;return ${DELETED_IDS}.add(t.id),Promise.resolve().then(()=>e.get(${serviceTokenAlias}).${deleteMethodName}(t.id)).then(()=>{i&&s(${JSON.stringify(NEW_THREAD_ROUTE)}),${cacheEvictionAlias}(e.queryClient,t.id)}).catch(()=>{${DELETED_IDS}.delete(t.id),e.get(${toastTokenAlias}).danger(o.formatMessage(${archiveMessageAlias}.deleteError))})}`;
}

function patchConversationClient(source, contract) {
	let patched = source;
	for (const [methodName, itemExpression] of [
		["list", "e?.id"],
		["getBatch", "e?.id"],
		["listPinnedConversationItems", "e.item?.id"],
		["listProjectConversations", "e?.id"],
	]) {
		const method = contract.methods[methodName];
		const needle = `.filter(${method.filterAlias})`;
		const replacement = `${needle}.filter(e=>!${DELETED_IDS}.has(${itemExpression}))`;
		const methodPatched = method.text.replace(needle, replacement);
		if (methodPatched === method.text) {
			return null;
		}
		patched = patched.replace(method.text, methodPatched);
	}
	return patched;
}

function patchSidebar(source, contract, runtimeSource) {
	const {
		block,
		hookSlotsAlias,
		hookCacheAlias,
		hookCacheSize,
		activeAlias,
		archiveMessageAlias,
		archivePendingAlias,
		archiveItemText,
		renderGuardText,
		conversationAlias,
		titleAlias,
		scopeAlias,
		intlAlias,
		navigateAlias,
		guardStart,
		guardQuestion,
		assignmentText,
	} = contract;
	const opening = block.text.match(
		new RegExp(
			`^function ${contract.functionName}\\(e\\)\\{let ${hookSlotsAlias}=\\(0,${hookCacheAlias}\\.c\\)\\(${hookCacheSize}\\),`,
		),
	)?.[0];
	if (opening == null) {
		return null;
	}
	const openingPatched = opening.replace(
		`(${hookCacheSize}),`,
		`(${hookCacheSize + 1}),`,
	);
	let patchedBlock = block.text.replace(opening, openingPatched);

	const deleteItem = `{id:${BACKTICK}${DELETE_MENU_ID}${BACKTICK},message:${archiveMessageAlias}.delete,onSelect:()=>${RUNTIME_MARKER}(${scopeAlias},${conversationAlias},${titleAlias},${archivePendingAlias},${activeAlias},${intlAlias},${navigateAlias})}`;
	if (countOccurrences(patchedBlock, archiveItemText) !== 1) {
		return null;
	}
	patchedBlock = patchedBlock.replace(
		archiveItemText,
		`${archiveItemText},${deleteItem}`,
	);

	const guardCondition = block.text.slice(guardStart, guardQuestion);
	if (countOccurrences(patchedBlock, guardCondition) !== 1) {
		return null;
	}
	patchedBlock = patchedBlock.replace(
		guardCondition,
		`${guardCondition}||${hookSlotsAlias}[${hookCacheSize}]!==${activeAlias}`,
	);

	if (countOccurrences(patchedBlock, assignmentText) !== 1) {
		return null;
	}
	patchedBlock = patchedBlock.replace(
		assignmentText,
		`${assignmentText.slice(0, 2)}${hookSlotsAlias}[${hookCacheSize}]=${activeAlias},${assignmentText.slice(2)}`,
	);

	const tombstoneGuard = `if(${conversationAlias}!=null&&${DELETED_IDS}.has(${conversationAlias}.id))return null;`;
	if (countOccurrences(patchedBlock, renderGuardText) !== 1) {
		return null;
	}
	patchedBlock = patchedBlock.replace(
		renderGuardText,
		renderGuardText.replace(";if", `;${tombstoneGuard}if`),
	);

	return source.replace(block.text, `${runtimeSource}${patchedBlock}`);
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

		const contracts = discoverContracts(source);
		if (contracts.missing.length > 0) {
			warn(`Could not find unique current ${contracts.missing.join(", ")}`);
			return source;
		}

		let patched = source.replace(LOCALIZATION_NEEDLE, LOCALIZATION_REPLACEMENT);
		const clientPatched = patchConversationClient(
			contracts.client.text,
			contracts.client,
		);
		if (clientPatched == null) {
			warn("Could not verify ChatGPT conversation response filters");
			return source;
		}
		patched = patched.replace(contracts.client.text, clientPatched);

		const runtimeSource = buildRuntimeSource({
			...contracts.service,
			...contracts.cache,
			toastTokenAlias: contracts.sidebar.toastTokenAlias,
			archiveMessageAlias: contracts.sidebar.archiveMessageAlias,
		});
		const sidebarPatched = patchSidebar(
			patched,
			contracts.sidebar,
			runtimeSource,
		);
		if (sidebarPatched == null) {
			warn("Could not verify ChatGPT sidebar delete menu injection");
			return source;
		}
		patched = sidebarPatched;

		if (
			!patched.includes(RUNTIME_MARKER) ||
			!patched.includes(`${DELETED_IDS}.add(t.id)`) ||
			!patched.includes(`${DELETED_IDS}.delete(t.id)`) ||
			!patched.includes(`${contracts.service.deleteMethodName}(t.id)`) ||
			!patched.includes(
				`${contracts.cache.cacheEvictionAlias}(e.queryClient,t.id)`,
			) ||
			!patched.includes(`${contracts.sidebar.archiveMessageAlias}.delete`) ||
			!patched.includes(
				`${contracts.sidebar.archiveMessageAlias}.deleteConfirm`,
			) ||
			!patched.includes(
				`${contracts.sidebar.archiveMessageAlias}.deleteError`,
			) ||
			!patched.includes("codexLinuxConversationDelete.delete") ||
			!patched.includes("codexLinuxConversationDelete.confirm") ||
			!patched.includes("codexLinuxConversationDelete.error") ||
			!patched.includes(`id:${BACKTICK}${DELETE_MENU_ID}${BACKTICK}`) ||
			!patched.includes(`${DELETED_IDS}.has(e?.id)`) ||
			!patched.includes(`${DELETED_IDS}.has(e.item?.id)`) ||
			!patched.includes(`s(${JSON.stringify(NEW_THREAD_ROUTE)})`)
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
		assetMatch: matchesChatGptSidebarContract,
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
};
