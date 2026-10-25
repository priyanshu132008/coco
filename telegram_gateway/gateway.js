#!/usr/bin/env node
/** Coco Telegram Command Center — grammY long polling.
 *  commands in → tasks.db rows (telegram_gateway/tasks.db) → python agent_runner in background →
 *  approval asks / 2FA code asks back to the chat, decisions back into the ledger. */
const { Bot, InputFile } = require("grammy");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); // same .env the Python side uses
const ledger = require("./ledger");

const db = ledger.open();
// browser-use layer needs py>=3.11 → .venv-bu; set COCO_RUNNER=agent_runner.py for the legacy
// SoM/pyautogui execution (needs the default .venv)
const NEW_DRIVER = process.env.COCO_RUNNER === "agent_runner.py";
const AGENT = path.join(__dirname, "..", NEW_DRIVER ? ".venv" : ".venv-bu", "bin", "python");
const RUNNER_NAME = NEW_DRIVER ? "agent_runner.py" : "browser_driver.py";
const RUNNER = path.join(__dirname, "..", "tools", RUNNER_NAME);
const APPROVE_RE = /^(yes|approve|approved|confirm|ok|go)\b/i;
const DENY_RE = /^(no|deny|denied)\b/i; // "cancel"/"stop" moved to STOP_RE — they cancel the task outright
const STOP_RE = /^\/?(stop|stoppp|cancel)[\s!.]*$/i;
const CODE_RE = /^\s*(?:otp\s*)?(\d{6})\s*$/i; // "123456" or "otp 123456"
const RETRY_RE = /^\/?(retry|again|resume)\b/i; // after a Cloudflare pause
//: The vault form lives in the Next dashboard (/vault in packages/dashboard).
const VAULT_URL = process.env.COCO_VAULT_URL || "http://127.0.0.1:3000/vault";
//: How long to wait for a SIGINT'ed runner to release the browser profile lock.
const SHUTDOWN_TIMEOUT = Number(process.env.COCO_SHUTDOWN_TIMEOUT || 15000);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("[gateway] TELEGRAM_BOT_TOKEN missing from environment — add it to .env");
  process.exit(2);
}
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const pending = new Map(); // chat id → task id awaiting approve/deny
const pendingCodes = new Map(); // chat id → {taskId, domain} awaiting a 6-digit 2FA code
const pendingLocations = new Map(); // chat id → {taskId, domain} awaiting a delivery address
const captchaBlocked = new Map(); // chat id → {taskId, domain} paused on a Cloudflare challenge

bot.catch((err) => console.error("[gateway] bot error:", err.error?.stack || err.error?.message || err.error));

bot.command("start", (ctx) => ctx.reply("Coco agent online. Text me a goal — e.g. 'Find me a flight to Delhi'."));

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = (ctx.message.text || "").trim();
  console.log(`[message] received: "${text}" from chat ${chatId}`);
  if (!text) return;

  // cancellation: never becomes a task — kill the live agent immediately
  if (STOP_RE.test(text)) {
    const tasks = ledger.activeTasksForChat(db, chatId);
    if (!tasks.length) {
      await ctx.reply("No running task to stop.");
      return;
    }
    for (const task of tasks) {
      try {
        if (task.pid) process.kill(task.pid, "SIGINT");
        ledger.setStatus(db, task.id, "cancelled");
        ledger.setPid(db, task.id, null);
      } catch (e) {
        ledger.setStatus(db, task.id, "failed");
        console.error(`[gateway] could not stop task ${task.id}:`, e.code || e.message);
      }
      console.log(`[gateway] stop → task ${task.id}`);
    }
    await ctx.reply(`🛑 Task cancelled. Agent stopped immediately.`);
    return;
  }

  // slash commands are never goals — /vault opens the Mini App, everything slash-y stops here
  // (before any pending-state or task logic, so /vault can't be eaten as an address either)
  if (text.startsWith("/")) {
    if (/^\/?vault/i.test(text)) {
      await ctx.reply("🔒 Open your secure credential and address vault:", { reply_markup: vaultKeyboard("", "credentials") });
    }
    return;
  }

  // delivery address gate: the runner stopped on an address screen; the next text is the address
  if (pendingLocations.has(chatId)) {
    // leading-slash commands (/vault, /stop, …) are never a delivery address — route them onward
    if (!CODE_RE.test(text) && !APPROVE_RE.test(text) && !DENY_RE.test(text) && !STOP_RE.test(text) && !text.startsWith("/") && text.length >= 4) {
      const { taskId } = pendingLocations.get(chatId);
      pendingLocations.delete(chatId);
      ledger.createPendingLocation(db, taskId, text);
      console.log(`[gateway] delivery address for task ${taskId} received`);
      await ctx.reply(`📍 Address saved — the agent is typing it in.`);
      return;
    }
    pendingLocations.delete(chatId); // not an address (a code/approve/stop) — fall through to other routing
  }

  // Cloudflare pause: the driver asked the human to solve the challenge. "retry" tells
  // the driver to re-check the page now that the challenge should be gone.
  if (captchaBlocked.has(chatId) && RETRY_RE.test(text)) {
    const { taskId, domain } = captchaBlocked.get(chatId);
    captchaBlocked.delete(chatId);
    ledger.createRetry(db, taskId); // the driver polls this to know the human solved it
    console.log(`[gateway] retry for task ${taskId} (${domain})`);
    await ctx.reply(`🔄 Retrying ${domain}…`);
    return;
  }

  // 2FA/OTP code relay: "123456" or "otp 123456" lands in pending_codes and wakes the polling runner
  if (pendingCodes.has(chatId)) {
    const codeMatch = text.match(CODE_RE);
    if (codeMatch) {
      const { taskId, domain } = pendingCodes.get(chatId);
      ledger.createPendingCode(db, taskId, domain, codeMatch[1]);
      console.log(`[gateway] 2FA/OTP code for task ${taskId} (${domain}) received`);
      await ctx.reply(`Code received — typing it into ${domain}.`);
      return;
    }
    if (!APPROVE_RE.test(text) && !DENY_RE.test(text)) {
      pendingCodes.delete(chatId); // not a code — treat the text as a fresh command below
    }
  }

  // approval reply? route it into the ledger; the runner polls the DB and resumes
  if (pending.has(chatId)) {
    const taskId = pending.get(chatId);
    pending.delete(chatId);
    if (APPROVE_RE.test(text)) {
      ledger.setStatus(db, taskId, "approved");
    } else if (DENY_RE.test(text)) {
      ledger.setStatus(db, taskId, "denied");
    } else {
      pending.set(chatId, taskId); // still waiting — don't leak the task
      await ctx.reply(`Didn't recognize that as approve/deny. Task #${taskId} is still waiting.`);
      return;
    }
    return;
  }

  // new command → stop any task still active for this chat → ledger row → ack → spawn
  try {
    const active = ledger.activeTasksForChat(db, chatId);
    for (const prev of active) {
      const stopped = await stopActiveTask(prev);
      if (stopped) {
        await ctx.reply(`♻️ Stopped the previous task #${prev.id} — starting the new one.`);
      }
    }

    const taskId = ledger.createTask(db, String(chatId), text);
    console.log(`[gateway] task ${taskId} created for chat ${chatId}: "${text}"`);
    await ctx.reply(`Task #${taskId} received. Booting local agent...`);

    const child = spawnRunner(taskId, text, chatId);
    child.on("close", () => pending.delete(chatId)); // freed for the next command
  } catch (e) {
    console.error("[gateway] task dispatch failed:", e.message);
    await ctx.reply(`Failed to boot the agent: ${e.message}`);
  }
});

// SIGINT the runner of a still-active task and wait for it to shut down cleanly.
// The runner releases the browser profile lock on exit — without this wait the next
// Chrome launch dies on 'SingletonLock: File exists'.
async function stopActiveTask(task) {
  console.log(`[gateway] stopping active task ${task.id} (status=${task.status}, pid=${task.pid || "none"})`);
  if (!task.pid) {
    // booting (no pid yet) — mark it cancelled so a late-arriving runner stands down
    ledger.setStatus(db, task.id, "cancelled");
    return true;
  }
  try {
    process.kill(task.pid, "SIGINT");
  } catch (e) {
    if (e.code === "ESRCH") {
      ledger.setStatus(db, task.id, "cancelled");
      ledger.setPid(db, task.id, null);
      return true;
    }
    console.error(`[gateway] could not SIGINT task ${task.id}:`, e.message);
    return false;
  }
  // wait for a clean exit (the runner's 'close' handler clears the pid)
  const deadline = Date.now() + SHUTDOWN_TIMEOUT;
  while (Date.now() < deadline) {
    if (!isAlive(task.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isAlive(task.pid)) {
    console.log(`[gateway] task ${task.id} did not exit in time — SIGKILL`);
    try {
      process.kill(task.pid, "SIGKILL");
    } catch {}
  }
  ledger.setStatus(db, task.id, "cancelled");
  ledger.setPid(db, task.id, null);
  return true;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch (e) {
    return e.code === "EPERM"; // alive, owned by someone else
  }
}

// The Mini App vault button: opens /vault in Telegram with the domain and the gate
// that decides which fields the form shows.
function vaultKeyboard(domain, gate) {
  const url = `${VAULT_URL}?domain=${encodeURIComponent(domain || "")}&gate=${gate}`;
  return {
    inline_keyboard: [[{ text: "🔒 Open Secure Vault", web_app: { url } }]],
  };
}

// Pick the most telling line out of a runner's stderr tail — a real exception beats a
// wall of browser-use log noise, and the chat deserves the actual reason.
function summarizeStderr(text) {
  if (!text) return "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.filter((l) => /^(RuntimeError|ValueError|OSError|Exception|TimeoutError|FileNotFoundError|[A-Za-z_]*Error):/.test(l));
  const interesting = fatal.length
    ? fatal
    : lines.filter((l) => /SingletonLock|FATAL|exited before CDP|Traceback|locked by/i.test(l));
  const pick = (interesting.length ? interesting : lines).slice(-1)[0] || "";
  return pick.length > 300 ? pick.slice(0, 300) + "…" : pick;
}

function spawnRunner(taskId, goal, chatId) {
  const { spawn } = require("child_process");
  const args = [RUNNER, "run", "--goal", goal, "--task-id", String(taskId)];
  if (NEW_DRIVER) args.push("--steps", process.env.COCO_AGENT_STEPS || "5"); // browser-driver self-paces (COCO_BU_MAX_STEPS)
  const child = spawn(
    AGENT,
    args,
    { cwd: path.join(__dirname, ".."), env: { ...process.env, COCO_AGENT_CLICK: "1" }, detached: true }
  );
  child.unref(); // fire-and-forget: the bot loop must never block on the agent
  if (child.pid) ledger.setPid(db, taskId, child.pid); // /stop kills this
  // a task cancelled while it was booting must not come to life — kill the runner at once
  const st = ledger.getStatus(db, taskId);
  if (st && st.status === "cancelled") {
    try {
      if (child.pid) process.kill(child.pid, "SIGINT");
    } catch {}
    console.log(`[gateway] task ${taskId} was cancelled while booting — killing runner`);
    return child;
  }
  ledger.setStatus(db, taskId, "running"); // booted — the runner is live
  let buf = "";
  let lastError = null; // the runner's structured 'error' event, if it sent one
  let errorNotified = false; // …and whether we already told the chat about it
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // non-JSON stdout noise
      }
      if (ev.type === "approval_required") {
        pending.set(chatId, taskId);
        const price = ev.price ? ev.price : "";
        bot.api
          .sendMessage(chatId, `Checkout reached. Total: ${price || "?"}\nReply "approve" to execute payment, "deny" to cancel.`)
          .catch((e) => console.error("[gateway] approval msg failed:", e.message));
      } else if (ev.type === "vault_required" || ev.type === "credentials") {
        bot.api
          .sendMessage(
            chatId,
            `🗄️ No credentials in the vault for ${ev.domain || "the target site"}. Open to fill:`,
            { reply_markup: vaultKeyboard(ev.domain, "credentials") }
          )
          .catch((e) => console.error("[gateway] vault msg failed:", e.message));
      } else if (ev.type === "location_required") {
        pendingLocations.set(chatId, { taskId: ev.task_id, domain: ev.domain || "unknown" });
        bot.api
          .sendMessage(
            chatId,
            `📍 ${ev.domain || "This site"} requires a delivery location. Add it here, or reply with your address:`,
            { reply_markup: vaultKeyboard(ev.domain, "location") }
          )
          .catch((e) => console.error("[gateway] location msg failed:", e.message));
      } else if (ev.type === "payment_required") {
        bot.api
          .sendMessage(
            chatId,
            `💳 ${ev.domain || "This site"} needs payment details. Add them to the vault:`,
            { reply_markup: vaultKeyboard(ev.domain, "card") }
          )
          .catch((e) => console.error("[gateway] payment msg failed:", e.message));
      } else if (ev.type === "code_required" || ev.type === "otp_required") {
        pendingCodes.set(chatId, { taskId, domain: ev.domain || "unknown-domain" });
        bot.api.sendMessage(chatId, `🔐 Task #${taskId} needs a ${ev.type === "otp_required" ? "one-time password" : "2FA code"} for ${ev.domain || "unknown-domain"}. Reply with the 6 digits (e.g. "otp 123456").`)
          .catch((e) => console.error("[gateway] code msg failed:", e.message));
      } else if (ev.type === "screenshot") {
        // live view: push the SoM-annotated frame to the chat (sendPhoto compresses for mobile;
        // sendDocument's raw PNG fails to render on some mobile devices)
        bot.api
          .sendPhoto(chatId, new InputFile(ev.path))
          .catch((e) => console.error("[gateway] screenshot send failed:", e.message));
      } else if (ev.type === "chat" && ev.message) {
        // two-way conversation: relay the VLM's findings/questions as-is
        bot.api.sendMessage(chatId, ev.message)
          .catch((e) => console.error("[gateway] chat relay failed:", e.message));
      } else if (ev.type === "captcha_required") {
        // the auto-solver could not clear the Cloudflare challenge — the human must
        // solve it in the visible browser window, then the driver retries
        captchaBlocked.set(chatId, { taskId, domain: ev.domain || "unknown-domain" });
        bot.api
          .sendMessage(
            chatId,
            `🛡️ Cloudflare verification required for ${ev.domain || "unknown-domain"}. Paused for 30s — solve on Mac or reply "retry".`
          )
          .catch((e) => console.error("[gateway] captcha notify failed:", e.message));
      } else if (ev.type === "error" && ev.message) {
        // the runner's fatal error — echo the real reason back to the chat
        lastError = ev.message;
        errorNotified = true;
        bot.api.sendMessage(chatId, `❌ Task #${taskId} failed: ${ev.message}`)
          .catch((e) => console.error("[gateway] error relay failed:", e.message));
      }
    }
  });
  // stderr goes straight into gateway.log (launchd captures stdout+stderr there) and is
  // kept so the exit notification can quote it instead of a generic "encountered an error"
  let stderrTail = "";
  child.stderr.on("data", (d) => {
    const text = d.toString();
    process.stdout.write(`[agent ${taskId}] ${text}`);
    stderrTail = (stderrTail + text).slice(-2000);
  });
  child.on("close", (code) => {
    const current = ledger.getStatus(db, taskId);
    // 'cancelled' was written by /stop or by the single-active-task handoff — don't stomp it
    if (!current || current.status === "running" || current.status === "booting") {
      ledger.setStatus(db, taskId, code === 0 ? "done" : code === 130 ? "cancelled" : "failed");
    }
    ledger.setPid(db, taskId, null);
    console.log(`[gateway] ${RUNNER_NAME} for task ${taskId} exited (${code})`);
    const reason = lastError || summarizeStderr(stderrTail);
    const notice =
      current?.status === "cancelled"
        ? `🛑 Task #${taskId} cancelled.`
        : code === 0
          ? `✅ Task #${taskId} finished.`
          : errorNotified
            ? null // the real reason was already sent with the error event
            : `❌ Task #${taskId} failed${reason ? `: ${reason}` : "."}`;
    if (notice) {
      bot.api.sendMessage(chatId, notice)
        .catch((e) => console.error("[gateway] status notify failed:", e.message));
    }
  });
  child.on("error", (e) => {
    ledger.setStatus(db, taskId, "failed");
    console.error(`[gateway] spawn failed for task ${taskId}:`, e.message);
  });
  return child;
}

// The vault form lives in the Next dashboard (packages/dashboard /vault → /api/vault/submit
// → tools/vault.py). coco start brings it up; if the dashboard is down the vault button
// just fails to open a page — long polling keeps running.

// /api/setup (or a hand edit) can change TELEGRAM_BOT_TOKEN while we poll, but dotenv
// already ran — this process would poll the old bot forever. On a token change exit(3):
// `coco start` respawns us with the new token, launchd KeepAlive does the same.
const ENV_FILE = path.join(__dirname, "..", ".env");
let currentToken = process.env.TELEGRAM_BOT_TOKEN;
fs.watch(ENV_FILE, () => {
  const tok = /^TELEGRAM_BOT_TOKEN=(.*)$/m.exec(fs.readFileSync(ENV_FILE, "utf8"));
  if (tok && tok[1].trim() && tok[1].trim() !== currentToken) {
    console.log("[gateway] .env changed — restarting for the new bot token…");
    process.exit(3);
  }
});

// A token moved off a cloud deploy keeps its old setWebhook — getUpdates then fails with
// "webhook is active" until it's dropped. Always clear it before long polling.
bot.api
  .deleteWebhook()
  .then(() => console.log("[gateway] webhook cleared — long polling fresh"))
  .catch((e) => console.error("[gateway] deleteWebhook failed — a cloud webhook may still block polling:", e.message));

bot.start(); // long polling — no webhook, no public host needed
console.log("[gateway] Telegram bot polling started");