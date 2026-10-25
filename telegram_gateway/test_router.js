#!/usr/bin/env node
/** Router self-check: vague message → plain chat reply; concrete goal → dispatch_browser tool call. */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const LLM_BASE = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");
const LLM_MODEL = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")).active_model.replace(/^openai\//, "");

const TOOLS = [{ type: "function", function: { name: "dispatch_browser", description: "Spawn the local browser agent. Call ONLY when the goal is final and self-contained.", parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } } }];

async function turn(text) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "You are Coco, a browser-automation assistant on Telegram. Ask a short clarifying question while anything is ambiguous; call dispatch_browser only when the goal is final AND self-contained. Replies 1-3 short sentences." },
        { role: "user", content: text },
      ],
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const msg = (await res.json()).choices?.[0]?.message;
  return { content: msg?.content || "", tool: msg?.tool_calls?.find((t) => t.function?.name === "dispatch_browser")?.function };
}

(async () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const vague = await turn("hi there");
  console.log("vague →", { content: vague.content.slice(0, 80), tool: vague.tool?.name || null });
  if (vague.tool) throw new Error("expected chat reply for a vague greeting, got a tool call");

  const clear = await turn("Search amazon.in for a 500ml Aquafina water bottle and open the cheapest one's product page, don't buy anything");
  console.log("clear →", { content: (clear.content || "").slice(0, 80), goal: clear.tool ? JSON.parse(clear.tool.arguments).goal.slice(0, 80) : null });
  if (!clear.tool) throw new Error("expected dispatch_browser for a fully-specified goal");
  console.log("router self-check OK");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });