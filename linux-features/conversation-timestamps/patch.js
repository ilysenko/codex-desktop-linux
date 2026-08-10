const {
	findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const BACKTICK = "`";
const APP_INITIAL_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const COMPOSER_CONTROLLER_ASSET_PATTERN =
	/^use-chatgpt-composer-controller-[A-Za-z0-9_-]+\.js$/;
const SUBAGENT_ACTIVITY_ASSET_PATTERN =
	/^subagent-activity-chip-group-[A-Za-z0-9_-]+\.js$/;
const LOCAL_CONVERSATION_TURN_ASSET_PATTERN =
	/^local-conversation-(?:turn|thread)-[A-Za-z0-9_-]+\.js$/;

function warn(message) {
	console.warn(
		`WARN: ${message} - skipping conversation timestamps feature patch`,
	);
}

function uniqueMatch(source, regex) {
	const globalRegex = regex.global
		? regex
		: new RegExp(regex.source, `${regex.flags}g`);
	globalRegex.lastIndex = 0;
	const matches = [...source.matchAll(globalRegex)];
	return matches.length === 1 ? matches[0] : null;
}

function replaceMatch(source, match, replacement) {
	return source.replace(match[0], replacement);
}

function isAppInitialTimestampPatched(source) {
	return (
		uniqueMatch(
			source,
			new RegExp(
				`sentAtMs:typeof ${JS_IDENT}\\.create_time===${BACKTICK}number${BACKTICK}&&Number\\.isFinite\\(${JS_IDENT}\\.create_time\\)\\?${JS_IDENT}\\.create_time\\*1e3:null`,
			),
		) != null &&
		uniqueMatch(
			source,
			new RegExp(
				`sentAtMs:${JS_IDENT}\\.sentAtMs\\?\\?null,targetedReplyLabel`,
			),
		) != null &&
		uniqueMatch(
			source,
			new RegExp(
				`phase:${BACKTICK}final_answer${BACKTICK},sentAtMs:${JS_IDENT}\\.sentAtMs\\?\\?null,structuredOutput:void 0`,
			),
		) != null &&
		uniqueMatch(
			source,
			new RegExp(
				`${JS_IDENT}\\(${JS_IDENT}\\.items,\\{isStreaming:${JS_IDENT}\\}\\)\\.map\\(\\(\\{item:${JS_IDENT}\\}\\)=>${JS_IDENT}\\)`,
			),
		) != null
	);
}

function findAppInitialTimestampContract(source) {
	const sourceMatch = uniqueMatch(
		source,
		new RegExp(
			`markdown:([^,]+),role:([^,]+),\\.\\.\\.(${JS_IDENT})\\.id==null\\?\\{\\}:\\{serverMessageId:\\3\\.id\\},sourcesFooterReferences:([^,]+),`,
		),
	);
	const userMatch = uniqueMatch(
		source,
		new RegExp(
			`message:(${JS_IDENT})\\.markdown,messageId:\\1\\.id,referencesPriorConversation:!1,sentAtMs:null,targetedReplyLabel:\\1\\.targetedReplyLabel`,
		),
	);
	const assistantMatch = uniqueMatch(
		source,
		new RegExp(
			`messageId:(${JS_IDENT})\\.id,phase:${BACKTICK}final_answer${BACKTICK},sentAtMs:null,structuredOutput:void 0`,
		),
	);
	const groupingMatch = uniqueMatch(
		source,
		new RegExp(
			`(${JS_IDENT})\\((${JS_IDENT})\\((${JS_IDENT})\\.items,\\{isStreaming:(${JS_IDENT})\\}\\)\\)\\.map\\(\\(\\{item:\\3\\}\\)=>\\3\\)`,
		),
	);
	if (
		[sourceMatch, userMatch, assistantMatch, groupingMatch].some(
			(match) => match == null,
		)
	) {
		return null;
	}
	return { sourceMatch, userMatch, assistantMatch, groupingMatch };
}

function applyAppInitialTimestampPatch(source) {
	if (isAppInitialTimestampPatched(source)) {
		return source;
	}
	const contract = findAppInitialTimestampContract(source);
	if (contract == null) {
		warn("Could not find unique current ChatGPT message timestamp markers");
		return source;
	}

	const { sourceMatch, userMatch, assistantMatch, groupingMatch } = contract;
	let patched = replaceMatch(
		source,
		sourceMatch,
		`markdown:${sourceMatch[1]},role:${sourceMatch[2]},sentAtMs:typeof ${sourceMatch[3]}.create_time===${BACKTICK}number${BACKTICK}&&Number.isFinite(${sourceMatch[3]}.create_time)?${sourceMatch[3]}.create_time*1e3:null,...${sourceMatch[3]}.id==null?{}:{serverMessageId:${sourceMatch[3]}.id},sourcesFooterReferences:${sourceMatch[4]},`,
	);
	patched = replaceMatch(
		patched,
		userMatch,
		`message:${userMatch[1]}.markdown,messageId:${userMatch[1]}.id,referencesPriorConversation:!1,sentAtMs:${userMatch[1]}.sentAtMs??null,targetedReplyLabel:${userMatch[1]}.targetedReplyLabel`,
	);
	patched = replaceMatch(
		patched,
		assistantMatch,
		`messageId:${assistantMatch[1]}.id,phase:${BACKTICK}final_answer${BACKTICK},sentAtMs:${assistantMatch[1]}.sentAtMs??null,structuredOutput:void 0`,
	);
	patched = replaceMatch(
		patched,
		groupingMatch,
		`${groupingMatch[2]}(${groupingMatch[3]}.items,{isStreaming:${groupingMatch[4]}}).map(({item:${groupingMatch[3]}})=>${groupingMatch[3]})`,
	);
	return isAppInitialTimestampPatched(patched) ? patched : source;
}

function findComposerTimestampContract(source) {
	const assistantActionMatch = uniqueMatch(
		source,
		new RegExp(
			`\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),\\{alwaysShowActions:(${JS_IDENT}),turnId:${JS_IDENT},copyText:${JS_IDENT},getCopyHtml:${JS_IDENT},forkDisabled:${JS_IDENT},forkLabel:${JS_IDENT},isForking:${JS_IDENT},sentAtMs:${JS_IDENT}\\.sentAtMs,[^}]*,onFork:${JS_IDENT}\\}\\)`,
		),
	);
	const userActionMatch = uniqueMatch(
		source,
		new RegExp(
			`\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),\\{message:(${JS_IDENT})\\.message,sentAtMs:(${JS_IDENT})\\.sentAtMs,hasExternalAttachments:${JS_IDENT},hostId:${JS_IDENT},onEditMessage:${JS_IDENT},threadId:${JS_IDENT},turnId:${JS_IDENT}\\}\\)`,
		),
	);
	const groupingMatch = uniqueMatch(
		source,
		new RegExp(
			`(${JS_IDENT})\\[(\\d+)\\]!==(${JS_IDENT})\\|\\|\\1\\[(\\d+)\\]!==(${JS_IDENT})\\|\\|\\1\\[(\\d+)\\]!==(${JS_IDENT})\\?\\((${JS_IDENT})=\\(0,(${JS_IDENT})\\.jsxs\\)\\(${BACKTICK}div${BACKTICK},\\{ref:\\3,"data-content-search-unit-key":\\5,children:\\[([\\s\\S]*?)\\]\\}\\),([\\s\\S]*?)\\):\\8=\\1\\[\\d+\\],\\8`,
		),
	);
	if (
		[assistantActionMatch, userActionMatch, groupingMatch].some(
			(match) => match == null,
		)
	) {
		return null;
	}
	const beforeGrouping = source.slice(0, groupingMatch.index);
	const itemMatches = [
		...beforeGrouping.matchAll(
			new RegExp(
				`if\\((${JS_IDENT})\\.type===${BACKTICK}assistant-message${BACKTICK}\\)\\{`,
				"g",
			),
		),
	];
	const itemAlias = itemMatches.at(-1)?.[1];
	if (itemAlias == null) {
		return null;
	}
	return { assistantActionMatch, userActionMatch, groupingMatch, itemAlias };
}

function isComposerTimestampPatched(source) {
	return (
		source.includes("showTimestampWithoutActions:!1,timestampHoverOnly:!0") &&
		source.includes("showTimestampWithoutActions:!0,timestampHoverOnly:!1") &&
		source.includes("flex w-full justify-center") &&
		uniqueMatch(
			source,
			new RegExp(
				`\\(0,${JS_IDENT}\\.jsx\\)\\(${JS_IDENT},\\{message:${JS_IDENT}\\.message,sentAtMs:${JS_IDENT}\\.sentAtMs,timestampHoverOnly:!1,`,
			),
		) != null
	);
}

function applyComposerControllerTimestampPatch(source) {
	if (isComposerTimestampPatched(source)) {
		return source;
	}
	const contract = findComposerTimestampContract(source);
	if (contract == null) {
		warn("Could not find unique current ChatGPT timestamp visibility markers");
		return source;
	}
	const { assistantActionMatch, userActionMatch, groupingMatch, itemAlias } =
		contract;
	const assistantRuntime = assistantActionMatch[1];
	const assistantComponent = assistantActionMatch[2];
	let patched = replaceMatch(
		source,
		assistantActionMatch,
		assistantActionMatch[0].replace(
			`alwaysShowActions:${assistantActionMatch[3]},`,
			`alwaysShowActions:${assistantActionMatch[3]},showTimestampWithoutActions:!1,timestampHoverOnly:!0,`,
		),
	);
	patched = replaceMatch(
		patched,
		userActionMatch,
		userActionMatch[0].replace(
			`sentAtMs:${userActionMatch[4]}.sentAtMs,`,
			`sentAtMs:${userActionMatch[4]}.sentAtMs,timestampHoverOnly:!1,`,
		),
	);
	const separator = `${itemAlias}.sentAtMs==null?null:(0,${assistantRuntime}.jsx)(${BACKTICK}div${BACKTICK},{className:${BACKTICK}flex w-full justify-center${BACKTICK},children:(0,${assistantRuntime}.jsx)(${assistantComponent},{showTimestampWithoutActions:!0,timestampHoverOnly:!1,sentAtMs:${itemAlias}.sentAtMs})})`;
	patched = replaceMatch(
		patched,
		groupingMatch,
		groupingMatch[0].replace(
			`children:[${groupingMatch[10]}]`,
			`children:[${groupingMatch[10]},${separator}]`,
		),
	);
	return isComposerTimestampPatched(patched) ? patched : source;
}

function findUserTimestampContract(source) {
	const propsMatch = uniqueMatch(
		source,
		new RegExp(
			`\\{message:${JS_IDENT},sentAtMs:${JS_IDENT},collapsedLineCount:${JS_IDENT},alwaysShowActions:${JS_IDENT},compactActions:${JS_IDENT},hideActions:${JS_IDENT},messageStatus:${JS_IDENT},messageStatusIcon:${JS_IDENT},messageReaction:${JS_IDENT},leadingActions:${JS_IDENT},hookStats:${JS_IDENT},threadDetailLevel:${JS_IDENT},referencesPriorConversation:${JS_IDENT},reviewMode:${JS_IDENT},pullRequestFixMode:${JS_IDENT},autoResolveSync:${JS_IDENT},hasExternalAttachments:${JS_IDENT},commentCount:${JS_IDENT},onEditMessage:${JS_IDENT},threadId:${JS_IDENT},turnId:${JS_IDENT},cwd:${JS_IDENT},hostId:(${JS_IDENT})\\}=(${JS_IDENT}),`,
		),
	);
	const rowMatch = uniqueMatch(
		source,
		new RegExp(
			`className:(${JS_IDENT})\\(${BACKTICK}me-1 ms-1 flex items-center gap-2${BACKTICK},(${JS_IDENT})\\?void 0:${BACKTICK}opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}\\)`,
		),
	);
	const spanMatch = uniqueMatch(
		source,
		new RegExp(
			`\\(0,(${JS_IDENT})\\.jsx\\)\\(${BACKTICK}span${BACKTICK},\\{className:${BACKTICK}flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK},children:\\(0,\\1\\.jsx\\)\\((${JS_IDENT}),\\{sentAtMs:(${JS_IDENT})\\}\\)\\}\\)`,
		),
	);
	const localActionMatch = uniqueMatch(
		source,
		new RegExp(
			`\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),\\{message:${JS_IDENT},sentAtMs:(${JS_IDENT})\\.sentAtMs,hostId:${JS_IDENT},`,
		),
	);
	const assistantTimestampMatch = uniqueMatch(
		source,
		new RegExp(
			`className:(${JS_IDENT})\\(${BACKTICK}ms-1\\.5 flex h-full items-center${BACKTICK},(${JS_IDENT})\\?${BACKTICK}opacity-0 group-hover:opacity-100${BACKTICK}:${BACKTICK}opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}\\),`,
		),
	);
	const assistantFunctionMatches =
		assistantTimestampMatch == null
			? []
			: [
					...source.matchAll(
						new RegExp(`function ${JS_IDENT}\\(${JS_IDENT}\\)\\{`, "g"),
					),
				]
					.map((match) => ({
						match,
						closeBrace: findMatchingBrace(
							source,
							match.index + match[0].length - 1,
						),
					}))
					.filter(
						({ match, closeBrace }) =>
							match.index < assistantTimestampMatch.index &&
							closeBrace >= assistantTimestampMatch.index,
					);
	const assistantShowTimestampMatch =
		assistantFunctionMatches.length !== 1
			? null
			: uniqueMatch(
					source.slice(
						assistantFunctionMatches[0].match.index,
						assistantFunctionMatches[0].closeBrace + 1,
					),
					new RegExp(
						`showTimestampWithoutActions:(${JS_IDENT}),timestampHoverOnly:${JS_IDENT}(?:,|\\})`,
					),
				);
	if (
		[
			propsMatch,
			rowMatch,
			spanMatch,
			localActionMatch,
			assistantTimestampMatch,
			assistantShowTimestampMatch,
		].some((match) => match == null)
	) {
		return null;
	}
	return {
		propsMatch,
		rowMatch,
		spanMatch,
		localActionMatch,
		assistantTimestampMatch,
		assistantShowTimestampMatch,
	};
}

function isUserTimestampPatched(source) {
	return (
		uniqueMatch(
			source,
			new RegExp(
				`timestampHoverOnly:codexLinuxTimestampHoverOnly\\}=(${JS_IDENT}),`,
			),
		) != null &&
		source.includes("codexLinuxTimestampHoverOnly===!1?void 0") &&
		uniqueMatch(
			source,
			new RegExp(`${JS_IDENT}\\|\\|codexLinuxTimestampHoverOnly===!1`),
		) != null &&
		uniqueMatch(
			source,
			new RegExp(
				`className:${JS_IDENT}\\(${BACKTICK}ms-1\\.5 flex h-full items-center${BACKTICK},${JS_IDENT}\\?${BACKTICK}opacity-0 group-hover:opacity-100${BACKTICK}:(${JS_IDENT})\\?void 0:${BACKTICK}opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}\\),`,
			),
		) != null &&
		source.includes("sentAtMs:")
	);
}

function applySubagentActivityTimestampPatch(source) {
	if (isUserTimestampPatched(source)) {
		return source;
	}
	const contract = findUserTimestampContract(source);
	if (contract == null) {
		warn(
			"Could not find unique current ChatGPT and local user timestamp markers",
		);
		return source;
	}
	const {
		propsMatch,
		rowMatch,
		spanMatch,
		localActionMatch,
		assistantTimestampMatch,
		assistantShowTimestampMatch,
	} = contract;
	let patched = replaceMatch(
		source,
		propsMatch,
		propsMatch[0].replace(
			`hostId:${propsMatch[1]}}=${propsMatch[2]},`,
			`hostId:${propsMatch[1]},timestampHoverOnly:codexLinuxTimestampHoverOnly}=${propsMatch[2]},`,
		),
	);
	patched = replaceMatch(
		patched,
		rowMatch,
		rowMatch[0].replace(
			`${rowMatch[2]}?void 0:`,
			`${rowMatch[2]}||codexLinuxTimestampHoverOnly===!1?void 0:`,
		),
	);
	patched = replaceMatch(
		patched,
		spanMatch,
		spanMatch[0].replace(
			`className:${BACKTICK}flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}`,
			`className:codexLinuxTimestampHoverOnly===!1?void 0:${BACKTICK}flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}`,
		),
	);
	patched = replaceMatch(
		patched,
		localActionMatch,
		localActionMatch[0].replace(
			`sentAtMs:${localActionMatch[3]}.sentAtMs,`,
			`sentAtMs:${localActionMatch[3]}.sentAtMs,timestampHoverOnly:!1,`,
		),
	);
	patched = replaceMatch(
		patched,
		assistantTimestampMatch,
		assistantTimestampMatch[0].replace(
			`,${assistantTimestampMatch[2]}?${BACKTICK}opacity-0 group-hover:opacity-100${BACKTICK}:${BACKTICK}opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}`,
			`,${assistantTimestampMatch[2]}?${BACKTICK}opacity-0 group-hover:opacity-100${BACKTICK}:${assistantShowTimestampMatch[1]}?void 0:${BACKTICK}opacity-0 group-focus-within:opacity-100 group-hover:opacity-100${BACKTICK}`,
		),
	);
	return isUserTimestampPatched(patched) ? patched : source;
}

function findLocalAssistantDataContract(source) {
	const stateObjectMatch = uniqueMatch(
		source,
		new RegExp(
			`\\b(${JS_IDENT})=\\{finalAssistantStartedAtMs:[^,]+,turnStartedAtMs:[^,]+,items:`,
		),
	);
	const returnMatch = uniqueMatch(
		source,
		new RegExp(
			`return (${JS_IDENT})\\?(${JS_IDENT})\\((${JS_IDENT})\\):\\3\\},\\[`,
		),
	);
	if (returnMatch == null) {
		return null;
	}
	const turnAliases = [
		...source
			.slice(0, returnMatch.index)
			.matchAll(new RegExp(`(?:^|[,\\{])turn:(${JS_IDENT})(?:,|\\})`, "g")),
	];
	const stateAlias =
		stateObjectMatch?.[1] ??
		(turnAliases.length === 1 ? turnAliases[0][1] : null);
	if (stateAlias == null) {
		return null;
	}
	return { stateAlias, returnMatch };
}

function isLocalAssistantDataPatched(source) {
	return (
		source.includes("codexLinuxAssistantTimestamp=") &&
		source.includes("normalizedItems=") &&
		uniqueMatch(
			source,
			new RegExp(
				`return ${JS_IDENT}\\?${JS_IDENT}\\(normalizedItems\\):normalizedItems\\},\\[`,
			),
		) != null
	);
}

function applyLocalAssistantDataPatch(source) {
	if (isLocalAssistantDataPatched(source)) {
		return source;
	}
	const contract = findLocalAssistantDataContract(source);
	if (contract == null) {
		warn(
			"Could not find unique current local Codex assistant timestamp data markers",
		);
		return source;
	}
	const { stateAlias, returnMatch } = contract;
	const arrayAlias = returnMatch[3];
	const replacement = `let codexLinuxAssistantTimestamp=${stateAlias}.finalAssistantStartedAtMs??${stateAlias}.turnStartedAtMs??null;let normalizedItems=codexLinuxAssistantTimestamp==null?${arrayAlias}:${arrayAlias}.map(e=>e.type===${BACKTICK}assistant-message${BACKTICK}&&e.sentAtMs==null?{...e,sentAtMs:codexLinuxAssistantTimestamp}:e);return ${returnMatch[1]}?${returnMatch[2]}(normalizedItems):normalizedItems},[`;
	const patched = replaceMatch(source, returnMatch, replacement);
	return isLocalAssistantDataPatched(patched) ? patched : source;
}

function findLocalAssistantTimestampContract(source) {
	const rendererMatch = uniqueMatch(
		source,
		new RegExp(
			`case${BACKTICK}assistant-message${BACKTICK}:[\\s\\S]*?(${JS_IDENT})\\[(\\d+)\\]=(${JS_IDENT})\\):\\3=\\1\\[\\2\\],\\3\\}case${BACKTICK}generated-image${BACKTICK}`,
		),
	);
	if (rendererMatch == null) {
		return null;
	}
	const beforeRenderer = source.slice(0, rendererMatch.index);
	const switchMatches = [
		...beforeRenderer.matchAll(
			new RegExp(`switch\\((${JS_IDENT})\\.type\\)\\{`, "g"),
		),
	];
	const enclosingSwitches = switchMatches
		.map((match) => ({
			match,
			closeBrace: findMatchingBrace(source, match.index + match[0].length - 1),
		}))
		.filter(({ closeBrace }) => closeBrace >= rendererMatch.index);
	if (enclosingSwitches.length !== 1) {
		return null;
	}
	const itemAlias = enclosingSwitches[0].match[1];
	const actionMatch = uniqueMatch(
		source,
		new RegExp(
			`\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),\\{alwaysShowActions:[^}]*sentAtMs:${itemAlias}\\.sentAtMs,[^}]*showTimestampWithoutActions:[^}]*\\}`,
		),
	);
	if (actionMatch == null) {
		return null;
	}
	return {
		rendererMatch,
		itemAlias,
		jsxAlias: actionMatch[1],
		assistantComponent: actionMatch[2],
	};
}

function isLocalAssistantTimestampPatched(source) {
	return (
		uniqueMatch(
			source,
			new RegExp(`${JS_IDENT}\\.sentAtMs==null\\?${JS_IDENT}:`),
		) != null &&
		source.includes("flex w-full justify-center") &&
		source.includes(
			"showTimestampWithoutActions:!0,timestampHoverOnly:!1,sentAtMs:",
		)
	);
}

function applyLocalAssistantTimestampPatch(source) {
	if (isLocalAssistantTimestampPatched(source)) {
		return source;
	}
	const contract = findLocalAssistantTimestampContract(source);
	if (contract == null) {
		warn(
			"Could not find unique current local Codex assistant timestamp markers",
		);
		return source;
	}
	const { rendererMatch, itemAlias, jsxAlias, assistantComponent } = contract;
	const renderAlias = rendererMatch[3];
	const separator = `${itemAlias}.sentAtMs==null?${renderAlias}:(0,${jsxAlias}.jsxs)(${jsxAlias}.Fragment,{children:[${renderAlias},(0,${jsxAlias}.jsx)(${BACKTICK}div${BACKTICK},{className:${BACKTICK}flex w-full justify-center${BACKTICK},children:(0,${jsxAlias}.jsx)(${assistantComponent},{showTimestampWithoutActions:!0,timestampHoverOnly:!1,sentAtMs:${itemAlias}.sentAtMs})})]})`;
	const replacement = rendererMatch[0].replace(
		`${renderAlias}}case${BACKTICK}generated-image${BACKTICK}`,
		`${separator}}case${BACKTICK}generated-image${BACKTICK}`,
	);
	const patched = replaceMatch(source, rendererMatch, replacement);
	return isLocalAssistantTimestampPatched(patched) ? patched : source;
}

function matchesAppInitialTimestampAsset(source) {
	return (
		typeof source === "string" &&
		(isAppInitialTimestampPatched(source) ||
			findAppInitialTimestampContract(source) != null)
	);
}

function matchesComposerTimestampAsset(source) {
	return (
		typeof source === "string" &&
		(isComposerTimestampPatched(source) ||
			findComposerTimestampContract(source) != null)
	);
}

function matchesUserTimestampAsset(source) {
	return (
		typeof source === "string" &&
		(isUserTimestampPatched(source) ||
			findUserTimestampContract(source) != null)
	);
}

function matchesLocalAssistantDataAsset(source) {
	return (
		typeof source === "string" &&
		(isLocalAssistantDataPatched(source) ||
			findLocalAssistantDataContract(source) != null)
	);
}

function matchesLocalAssistantTimestampAsset(source) {
	return (
		typeof source === "string" &&
		(isLocalAssistantTimestampPatched(source) ||
			findLocalAssistantTimestampContract(source) != null)
	);
}

const descriptors = [
	{
		id: "message-times",
		phase: "webview-asset",
		order: 20_920,
		ciPolicy: "optional",
		pattern: APP_INITIAL_ASSET_PATTERN,
		assetMatch: matchesAppInitialTimestampAsset,
		missingDescription: "ChatGPT message normalization bundle",
		skipDescription: "ChatGPT message timestamp data patch",
		apply: applyAppInitialTimestampPatch,
	},
	{
		id: "assistant-times",
		phase: "webview-asset",
		order: 20_921,
		ciPolicy: "optional",
		pattern: COMPOSER_CONTROLLER_ASSET_PATTERN,
		assetMatch: matchesComposerTimestampAsset,
		missingDescription: "ChatGPT conversation renderer bundle",
		skipDescription: "ChatGPT assistant timestamp separator patch",
		apply: applyComposerControllerTimestampPatch,
	},
	{
		id: "user-times",
		phase: "webview-asset",
		order: 20_922,
		ciPolicy: "optional",
		pattern: SUBAGENT_ACTIVITY_ASSET_PATTERN,
		assetMatch: matchesUserTimestampAsset,
		missingDescription: "ChatGPT and local user message action renderer bundle",
		skipDescription: "ChatGPT and local user timestamp visibility patch",
		apply: applySubagentActivityTimestampPatch,
	},
	{
		id: "local-assistant-data",
		phase: "webview-asset",
		order: 20_923,
		ciPolicy: "optional",
		pattern: LOCAL_CONVERSATION_TURN_ASSET_PATTERN,
		assetMatch: matchesLocalAssistantDataAsset,
		missingDescription: "local Codex conversation turn bundle",
		skipDescription: "local Codex assistant timestamp data patch",
		apply: applyLocalAssistantDataPatch,
	},
	{
		id: "local-assistant-times",
		phase: "webview-asset",
		order: 20_924,
		ciPolicy: "optional",
		pattern: SUBAGENT_ACTIVITY_ASSET_PATTERN,
		assetMatch: matchesLocalAssistantTimestampAsset,
		missingDescription: "local Codex conversation renderer bundle",
		skipDescription: "local Codex assistant timestamp separator patch",
		apply: applyLocalAssistantTimestampPatch,
	},
];

module.exports = {
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
	matchesAppInitialTimestampAsset,
	matchesComposerTimestampAsset,
	matchesLocalAssistantDataAsset,
	matchesLocalAssistantTimestampAsset,
	matchesUserTimestampAsset,
};
