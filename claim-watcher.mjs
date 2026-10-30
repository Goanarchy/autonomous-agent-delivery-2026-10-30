// Watches Taskmarket for new claim-mode tasks on Base and claims them immediately.
// v2: 15s poll, plus it logs every newly seen open task to opportunities.jsonl so the
// operator can respond to fresh bounty work before the crowd arrives.
import { spawn } from "node:child_process";
import fs from "node:fs";

const API = "https://taskmarket.dev/api/tasks?status=open&limit=100";
const POLL_MS = 15_000;
const MAX_STAKE = 1_700_000n; // 1.70 USDC of the 1.957 available
const MIN_REWARD = 500_000n; // 0.50 USDC
const MIN_LEAD_MS = 20 * 60 * 1000; // only take tasks with >=20 min left
const STATE = "claim-watcher-state.json";
const QUEUE = "claim-queue.json";
const OPPS = "opportunities.jsonl";

const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync("claim-watcher.log", line + "\n");
};

const state = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, "utf8"))
  : { seen: {}, claimed: [], tasks: {} };
state.tasks = state.tasks || {};

const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

function runClaim(taskId) {
  return new Promise((resolve) => {
    const p = spawn("taskmarket", ["--network", "base", "task", "claim", taskId, "--yes"], {
      shell: true,
      windowsHide: true,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out: out.slice(0, 2000) }));
  });
}

function noteNewTask(t) {
  if (state.tasks[t.id]) return false;
  state.tasks[t.id] = { ref: t.referenceCode, mode: t.mode, seenAt: new Date().toISOString() };
  const row = {
    at: new Date().toISOString(),
    ref: t.referenceCode,
    id: t.id,
    mode: t.mode,
    reward: Number(t.reward) / 1e6,
    subs: Number(t.submissionCount || 0),
    chainId: t.chainId,
    expiry: t.expiryTime,
    tags: t.tags,
    title: (t.description || "").split("\n")[0].slice(0, 90),
  };
  fs.appendFileSync(OPPS, JSON.stringify(row) + "\n");
  return true;
}

async function poll() {
  let tasks;
  try {
    const r = await fetch(API, { headers: { accept: "application/json" } });
    tasks = (await r.json()).tasks || [];
  } catch (e) {
    return log("poll error", String(e).slice(0, 120));
  }

  // Log brand-new tasks regardless of mode.
  for (const t of tasks) {
    if (noteNewTask(t)) {
      log(`NEW ${t.referenceCode} mode=${t.mode} reward=${Number(t.reward) / 1e6} subs=${t.submissionCount} exp=${t.expiryTime}`);
    }
  }
  save();

  const now = Date.now();
  const candidates = tasks.filter((t) => {
    if (t.mode !== "claim" || t.status !== "open") return false;
    if (t.chainId !== 8453) return false;
    const stake = BigInt(t.enforcedClaimStake || "0");
    const reward = BigInt(t.reward || "0");
    if (stake > MAX_STAKE || reward < MIN_REWARD) return false;
    const left = new Date(t.expiryTime).getTime() - now;
    if (left < MIN_LEAD_MS) return false;
    if (t.claimedBy) return false;
    return true;
  });

  const busy = state.claimed.some((c) => c.status === "pending" || c.status === "claimed");
  if (busy) return log("already holding a claim, skipping", candidates.length, "candidate(s)");

  for (const t of candidates) {
    if (state.seen[t.id]) continue;
    state.seen[t.id] = new Date().toISOString();
    log(`CLAIMING ${t.referenceCode} reward=${Number(t.reward) / 1e6} stake=${Number(t.enforcedClaimStake) / 1e6}`);
    const res = await runClaim(t.id);
    log(`${t.referenceCode} exit=${res.code} ${res.out.replace(/\s+/g, " ").slice(0, 300)}`);
    const ok = res.code === 0 && res.out.includes('"ok":true');
    state.claimed.push({
      ref: t.referenceCode,
      id: t.id,
      reward: t.reward,
      stake: t.enforcedClaimStake,
      expiry: t.expiryTime,
      status: ok ? "claimed" : "failed",
      at: new Date().toISOString(),
    });
    save();
    if (ok) {
      fs.writeFileSync(
        QUEUE,
        JSON.stringify(
          {
            ref: t.referenceCode,
            id: t.id,
            reward: Number(t.reward) / 1e6,
            expires: t.expiryTime,
            description: t.description,
            tags: t.tags,
            claimedAt: new Date().toISOString(),
            deliverTo: "taskmarket --network base task submit " + t.id + " --file <path>",
          },
          null,
          2
        )
      );
      log("QUEUE updated ->", QUEUE);
      return;
    }
  }
  log("poll ok", tasks.filter((t) => t.mode === "claim").length, "claim tasks", candidates.length, "eligible");
}

log("watcher v2 started");
await poll();
setInterval(poll, POLL_MS);
