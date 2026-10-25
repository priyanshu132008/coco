#!/usr/bin/env node
/** tasks.db ledger — schema + small task helpers for the WhatsApp gateway and the Python runner. */
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.COCO_DB_PATH || process.env.OI_DB_PATH || path.join(__dirname, "tasks.db");

function open() {
  const db = new Database(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT,
    goal TEXT,
    status TEXT,
    created_at DATETIME
  )`);
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN pid INTEGER"); // runner process — killable via /stop
  } catch {} // column exists already
  db.exec(`CREATE TABLE IF NOT EXISTS pending_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    domain TEXT,
    code TEXT,
    created_at DATETIME
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS pending_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    location TEXT,
    created_at DATETIME
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS retries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    created_at DATETIME
  )`);
  return db;
}

function createPendingCode(db, taskId, domain, code) {
  db.prepare("INSERT INTO pending_codes (task_id, domain, code, created_at) VALUES (?, ?, ?, datetime('now'))").run(taskId, domain, code);
  return db.prepare("SELECT last_insert_rowid() AS id").get().id;
}

function createPendingLocation(db, taskId, location) {
  db.prepare("INSERT INTO pending_locations (task_id, location, created_at) VALUES (?, ?, datetime('now'))").run(taskId, location);
  return db.prepare("SELECT last_insert_rowid() AS id").get().id;
}

function createTask(db, phoneNumber, goal) {
  // 'booting' until the runner is spawned and its pid is recorded — a task in either
  // 'booting' or 'running' counts as active and blocks the next command.
  const info = db
    .prepare("INSERT INTO tasks (phone_number, goal, status, created_at) VALUES (?, ?, 'booting', datetime('now'))")
    .run(phoneNumber, goal);
  return Number(info.lastInsertRowid);
}

function setStatus(db, taskId, status) {
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);
}

function getStatus(db, taskId) {
  return db.prepare("SELECT id, phone_number, goal, status FROM tasks WHERE id = ?").get(taskId);
}

function setPid(db, taskId, pid) {
  db.prepare("UPDATE tasks SET pid = ? WHERE id = ?").run(pid, taskId);
}

function activeTasksForChat(db, chatId) {
  // every task for this chat that is booting or running (a booting task has no pid yet)
  return db
    .prepare("SELECT id, status, pid FROM tasks WHERE phone_number = ? AND status IN ('booting', 'running') ORDER BY id ASC")
    .all(String(chatId));
}

function createRetry(db, taskId) {
  db.prepare("INSERT INTO retries (task_id, created_at) VALUES (?, datetime('now'))").run(taskId);
}

if (require.main === module) {
  // self-check: create → read → flip, throwaway in-memory DB unless COCO_DB_PATH set
  const db = open();
  const id = createTask(db, "15551234567", "self-check goal");
  const row = getStatus(db, id);
  console.log("created:", row);
  if (row.status !== "booting") throw new Error("initial status not booting");
  // a booting task counts as active and blocks the next command
  if (activeTasksForChat(db, "15551234567").length !== 1) throw new Error("booting task not seen as active");
  setStatus(db, id, "running");
  if (activeTasksForChat(db, "15551234567").length !== 1) throw new Error("running task not seen as active");
  setStatus(db, id, "approved");
  if (getStatus(db, id).status !== "approved") throw new Error("status flip failed");
  if (activeTasksForChat(db, "15551234567").length) throw new Error("approved task still reported active");
  const cid = createPendingCode(db, id, "github.com", "424242");
  const prow = db.prepare("SELECT code, domain FROM pending_codes WHERE id = ?").get(cid);
  if (prow.code !== "424242" || prow.domain !== "github.com") throw new Error("pending_code insert failed");
  createRetry(db, id);
  const rrow = db.prepare("SELECT task_id FROM retries WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id);
  if (!rrow || rrow.task_id !== id) throw new Error("retry insert failed");
  console.log("ledger self-check OK (tasks + active states + pending_codes + retries)");
  db.close();
}

module.exports = { open, createTask, setStatus, getStatus, setPid, activeTasksForChat, createPendingCode, createPendingLocation, createRetry, DB_PATH };