"use strict";

const HANDLER_NAME = "linux-read-aloud";
const RUNTIME_VERSION = "conversation-mode-v20";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyReadAloudMainBundlePatch(source) {
  if (!source.includes(`"${HANDLER_NAME}":async`)) {
    return source;
  }
  if (
    source.includes("e.source===`conversation`") &&
    source.includes("codexLinuxReadAloudSpeak(e.text,{requireEnabled:!1})")
  ) {
    return source;
  }
  const explicitButton =
    "e.action===`speak`&&e.source===`button`?codexLinuxReadAloudSpeak(e.text,{requireEnabled:!1})";
  const buttonOnly = "e.action===`speak`&&e.source===`button`?codexLinuxReadAloudSpeak(e.text)";
  const oldConversation = "e.action===`speak`&&(e.source===`button`||e.source===`conversation`)?codexLinuxReadAloudSpeak(e.text)";
  const oldConversationGate =
    "e.action===`speak`&&(e.source===`button`||e.source===`conversation`)?codexLinuxReadAloudSpeak(e.text,{requireEnabled:e.source!==`conversation`})";
  const withConversation = "e.action===`speak`&&(e.source===`button`||e.source===`conversation`)?codexLinuxReadAloudSpeak(e.text,{requireEnabled:!1})";
  if (source.includes(oldConversationGate)) {
    return source.replace(oldConversationGate, withConversation);
  }
  if (source.includes(oldConversation)) {
    return source.replace(oldConversation, withConversation);
  }
  if (source.includes(explicitButton)) {
    return source.replace(explicitButton, withConversation);
  }
  if (source.includes(buttonOnly)) {
    return source.replace(buttonOnly, withConversation);
  }
  warn("Could not find read aloud speak source gate", "conversation mode read aloud main-bundle patch");
  return source;
}

function conversationRuntimeSource() {
  return [
    `;(()=>{const VERSION=${JSON.stringify(RUNTIME_VERSION)};if(globalThis.codexLinuxConversationVersion===VERSION)return;globalThis.codexLinuxConversationVersion=VERSION;`,
    `const METHOD=${JSON.stringify(HANDLER_NAME)};let seq=0,pending=new Map,state={active:false,controls:null,activeConversationId:null,epoch:0,listening:false,muted:false,transcribing:false,awaitingUserTranscript:false,allowAssistant:false,finalizing:false,assistantKey:null,assistantFallbackKey:null,assistantFinalSpoken:false,assistantText:"",assistantSpokenText:"",assistantKeys:[],spokenAssistant:new Map,spokenAssistantTexts:[],queue:[],speaking:false,speechTimer:null,speechCooldownUntil:0,interruptCleanup:null,interruptPendingEpoch:0,interruptSerial:0,restartTimer:null,flushTimer:null,seenAssistantKeys:new Set,lastConversationId:null,lastSentText:"",lastSentAt:0,cursorSentAtMs:0,spokenEchoText:"",spokenEchoAt:0,stopButton:null,muteButton:null,composerAura:null};`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);clearTimeout(n.timer);if(t.responseType==="success"){let e=null;try{e=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve({status:t.status,body:e})}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,event=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){event.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(event)}`,
    `function post(params,timeoutMs=4000){let requestId="codex-linux-conversation-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+METHOD,body:JSON.stringify(params??{})};return new Promise((resolve,reject)=>{let timer=setTimeout(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);pending.set(requestId,{resolve,reject,timer});dispatch(payload)})}`,
    `function clean(text){return String(text||"").replace(/\\r\\n/g,"\\n").replace(/\\\`\\\`\\\`[\\s\\S]*?\\\`\\\`\\\`/g," code block. ").replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,"$1").replace(/[*_#>~]/g,"").replace(/\\n{3,}/g,"\\n\\n").trim().slice(0,8e3)}`,
    `function available(){return navigator.userAgent.includes("Linux")&&!!navigator.mediaDevices&&typeof MediaRecorder!="undefined"}`,
    `function conversationId(value){return typeof value==="string"&&value.length>0?value:null}`,
    `function resetTurnState(){clearTimeout(state.flushTimer);state.flushTimer=null;state.finalizing=false;state.assistantKey=null;state.assistantFallbackKey=null;state.assistantFinalSpoken=false;state.assistantText="";state.assistantSpokenText="";state.assistantKeys=[];state.queue=[]}`,
    `function resetSpeechState(){state.queue=[];state.speaking=false;state.speechCooldownUntil=0;clearTimeout(state.speechTimer);state.speechTimer=null}`,
    `function resetTranscriptState(){state.lastSentText="";state.lastSentAt=0;state.spokenEchoText="";state.spokenEchoAt=0}`,
    `function stopSpeech(resetAssistant=false){state.epoch++;resetSpeechState();resetAssistant&&resetTurnState();try{globalThis.speechSynthesis?.cancel?.()}catch{}post({action:"stop"}).catch(()=>{})}`,
    `function isSpeaking(){return state.active&&(state.speaking||state.queue.length>0)}`,
    `function stopSpeaking(){if(!isSpeaking())return false;state.assistantFinalSpoken=true;stopSpeech(false);return true}`,
    `function installUi(){if(typeof document==="undefined"||!document.body)return;let style=document.getElementById("codex-linux-conversation-style");if(!style){style=document.createElement("style");style.id="codex-linux-conversation-style";style.textContent=".codex-linux-conversation-composer-aura{position:relative!important;outline:1px solid rgba(58,196,125,.55)!important;box-shadow:0 0 0 2px rgba(58,196,125,.11),0 0 0 6px rgba(56,189,248,.055),0 12px 30px rgba(20,120,90,.10)!important;border-radius:18px!important;transition:outline-color .18s ease,box-shadow .18s ease}.codex-linux-conversation-composer-aura::after{content:\\"\\";position:absolute;inset:-4px;border:1px solid rgba(56,189,248,.36);border-radius:20px;box-shadow:0 0 18px rgba(34,197,94,.12);opacity:.78;pointer-events:none}.codex-linux-conversation-stop,.codex-linux-conversation-mute{position:fixed;right:var(--codex-linux-conversation-control-right,22px);width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--token-surface-primary,#fff);box-shadow:0 8px 22px rgba(0,0,0,.18);cursor:pointer;z-index:2147483001}.codex-linux-conversation-stop{bottom:var(--codex-linux-conversation-stop-bottom,92px);border:1px solid rgba(58,196,125,.75);color:rgb(18,126,82)}.codex-linux-conversation-mute{bottom:var(--codex-linux-conversation-mute-bottom,138px);border:1px solid rgba(56,189,248,.75);color:rgb(14,116,144)}.codex-linux-conversation-muted .codex-linux-conversation-mute{border-color:rgba(239,68,68,.8);background:rgba(239,68,68,.10);color:rgb(185,28,28)}.codex-linux-conversation-stop:hover,.codex-linux-conversation-mute:hover{background:rgba(58,196,125,.12)}.codex-linux-conversation-muted .codex-linux-conversation-mute:hover{background:rgba(239,68,68,.16)}.codex-linux-conversation-stop:active,.codex-linux-conversation-mute:active{transform:translateY(1px)}.codex-linux-conversation-stop[hidden],.codex-linux-conversation-mute[hidden]{display:none}.codex-linux-conversation-stop svg,.codex-linux-conversation-mute svg{width:18px;height:18px}@media (prefers-reduced-motion:no-preference){.codex-linux-conversation-composer-aura::after{animation:codex-linux-conversation-aura 2.4s ease-in-out infinite}@keyframes codex-linux-conversation-aura{0%,100%{opacity:.55;box-shadow:0 0 14px rgba(34,197,94,.10)}50%{opacity:.95;box-shadow:0 0 24px rgba(56,189,248,.16)}}}";document.head?.appendChild?.(style)}if(!state.stopButton)state.stopButton=document.getElementById("codex-linux-conversation-stop");if(!state.stopButton){let button=document.createElement("button");button.id="codex-linux-conversation-stop";button.type="button";button.className="codex-linux-conversation-stop";button.title="Stop conversation mode";button.setAttribute("aria-label","Stop conversation mode");button.hidden=true;button.innerHTML="<svg aria-hidden=\\"true\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"9\\"></circle><rect x=\\"9\\" y=\\"9\\" width=\\"6\\" height=\\"6\\" rx=\\"1\\" fill=\\"currentColor\\"></rect></svg>";button.addEventListener("click",e=>{e?.preventDefault?.();e?.stopPropagation?.();stopConversation()});document.body.appendChild(button);state.stopButton=button}if(!state.muteButton)state.muteButton=document.getElementById("codex-linux-conversation-mute");if(!state.muteButton){let button=document.createElement("button");button.id="codex-linux-conversation-mute";button.type="button";button.className="codex-linux-conversation-mute";button.hidden=true;button.addEventListener("click",e=>{e?.preventDefault?.();e?.stopPropagation?.();toggleMute()});document.body.appendChild(button);state.muteButton=button}}`,
    `function conversationMuteIcon(muted){return muted?"<svg aria-hidden=\\"true\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 5.12 2.12\\"></path><path d=\\"M15 9.34V6a3 3 0 0 0-4.28-2.71\\"></path><path d=\\"M19 10v2a7 7 0 0 1-.7 3.05\\"></path><path d=\\"M5 10v2a7 7 0 0 0 9.74 6.44\\"></path><line x1=\\"12\\" y1=\\"19\\" x2=\\"12\\" y2=\\"22\\"></line><line x1=\\"4\\" y1=\\"4\\" x2=\\"20\\" y2=\\"20\\"></line></svg>":"<svg aria-hidden=\\"true\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z\\"></path><path d=\\"M19 10v2a7 7 0 0 1-14 0v-2\\"></path><line x1=\\"12\\" y1=\\"19\\" x2=\\"12\\" y2=\\"22\\"></line></svg>"}`,
    `function findComposerAuraTarget(){if(typeof document==="undefined")return null;let anchors=document.querySelectorAll?.("[data-composer-attachments-row],textarea,[contenteditable='true'],[data-above-composer-queue-portal],[data-above-composer-portal]")??[];for(let i=anchors.length-1;i>=0;i--){let anchor=anchors[i],target=anchor.closest?.("form,[data-composer-overlay-floating-ui],[class*='composer']")||anchor.parentElement;if(target&&(!document.body?.contains||document.body.contains(target)))return target}return null}`,
    `function updateControlAnchor(target){if(typeof document==="undefined")return;let style=document.documentElement?.style;if(!style)return;if(!state.active||!target?.getBoundingClientRect){style.removeProperty?.("--codex-linux-conversation-control-right");style.removeProperty?.("--codex-linux-conversation-stop-bottom");style.removeProperty?.("--codex-linux-conversation-mute-bottom");return}let rect=target.getBoundingClientRect(),width=window.innerWidth||document.documentElement?.clientWidth||0,height=window.innerHeight||document.documentElement?.clientHeight||0;if(!width||!height)return;let right=Math.max(12,Math.min(width-50,width-rect.right-48)),maxStopBottom=Math.max(82,Math.min(240,height-96)),stopBottom=Math.max(82,Math.min(maxStopBottom,height-rect.top+8)),muteBottom=Math.min(height-50,stopBottom+46);style.setProperty("--codex-linux-conversation-control-right",right+"px");style.setProperty("--codex-linux-conversation-stop-bottom",stopBottom+"px");style.setProperty("--codex-linux-conversation-mute-bottom",muteBottom+"px")}`,
    `function updateComposerAura(){let previous=state.composerAura;if(!state.active){previous?.classList?.remove?.("codex-linux-conversation-composer-aura");state.composerAura=null;updateControlAnchor(null);return}let target=findComposerAuraTarget();if(previous&&previous!==target)previous.classList?.remove?.("codex-linux-conversation-composer-aura");target?.classList?.add?.("codex-linux-conversation-composer-aura");state.composerAura=target;updateControlAnchor(target)}`,
    `function updateUi(){try{if(typeof document==="undefined")return;if(!document.body){state.active&&setTimeout(updateUi,250);return}installUi();document.documentElement?.classList?.toggle?.("codex-linux-conversation-active",state.active);document.body.classList?.toggle?.("codex-linux-conversation-active",state.active);document.documentElement?.classList?.toggle?.("codex-linux-conversation-muted",state.active&&state.muted);document.body.classList?.toggle?.("codex-linux-conversation-muted",state.active&&state.muted);updateComposerAura();if(state.stopButton)state.stopButton.hidden=!state.active;if(state.muteButton){let label=state.muted?"Unmute microphone":"Mute microphone";state.muteButton.hidden=!state.active;state.muteButton.title=label;state.muteButton.setAttribute("aria-label",label);state.muteButton.setAttribute("aria-pressed",state.muted?"true":"false");state.muteButton.innerHTML=conversationMuteIcon(state.muted)}}catch{}}`,
    `function stopConversation(){if(!state.active)return false;deactivate("discard");return true}`,
    `function cancelInterruptMonitor(){state.interruptSerial++;state.interruptPendingEpoch=0;stopInterruptMonitor()}`,
    `function toggleMute(force){if(!state.active)return false;let muted=typeof force==="boolean"?force:!state.muted;if(muted===state.muted){updateUi();return true}state.muted=muted;state.speechCooldownUntil=0;clearTimeout(state.restartTimer);state.restartTimer=null;if(state.muted){cancelInterruptMonitor();state.listening=false;state.controls?.stopDictation?.("discard")}else if(isResponseInProgress()||state.speaking||state.queue.length>0)startInterruptMonitor();else{state.listening=false;startListeningSoon(0,!0)}updateUi();return true}`,
    `function deactivate(stopAction="insert"){if(!state.active)return;state.active=false;state.muted=false;state.epoch++;state.interruptPendingEpoch=0;clearTimeout(state.restartTimer);state.restartTimer=null;stopSpeech();cancelInterruptMonitor();state.controls?.stopDictation?.(stopAction);state.controls=null;state.activeConversationId=null;state.seenAssistantKeys.clear();state.spokenAssistant.clear();state.spokenAssistantTexts=[];state.cursorSentAtMs=0;resetTranscriptState();resetTurnState();updateUi()}`,
    `function mergeControls(controls){if(controls&&typeof controls==="object")state.controls={...state.controls,...controls}}`,
    `function sync(conversation,controls){if(!state.active)return false;let id=conversationId(conversation);if(id!==state.activeConversationId){deactivate("insert");return false}let was=isResponseInProgress();mergeControls(controls);let now=isResponseInProgress();if(now&&!was){(!state.allowAssistant||state.awaitingUserTranscript)&&stopSpeech(!0);state.awaitingUserTranscript=false;state.allowAssistant=true;state.muted||startInterruptMonitor()}else if(now&&!state.muted)startInterruptMonitor();if(was&&!now){state.finalizing=true;finishAssistantSoon(650)}updateComposerAura();return true}`,
    `function isActive(conversation){return state.active&&conversationId(conversation)===state.activeConversationId}`,
    `function estimateMs(text){let words=text.split(/\\s+/).filter(Boolean).length;return Math.max(2200,Math.min(600000,words*430))}`,
    `function speechSettings(){let quiet=Number(localStorage.getItem("codex-linux-conversation-silence-ms")||1800),threshold=Number(localStorage.getItem("codex-linux-conversation-vad-threshold")||0.01),interrupt=Number(localStorage.getItem("codex-linux-conversation-interrupt-threshold")||0.035);threshold=Number.isFinite(threshold)?Math.min(.2,Math.max(.002,threshold)):.01;let possibleThreshold=Math.max(.002,threshold*.45);interrupt=Number.isFinite(interrupt)?Math.min(.25,Math.max(threshold*1.8,interrupt)):.035;return{quietMs:Number.isFinite(quiet)?Math.min(2000,Math.max(900,quiet)):1800,threshold,possibleThreshold,interruptThreshold:interrupt,speechMs:220,interruptMs:420,interruptGraceMs:180,audioPollMs:32}}`,
    `function micConstraints(){return{audio:{channelCount:1,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0}}}`,
    `function stopTracks(stream){try{stream?.getTracks?.().forEach(e=>e.stop())}catch{}}`,
    `function makeAudioGraph(stream){let ctx=null,source=null,analyser=null;try{ctx=new (window.AudioContext||window.webkitAudioContext)(),source=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser(),analyser.fftSize=512,source.connect(analyser)}catch{try{source?.disconnect?.()}catch{}try{ctx?.close?.()}catch{}return null}let data=new Float32Array(analyser.fftSize);return{level(){analyser.getFloatTimeDomainData(data);let sum=0;for(let i=0;i<data.length;i++)sum+=data[i]*data[i];return Math.sqrt(sum/data.length)},close(){try{source?.disconnect?.()}catch{}try{ctx?.close?.()}catch{}}}}`,
    `function makeMonitor(stream,onSpeech){let graph=makeAudioGraph(stream);if(!graph){stopTracks(stream);return null}let timer=0,closed=false,voicedSince=0,startedAt=performance.now(),{interruptThreshold,interruptMs,interruptGraceMs,audioPollMs}=speechSettings(),finish=()=>{if(closed)return;closed=true,clearTimeout(timer);graph.close()},schedule=()=>{timer=setTimeout(tick,audioPollMs)},tick=()=>{if(closed)return;let now=performance.now();if(now-startedAt<interruptGraceMs){schedule();return}if(graph.level()>interruptThreshold){voicedSince||(voicedSince=now);if(now-voicedSince>=interruptMs){finish();onSpeech();return}}else voicedSince=0;schedule()};schedule();return finish}`,
    `function startInterruptMonitor(){if(!state.active||state.muted||state.listening||state.interruptCleanup||state.interruptPendingEpoch||!navigator.mediaDevices?.getUserMedia)return;let monitorEpoch=state.epoch,monitorSerial=state.interruptSerial;state.interruptPendingEpoch=monitorEpoch;navigator.mediaDevices.getUserMedia(micConstraints()).then(stream=>{state.interruptPendingEpoch===monitorEpoch&&state.interruptSerial===monitorSerial&&(state.interruptPendingEpoch=0);if(monitorEpoch!==state.epoch||monitorSerial!==state.interruptSerial||!state.active||state.muted||state.listening||state.interruptCleanup){stopTracks(stream);return}let cleanup=makeMonitor(stream,()=>{stopTracks(stream);state.interruptCleanup=null;state.awaitingUserTranscript=true;state.allowAssistant=false;stopSpeech(!0);state.controls?.onStop?.();startListeningSoon(0,!0)});if(!cleanup)return;state.interruptCleanup=()=>{cleanup();stopTracks(stream)}}).catch(()=>{state.interruptPendingEpoch===monitorEpoch&&state.interruptSerial===monitorSerial&&(state.interruptPendingEpoch=0)})}`,
    `function stopInterruptMonitor(){state.interruptCleanup?.();state.interruptCleanup=null}`,
    `function rememberSpoken(text){let normalized=normalizeSent(text);if(!normalized)return;state.spokenEchoText=(state.spokenEchoText+" "+normalized).trim().slice(-2400);state.spokenEchoAt=Date.now()}`,
    `function speakNext(epoch=state.epoch){if(epoch!==state.epoch||!state.active||state.speaking)return;let text=state.queue.shift();if(!text&&state.assistantText&&!state.assistantFinalSpoken&&isResponseInProgress())text=takeAssistantTextToSpeak();if(!text){state.speaking=false;state.speechCooldownUntil=Date.now()+1200;if(isResponseInProgress())startInterruptMonitor();else stopInterruptMonitor();return}state.speaking=true;rememberSpoken(text);post({action:"speak",source:"conversation",text},8000).catch(()=>{});startInterruptMonitor();state.speechTimer=setTimeout(()=>{if(epoch!==state.epoch)return;state.speaking=false;speakNext(epoch)},estimateMs(text)+700)}`,
    `function enqueue(text){text=clean(text);if(!text)return;state.queue.push(text);speakNext()}`,
    `function isResponseInProgress(){return state.controls?.isResponseInProgress===!0}`,
    `function assistantSentAtMs(item){let value=Number(item?.sentAtMs??item?.createdAtMs??item?.timestampMs??0);return Number.isFinite(value)&&value>0?value:0}`,
    `function beforeCursor(item){let sentAt=assistantSentAtMs(item);return state.cursorSentAtMs>0&&sentAt>0&&sentAt<state.cursorSentAtMs}`,
    `function assistantKey(item,text,turnKey,liveTurn){let raw=turnKey??item?.turnId??item?.id??item?.itemId??item?.messageId??item?.requestId??item?.callId;if(raw!=null)return"id:"+String(raw);if(state.assistantKey&&state.assistantText&&(text.startsWith(state.assistantText)||state.assistantText.startsWith(text)))return state.assistantKey;if(liveTurn)return state.assistantFallbackKey??="live:"+state.activeConversationId+":"+state.epoch;let normalized=normalizeSent(text);return normalized?"text:"+normalized.length+":"+normalized.slice(0,96)+":"+normalized.slice(-96):null}`,
    `function rememberAssistantKey(key){if(!key)return;if(!state.assistantKeys.includes(key))state.assistantKeys.push(key);let spoken=state.spokenAssistant.get(key);if(spoken&&spoken.length>state.assistantSpokenText.length)state.assistantSpokenText=spoken}`,
    `function beginAssistant(key){state.assistantKey=key;state.assistantKeys=[];state.assistantFinalSpoken=false;state.assistantText="";state.assistantSpokenText="";rememberAssistantKey(key)}`,
    `function trimKnownSpoken(text){let remaining=text,known=[];state.assistantSpokenText&&known.push(state.assistantSpokenText);for(let spoken of state.spokenAssistantTexts)known.push(spoken);for(let spoken of known){spoken=clean(spoken);if(!spoken)continue;if(remaining.startsWith(spoken))remaining=remaining.slice(spoken.length).trim();else if(spoken.startsWith(remaining))return""}return remaining}`,
    `function rememberAssistantText(text){text=clean(text);if(!text)return;for(let known of state.spokenAssistantTexts)if(known===text||known.startsWith(text))return;state.spokenAssistantTexts=state.spokenAssistantTexts.filter(known=>!text.startsWith(known));state.spokenAssistantTexts.push(text);if(state.spokenAssistantTexts.length>16)state.spokenAssistantTexts.shift();for(let key of state.assistantKeys)key&&state.spokenAssistant.set(key,text);while(state.spokenAssistant.size>120)state.spokenAssistant.delete(state.spokenAssistant.keys().next().value)}`,
    `function assistantTextToSpeak(){return trimKnownSpoken(state.assistantText)}`,
    `function takeAssistantTextToSpeak(){let text=assistantTextToSpeak();state.assistantFinalSpoken=true;state.assistantSpokenText=state.assistantText;rememberAssistantText(state.assistantText);return text}`,
    `function speakAssistantText(){let text=takeAssistantTextToSpeak();if(!text)return false;enqueue(text);return true}`,
    `function finishAssistant(epoch=state.epoch){clearTimeout(state.flushTimer);state.flushTimer=null;if(epoch!==state.epoch||!state.active)return;state.finalizing=false;if(state.assistantFinalSpoken||!state.assistantText){startListeningSoon(600);return}if(!speakAssistantText()){startListeningSoon(600);return}clearTimeout(state.restartTimer);let waitEpoch=state.epoch;state.restartTimer=setTimeout(()=>waitForQuietAssistant(waitEpoch),700)}`,
    `function finishAssistantSoon(delay=500){clearTimeout(state.flushTimer);let epoch=state.epoch;state.flushTimer=setTimeout(()=>finishAssistant(epoch),delay)}`,
    `function waitForQuietAssistant(epoch=state.epoch){if(epoch!==state.epoch||!state.active)return;if(!state.speaking&&!isResponseInProgress())startListeningSoon(600);else{isResponseInProgress()&&startInterruptMonitor();state.restartTimer=setTimeout(()=>waitForQuietAssistant(epoch),500)}}`,
    `function assistant(item,copyText,cid,turnKey,turnInProgress){if(!state.active||state.awaitingUserTranscript)return null;let id=conversationId(cid);if(id)state.lastConversationId=id;if(id!==state.activeConversationId){deactivate("insert");return null}let text=clean(copyText||item?.content||"");if(!text)return null;let responding=isResponseInProgress(),liveTurn=turnInProgress===!0,key=assistantKey(item,text,turnKey,liveTurn||responding),completed=item?.completed===!0,finalTurn=!liveTurn||completed,seen=key&&state.seenAssistantKeys.has(key),sameAssistant=state.assistantText&&(text.startsWith(state.assistantText)||state.assistantText.startsWith(text)),canObserve=state.allowAssistant||responding||state.finalizing||state.assistantKey!=null;if(beforeCursor(item)){key&&state.seenAssistantKeys.add(key);return null}if(!canObserve){key&&state.seenAssistantKeys.add(key);return null}if(seen&&completed&&key!==state.assistantKey){key&&state.seenAssistantKeys.add(key);return null}if(!state.assistantKey){if(!liveTurn&&!responding&&!state.finalizing&&!state.allowAssistant){key&&state.seenAssistantKeys.add(key);return null}beginAssistant(key)}else if(key&&key!==state.assistantKey&&!sameAssistant){if(responding&&completed&&!liveTurn&&!state.assistantFinalSpoken){state.seenAssistantKeys.add(key);return null}if(!responding&&!liveTurn&&!state.finalizing&&(!state.allowAssistant||completed||seen)){state.seenAssistantKeys.add(key);return null}beginAssistant(key)}rememberAssistantKey(key);key&&state.seenAssistantKeys.add(key);if(text!==state.assistantText){state.assistantText=text;state.assistantFinalSpoken=state.assistantSpokenText===state.assistantText;if(liveTurn&&!completed){clearTimeout(state.restartTimer);return null}}else if(liveTurn&&!completed)return null;if(responding&&completed&&!liveTurn&&state.speaking)return null;if(!finalTurn||state.assistantFinalSpoken)return null;if(state.finalizing&&!responding){finishAssistantSoon(250);return null}if(!speakAssistantText())return null;if(responding)startInterruptMonitor();else{clearTimeout(state.restartTimer);let epoch=state.epoch;state.restartTimer=setTimeout(()=>waitForQuietAssistant(epoch),700)}return null}`,
    `function startListeningSoon(delay=250,force=false){clearTimeout(state.restartTimer);if(!state.active||state.muted||state.listening||state.transcribing||(!force&&isResponseInProgress()))return;let wait=Math.max(delay,state.speechCooldownUntil-Date.now());let epoch=state.epoch;state.restartTimer=setTimeout(()=>{if(epoch!==state.epoch||!state.active||state.muted||state.listening||state.transcribing||(!force&&isResponseInProgress())||Date.now()<state.speechCooldownUntil)return;stopInterruptMonitor();state.controls?.startDictation?.()},wait)}`,
    `function toggle(controls){if(!available())return false;let id=conversationId(controls?.conversationId);if(!id)return false;if(state.active){deactivate("discard");return true}state.controls=controls;state.active=true;state.muted=false;state.activeConversationId=id;state.epoch++;state.awaitingUserTranscript=controls?.isResponseInProgress===!0;state.allowAssistant=false;state.seenAssistantKeys.clear();state.spokenAssistant.clear();state.spokenAssistantTexts=[];state.cursorSentAtMs=0;resetTranscriptState();resetTurnState();stopSpeech();updateUi();if(controls?.isResponseInProgress)controls.onStop?.();startListeningSoon(0,!0);return true}`,
    `function endpoint({stream,stop,isActive}){if(!state.active||state.muted)return null;state.listening=true;let graph=makeAudioGraph(stream);if(!graph){state.listening=false;stopTracks(stream);return()=>{}}let sawSpeech=false,lastSpeech=0,voicedSince=0,{quietMs,threshold,possibleThreshold,speechMs,audioPollMs}=speechSettings(),timer=0,done=false,finish=()=>{if(done)return;done=true;clearTimeout(timer);graph.close();state.listening=false},schedule=()=>{timer=setTimeout(tick,audioPollMs)},tick=()=>{if(done)return;if(!state.active||state.muted||!isActive?.()){finish();return}let now=performance.now(),level=graph.level(),voiced=level>threshold,possible=level>possibleThreshold;if(voiced){voicedSince||(voicedSince=now);if(now-voicedSince>=speechMs){sawSpeech||stopSpeech(!0);sawSpeech=!0;lastSpeech=now;stopInterruptMonitor()}}else if(sawSpeech&&possible){lastSpeech=now;voicedSince=0}else voicedSince=0;if(sawSpeech&&now-lastSpeech>=quietMs){finish();stop?.();return}schedule()};schedule();return finish}`,
    `function normalizeSent(text){return clean(text).toLowerCase().replace(/\\s+/g," ").trim()}`,
    `function tokenSimilarity(a,b){let A=[...new Set(a.split(/\\s+/).filter(e=>e.length>2))],B=new Set(b.split(/\\s+/).filter(e=>e.length>2));if(A.length<4||B.size<4)return false;let hits=0;for(let word of A)B.has(word)&&hits++;return hits/Math.min(A.length,B.size)>=.72}`,
    `function isLikelySpeechEcho(normalized){if(!normalized||Date.now()-state.spokenEchoAt>45e3)return false;let echo=state.spokenEchoText;if(!echo)return false;return normalized.length>=16&&(echo.includes(normalized)||normalized.includes(echo)||tokenSimilarity(normalized,echo))}`,
    `function shouldSendTranscript(text,action){if(!state.active||action!==\`send\`)return true;if(state.muted)return false;let normalized=normalizeSent(text);if(!normalized)return false;let now=Date.now();if(normalized===state.lastSentText&&now-state.lastSentAt<3e4)return false;if(isLikelySpeechEcho(normalized)){state.epoch++;state.awaitingUserTranscript=false;state.allowAssistant=false;resetSpeechState();resetTurnState();startListeningSoon(900,!0);return false}stopSpeech(!0);state.awaitingUserTranscript=false;state.allowAssistant=true;state.spokenAssistant.clear();state.spokenAssistantTexts=[];state.cursorSentAtMs=now-1500;state.lastSentText=normalized;state.lastSentAt=now;return true}`,
    `globalThis.codexLinuxConversationAvailable=available;globalThis.codexLinuxConversationToggle=toggle;globalThis.codexLinuxConversationToggleMute=toggleMute;globalThis.codexLinuxConversationSync=sync;globalThis.codexLinuxConversationIsActive=isActive;globalThis.codexLinuxConversationStop=stopConversation;globalThis.codexLinuxConversationIsSpeaking=isSpeaking;globalThis.codexLinuxConversationStopSpeaking=stopSpeaking;globalThis.codexLinuxConversationEndpoint=endpoint;globalThis.codexLinuxConversationAssistant=assistant;globalThis.codexLinuxConversationShouldSendTranscript=shouldSendTranscript;})();`,
  ].join("");
}

function applyComposerRuntimePatch(source) {
  if (source.includes(RUNTIME_VERSION)) {
    return source;
  }
  return `${source}\n${conversationRuntimeSource()}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const JS_IDENT = "[A-Za-z_$][\\w$]*";

function objectPropVar(objectSource, name, fallback) {
  return objectSource.match(new RegExp(`(?:^|,)\\s*${escapeRegExp(name)}:(${JS_IDENT})(?:,|$)`))?.[1] ?? fallback;
}

function currentComposerBinding(source) {
  const propsPattern = new RegExp(`\\{([^{}]*voiceControls:${JS_IDENT}[^{}]*)\\}\\s*=\\s*${JS_IDENT}`, "g");
  for (const propsMatch of source.matchAll(propsPattern)) {
    const propsObject = propsMatch[1];
    const voiceControlsVar = objectPropVar(propsObject, "voiceControls", null);
    if (voiceControlsVar == null) {
      continue;
    }
    const requiredProps = ["conversationId", "isResponseInProgress", "onStop", "submitBlockReason"];
    if (!requiredProps.every((name) => objectPropVar(propsObject, name, null) != null)) {
      continue;
    }
    const voiceControlsPattern = new RegExp(
      `\\{([^{}]*startDictation:[^{}]*stopDictation:[^{}]*threadRealtime:[^{}]*)\\}\\s*=\\s*${escapeRegExp(voiceControlsVar)}`,
      "g",
    );
    voiceControlsPattern.lastIndex = propsMatch.index + propsMatch[0].length;
    const voiceControlsMatch = voiceControlsPattern.exec(source);
    if (voiceControlsMatch != null) {
      return { propsObject, voiceControlsObject: voiceControlsMatch[1], voiceControlsVar };
    }
  }
  return null;
}

function voiceControlsObjectVar(source) {
  const currentBinding = currentComposerBinding(source);
  if (currentBinding != null) {
    return currentBinding.voiceControlsVar;
  }
  return source.match(/voiceControls:([A-Za-z_$][\w$]*)/)?.[1] ?? "z";
}

function voiceControlVar(source, name, fallback) {
  const currentBinding = currentComposerBinding(source);
  if (currentBinding != null) {
    return objectPropVar(currentBinding.voiceControlsObject, name, fallback);
  }
  const voiceControlsVar = voiceControlsObjectVar(source);
  const match = source.match(
    new RegExp(`\\{([^{}]*startDictation:[^{}]*stopDictation:[^{}]*threadRealtime:[^{}]*)\\}=${escapeRegExp(voiceControlsVar)}`),
  );
  if (!match) {
    return fallback;
  }
  return objectPropVar(match[1], name, fallback);
}

function composerPropVar(source, name, fallback) {
  const currentBinding = currentComposerBinding(source);
  if (currentBinding == null) {
    return fallback;
  }
  return objectPropVar(currentBinding.propsObject, name, fallback);
}

function isLegacyComposerControlShape(source) {
  return (
    new RegExp(`\\{\\s*voiceControls:${JS_IDENT}\\s*\\}\\s*=\\s*${JS_IDENT}`).test(source) &&
    source.includes("F===`empty-message`&&!A") &&
    source.includes("ue.isAvailable&&ue.phase!==`active`")
  );
}

function composerPropVars(source) {
  if (currentComposerBinding(source) == null && !isLegacyComposerControlShape(source)) {
    return null;
  }
  return {
    conversationId: composerPropVar(source, "conversationId", "v"),
    isResponseInProgress: composerPropVar(source, "isResponseInProgress", "A"),
    onStop: composerPropVar(source, "onStop", "P"),
    submitBlockReason: composerPropVar(source, "submitBlockReason", "F"),
  };
}

function composerVoiceVars(source) {
  const startRealtimeConversation = voiceControlVar(source, "startRealtimeConversation", null);
  return {
    isDictating: voiceControlVar(source, "isDictating", "J"),
    isDictationSupported: voiceControlVar(source, "isDictationSupported", "q"),
    isTranscribing: voiceControlVar(source, "isTranscribing", "re"),
    isNewRealtimeConversationAvailable: voiceControlVar(source, "isNewRealtimeConversationAvailable", "J"),
    startDictation: voiceControlVar(source, "startDictation", "se"),
    startRealtimeConversation: startRealtimeConversation ?? "ce",
    startNewRealtimeConversation: voiceControlVar(
      source,
      "startNewRealtimeConversation",
      startRealtimeConversation ?? "ce",
    ),
    stopDictation: voiceControlVar(source, "stopDictation", "le"),
    threadRealtime: voiceControlVar(source, "threadRealtime", "ue"),
  };
}

function composerSyncPayload(vars, props) {
  return [
    `isResponseInProgress:${props.isResponseInProgress}`,
    `isDictating:${vars.isDictating}`,
    `isTranscribing:${vars.isTranscribing}`,
    `startDictation:${vars.startDictation}`,
    `stopDictation:${vars.stopDictation}`,
    `onStop:${props.onStop}`,
  ].join(",");
}

function composerTogglePayload(vars, props) {
  return [
    `conversationId:${props.conversationId}`,
    `startDictation:${vars.startDictation}`,
    `stopDictation:${vars.stopDictation}`,
    `onStop:${props.onStop}`,
    `isDictating:${vars.isDictating}`,
    `isTranscribing:${vars.isTranscribing}`,
    `isResponseInProgress:${props.isResponseInProgress}`,
    `isDictationSupported:${vars.isDictationSupported}`,
  ].join(",");
}

function applyComposerControlPatch(source) {
  let patched = source;
  const vars = composerVoiceVars(patched);
  const props = composerPropVars(patched);
  if (props == null) {
    warn("Could not resolve composer prop aliases", "conversation mode composer control patch");
  } else {
    const visiblePattern = new RegExp(
      `let (${JS_IDENT})=(${JS_IDENT}),(${JS_IDENT})=${escapeRegExp(props.submitBlockReason)}` +
        '===`empty-message`' +
        `&&!${escapeRegExp(props.isResponseInProgress)}&&\\((?:(${JS_IDENT})&&)?` +
        `${escapeRegExp(vars.threadRealtime)}\\.isAvailable&&${escapeRegExp(vars.threadRealtime)}\\.phase!==` +
        '`active`' +
        `\\|\\|(${JS_IDENT})\\),(${JS_IDENT})=(${JS_IDENT})\\((${JS_IDENT}),` +
        '`composer\\.startVoiceMode`' +
        "\\)",
    );
    const visibleMatch = patched.match(visiblePattern);
    if (visibleMatch && !patched.includes(`codexLinuxConversationSync?.(${props.conversationId}`)) {
      const labelVar = visibleMatch[1];
      const labelSrc = visibleMatch[2];
      const visVar = visibleMatch[3];
      const existingRealtimeAvailable = visibleMatch[4] == null ? "" : `${visibleMatch[4]}&&`;
      const realtimeAvailable = visibleMatch[5] || vars.isNewRealtimeConversationAvailable;
      const shortcutResultVar = visibleMatch[6];
      const shortcutFn = visibleMatch[7];
      const shortcutArg = visibleMatch[8];
      patched = patched.replace(
        visiblePattern,
        `let ${labelVar}=${labelSrc};globalThis.codexLinuxConversationSync?.(${props.conversationId},{${composerSyncPayload(vars, props)}});let codexLinuxConversationActive=globalThis.codexLinuxConversationIsActive?.(${props.conversationId})===!0,${visVar}=codexLinuxConversationActive||${props.submitBlockReason}===\`empty-message\`&&!${props.isResponseInProgress}&&((${props.conversationId}&&globalThis.codexLinuxConversationAvailable?.())||${existingRealtimeAvailable}${vars.threadRealtime}.isAvailable&&${vars.threadRealtime}.phase!==\`active\`||${realtimeAvailable}),${shortcutResultVar}=${shortcutFn}(${shortcutArg},\`composer.startVoiceMode\`)`,
      );
    } else if (!patched.includes(`codexLinuxConversationSync?.(${props.conversationId}`)) {
      warn("Could not find composer voice button visibility gate", "conversation mode composer control patch");
    }
  }

  const threadRealtime = escapeRegExp(vars.threadRealtime);
  const startNewRealtimeConversation = escapeRegExp(vars.startNewRealtimeConversation);
  const legacyClickPattern = new RegExp(
    `([A-Za-z_$][\\w$]*)=\\(\\)=>\\{if\\(${threadRealtime}\\.phase===\`starting\`\\|\\|${threadRealtime}\\.phase===\`active\`\\)\\{${threadRealtime}\\.stopRealtime\\(\\);return\\}if\\(${threadRealtime}\\.isAvailable\\)\\{${threadRealtime}\\.phase===\`inactive\`&&${threadRealtime}\\.startRealtime\\(\`composer_button_existing_thread\`\\);return\\}${startNewRealtimeConversation}\\(\\)\\}`,
  );
  const currentStartRealtimeConversation = escapeRegExp(vars.startRealtimeConversation);
  const currentClickPattern = new RegExp(
    `([A-Za-z_$][\\w$]*)=\\(\\)=>\\{if\\(${threadRealtime}\\.phase===\`starting\`\\|\\|${threadRealtime}\\.phase===\`active\`\\)\\{${threadRealtime}\\.stopRealtime\\(\\);return\\}if\\(${threadRealtime}\\.isAvailable\\)\\{${threadRealtime}\\.phase===\`inactive\`&&${currentStartRealtimeConversation}\\(\\);return\\}${currentStartRealtimeConversation}\\(\\)\\}`,
  );
  const anyTogglePattern = new RegExp(
    `codexLinuxConversationToggle\\?\\.\\(\\{conversationId:${JS_IDENT},startDictation:${JS_IDENT},stopDictation:${JS_IDENT},onStop:${JS_IDENT},isDictating:${JS_IDENT},isTranscribing:${JS_IDENT},isResponseInProgress:${JS_IDENT},isDictationSupported:${JS_IDENT}\\}\\)`,
  );
  if (props != null) {
    const togglePattern = new RegExp(
      `codexLinuxConversationToggle\\?\\.\\(\\{conversationId:${escapeRegExp(props.conversationId)},startDictation:${JS_IDENT},stopDictation:${JS_IDENT},onStop:${escapeRegExp(props.onStop)},isDictating:${JS_IDENT},isTranscribing:${JS_IDENT},isResponseInProgress:${escapeRegExp(props.isResponseInProgress)},isDictationSupported:${JS_IDENT}\\}\\)`,
    );
    const toggleCall = `codexLinuxConversationToggle?.({${composerTogglePayload(vars, props)}})`;
    if (legacyClickPattern.test(patched)) {
      patched = patched.replace(
        legacyClickPattern,
        `$1=()=>{if(globalThis.${toggleCall})return;if(${vars.threadRealtime}.phase===\`starting\`||${vars.threadRealtime}.phase===\`active\`){${vars.threadRealtime}.stopRealtime();return}if(${vars.threadRealtime}.isAvailable){${vars.threadRealtime}.phase===\`inactive\`&&${vars.threadRealtime}.startRealtime(\`composer_button_existing_thread\`);return}${vars.startNewRealtimeConversation}()}`,
      );
    } else if (currentClickPattern.test(patched)) {
      patched = patched.replace(
        currentClickPattern,
        `$1=()=>{if(globalThis.${toggleCall})return;if(${vars.threadRealtime}.phase===\`starting\`||${vars.threadRealtime}.phase===\`active\`){${vars.threadRealtime}.stopRealtime();return}if(${vars.threadRealtime}.isAvailable){${vars.threadRealtime}.phase===\`inactive\`&&${vars.startRealtimeConversation}();return}${vars.startRealtimeConversation}()}`,
      );
    } else if (togglePattern.test(patched)) {
      patched = patched.replace(togglePattern, toggleCall);
    } else if (anyTogglePattern.test(patched)) {
      patched = patched.replace(anyTogglePattern, toggleCall);
    } else if (!patched.includes("codexLinuxConversationToggle")) {
      warn("Could not find composer voice button click handler", "conversation mode composer control patch");
    }
  } else if (!patched.includes("codexLinuxConversationToggle")) {
    warn("Could not find composer voice button click handler", "conversation mode composer control patch");
  }

  if (patched.includes("codexLinuxConversationActive=globalThis.codexLinuxConversationIsActive")) {
    patched = patched
      .replace(
        /defaultMessage:`(?:Start realtime voice|Start conversation mode)`/g,
        "defaultMessage:codexLinuxConversationActive?`Stop conversation mode`:`Start conversation mode`",
      )
      .replace(
        /defaultMessage:`(?:Start realtime voice mode|Start conversation mode) in the composer`/g,
        "defaultMessage:codexLinuxConversationActive?`Stop conversation mode in the composer`:`Start conversation mode in the composer`",
      );
  } else {
    patched = patched
      .replace(/defaultMessage:`Start realtime voice`/g, "defaultMessage:`Start conversation mode`")
      .replace(/defaultMessage:`Start realtime voice mode in the composer`/g, "defaultMessage:`Start conversation mode in the composer`");
  }

  return patched;
}

function applyDictationEndpointPatch(source) {
  if (
    !source.includes("global-dictation-record-history-item") &&
    !source.includes("navigator.mediaDevices.getUserMedia({audio:{channelCount:1}})") &&
    !source.includes("new MediaRecorder")
  ) {
    return source;
  }

  let patched = source;
  const getUserMediaNeedle = "navigator.mediaDevices.getUserMedia({audio:{channelCount:1}})";
  if (patched.includes(getUserMediaNeedle)) {
    patched = patched.replace(
      getUserMediaNeedle,
      "navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0}})",
    );
  } else {
    const currentMicConstraintsPattern =
      /([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(\{channelCount:1\}\)/u;
    if (currentMicConstraintsPattern.test(patched)) {
      patched = patched.replace(
        currentMicConstraintsPattern,
        "$1=await $2({channelCount:1,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0})",
      );
    }
  }

  const cleanupNeedle = "r&&(r.ondataavailable=null,r.onstop=null),m.current=null,D();";
  if (!patched.includes("codexLinuxConversationCleanup?.()") && patched.includes(cleanupNeedle)) {
    patched = patched.replace(
      cleanupNeedle,
      "r?.codexLinuxConversationCleanup?.(),r&&(r.ondataavailable=null,r.onstop=null),m.current=null,D();",
    );
  } else if (!patched.includes("codexLinuxConversationCleanup")) {
    const currentCleanupPattern =
      /([A-Za-z_$][\w$]*)&&\(\1\.ondataavailable=null,\1\.onstop=null\),([A-Za-z_$][\w$]*)\.current=null,([A-Za-z_$][\w$]*)\(\);/u;
    if (currentCleanupPattern.test(patched)) {
      patched = patched.replace(
        currentCleanupPattern,
        "$1?.codexLinuxConversationCleanup?.(),$1&&($1.ondataavailable=null,$1.onstop=null),$2.current=null,$3();",
      );
    } else {
      warn("Could not find dictation cleanup point", "conversation mode dictation endpoint patch");
    }
  }

  const recorderNeedle =
    "t.ondataavailable=e=>{e.data.size>0&&g.current.push(e.data)},t.onstop=()=>{A()},t.start(),l(!0)";
  if (!patched.includes("codexLinuxConversationEndpoint?.(") && patched.includes(recorderNeedle)) {
    patched = patched.replace(
      recorderNeedle,
      "t.ondataavailable=e=>{e.data.size>0&&g.current.push(e.data)},t.onstop=()=>{A()},t.codexLinuxConversationCleanup=globalThis.codexLinuxConversationEndpoint?.({stream:e,stop:()=>a(`send`),isActive:()=>m.current===t&&t.state!==`inactive`}),t.start(),l(!0)",
    );
  } else if (!patched.includes("codexLinuxConversationEndpoint")) {
    const currentActionRef = patched.match(/let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.current\?\?`insert`/)?.[1] ?? "w";
    const currentRecorderPattern =
      /let ([A-Za-z_$][\w$]*)=new MediaRecorder\(([A-Za-z_$][\w$]*)\);if\(([A-Za-z_$][\w$]*)\.current=\1,([A-Za-z_$][\w$]*)\.current=\[\],\1\.ondataavailable=([A-Za-z_$][\w$]*)=>\{\5\.data\.size>0&&\4\.current\.push\(\5\.data\)\},\1\.onstop=\(\)=>\{([A-Za-z_$][\w$]*)\(\)\},\1\.start\(\),([A-Za-z_$][\w$]*)\(!0\)/u;
    if (currentRecorderPattern.test(patched)) {
      patched = patched.replace(
        currentRecorderPattern,
        (_needle, recorderVar, streamVar, recorderRefVar, chunksRefVar, dataVar, finishFn, activeSetterVar) =>
          `let ${recorderVar}=new MediaRecorder(${streamVar});if(${recorderRefVar}.current=${recorderVar},${chunksRefVar}.current=[],${recorderVar}.ondataavailable=${dataVar}=>{${dataVar}.data.size>0&&${chunksRefVar}.current.push(${dataVar}.data)},${recorderVar}.onstop=()=>{${finishFn}()},${recorderVar}.codexLinuxConversationCleanup=globalThis.codexLinuxConversationEndpoint?.({stream:${streamVar},stop:()=>{${currentActionRef}.current=\`send\`;${recorderVar}.state!==\`inactive\`&&${recorderVar}.stop()},isActive:()=>${recorderRefVar}.current===${recorderVar}&&${recorderVar}.state!==\`inactive\`}),${recorderVar}.start(),${activeSetterVar}(!0)`,
      );
    } else {
      warn("Could not find dictation recorder start point", "conversation mode dictation endpoint patch");
    }
  }

  const globalStopNeedle = "p.current!==e.sessionId||(p.current=null,o(`insert`))";
  if (!patched.includes("e.action===`discard`?`discard`") && patched.includes(globalStopNeedle)) {
    patched = patched.replace(
      globalStopNeedle,
      "p.current!==e.sessionId||(p.current=null,o(e.action===`discard`?`discard`:e.action===`send`?`send`:`insert`))",
    );
  }

  const transcriptSendNeedle =
    "i.length>0&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))";
  if (!patched.includes("codexLinuxConversationShouldSendTranscript") && patched.includes(transcriptSendNeedle)) {
    patched = patched.replace(
      transcriptSendNeedle,
      "i.length>0&&e!==`discard`&&globalThis.codexLinuxConversationShouldSendTranscript?.(i,e)!==!1&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))",
    );
  } else if (!patched.includes("codexLinuxConversationShouldSendTranscript")) {
    const currentTranscriptPattern =
      /([A-Za-z_$][\w$]*)\.length>0&&\(([A-Za-z_$][\w$]*)\.getInstance\(\)\.dispatchMessage\(`global-dictation-record-history-item`,\{text:\1\}\),([A-Za-z_$][\w$]*)===`send`\?([A-Za-z_$][\w$]*)\.onTranscriptSend\(\1\):\4\.onTranscriptInsert\(\1\)\)/u;
    if (currentTranscriptPattern.test(patched)) {
      patched = patched.replace(
        currentTranscriptPattern,
        "$1.length>0&&$3!==`discard`&&globalThis.codexLinuxConversationShouldSendTranscript?.($1,$3)!==!1&&($2.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:$1}),$3===`send`?$4.onTranscriptSend($1):$4.onTranscriptInsert($1))",
      );
    } else {
      warn("Could not find dictation transcript send point", "conversation mode transcript dedupe patch");
    }
  }

  return patched;
}

function propVar(match, name) {
  const re = new RegExp(`${name}:([A-Za-z_$][\\w$]*)`);
  return match.match(re)?.[1] ?? "null";
}

function readAssistantObserveSource(itemVar, copyVar, conversationVar, turnVar) {
  return `globalThis.codexLinuxConversationAssistant?.(${itemVar},${copyVar},${conversationVar},${turnVar},typeof c!="undefined"?c:null)??null`;
}

function applyAssistantRenderPatch(source) {
  if (source.includes("codexLinuxConversationAssistant?.(")) {
    return source;
  }
  const jsxCallPattern =
    /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{item:([A-Za-z_$][\w$]*),([^{}]*?)assistantCopyText:([A-Za-z_$][\w$]*),([^{}]*?)conversationId:([A-Za-z_$][\w$]*),[^{}]*?\}\)/g;
  const patched = source.replace(
    jsxCallPattern,
    (match, jsxVar, _component, itemVar, _beforeCopy, copyVar, _beforeConversation, conversationVar) =>
      `(0,${jsxVar}.jsxs)(${jsxVar}.Fragment,{children:[${match},${readAssistantObserveSource(itemVar, copyVar, conversationVar, propVar(match, "turnId"))}]})`,
  );
  if (patched !== source) {
    return patched;
  }
  if (source.includes("assistantCopyText")) {
    warn("Could not find assistant message render call", "conversation mode assistant observer patch");
  }
  return source;
}

function applyComposerPatch(source) {
  if (!source.includes("composer.startVoiceMode") || !source.includes("voiceControls")) {
    return source;
  }
  return applyComposerRuntimePatch(applyComposerControlPatch(source));
}

module.exports = {
  applyAssistantRenderPatch,
  applyComposerControlPatch,
  applyComposerPatch,
  applyComposerRuntimePatch,
  applyDictationEndpointPatch,
  applyReadAloudMainBundlePatch,
  descriptors: [
    {
      id: "read-aloud-conversation-source",
      phase: "main-bundle",
      order: 20680,
      ciPolicy: "optional",
      apply: applyReadAloudMainBundlePatch,
    },
    {
      id: "dictation-endpoint",
      phase: "webview-asset",
      order: 20690,
      ciPolicy: "optional",
      pattern:
        /^(?:(?:browser-sidebar-comment-light-dismiss|use-dictation(?!-hotkey))-|app-initial~app-main~.*onboarding-page).*\.js$/,
      missingDescription: "composer dictation bundle",
      skipDescription: "conversation mode dictation endpoint patch",
      apply: applyDictationEndpointPatch,
    },
    {
      id: "composer-control",
      phase: "webview-asset",
      order: 20700,
      ciPolicy: "optional",
      pattern: /^composer-(?!atoms-).*\.js$/,
      missingDescription: "composer bundle",
      skipDescription: "conversation mode composer control patch",
      apply: applyComposerPatch,
    },
    {
      id: "assistant-observer",
      phase: "webview-asset",
      order: 20710,
      ciPolicy: "optional",
      pattern: /^(index|local-conversation-thread|local-conversation-turn)-.*\.js$/,
      missingDescription: "conversation thread bundle",
      skipDescription: "conversation mode assistant observer patch",
      apply: applyAssistantRenderPatch,
    },
  ],
};
