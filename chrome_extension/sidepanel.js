// Side panel: shows hayamimi's captions by reading the local SSE stream that
// `realtime_transcribe.py --serve` exposes. Only caption text is received --
// no audio ever passes through the extension, and nothing leaves the PC.
"use strict";

const SERVER = "http://127.0.0.1:8833";
const MAX_LINES = 1000;          // per tab; oldest lines are dropped beyond this
const FONT_MIN = 12;
const FONT_MAX = 40;
const FONT_STEP = 2;
const FONT_DEFAULT = 18;
const PARTIAL_IDLE_MS = 4000;    // dim the in-progress line after this much quiet
const REPLAY_WINDOW_MS = 500;    // refines this soon after connecting are the server's replay
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 10000;
const STICK_PX = 48;             // "at the bottom" tolerance for auto-scroll

const $ = (id) => document.getElementById(id);
const scroller = $("scroller");
const feeds = { live: $("feed-live"), refined: $("feed-refined") };
const tabs = { live: $("tab-live"), refined: $("tab-refined") };
const placeholders = {
  live: feeds.live.querySelector(".empty").textContent,
  refined: feeds.refined.querySelector(".empty").textContent,
};
const partial = $("partial");
const statusBox = $("status");
const statusText = $("status-text");
const hint = $("hint");
const jump = $("jump");
const toast = $("toast");

const STATUS_TEXT = {
  connecting: "早耳に接続しています…",
  live: "早耳につながっています",
  down: "早耳が動いていません（自動でつなぎ直します）",
};

// chrome.storage is missing when the page is opened outside the extension
// (e.g. while testing), so every use goes through this guard.
const store = globalThis.chrome?.storage?.local ?? null;

let active = "live";
let lastLive = null;      // newest final line; translations attach to it
let partialTimer = null;
let toastTimer = null;
let es = null;
let state = "connecting";
let retryMs = RETRY_MIN_MS;
let retryTimer = null;
let openedAt = 0;
let fontPx = FONT_DEFAULT;

// ---- font size -------------------------------------------------------------

function applyFont(px) {
  fontPx = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
  document.documentElement.style.setProperty("--fs", fontPx + "px");
}

function changeFont(delta) {
  const pinned = nearBottom();
  applyFont(fontPx + delta);
  if (pinned) scrollToBottom();
  store?.set({ fontPx });
}

applyFont(FONT_DEFAULT);
store?.get("fontPx").then((v) => {
  if (typeof v.fontPx === "number") applyFont(v.fontPx);
});

// ---- scrolling -------------------------------------------------------------

function nearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
}

function scrollToBottom() {
  scroller.scrollTop = scroller.scrollHeight;
  jump.hidden = true;
}

scroller.addEventListener("scroll", () => {
  if (nearBottom()) jump.hidden = true;
});
jump.addEventListener("click", scrollToBottom);

// ---- lines -----------------------------------------------------------------

function clock() {
  return new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function makeLine(text, { time, speaker }) {
  const line = document.createElement("div");
  line.className = "line new";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = time || "（接続前の内容）";
  if (speaker) {
    const spk = document.createElement("span");
    spk.className = "spk";
    spk.textContent = speaker;
    meta.appendChild(spk);
  }
  line.append(meta, document.createTextNode(text));
  const who = speaker ? speaker + ": " : "";
  line.dataset.copy = (time ? "[" + time + "] " : "") + who + text;
  return line;
}

function append(key, line) {
  const feed = feeds[key];
  feed.querySelector(".empty")?.remove();
  const visible = key === active;
  const pinned = visible && nearBottom();
  // Animate only what is on screen; a hidden tab would replay it on switch.
  if (!visible) line.classList.remove("new");
  feed.appendChild(line);
  while (feed.childElementCount > MAX_LINES) feed.firstElementChild.remove();
  if (!visible) return;
  if (pinned) scrollToBottom();
  else jump.hidden = false;
}

function clearFeed(key) {
  const feed = feeds[key];
  feed.replaceChildren();
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = placeholders[key];
  feed.appendChild(p);
  if (key === "live") lastLive = null;
}

function clearPartial() {
  clearTimeout(partialTimer);
  partial.textContent = "…";
  partial.classList.add("idle");
}

// ---- events from hayamimi --------------------------------------------------

function handle(ev) {
  switch (ev.type) {
    case "partial": {
      partial.textContent = ev.text || "…";
      partial.classList.remove("idle");
      clearTimeout(partialTimer);
      partialTimer = setTimeout(() => partial.classList.add("idle"), PARTIAL_IDLE_MS);
      break;
    }
    case "final": {
      clearPartial();
      if (!ev.text) break;
      lastLive = makeLine(ev.text, { time: clock(), speaker: ev.speaker });
      append("live", lastLive);
      break;
    }
    case "translation": {
      if (!lastLive || !ev.text) break;
      const pinned = active === "live" && nearBottom();
      const tr = document.createElement("span");
      tr.className = "trans";
      tr.textContent = "→" + (ev.lang || "") + " " + ev.text;
      lastLive.appendChild(tr);
      lastLive.dataset.copy += "\n  →" + (ev.lang || "") + " " + ev.text;
      if (pinned) scrollToBottom();
      break;
    }
    case "refine": {
      if (!ev.text) break;
      // The server replays its recent refines to every new connection, all
      // at once; those have no real arrival time, so they get no clock.
      const replayed = Date.now() - openedAt < REPLAY_WINDOW_MS;
      append("refined", makeLine(ev.text, { time: replayed ? "" : clock(), speaker: ev.speaker }));
      break;
    }
    case "session_reset": {
      clearFeed("live");
      clearFeed("refined");
      clearPartial();
      break;
    }
    default:
      break;
  }
}

// ---- connection ------------------------------------------------------------

function setState(next) {
  state = next;
  statusBox.dataset.state = next;
  statusText.textContent = STATUS_TEXT[next];
  hint.hidden = next !== "down";
}

function connect() {
  clearTimeout(retryTimer);
  // While hayamimi is down, keep saying so between retries instead of
  // flickering back to "connecting".
  if (state !== "down") setState("connecting");
  es = new EventSource(SERVER + "/events");
  es.onopen = () => {
    retryMs = RETRY_MIN_MS;
    openedAt = Date.now();
    // The replay that follows rebuilds this tab, so start it empty.
    clearFeed("refined");
    setState("live");
  };
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(ev);
  };
  es.onerror = () => {
    es.close();
    es = null;
    clearPartial();
    setState("down");
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };
}

// ---- toolbar ---------------------------------------------------------------

function showToast(msg) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1600);
}

function selectTab(key) {
  active = key;
  for (const k of Object.keys(tabs)) {
    tabs[k].setAttribute("aria-selected", String(k === key));
    feeds[k].hidden = k !== key;
  }
  scrollToBottom();
}

tabs.live.addEventListener("click", () => selectTab("live"));
tabs.refined.addEventListener("click", () => selectTab("refined"));
$("font-up").addEventListener("click", () => changeFont(FONT_STEP));
$("font-down").addEventListener("click", () => changeFont(-FONT_STEP));

$("copy").addEventListener("click", async () => {
  const text = [...feeds[active].querySelectorAll(".line")].map((l) => l.dataset.copy).join("\n");
  if (!text) {
    showToast("コピーする字幕がありません");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("コピーしました");
  } catch {
    showToast("コピーできませんでした");
  }
});

$("clear").addEventListener("click", () => {
  clearFeed("live");
  clearFeed("refined");
  clearPartial();
  jump.hidden = true;
});

connect();
