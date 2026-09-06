#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function usage() {
  console.error("usage: shared-state-sqlite.js rewrite-rollout-paths <codex-home> <shared-root> | merge-catalog <incoming-db> <shared-db>");
  process.exit(2);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isSqliteDatabase(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    return fs.readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from("SQLite format 3\0"));
  } finally {
    fs.closeSync(fd);
  }
}

function mergeCatalog(incomingPath, sharedPath) {
  // Some focused shell fixtures intentionally use opaque catalog bytes. Real
  // Codex catalogs are SQLite; leave opaque files on the preservation path.
  if (!isSqliteDatabase(incomingPath) || !isSqliteDatabase(sharedPath)) return;
  const db = new DatabaseSync(sharedPath);
  try {
    db.exec("pragma foreign_keys=off");
    db.prepare("attach database ? as incoming").run(incomingPath);
    db.exec("begin immediate");
    const tables = db.prepare("select name, sql from incoming.sqlite_master where type='table' and name not like 'sqlite_%' and sql is not null order by name").all();
    for (const table of tables) {
      const name = String(table.name);
      const quoted = quoteIdentifier(name);
      const targetExists = db.prepare("select 1 as found from main.sqlite_master where type='table' and name=?").get(name);
      if (!targetExists) db.exec(String(table.sql));
      const incomingColumns = db.prepare(`pragma incoming.table_info(${quoted})`).all().map((column) => String(column.name));
      const targetColumns = new Set(db.prepare(`pragma main.table_info(${quoted})`).all().map((column) => String(column.name)));
      const columns = incomingColumns.filter((column) => targetColumns.has(column));
      if (columns.length === 0) continue;
      const list = columns.map(quoteIdentifier).join(",");
      db.exec(`insert or ignore into main.${quoted} (${list}) select ${list} from incoming.${quoted}`);
    }
    db.exec("commit");
    db.exec("detach database incoming");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    try { db.exec("detach database incoming"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

const [, , action, codexHome, sharedRoot] = process.argv;
if (!action || !codexHome || !sharedRoot) usage();

if (action === "merge-catalog") {
  mergeCatalog(codexHome, sharedRoot);
  process.exit(0);
}

if (action !== "rewrite-rollout-paths") usage();

const sharedContextsRoot = path.dirname(path.resolve(sharedRoot));
const managedContextPrefix = `${sharedContextsRoot}/`;
const targetPrefix = `${path.resolve(codexHome)}/sessions/`;
const entries = fs.readdirSync(codexHome, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isFile() || !/^state_[0-9]+\.sqlite$/.test(entry.name)) continue;
  const databasePath = path.join(codexHome, entry.name);
  const db = new DatabaseSync(databasePath);
  try {
    const table = db.prepare("select name from sqlite_master where type = 'table' and name = 'threads'").get();
    if (!table) continue;
    db.exec("begin immediate");
    const rows = db.prepare("select id, rollout_path from threads where rollout_path like ?").all(`${managedContextPrefix}%/sessions/%`);
    const update = db.prepare("update threads set rollout_path = ? where id = ?");
    for (const row of rows) {
      const rolloutPath = String(row.rollout_path);
      if (!rolloutPath.startsWith(managedContextPrefix)) continue;
      const relative = rolloutPath.slice(managedContextPrefix.length);
      const sessionsMarker = "/sessions/";
      const markerIndex = relative.indexOf(sessionsMarker);
      if (markerIndex <= 0) continue;
      const contextId = relative.slice(0, markerIndex);
      const sessionRelative = relative.slice(markerIndex + sessionsMarker.length);
      if (contextId.includes("/") || !sessionRelative || sessionRelative.split("/").includes("..")) continue;
      update.run(`${targetPrefix}${sessionRelative}`, row.id);
    }
    const backfillTable = db.prepare("select name from sqlite_master where type = 'table' and name = 'backfill_state'").get();
    if (backfillTable) db.prepare("delete from backfill_state where id = 1").run();
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}
