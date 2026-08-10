const CHATGPT_SIDEBAR_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
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
const SIDEBAR_MENU_NEEDLE =
	"{id:`archive-chatgpt-conversation`,message:OW.archive,onSelect:ae}]}";
const MENU_CACHE_GUARD_NEEDLE =
	"t[27]!==n||t[28]!==ae||t[29]!==re||t[30]!==w||t[31]!==k||t[32]!==L||t[33]!==E?(oe=async()=>{";
const MENU_CACHE_GUARD_REPLACEMENT =
	"t[27]!==n||t[28]!==ae||t[29]!==re||t[30]!==w||t[31]!==k||t[32]!==L||t[33]!==E||t[83]!==o?(oe=async()=>{";
const MENU_CACHE_ASSIGNMENT_NEEDLE = "t[33]=E,t[34]=oe):oe=t[34]";
const MENU_CACHE_ASSIGNMENT_REPLACEMENT = "t[33]=E,t[83]=o,t[34]=oe):oe=t[34]";
const SIDEBAR_MENU_REPLACEMENT = `{id:\`archive-chatgpt-conversation\`,message:OW.archive,onSelect:ae},{id:\`${DELETE_MENU_ID}\`,message:OW.delete,onSelect:()=>${RUNTIME_MARKER}(E,n,v,w,o,D,O)}]}`;
const SIDEBAR_COMPONENT_NEEDLE = "function VBc(e){let t=(0,w5.c)(83),";
const CACHE_EVICTION_NEEDLE = "function KDa(";
const DELETE_API_NEEDLE = "safeDelete(`/conversation/id/{conversation_id}`,";
const NEW_CHAT_HANDLER_NEEDLE = "function y0(e,t){";
const LIST_FILTER_NEEDLE = "return{...l,items:l.items?.filter(uBr)??[]}";
const BATCH_FILTER_NEEDLE =
	"async getBatch(e,t){return(await this.request.getConversationsBatch(e,t)).filter(uBr)}";
const PINNED_FILTER_NEEDLE =
	"async listPinnedConversationItems(){return(await this.request.listPinnedItems({itemType:`conversation`})).filter(lBr)}";
const LIST_FILTER_REPLACEMENT = `return{...l,items:l.items?.filter(e=>!${DELETED_IDS}.has(e?.id)&&uBr(e))??[]}`;
const BATCH_FILTER_REPLACEMENT = `async getBatch(e,t){return(await this.request.getConversationsBatch(e,t)).filter(uBr).filter(e=>!${DELETED_IDS}.has(e?.id))}`;
const PINNED_FILTER_REPLACEMENT =
	"async listPinnedConversationItems(){return(await this.request.listPinnedItems({itemType:`conversation`})).filter(lBr).filter(e=>!" +
	`${DELETED_IDS}.has(e.item?.id))}`;
const PROJECT_LIST_FILTER_NEEDLE =
	"async listProjectConversations({cursor:e=null,limit:t=5,ownedOnly:n=!0,projectId:r}){let i=await this.request.listProjectConversations({cursor:e,limit:t,ownedOnly:n,projectId:r});return{cursor:i.cursor,items:i.items?.filter(uBr)??[]}}";
const PROJECT_LIST_FILTER_REPLACEMENT = `async listProjectConversations({cursor:e=null,limit:t=5,ownedOnly:n=!0,projectId:r}){let i=await this.request.listProjectConversations({cursor:e,limit:t,ownedOnly:n,projectId:r});return{cursor:i.cursor,items:i.items?.filter(e=>!${DELETED_IDS}.has(e?.id)&&uBr(e))??[]}}`;
const RUNTIME_SOURCE = `const ${DELETED_IDS}=new Set;function ${RUNTIME_MARKER}(e,t,n,r,i,o,s){if(t==null||r)return;if(typeof window==="undefined"||typeof window.confirm!=="function"||!window.confirm(o.formatMessage(OW.deleteConfirm,{title:n})))return;e.get(zN).delete(t.id).then(()=>{${DELETED_IDS}.add(t.id),i&&(typeof y0==="function"?y0(e):typeof s==="function"&&s(${JSON.stringify(NEW_THREAD_ROUTE)})),KDa(e.queryClient,t.id)}).catch(()=>{e.get(yv).danger(o.formatMessage(OW.deleteError))})}`;

function warn(message) {
	console.warn(`WARN: ${message} - skipping conversation delete feature patch`);
}

function countOccurrences(source, needle) {
	return source.split(needle).length - 1;
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

		const markers = [
			["ChatGPT sidebar localization markers", LOCALIZATION_NEEDLE],
			["ChatGPT sidebar conversation row", SIDEBAR_COMPONENT_NEEDLE],
			["ChatGPT conversation cache helper", CACHE_EVICTION_NEEDLE],
			["ChatGPT conversation delete API client", DELETE_API_NEEDLE],
			["ChatGPT new-chat state handler", NEW_CHAT_HANDLER_NEEDLE],
			["ChatGPT sidebar menu cache guard", MENU_CACHE_GUARD_NEEDLE],
			["ChatGPT sidebar menu cache assignment", MENU_CACHE_ASSIGNMENT_NEEDLE],
			["ChatGPT conversation list response filter", LIST_FILTER_NEEDLE],
			["ChatGPT conversation batch response filter", BATCH_FILTER_NEEDLE],
			["ChatGPT pinned conversation response filter", PINNED_FILTER_NEEDLE],
			[
				"ChatGPT project conversation response filter",
				PROJECT_LIST_FILTER_NEEDLE,
			],
			["ChatGPT sidebar archive menu item", SIDEBAR_MENU_NEEDLE],
		];
		const missing = markers.filter(
			([, needle]) => countOccurrences(source, needle) !== 1,
		);
		if (missing.length > 0) {
			warn(
				`Could not find unique current ${missing.map(([label]) => label).join(", ")}`,
			);
			return source;
		}

		let patched = source.replace(LOCALIZATION_NEEDLE, LOCALIZATION_REPLACEMENT);
		patched = patched.replace(LIST_FILTER_NEEDLE, LIST_FILTER_REPLACEMENT);
		patched = patched.replace(BATCH_FILTER_NEEDLE, BATCH_FILTER_REPLACEMENT);
		patched = patched.replace(PINNED_FILTER_NEEDLE, PINNED_FILTER_REPLACEMENT);
		patched = patched.replace(
			PROJECT_LIST_FILTER_NEEDLE,
			PROJECT_LIST_FILTER_REPLACEMENT,
		);
		patched = patched.replace(
			MENU_CACHE_GUARD_NEEDLE,
			MENU_CACHE_GUARD_REPLACEMENT,
		);
		patched = patched.replace(
			MENU_CACHE_ASSIGNMENT_NEEDLE,
			MENU_CACHE_ASSIGNMENT_REPLACEMENT,
		);
		patched = patched.replace(
			SIDEBAR_COMPONENT_NEEDLE,
			`${RUNTIME_SOURCE}${SIDEBAR_COMPONENT_NEEDLE.replace("(83)", "(84)")}`,
		);
		patched = patched.replace(SIDEBAR_MENU_NEEDLE, SIDEBAR_MENU_REPLACEMENT);

		if (
			!patched.includes(RUNTIME_MARKER) ||
			!patched.includes(`${DELETED_IDS}.add(t.id)`) ||
			!patched.includes(LIST_FILTER_REPLACEMENT) ||
			!patched.includes(MENU_CACHE_GUARD_REPLACEMENT) ||
			!patched.includes(MENU_CACHE_ASSIGNMENT_REPLACEMENT) ||
			!patched.includes("function VBc(e){let t=(0,w5.c)(84),") ||
			!patched.includes(`id:\`${DELETE_MENU_ID}\``) ||
			!patched.includes("message:OW.delete")
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
