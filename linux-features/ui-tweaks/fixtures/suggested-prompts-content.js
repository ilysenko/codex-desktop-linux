"use strict";

// Compact current factory/component/cache shape. Signed tests additionally run
// the actual content component, native policy module and returned card actions.
module.exports = [
  'export const __webpack_modules__={Content(e,t,r){var d=r("runtime"),b=r("settings"),a=r("store"),tf=r("policy"),JSX=r("jsx");let jn={};',
  'function ua(e){let{generatedSuggestionsEnabled:i,projectRoot:l,hostId:host}=e,account={accountId:"test"},',
  'Ee=!0===(0,d.iK)(b.pref.enabled),De=(0,a.Ul)(jn),Me=i&&null!=l,Ne=null==De&&Me&&Ee;',
  'let options={accountId:account.accountId,enabled:Ne,hostId:host};let{data:Pe,isLoading:Fe}=(0,tf.fy)(options),',
  'P=!1,Le=Ne&&!0===Pe,config={get:()=>!1},x=!0,eB=[],ze;',
  'if(eB[0]!==Ne){let Re=Le&&!P&&config.get("personalized",!1);',
  'ze=Ne&&(Fe||Le&&P)?null:(0,tf.o1)({debugOverride:De,experimentEligible:Le,personalized:Re}),eB[0]=Ne,eB[1]=ze}else ze=eB[1];',
  'let z="curated"===ze;let Ve=(0,tf.b4)({canUsePersonalizedSuggestions:Ee,generatedSuggestionsEnabled:Me,',
  'hasGeneratedSuggestionsReadSettled:x,shouldUseCuratedNewChatPageSuggestions:z});return{source:ze,curated:z,show:Ve}}',
  'function Home(e){let{page:page,root:root,host:host}=e;return(0,JSX.jsx)(ua,{generatedSuggestionsEnabled:page,hostId:host,projectRoot:root})}',
  'r.d(t,{HomeAmbientSuggestionsContent:()=>Home})}};',
].join("");
