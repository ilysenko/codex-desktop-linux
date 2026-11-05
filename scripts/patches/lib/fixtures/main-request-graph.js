"use strict";

// Shared current-native shape for request-bridge contract tests.
function graphBody() {
  return [
    'class RequestWrapper{options;constructor(e){this.options=e}async handleRequest(e,t){if("/codex/dictation-stream-connect-info"===t.url)return void await this.handleDictationStreamConnectInfoRequest(e,t);throw Error("HTTP requests must use the HTTP fetch service.")}async handleDictationStreamConnectInfoRequest(e,t){try{if(t.fail)throw Error("dictation failed");this.options.chunkedMessageSender.sendInlineMessageForView(e,{type:"fetch-response",responseType:"success",requestId:t.requestId,status:200,bodyJsonString:"{}"})}catch(r){this.options.chunkedMessageSender.sendInlineMessageForView(e,{type:"fetch-response",responseType:"error",requestId:t.requestId,status:432,error:r.message})}}cancelRequest(e,t){this.options.cancelled.push({owner:this,view:e,request:t})}}',
    'class ViewHandler{chunkedMessageSender;fetchWrapper;globalState;constructor(a,b,c,d,sender,f,g,wrapper,state,j,lookup=e=>{if(e)return e;throw Error("missing")},tail=()=>!0){this.chunkedMessageSender=sender,this.fetchWrapper=wrapper,this.globalState=state}async handleMessage(e,t){switch(t.type){case"mcp-response":break;case"fetch":await this.fetchWrapper.handleRequest(e,t);break;case"cancel-fetch":this.fetchWrapper.cancelRequest(e,t);break;case"show-diff":break}}}',
    'class Host{constructor(e){let a="local",b=null,c=null,f=null,g=null,j=null;this.options=e,this.scopedState=e.globalState,this.fetchWrapper=new RequestWrapper({applicationNetwork:e.applicationNetwork,chunkedMessageSender:e.chunkedMessageSender,cancelled:e.cancelled});this.messageHandler=new ViewHandler(a,b,c,e.windowManager,e.chunkedMessageSender,f,g,this.fetchWrapper,this.scopedState,j,e=>{let a=e;return a},()=>!0);this.seen=[]}async handleMessage(e,t){await this.messageHandler.handleMessage(e,t),this.seen.push(t.type)}}',
    'function runMainAppStartup(e){let created=function({globalState:state,chunkedMessageSender:sender,cancelled:cancelled,windowManager:window}){let host;(host=new Host({globalState:state,chunkedMessageSender:sender,cancelled:cancelled,windowManager:window}));return host}({globalState:e.globalState,chunkedMessageSender:e.chunkedMessageSender,cancelled:e.cancelled,windowManager:e.windowManager});return created}require.d(exports,{runMainAppStartup:()=>runMainAppStartup});module.exports=exports;',
  ].join("");
}
function fixture(body = graphBody(), id = "82820", extra = "") {
  return `exports.ids=[45],exports.modules={${id}(module,exports,require){${body}}${extra}};`;
}
module.exports = { graphBody, fixture };
