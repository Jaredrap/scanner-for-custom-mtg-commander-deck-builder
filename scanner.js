/* Commander Forge — live card scanner (runs top-level in Safari/Chrome). */
(function () {
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const LS = "cforge.scanner.v1";

// ------------------------------------------------------------ state
let DECK = null;          // {id, name, cmd, entries:[{n, k:'p'|'a'|'n'|'o', c, why, swap}]}
let VOCAB = [];           // [{key, e}]
let pulled = [];          // names
let log = [];             // [{n,k,t}]
let worker = null, running = false, paused = false, busy = false, stream = null, track = null;
let audio = null;
const recent = [];        // recent match names (for stability)
let lastShown = null, lastShownAt = 0, emptyStreak = 0;

function save() { try { localStorage.setItem(LS, JSON.stringify({deck: DECK, pulled, log: log.slice(0, 200)})); } catch (e) {} }
function load() { try { const j = JSON.parse(localStorage.getItem(LS) || "null"); if (j && j.deck) { setDeck(j.deck); pulled = j.pulled || []; log = j.log || []; } } catch (e) {} }

// ------------------------------------------------------------ deck payload
async function decodeCode(txt) {
  txt = txt.trim();
  if (txt.startsWith("CF1:")) {
    const b64 = txt.slice(4).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ds = new DecompressionStream("gzip");
    const out = await new Response(new Blob([bin]).stream().pipeThrough(ds)).text();
    return JSON.parse(out);
  }
  // plain decklist fallback
  const entries = new Map(); let cmd = []; let section = "main";
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const h = line.replace(/^\/\/\s*|:$/g, "").toLowerCase();
    if (/^commanders?$/.test(h)) { section = "cmd"; continue; }
    if (/^(deck|main|mainboard)$/.test(h)) { section = "main"; continue; }
    if (/^(sideboard|maybeboard)$/.test(h)) { section = "side"; continue; }
    if (section === "side") continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+?)(?:\s+[\(\[][A-Za-z0-9]{2,6}[\)\]].*)?(?:\s+\*[A-Z]+\*)*$/);
    const qty = m ? +m[1] : 1, name = (m ? m[2] : line).trim();
    if (/^(plains|island|swamp|mountain|forest|wastes)$/i.test(name)) continue;
    const e = entries.get(name) || {n: name, k: "p", c: 0}; e.c += qty; entries.set(name, e);
    if (section === "cmd") cmd.push(name);
  }
  return {v: 1, id: "plain-" + Date.now(), name: "Pasted decklist", cmd, entries: [...entries.values()], plain: true};
}
function setDeck(d) {
  DECK = d;
  VOCAB = d.entries.map(e => {
    const front = e.n.split(" // ")[0];
    return {key: norm(front), e};
  }).filter(v => v.key.length >= 3);
  $("#deckName").textContent = d.name;
  buildAllVocab();
  renderAll();
}

// ------------------------------------------------------------ matching
function lev(a, b, max) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = new Array(n + 1); for (let k = 0; k <= n; k++) prev[k] = k;
  for (let i = 1; i <= m; i++) {
    const cur = [i]; let best = i;
    for (let k = 1; k <= n; k++) { const v = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1)); cur[k] = v; if (v < best) best = v; }
    if (best > max) return max + 1; prev = cur;
  }
  return prev[n];
}
let ALLV = [];
function buildAllVocab() {
  if (!self.CF_NAMES) return;
  const have = new Set(VOCAB.map(v => v.key));
  ALLV = self.CF_NAMES.map(n => ({key: norm(n), e: {n, k: "x"}})).filter(v => v.key.length >= 3 && !have.has(v.key));
  // trigram index so we only run edit distance on plausible names
  TRI = new Map();
  ALLV.forEach((v, i) => { for (const g of grams(v.key)) { let a = TRI.get(g); if (!a) TRI.set(g, a = []); a.push(i); } });
}
let TRI = new Map();
function grams(s) { const t = " " + s + " ", out = new Set(); for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3)); return out; }
function allCandidates(s) {
  const cnt = new Map(); const gs = grams(s);
  for (const g of gs) { const a = TRI.get(g); if (!a || a.length > 4000) continue; for (const i of a) cnt.set(i, (cnt.get(i) || 0) + 1); }
  const need = Math.max(2, Math.floor(gs.size * 0.35));
  const out = []; for (const [i, c] of cnt) if (c >= need) out.push(ALLV[i]);
  return out;
}
function match(raw) {
  const r = matchIn(raw, VOCAB, DECK && DECK.plain ? 0.84 : 0.70);
  if (r && r.v) return r;
  if (!ALLV.length) return r;
  const s = norm(raw); if (s.length < 5) return r;
  const r2 = matchIn(raw, allCandidates(s), 0.76, true);           // a real card that just isn't in this deck/collection list
  return r2 && r2.v ? r2 : r;
}
function matchIn(raw, LIST, strictness, tight) {
  const s = norm(raw); if (s.length < 3) return null;
  let best = null, bs = 0, second = 0;
  for (const v of LIST) {
    if (tight && Math.abs(v.key.length - s.length) > 4) continue;
    const k = v.key;
    const max = Math.max(2, Math.ceil(k.length * 0.45));
    // compare full read, and the read trimmed to the name's length (OCR often adds junk at the end)
    // lev() returns max+1 when it gives up early, so anything over max counts as no match
    const d1 = lev(s, k, max);
    let sim = d1 > max ? 0 : 1 - d1 / Math.max(k.length, s.length);
    if (s.length > k.length) { const d2 = lev(s.slice(0, k.length + 1), k, max); if (d2 <= max) sim = Math.max(sim, 1 - (d2 + 0.5) / k.length); }
    // OCR picked up junk at the start (e.g. a frame edge read as letters)
    if (s.length > k.length + 1) { for (let off = 1; off <= Math.min(4, s.length - k.length); off++) { const d4 = lev(s.slice(off, off + k.length), k, max); if (d4 <= max) sim = Math.max(sim, 1 - (d4 + 0.4 + 0.1 * off) / k.length); } }
    // partial read: the name got cut off on the right
    if (s.length >= 6 && s.length < k.length) { const mx = Math.ceil(s.length * 0.35); const d3 = lev(s, k.slice(0, s.length), mx); if (d3 <= mx) sim = Math.max(sim, (1 - d3 / s.length) * (0.72 + 0.28 * s.length / k.length)); }
    if (sim > bs) { second = bs; bs = sim; best = v; } else if (sim > second) second = sim;
  }
  if (!best) return null;
  const ok = (bs >= strictness && bs - second >= 0.05) || bs >= 0.9;
  return ok ? {v: best, sim: bs} : {v: null, sim: bs, near: best};
}

// ------------------------------------------------------------ camera + OCR
function setVerdict(cls, v, n, w) {
  const el = $("#verdict"); el.className = cls; $("#stage").className = cls;
  el.innerHTML = `<div class="v">${esc(v)}</div>${n ? `<div class="n">${esc(n)}</div>` : ""}${w ? `<div class="w">${esc(w)}</div>` : ""}`;
}
function layoutGuide() {
  const st = $("#stage").getBoundingClientRect();
  const W = st.width, H = st.height;
  let gw = W * 0.86, gh = gw * 88 / 63;
  if (gh > H * 0.9) { gh = H * 0.9; gw = gh * 63 / 88; }
  const g = $("#guide"); g.style.width = gw + "px"; g.style.height = gh + "px"; g.style.left = (W - gw) / 2 + "px"; g.style.top = (H - gh) / 2 + "px";
  const b = $("#band"); b.style.top = gh * 0.03 + "px"; b.style.height = gh * 0.085 + "px"; b.style.left = gw * 0.03 + "px"; b.style.right = gw * 0.2 + "px";
}
async function initOCR() {
  if (worker) return worker;
  const base = new URL(".", location.href).href;
  setStart("Loading the text reader (first time ≈ 8 MB)…");
  // the engine files may sit next to this page or in an ocr/ folder — try both
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  let dir = "";
  try { await loadScript("eng-data.js?v=2"); } catch (e) { dir = "ocr/"; try { await loadScript("ocr/eng-data.js?v=2"); } catch (e2) { throw new Error("couldn't load OCR data (eng-data.js not found next to the page or in ocr/)"); } }
  try { await loadScript(dir + "names.js?v=3"); } catch (e) { try { await loadScript("names.js?v=3"); } catch (e2) {} }
  buildAllVocab();
  if (typeof Tesseract === "undefined") { try { await loadScript(dir + "tesseract.min.js?v=2"); } catch (e) { throw new Error("couldn't load tesseract.min.js"); } }
  const bin = Uint8Array.from(atob(self.ENG_TRAINEDDATA_B64), c => c.charCodeAt(0));
  self.ENG_TRAINEDDATA_B64 = null;
  worker = await Tesseract.createWorker([{code: "eng", data: bin}], 1, {
    workerPath: base + dir + "worker.min.js", corePath: base + dir, workerBlobURL: false, cacheMethod: "none", gzip: true,
  });
  await worker.setParameters({
    tessedit_pageseg_mode: "7",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,'- ",
    preserve_interword_spaces: "1",
  });
  return worker;
}
function setStart(msg, err) { $("#startMsg").textContent = msg; $("#err").textContent = err || ""; }
async function startCamera() {
  if (!DECK) { setStart("Load a deck first (Deck tab below)."); showTab("load"); return; }
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume && audio.resume();
  } catch (e) {}
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStart("This browser view can't use the camera.", "Open this page directly in Safari or Chrome (not inside another app's viewer). If it still fails, use the GitHub Pages copy.");
    return;
  }
  $("#btnStart").disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1080}}});
  } catch (e) {
    $("#btnStart").disabled = false;
    setStart("Camera blocked.", (e && e.name === "NotAllowedError" ? "Camera permission was refused or this page isn't allowed to use it. " : (e && e.message || "") + " ") + "If you opened this inside the Claude app, open it in Safari instead; otherwise use the GitHub Pages copy.");
    return;
  }
  const v = $("#vid"); v.srcObject = stream; await v.play().catch(() => {});
  track = stream.getVideoTracks()[0];
  try { const caps = track.getCapabilities && track.getCapabilities(); if (caps && caps.torch) $("#btnTorch").style.display = "inline-block"; if (caps && caps.focusMode && caps.focusMode.includes("continuous")) track.applyConstraints({advanced: [{focusMode: "continuous"}]}); } catch (e) {}
  try { await initOCR(); } catch (e) { setStart("Couldn't start the text reader.", String(e && e.message || e)); $("#btnStart").disabled = false; return; }
  $("#start").style.display = "none";
  layoutGuide();
  running = true; loop();
}
const cvs = document.createElement("canvas"), ctx = cvs.getContext("2d", {willReadFrequently: true});
const reg = document.createElement("canvas"), rctx = reg.getContext("2d", {willReadFrequently: true});
let preview = null, pctx = null, frameNo = 0;
function ensurePreview() {
  if (preview) return;
  const wrap = document.createElement("div"); wrap.className = "panel"; wrap.style.marginTop = "8px"; wrap.style.padding = "8px";
  wrap.innerHTML = `<div class="small muted" style="margin-bottom:4px">What the reader sees <span id="readTxt" style="color:#f2cf83"></span></div>`;
  preview = document.createElement("canvas"); preview.style.width = "100%"; preview.style.height = "44px"; preview.style.background = "#fff"; preview.style.borderRadius = "6px";
  wrap.appendChild(preview); $("#stage").insertAdjacentElement("afterend", wrap); pctx = preview.getContext("2d");
}
// Map an element-space rectangle (relative to the stage) to video pixels.
function toVideo(rect) {
  const v = $("#vid"); const vw = v.videoWidth, vh = v.videoHeight;
  const st = $("#stage").getBoundingClientRect();
  const scale = Math.max(st.width / vw, st.height / vh);
  const ox = (st.width - vw * scale) / 2, oy = (st.height - vh * scale) / 2;
  return {x: (rect.left - st.left - ox) / scale, y: (rect.top - st.top - oy) / scale, w: rect.width / scale, h: rect.height / scale};
}
function grabBand() {
  const v = $("#vid"); if (!v.videoWidth) return null;
  frameNo++;
  const g = $("#guide").getBoundingClientRect();
  const G = toVideo(g);
  // Search region: top 24% of the card, skipping the right side where the mana cost sits.
  const sx = G.x + G.w * 0.03, sw = G.w * 0.80, sy = G.y - G.h * 0.02, sh = G.h * 0.26;
  const RW = 480, RH = Math.round(RW * sh / sw);
  reg.width = RW; reg.height = RH;
  rctx.drawImage(v, sx, sy, sw, sh, 0, 0, RW, RH);
  const rd = rctx.getImageData(0, 0, RW, RH).data;
  const gray = new Float32Array(RW * RH);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = rd[i] * 0.299 + rd[i + 1] * 0.587 + rd[i + 2] * 0.114;
  // Row energy = horizontal gradient; text lines light up.
  const energy = new Float32Array(RH);
  for (let y = 0; y < RH; y++) { let e = 0; const o = y * RW; for (let x = 1; x < RW; x++) e += Math.abs(gray[o + x] - gray[o + x - 1]); energy[y] = e / RW; }
  const lineH = Math.max(8, Math.round(RH * (0.062 / 0.26)));       // name line ≈ 6.2% of card height
  let best = 0, bestY = Math.round(RH * 0.2), run = 0;
  for (let y = 0; y < RH; y++) { run += energy[y]; if (y >= lineH) run -= energy[y - lineH]; if (y >= lineH - 1 && run > best) { best = run; bestY = y - lineH + 1; } }
  // Alternate between the detected line and the fixed gold strip, so either alignment works.
  let by, bh;
  if (frameNo % 2) { by = bestY - lineH * 0.25; bh = lineH * 1.5; }
  else { by = RH * (0.045 / 0.26); bh = RH * (0.095 / 0.26); }
  by = Math.max(0, by); bh = Math.min(RH - by, bh);
  // Re-crop the chosen line from the full-resolution video for sharpness.
  const vy = sy + by / RH * sh, vhh = bh / RH * sh;
  const outH = 96, outW = Math.min(1400, Math.round(sw / vhh * outH));
  cvs.width = outW; cvs.height = outH;
  ctx.drawImage(v, sx, vy, sw, vhh, 0, 0, outW, outH);
  const img = ctx.getImageData(0, 0, outW, outH), d = img.data;
  const n = outW * outH, gr = new Float32Array(n), hist = new Uint32Array(256);
  for (let i = 0, k = 0; k < n; i += 4, k++) { const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; gr[k] = y; hist[y | 0]++; }
  // Contrast stretch between the 3rd and 97th percentile.
  let acc = 0, lo = 0, hi = 255; for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= n * 0.03) { lo = t; break; } }
  acc = 0; for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= n * 0.03) { hi = t; break; } }
  const span = Math.max(1, hi - lo);
  let mean = 0; for (let k = 0; k < n; k++) mean += gr[k]; mean /= n;
  const median = (() => { let a = 0; for (let t = 0; t < 256; t++) { a += hist[t]; if (a >= n / 2) return t; } return 128; })();
  const invert = median < 110;                                      // light text on a dark title bar
  for (let i = 0, k = 0; k < n; i += 4, k++) { let y = (gr[k] - lo) / span * 255; y = y < 0 ? 0 : y > 255 ? 255 : y; if (invert) y = 255 - y; d[i] = d[i + 1] = d[i + 2] = y; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  ensurePreview();
  preview.width = outW; preview.height = outH; pctx.drawImage(cvs, 0, 0);
  return {canvas: cvs, contrast: span / 4};
}
let frames = 0, lastFps = performance.now();
async function loop() {
  if (!running) return;
  if (paused || busy) { requestAnimationFrame(loop); return; }
  busy = true;
  try {
    const g = grabBand();
    if (g && g.contrast > 8) {
      const r = await worker.recognize(g.canvas);
      const text = (r.data.text || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      $("#readout").textContent = text ? `“${text}”` : "";
      const rt = document.getElementById("readTxt"); if (rt) rt.textContent = text ? `“${text}”` : "";
      handleRead(text);
    } else { $("#readout").textContent = ""; handleRead(""); }
    frames++;
    const now = performance.now(); if (now - lastFps > 2000) { $("#fps").textContent = `${(frames * 1000 / (now - lastFps)).toFixed(1)} reads/s`; frames = 0; lastFps = now; }
  } catch (e) { console.warn(e); }
  busy = false;
  setTimeout(() => requestAnimationFrame(loop), 30);
}

// ------------------------------------------------------------ verdicts
function beep(kind) {
  try {
    if (!audio) return; const o = audio.createOscillator(), gn = audio.createGain();
    const f = {in: 880, add: 660, no: 300, unk: 200}[kind] || 400;
    o.frequency.value = f; gn.gain.value = kind === "no" ? 0.03 : 0.08; o.connect(gn); gn.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (kind === "in" ? 0.16 : 0.07));
    if (kind === "in") { const o2 = audio.createOscillator(); o2.frequency.value = 1175; o2.connect(gn); o2.start(audio.currentTime + 0.18); o2.stop(audio.currentTime + 0.32); }
  } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(kind === "in" ? [70, 40, 70] : kind === "add" ? 60 : 15); } catch (e) {}
}
function handleRead(text) {
  if (!DECK) return;
  const m = text ? match(text) : null;
  if (!m || !m.v) {
    emptyStreak++;
    if (emptyStreak >= 3) { recent.length = 0; if (lastShown && emptyStreak === 3) lastShown = null; }
    return;
  }
  emptyStreak = 0;
  const name = m.v.e.n;
  recent.push(name); if (recent.length > 3) recent.shift();
  const votes = recent.filter(x => x === name).length;
  if (votes < 2 && m.sim < 0.84) return;                    // need two agreeing reads unless very confident
  if (lastShown === name && performance.now() - lastShownAt < 4000) return; // same card still in frame
  lastShown = name; lastShownAt = performance.now();
  decide(m.v.e);
}
function decide(e, manual) {
  const need = e.c || 1, got = pulled.filter(x => x === e.n).length;
  let cls, v, w;
  if (e.k === "p") {
    if (got >= need) { cls = "no"; v = "SPARE COPY"; w = "Already pulled for this deck."; beep("no"); }
    else { cls = "in"; v = DECK.cmd.includes(e.n) ? "COMMANDER — SET ASIDE" : "PULL — SET ASIDE"; w = e.why || ""; pulled.push(e.n); beep("in"); }
  } else if (e.k === "a") { cls = "add"; v = "WORTH ADDING"; w = (e.why || "") + (e.swap ? ` · swap for ${e.swap}` : ""); beep("add"); }
  else if (e.k === "o") { cls = "no"; v = "Off-color"; w = "Outside the commander's colors"; beep("no"); }
  else if (e.k === "x") { cls = "no"; v = "Not in this deck"; w = "Not in the collection list from Commander Forge"; beep("no"); }
  else { cls = "no"; v = "Not needed"; w = "Doesn't beat what's already in the deck"; beep("no"); }
  setVerdict(cls, v, e.n, w);
  log.unshift({n: e.n, k: cls, v, t: Date.now()}); if (log.length > 300) log.pop();
  save(); renderAll();
}

// ------------------------------------------------------------ lists
let tab = "log";
function showTab(t) { tab = t; document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === t)); ["log", "left", "adds", "load"].forEach(x => $("#t-" + x).style.display = x === t ? "block" : "none"); renderAll(); }
function renderAll() {
  if (!DECK) { $("#progTxt").textContent = "No deck loaded"; return; }
  const pulls = DECK.entries.filter(e => e.k === "p");
  const total = pulls.reduce((a, e) => a + (e.c || 1), 0);
  const got = pulls.reduce((a, e) => a + Math.min(e.c || 1, pulled.filter(x => x === e.n).length), 0);
  $("#progTxt").textContent = `${got} / ${total} pulled`;
  $("#prog").style.width = (got / Math.max(1, total) * 100) + "%";
  if (tab === "log") $("#t-log").innerHTML = log.slice(0, 60).map(l => `<div class="item"><span class="tag ${l.k}">${l.k === "in" ? "PULL" : l.k === "add" ? "ADD?" : "SKIP"}</span>${esc(l.n)}<span class="sp"></span><span class="small muted">${new Date(l.t).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}</span></div>`).join("") || `<p class="small muted">Scanned cards show up here.</p>`;
  if (tab === "left") {
    const rows = pulls.map(e => ({e, left: (e.c || 1) - pulled.filter(x => x === e.n).length})).sort((a, b) => (a.left <= 0) - (b.left <= 0) || a.e.n.localeCompare(b.e.n));
    $("#t-left").innerHTML = rows.map(r => `<div class="item ${r.left <= 0 ? "done" : ""}" data-toggle="${esc(r.e.n)}"><input type="checkbox" ${r.left <= 0 ? "checked" : ""}> ${esc(r.e.n)}${(r.e.c || 1) > 1 ? ` ×${r.e.c}` : ""}</div>`).join("");
  }
  if (tab === "adds") {
    const seen = [...new Set(log.filter(l => l.k === "add").map(l => l.n))];
    const map = new Map(DECK.entries.map(e => [e.n, e]));
    $("#t-adds").innerHTML = seen.length ? seen.map(n => { const e = map.get(n) || {}; return `<div class="item"><span class="tag add">ADD?</span><div>${esc(n)}<div class="small muted">${esc(e.why || "")}${e.swap ? ` · swap for ${esc(e.swap)}` : ""}</div></div></div>`; }).join("") + `<p class="small muted">Make the swaps in Commander Forge's Deck Lab.</p>` : `<p class="small muted">Cards worth adding that you scan are collected here.</p>`;
  }
}

// ------------------------------------------------------------ wiring
$("#btnStart").onclick = startCamera;
$("#btnPause").onclick = () => { paused = !paused; $("#btnPause").textContent = paused ? "Resume" : "Pause"; if (paused) setVerdict("", "Paused", "", "Tap Resume to keep scanning."); };
let torchOn = false;
$("#btnTorch").onclick = async () => { torchOn = !torchOn; try { await track.applyConstraints({advanced: [{torch: torchOn}]}); } catch (e) {} };
$("#btnUndo").onclick = () => { const l = log.shift(); if (l && l.k === "in") { const i = pulled.lastIndexOf(l.n); if (i >= 0) pulled.splice(i, 1); } lastShown = null; save(); renderAll(); setVerdict("", "Undone", l ? l.n : "", "Scan it again if needed."); };
document.querySelector(".tabs").onclick = e => { const t = e.target.dataset.t; if (t) showTab(t); };
$("#t-left").onclick = e => { const it = e.target.closest("[data-toggle]"); if (!it) return; const n = it.dataset.toggle; const en = DECK.entries.find(x => x.n === n); const got = pulled.filter(x => x === n).length; if (got >= (en.c || 1)) { pulled.splice(pulled.lastIndexOf(n), 1); } else pulled.push(n); save(); renderAll(); };
$("#btnLoad").onclick = async () => {
  try { const d = await decodeCode($("#code").value); if (!d.entries || !d.entries.length) throw new Error("no cards"); if (!DECK || DECK.id !== d.id) { pulled = d.pulled || []; log = []; } setDeck(d); save(); $("#code").value = ""; setStart(`Loaded “${d.name}”. Start the camera.`); showTab("log"); }
  catch (e) { alert("That code couldn't be read: " + (e.message || e)); }
};
$("#btnCopyPulled").onclick = async () => { const txt = "CFP:" + JSON.stringify({id: DECK && DECK.id, pulled}); try { await navigator.clipboard.writeText(txt); $("#btnCopyPulled").textContent = "Copied!"; } catch (e) { $("#code").value = txt; $("#code").select(); } };
window.addEventListener("resize", layoutGuide);
window.addEventListener("orientationchange", () => setTimeout(layoutGuide, 300));
document.addEventListener("visibilitychange", () => { if (document.hidden) paused = true; else if (running) { paused = false; $("#btnPause").textContent = "Pause"; } });
load(); layoutGuide();
if (!DECK) showTab("load"); else setStart(`“${DECK.name}” loaded. Start the camera.`);
// allow a code in the URL hash for quick hand-off
if (location.hash.startsWith("#CF1:")) { $("#code").value = decodeURIComponent(location.hash.slice(1)); $("#btnLoad").click(); history.replaceState(null, "", location.pathname); }
window.CFScanner = {grabBand, match, decide, setDeck, handleRead, get DECK() { return DECK; }, get pulled() { return pulled; }};
})();
