#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  PATCH_MARKER,
  applyLinuxNotificationActionsPatch,
  codexLinuxCreateActionNotification,
  codexLinuxNotificationActionLines,
} = require("./notifications.js");

const currentFactory =
  "e.createNotification?this.createNotification=e.createNotification:this.createNotification=e=>{let t=new c.Notification(e);return{show:()=>t.show(),on:(e,n)=>{switch(e){case`action`:return t.on(`action`,(e,t)=>{n(e,t)});case`click`:return t.on(`click`,()=>{n(void 0)});case`close`:return t.on(`close`,()=>{n(void 0)})}},close:()=>t.close()}}";

test("Linux notification actions patch routes action payloads through the bridge", () => {
  const patched = applyLinuxNotificationActionsPatch(`before;${currentFactory};after`);

  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.match(patched, /require\("electron"\)\.app\.setDesktopName\("codex-desktop"\)/);
  assert.match(
    patched,
    /process\.platform===`linux`&&Array\.isArray\(e\.actions\)&&e\.actions\.length>0/,
  );
  assert.match(patched, /codexLinuxCreateActionNotification\(e,codexLinuxNotificationFallback\)/);
  assert.match(patched, /new c\.Notification\(e\)/);
});

test("Linux notification actions patch is idempotent", () => {
  const patched = applyLinuxNotificationActionsPatch(currentFactory);
  assert.equal(applyLinuxNotificationActionsPatch(patched), patched);
});

test("Linux notification actions patch reports current upstream drift", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(applyLinuxNotificationActionsPatch("no notification factory"), "no notification factory");
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [
    "WARN: Could not find desktop notification factory - skipping Linux notification actions patch",
  ]);
});

test("notification bridge line parser handles chunked events", () => {
  const stream = new EventEmitter();
  const lines = [];
  codexLinuxNotificationActionLines(stream, (line) => lines.push(line));

  stream.emit("data", Buffer.from('{"event":"sho'));
  stream.emit("data", Buffer.from('wn"}\n\n{"event":"action","index":1}\n'));

  assert.deepEqual(lines, ['{"event":"shown"}', '{"event":"action","index":1}']);
});

function fakeBridgeProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    ended: false,
    write(value) {
      this.writes.push(value);
    },
    end(value) {
      if (value != null) this.writes.push(value);
      this.ended = true;
    },
  };
  child.kill = () => {};
  return child;
}

test("action notification keeps the bridge command channel open and forwards an action index", () => {
  const child = fakeBridgeProcess();
  const actions = [];
  let fallbackStarted = false;
  const notification = codexLinuxCreateActionNotification(
    {
      title: "Command approval",
      body: "Run command?",
      actions: [{ text: "Approve" }, { text: "Decline" }],
    },
    () => {
      fallbackStarted = true;
      return null;
    },
    { bridgePath: "/test/bridge", spawn: () => child },
  );
  notification.on("action", (_event, index) => actions.push(index));
  notification.show();

  assert.equal(child.stdin.ended, false);
  assert.equal(child.stdin.writes.length, 1);
  assert.deepEqual(JSON.parse(child.stdin.writes[0]), {
    title: "Command approval",
    body: "Run command?",
    actions: ["Approve", "Decline"],
  });

  child.stdout.emit("data", Buffer.from('{"event":"shown","notification_id":42}\n'));
  child.stdout.emit("data", Buffer.from('{"event":"action","index":1}\n'));
  assert.deepEqual(actions, [1]);
  assert.equal(fallbackStarted, false);
});

test("action notification falls back before the bridge is shown", () => {
  const child = fakeBridgeProcess();
  const fallbackEvents = [];
  const fallback = {
    on(event) {
      fallbackEvents.push(`on:${event}`);
    },
    show() {
      fallbackEvents.push("show");
    },
    close() {},
  };
  const notification = codexLinuxCreateActionNotification(
    { title: "Approval", body: "Required", actions: [{ text: "Approve" }] },
    () => fallback,
    { bridgePath: "/test/bridge", spawn: () => child },
  );
  notification.on("click", () => {});
  notification.on("close", () => {});
  notification.show();
  child.stdout.emit(
    "data",
    Buffer.from('{"event":"unavailable","reason":"notification-actions-unsupported"}\n'),
  );

  assert.deepEqual(fallbackEvents, ["on:click", "on:close", "show"]);
});

test("programmatic close waits for the bridge close event and forwards it once", () => {
  const child = fakeBridgeProcess();
  let closeCount = 0;
  const notification = codexLinuxCreateActionNotification(
    { title: "Approval", body: "Required", actions: [{ text: "Approve" }] },
    () => null,
    { bridgePath: "/test/bridge", spawn: () => child },
  );
  notification.on("close", () => {
    closeCount += 1;
  });
  notification.show();
  child.stdout.emit("data", Buffer.from('{"event":"shown","notification_id":42}\n'));

  notification.close();
  notification.close();

  assert.equal(child.stdin.ended, true);
  assert.equal(child.stdin.writes.at(-1), "close\n");
  assert.equal(closeCount, 0);

  child.stdout.emit("data", Buffer.from('{"event":"closed"}\n'));
  child.stdout.emit("data", Buffer.from('{"event":"closed"}\n'));

  assert.equal(closeCount, 1);
});

test("close before show prevents both bridge and fallback notifications", () => {
  let spawnCount = 0;
  let fallbackCount = 0;
  let closeCount = 0;
  const notification = codexLinuxCreateActionNotification(
    { title: "Approval", body: "Required", actions: [{ text: "Approve" }] },
    () => {
      fallbackCount += 1;
      return null;
    },
    {
      bridgePath: "/test/bridge",
      spawn: () => {
        spawnCount += 1;
        return fakeBridgeProcess();
      },
    },
  );
  notification.on("close", () => {
    closeCount += 1;
  });

  notification.close();
  notification.show();

  assert.equal(spawnCount, 0);
  assert.equal(fallbackCount, 0);
  assert.equal(closeCount, 1);
});

test("close while the bridge starts prevents a later fallback", () => {
  const child = fakeBridgeProcess();
  let actionCount = 0;
  let fallbackCount = 0;
  let closeCount = 0;
  const notification = codexLinuxCreateActionNotification(
    { title: "Approval", body: "Required", actions: [{ text: "Approve" }] },
    () => {
      fallbackCount += 1;
      return null;
    },
    { bridgePath: "/test/bridge", spawn: () => child },
  );
  notification.on("close", () => {
    closeCount += 1;
  });
  notification.on("action", () => {
    actionCount += 1;
  });
  notification.show();

  notification.close();
  child.stdout.emit("data", Buffer.from('{"event":"action","index":0}\n'));
  child.stdout.emit(
    "data",
    Buffer.from('{"event":"unavailable","reason":"notification-actions-unsupported"}\n'),
  );
  child.emit("exit", 0);

  assert.equal(fallbackCount, 0);
  assert.equal(actionCount, 0);
  assert.equal(closeCount, 1);
});

test("process exit waits for buffered stdout before deciding fallback", () => {
  const child = fakeBridgeProcess();
  const actions = [];
  let closeCount = 0;
  let fallbackCount = 0;
  const notification = codexLinuxCreateActionNotification(
    { title: "Approval", body: "Required", actions: [{ text: "Approve" }] },
    () => {
      fallbackCount += 1;
      return null;
    },
    { bridgePath: "/test/bridge", spawn: () => child },
  );
  notification.on("action", (_event, index) => actions.push(index));
  notification.on("close", () => {
    closeCount += 1;
  });
  notification.show();

  child.emit("exit", 0);
  assert.equal(fallbackCount, 0);

  child.stdout.emit(
    "data",
    Buffer.from(
      '{"event":"shown","notification_id":42}\n{"event":"action","index":0}\n{"event":"closed"}\n',
    ),
  );
  child.emit("close", 0);

  assert.deepEqual(actions, [0]);
  assert.equal(closeCount, 1);
  assert.equal(fallbackCount, 0);
});
