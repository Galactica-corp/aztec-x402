/**
 * The funding page: one self-contained HTML document, no external scripts.
 * It talks to the user's browser wallet over EIP-1193 and to the local
 * server; the server prepares every transaction's calldata, so the page
 * holds no ABI, no keys, and no claim secret.
 */
export function renderFundPage(token: string): string {
  return PAGE.replace("__TOKEN__", JSON.stringify(token));
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fund your agent</title>
<style>
  :root {
    --bg: #f7f7f5; --card: #ffffff; --text: #1b1b1f; --muted: #62636b; --line: #e3e3e0;
    --accent: #3a4fd8; --accent-text: #ffffff; --ok: #1d7f4e; --warn: #9a5b00; --err: #b3261e;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121316; --card: #1b1c20; --text: #ececf0; --muted: #a0a1aa; --line: #2c2d33;
      --accent: #8c9bff; --accent-text: #0d0f1a; --ok: #5cd39a; --warn: #f0b45c; --err: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; min-width: 0; }
  .mono { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
  .note { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 10px 16px;
    background: var(--accent); color: var(--accent-text); cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  ol.steps { list-style: none; padding: 0; margin: 0; }
  ol.steps li { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
  ol.steps li:first-child { border-top: 0; }
  .dot { flex: none; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--line);
    display: grid; place-items: center; font-size: 12px; margin-top: 1px; }
  li.active .dot { border-color: var(--accent); color: var(--accent); }
  li.done .dot { border-color: var(--ok); background: var(--ok); color: var(--card); }
  li.failed .dot { border-color: var(--err); color: var(--err); }
  li .label { flex: 1; min-width: 0; }
  li .detail { color: var(--muted); font-size: 13px; }
  .status { margin-top: 12px; font-weight: 600; }
  .status.ok { color: var(--ok); } .status.err { color: var(--err); } .status.warn { color: var(--warn); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Fund your agent</h1>
  <p class="sub" id="sub">Loading…</p>

  <section class="card">
    <h2>Deposit</h2>
    <dl id="facts"></dl>
    <p class="note" id="privacy"></p>
  </section>

  <section class="card">
    <h2>Steps</h2>
    <ol class="steps" id="steps"></ol>
    <div style="margin-top:16px"><button id="go" disabled>Connect wallet</button></div>
    <div class="status" id="status" role="status" aria-live="polite"></div>
  </section>
</main>
<script>
const TOKEN = __TOKEN__;
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path + "?t=" + encodeURIComponent(TOKEN), body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};
const short = (a) => a ? a.slice(0, 10) + "…" + a.slice(-8) : "";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let state, owner, txs = [], txStatus = {}, l1Explorer;

function setStatus(text, kind) { const el = $("status"); el.textContent = text || ""; el.className = "status " + (kind || ""); }

function renderFacts() {
  const b = state.bridge;
  $("sub").textContent = "Sign a deposit on " + state.l1ChainName + " with your browser wallet. The agent claims it on Aztec " + state.network + ".";
  $("facts").innerHTML = [
    ["Agent (Aztec)", '<span class="mono">' + esc(state.agent) + "</span>"],
    ["You send", esc(state.amount + " " + b.l1Token.symbol) + " on " + esc(state.l1ChainName)],
    ["Agent receives", esc(b.result)],
    ["Portal", '<span class="mono">' + esc(b.portal) + "</span>"],
  ].map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("");
  $("privacy").textContent = b.privacy;
}

function renderSteps() {
  const phase = state.phase;
  const after = [
    { id: "message", label: "Message reaches Aztec", detail: "Usually a few minutes after the deposit is mined." },
    { id: "claim", label: "Agent claims the deposit", detail: "The agent proves the claim on Aztec." },
  ];
  const order = ["signing", "waiting_l1", "waiting_message", "claiming", "done"];
  const reached = (p) => order.indexOf(phase) >= order.indexOf(p);
  const rows = txs.map((t, i) => {
    const s = txStatus[t.id] || "pending";
    const link = s.hash && l1Explorer ? ' · <a href="' + l1Explorer + "/tx/" + s.hash + '" target="_blank" rel="noopener">view tx</a>' : "";
    const cls = s === "pending" ? "" : s.state;
    return '<li class="' + cls + '"><span class="dot">' + (s.state === "done" ? "✓" : i + 1) + '</span><span class="label">' +
      esc(t.label) + '<div class="detail">' + (s.text ? esc(s.text) : "Needs your signature") + link + "</div></span></li>";
  });
  if (!txs.length) rows.push('<li><span class="dot">1</span><span class="label">Connect a wallet on ' + esc(state.l1ChainName) + '<div class="detail">MetaMask or any browser wallet. You need a little ' + esc(state.l1ChainName) + " ETH for gas.</div></span></li>");
  after.forEach((a, i) => {
    const n = (txs.length || 1) + i + 1;
    const active = (a.id === "message" && phase === "waiting_message") || (a.id === "claim" && phase === "claiming");
    const done = (a.id === "message" && reached("claiming")) || (a.id === "claim" && phase === "done");
    const failed = phase === "failed" && ((a.id === "message" && !reached("claiming")) || a.id === "claim");
    const cls = done ? "done" : failed ? "failed" : active ? "active" : "";
    rows.push('<li class="' + cls + '"><span class="dot">' + (done ? "✓" : n) + '</span><span class="label">' + esc(a.label) +
      '<div class="detail">' + esc(a.detail) + "</div></span></li>");
  });
  $("steps").innerHTML = rows.join("");
}

async function refresh() {
  state = await api("/api/state");
  l1Explorer = state.l1ExplorerUrl;
  renderFacts();
  renderSteps();
  if (state.phase === "done") {
    setStatus("Done. The agent's balance is " + state.l2Balance + ".", "ok");
    $("go").disabled = true; $("go").textContent = "Funded";
  } else if (state.phase === "failed") {
    setStatus("Claim failed: " + (state.error || "unknown error") + ". Ask the agent to run \"aztec-x402 fund claim\".", "err");
  } else if (state.phase === "waiting_message") {
    setStatus("Deposit mined. Waiting for it to reach Aztec…", "warn");
  } else if (state.phase === "claiming") {
    setStatus("The agent is claiming the deposit on Aztec…", "warn");
  }
}

async function waitReceipt(hash) {
  for (;;) {
    const r = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) return r;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

async function connect() {
  if (!window.ethereum) {
    setStatus("No browser wallet found. Install MetaMask (or another EIP-1193 wallet) and reload.", "err");
    return;
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  owner = accounts[0];
  const want = "0x" + state.l1ChainId.toString(16);
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId !== want) {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  }
  setStatus("Preparing transactions…");
  txs = (await api("/api/prepare", { owner })).txs;
  setStatus("Connected " + short(owner) + ". " + txs.length + " transaction(s) to sign.");
  renderSteps();
  $("go").textContent = "Sign and send";
  $("go").onclick = () => run().catch(fail);
}

async function run() {
  $("go").disabled = true;
  for (const t of txs) {
    if (txStatus[t.id] && txStatus[t.id].state === "done") continue;
    txStatus[t.id] = { state: "active", text: "Waiting for your signature…" }; renderSteps();
    const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: owner, to: t.to, data: t.data }] });
    txStatus[t.id] = { state: "active", text: "Mining…", hash }; renderSteps();
    const receipt = await waitReceipt(hash);
    if (receipt.status !== "0x1") {
      txStatus[t.id] = { state: "failed", text: "Reverted", hash }; renderSteps();
      throw new Error("Transaction reverted");
    }
    txStatus[t.id] = { state: "done", text: "Confirmed", hash }; renderSteps();
    if (t.id === "deposit") await api("/api/submitted", { l1TxHash: hash, owner });
  }
  $("go").textContent = "Signed";
  await refresh();
}

function fail(e) {
  $("go").disabled = false;
  setStatus((e && e.message) || String(e), "err");
}

(async () => {
  try {
    await refresh();
    $("go").disabled = state.phase !== "signing";
    $("go").onclick = () => connect().catch(fail);
    setInterval(() => { if (!["done", "signing"].includes(state.phase)) refresh().catch(() => {}); }, 4000);
  } catch (e) { fail(e); }
})();
</script>
</body>
</html>
`;
