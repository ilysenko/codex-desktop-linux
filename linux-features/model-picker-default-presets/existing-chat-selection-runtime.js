"use strict";

// Serialized into the qualified settings factory. Native pending/writing atoms,
// targets, RPCs and queue remain owned by the application. This state only keeps
// a successful configured choice visible until actual thread metadata agrees.
function createExistingChatSelectionRuntime(presetIds, effortAliases) {
  const configured = new Set(presetIds);
  const efforts = new Map(effortAliases);
  const stores = new WeakMap();
  const identityFields = ["store", "pendingAtom", "writingAtom", "targetKey",
    "hostId", "conversationId", "profile", "authIdentity", "chatGpt",
    "hasConversation", "ready"];

  function state(store) {
    let value = stores.get(store);
    if (value == null) {
      value = { latest: new Map(), writing: new WeakMap(), retired: new Set() };
      stores.set(store, value);
    }
    return value;
  }
  function sameIdentity(left, right) {
    return left != null && right != null &&
      identityFields.every(field => left[field] === right[field]);
  }
  function current(ticket) {
    return ticket != null && !ticket.cancelled && ticket.lease.active &&
      ticket.generation === ticket.lease.generation &&
      sameIdentity(ticket.context, ticket.lease.context) &&
      state(ticket.context.store).latest.get(ticket.key) === ticket;
  }
  function eligible(ticket) {
    const context = ticket.context, selection = ticket.selection;
    return context.chatGpt === true && context.hasConversation === true &&
      context.ready === true && ticket.target[0] === "conversation" &&
      ticket.target[1] === context.conversationId &&
      ticket.key === context.targetKey &&
      configured.has(`${selection.model}:${selection.reasoningEffort}`);
  }
  function acknowledged(ticket) {
    const context = ticket.lease.context;
    // metadataModel/metadataEffort are the native thread-derived eK/eH roles,
    // never the effective settings that can fall back to account defaults.
    if (current(ticket) && context.metadataModel != null &&
        context.metadataModel === ticket.selection.model &&
        (efforts.get(context.metadataEffort) ?? context.metadataEffort) ===
          (efforts.get(ticket.selection.reasoningEffort) ?? ticket.selection.reasoningEffort)) {
      ticket.acknowledged = true;
    }
    return ticket.acknowledged;
  }
  function forget(ticket) {
    if (ticket.context == null) { ticket.cancelled = true; return; }
    const value = state(ticket.context.store);
    if (value.latest.get(ticket.key) === ticket) value.latest.delete(ticket.key);
    if (ticket.writingSelection != null) value.writing.delete(ticket.writingSelection);
    value.retired.delete(ticket);
    ticket.lease.tickets.delete(ticket);
    ticket.cancelled = true;
  }
  function release(ticket) {
    if (ticket.held != null &&
        ticket.context.store.get(ticket.context.pendingAtom, ticket.target) === ticket.held) {
      ticket.context.store.set(ticket.context.pendingAtom, ticket.target, null);
    }
    ticket.held = null;
    forget(ticket);
  }
  function releaseRetired(owner) {
    if (owner.context == null) return;
    const value = state(owner.context.store);
    if (value.latest.get(owner.key) !== owner) return;
    for (const ticket of [...value.retired]) {
      if (ticket.key === owner.key) release(ticket);
    }
  }

  function use(React, context) {
    const lease = React.useRef(null);
    if (lease.current == null) {
      lease.current = { active: true, generation: 0, context: null, tickets: new Set() };
    }
    const owner = lease.current;
    const next = { ...context, targetKey: JSON.stringify(context.target) };
    React.useLayoutEffect(() => {
      // A speculative render cannot invalidate committed callbacks or tickets.
      if (!sameIdentity(owner.context, next)) owner.generation += 1;
      owner.context = next;
      for (const ticket of [...owner.tickets]) {
        if (!current(ticket)) {
          release(ticket);
          continue;
        }
        if (acknowledged(ticket) && ticket.status === "succeeded") release(ticket);
      }
    }, [...identityFields.map(field => next[field]), context.metadataModel,
      context.metadataEffort, context.pending, context.writing]);
    React.useLayoutEffect(() => {
      owner.active = true;
      return () => {
        owner.active = false;
        for (const ticket of [...owner.tickets]) release(ticket);
      };
    }, []);
    return owner;
  }

  function begin(lease, caller) {
    const { store, target, selection, hostId } = caller;
    const context = lease.context, key = JSON.stringify(target);
    const ticket = { lease, context, key, target, selection,
      generation: lease.generation, status: "pending", acknowledged: false,
      held: null, writingSelection: null, cancelled: false };
    // Cached native callbacks read the stable lease's latest profile/auth,
    // while their original store/host/target still identify the actual RPC.
    // A stale callback cannot cancel another live context's ticket.
    if (context == null || !lease.active || store !== context.store || hostId !== context.hostId ||
        key !== context.targetKey) {
      ticket.cancelled = true;
      return ticket;
    }
    const value = state(context.store);
    const previous = value.latest.get(key);
    if (previous?.held != null) {
      // Keep ownership until the new native call publishes, settles, or a
      // layout effect converges it. Never leave an old EX object untracked.
      previous.cancelled = true;
      if (previous.writingSelection != null) value.writing.delete(previous.writingSelection);
      value.retired.add(previous);
    } else if (previous != null) forget(previous);
    value.latest.set(key, ticket);
    lease.tickets.add(ticket);
    return ticket;
  }

  function directSucceeded(ticket) {
    releaseRetired(ticket);
    ticket.status = "succeeded";
    if (current(ticket) && eligible(ticket) && !acknowledged(ticket) &&
        ticket.context.store.get(ticket.context.pendingAtom, ticket.target) === ticket.selection) {
      ticket.held = { ...ticket.selection };
      ticket.context.store.set(ticket.context.pendingAtom, ticket.target, ticket.held);
    }
  }
  function finished(ticket) {
    releaseRetired(ticket);
    if (ticket.status === "succeeded" && current(ticket) && eligible(ticket) &&
        !acknowledged(ticket) && ticket.held != null &&
        ticket.context.store.get(ticket.context.pendingAtom, ticket.target) === ticket.held) {
      return;
    }
    if (ticket.held != null) release(ticket);
    else forget(ticket);
  }

  function bindQueued(ticket, selection) {
    if (current(ticket) && selection != null && typeof selection === "object" &&
        selection.model === ticket.selection.model &&
        selection.reasoningEffort === ticket.selection.reasoningEffort &&
        selection.serviceTier === ticket.selection.serviceTier) {
      ticket.writingSelection = selection;
      state(ticket.context.store).writing.set(selection, ticket);
    }
    // This runs synchronously after the native HM invocation. Normally EX has
    // already changed; a no-write failure still releases the previous hold.
    releaseRetired(ticket);
    return result => {
      if (ticket.writingSelection != null) {
        state(ticket.context.store).writing.delete(ticket.writingSelection);
        ticket.writingSelection = null;
      }
      if (result !== true) ticket.status = "failed";
      finished(ticket);
      return result;
    };
  }
  function queuedResult(store, writingAtom, target, result) {
    if (result !== true) return result;
    const selection = store.get(writingAtom, target);
    const ticket = selection == null ? null : state(store).writing.get(selection);
    if (ticket == null || ticket.key !== JSON.stringify(target)) return result;
    ticket.status = "succeeded";
    if (current(ticket) && eligible(ticket) && !acknowledged(ticket) &&
        store.get(ticket.context.pendingAtom, target) === selection) {
      // Publish the same fields before the native queue's finally. Its existing
      // identity guard clears its writing atom and leaves this new pending
      // object, avoiding an intermediate render of stale metadata.
      ticket.held = { ...selection };
      store.set(ticket.context.pendingAtom, target, ticket.held);
    }
    return result;
  }

  return { use, begin, directSucceeded, finished, bindQueued, queuedResult };
}

module.exports = { createExistingChatSelectionRuntime };
