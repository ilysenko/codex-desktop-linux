"use strict";

// Minimal connected request-bridge graph. currentGraphBody adds the verbatim
// latest native Avatar prelude and inert origin-aware receiver wiring.
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
const nativePrelude = "if(t.type.startsWith(\"avatar-overlay-\"))return void await async function(e,t,r,n=()=>{}){switch(r.type){case\"avatar-overlay-close\":e.dismiss();return;case\"avatar-overlay-hide\":e.hide();return;case\"avatar-overlay-open\":await e.toggle(t);return;case\"avatar-overlay-open-state-request\":n({type:\"avatar-overlay-open-state-changed\",isOpen:e.isOpen()});return;case\"avatar-overlay-drag-start\":{let n=_P(r),i=null==n?{pointerWindowX:r.pointerWindowX,pointerWindowY:r.pointerWindowY}:{...n,pointerWindowX:r.pointerWindowX,pointerWindowY:r.pointerWindowY};e.startDrag(t.id,i,r.usesOrbPhysics);return}case\"avatar-overlay-drag-move\":{let n=_P(r);n?e.moveDrag(t.id,n):e.moveDrag(t.id);return}case\"avatar-overlay-drag-end\":{let n=_P(r);e.endDrag(t.id,n??void 0,r.altKey);return}case\"avatar-overlay-drag-release\":e.throwWithVelocity(t.id,r.velocityX,r.velocityY,r.shouldBounce);return;case\"avatar-overlay-element-size-changed\":e.setElementSize(t.id,{quickChatFocusRequestId:r.quickChatFocusRequestId,isGlobalRealtimeVoiceTransitioning:r.isGlobalRealtimeVoiceTransitioning,isQuickChatLoading:r.isQuickChatLoading,isTrayVisible:r.isTrayVisible,mascot:r.mascot,petControlsAppearance:r.petControlsAppearance,presentation:r.presentation,quickChat:r.quickChat,realtimeCaptionAboveMascotPx:r.realtimeCaptionAboveMascotPx,showsPetControls:r.showsPetControls,tray:r.tray});return;case\"avatar-overlay-pointer-interaction-changed\":e.setPointerInteraction(t.id,r.isInteractive);return;case\"avatar-overlay-keyboard-interaction-changed\":e.setKeyboardInteraction(t.id,r.isInteractive,r.restorePreviousFocus);return}}(this.getOverlayManagerForOrigin?.(e)??this.avatarOverlayManager,e,t,t=>{this.windowManager.sendMessageToWebContents(e,t)});";

function currentGraphBody() {
  return graphBody()
    .replace("this.chunkedMessageSender=sender,", "this.windowManager=d,this.avatarOverlayManager=c,this.getOverlayManagerForOrigin=lookup,this.chunkedMessageSender=sender,")
    .replace("async handleMessage(e,t){switch(t.type)", `async handleMessage(e,t){${nativePrelude}switch(t.type)`)
    .replace("b=null,c=null,f=null", "b=null,c=e.avatarOverlayManager,f=null")
    .replace("j,e=>{let a=e;return a},()=>!0)", "j,e.getOverlayManagerForOrigin,()=>!0)")
    .replace("cancelled:cancelled,windowManager:window})", "cancelled:cancelled,windowManager:window,avatarOverlayManager:avatar,getOverlayManagerForOrigin:lookup})")
    .replace("cancelled:cancelled,windowManager:window})", "cancelled:cancelled,windowManager:window,avatarOverlayManager:avatar,getOverlayManagerForOrigin:lookup})")
    .replace("cancelled:e.cancelled,windowManager:e.windowManager})", "cancelled:e.cancelled,windowManager:e.windowManager,avatarOverlayManager:e.avatarOverlayManager,getOverlayManagerForOrigin:e.getOverlayManagerForOrigin})");
}
module.exports = { graphBody, currentGraphBody, nativePrelude, fixture };
