"use strict";

const { mainBundlePatch } = require("../../descriptor.js");
const { escapeRegExp, findMatchingBrace } = require("../../lib/minified-js.js");

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const QUIT_STATE_METHOD = "canQuitWithoutPrompt(){return this.allowQuitWithoutPrompt}";
const QUIT_APPROVAL_METHOD = "markQuitApproved(){this.allowQuitWithoutPrompt=!0}";
const LIFECYCLE_HEADER = new RegExp(
  String.raw`function\(\{isWindows:${IDENTIFIER},quitState:(?<quitState>${IDENTIFIER}),` +
    String.raw`windows:(?<windows>${IDENTIFIER}),applicationMenuManager:${IDENTIFIER},` +
    String.raw`ensureWindow:${IDENTIFIER},hotkeyWindowLifecycleManager:${IDENTIFIER},` +
    String.raw`globalDictationLifecycleManager:${IDENTIFIER},globalState:${IDENTIFIER},` +
    String.raw`settingsStore:${IDENTIFIER},stopCodexMicro:${IDENTIFIER},` +
    String.raw`flushTracingBeforeQuit:${IDENTIFIER},flushAndDisposeContext:${IDENTIFIER},` +
    String.raw`disposables:${IDENTIFIER},appEvent:${IDENTIFIER},onAppEntrySource:${IDENTIFIER},` +
    String.raw`canAttributeAppReactivation:${IDENTIFIER}\}\)\{`,
  "gu",
);

function allMatches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function findQuitLifecycleContract(source) {
  if (source.split(QUIT_STATE_METHOD).length !== 2 ||
      source.split(QUIT_APPROVAL_METHOD).length !== 2) {
    return null;
  }

  const owners = allMatches(source, LIFECYCLE_HEADER);
  if (owners.length !== 1) return null;
  const [owner] = owners;
  const ownerOpen = owner.index + owner[0].length - 1;
  const ownerClose = findMatchingBrace(source, ownerOpen);
  if (ownerClose < 0) return null;
  const ownerBody = source.slice(ownerOpen, ownerClose + 1);

  const beforeQuitPattern = new RegExp(
    String.raw`${IDENTIFIER}\.app\.on\("before-quit",(?<event>${IDENTIFIER})=>\{`,
    "gu",
  );
  const beforeQuitHandlers = allMatches(ownerBody, beforeQuitPattern);
  if (beforeQuitHandlers.length !== 1) return null;
  const [beforeQuit] = beforeQuitHandlers;
  const handlerOpenInOwner = beforeQuit.index + beforeQuit[0].length - 1;
  const handlerCloseInOwner = findMatchingBrace(ownerBody, handlerOpenInOwner);
  if (handlerCloseInOwner < 0) return null;
  const handlerBody = ownerBody.slice(handlerOpenInOwner, handlerCloseInOwner + 1);

  const { event } = beforeQuit.groups;
  const { quitState, windows } = owner.groups;
  const acceptedPattern = new RegExp(
    String.raw`(?<quitting>${IDENTIFIER})=!0,${escapeRegExp(windows)}` +
      String.raw`\.markAppQuitting\(\)\):${escapeRegExp(event)}\.preventDefault\(\)`,
    "gu",
  );
  const accepted = allMatches(handlerBody, acceptedPattern);
  if (accepted.length !== 1) return null;
  const [acceptedMatch] = accepted;
  const acceptedAction = `${acceptedMatch.groups.quitting}=!0,${windows}.markAppQuitting()`;
  const approvalBranch =
    `${quitState}.canQuitWithoutPrompt()?(${acceptedAction}):${event}.preventDefault()`;
  const approvalCount = handlerBody.split(approvalBranch).length - 1;
  if (approvalCount > 1 ||
      (approvalCount === 0 && handlerBody.includes(`${quitState}.canQuitWithoutPrompt()`))) {
    return null;
  }

  const handlerStart = ownerOpen + handlerOpenInOwner;
  return {
    acceptedAction,
    acceptedMatch,
    approvalBranch,
    approvalConsumed: approvalCount === 1,
    event,
    handlerBody,
    handlerStart,
    quitState,
    windows,
  };
}

function applyQuitConfirmationFocusPatch(source) {
  const contract = findQuitLifecycleContract(source);
  if (contract == null) {
    console.warn(
      "WARN: Could not uniquely prove the current quit-state before-quit owner - " +
      "skipping quit confirmation focus patch",
    );
    return source;
  }
  if (contract.approvalConsumed) return source;

  const original = contract.acceptedMatch[0];
  const replacement =
    `${contract.acceptedAction}):${contract.approvalBranch}`;
  const patchedHandler = contract.handlerBody.replace(original, replacement);
  if (patchedHandler === contract.handlerBody ||
      patchedHandler.split(contract.approvalBranch).length !== 2) {
    console.warn(
      "WARN: Could not uniquely wire the current quit approval into before-quit - " +
      "skipping quit confirmation focus patch",
    );
    return source;
  }
  return source.slice(0, contract.handlerStart) + patchedHandler +
    source.slice(contract.handlerStart + contract.handlerBody.length);
}

const descriptors = [mainBundlePatch({
  id: "quit-confirmation-focus",
  order: 100,
  ciPolicy: "required-upstream",
  apply: applyQuitConfirmationFocusPatch,
})];

module.exports = {
  applyQuitConfirmationFocusPatch,
  descriptors,
  findQuitLifecycleContract,
};
