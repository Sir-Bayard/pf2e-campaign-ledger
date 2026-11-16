import { esc, tipAttr } from "./kit/safe-text.mjs";
import { aggregate } from "./aggregate.mjs";
import { mdEscape } from "./archive.mjs";
import { L, MOD, SKIP, now } from "./constants.mjs";
import { Store } from "./store.mjs";
import { fmtDate, fmtDuration, isAlly, pct, saveLabel, skillLabel } from "./util.mjs";

/* Words and pictures made from the events: the round log, dice, presence, summaries, trends and the recap. */

/** An attack's degree of success (0 to 3) in words. */
const attackResult = (o) => L(["CritMiss", "Miss", "Hit", "CritHit"][o]);
/** A check's degree of success (0 to 3) in words. */
const checkResult = (o) => L(["CritFailure", "Failure", "Success", "CritSuccess"][o]);

/** What an entry is, in a word or two, for the correction button's name. */
const ENTRY_KEYS = { atk: "EntryAttack", dealt: "EntryDealt", healdone: "EntryHealing", save: "EntrySave", skill: "EntrySkill", rec: "EntryRecovery", spell: "EntrySpell", ability: "EntryAbility", down: "EntryDown", kill: "EntryKill", up: "EntryUp", dying: "EntryDying", dead: "EntryDead", reroll: "EntryReroll", hero: "EntryHero", taken: "EntryTaken", healed: "EntryHealed" };
const entryWord = (k) => (ENTRY_KEYS[k] ? L(ENTRY_KEYS[k]) : k);

/** One line of the round-by-round log, or null for events the log leaves out. */
function describe(e) {
  const a = esc(e.a?.n ?? L("Someone"));
  const tg = e.tg ? esc(e.tg.n) : null;
  const it = e.it ? esc(e.it) : null;
  const nat = e.nat === 20 ? L("LogNat20") : e.nat === 1 ? L("LogNat1") : "";
  const res = (word, o) => (o === null || o === undefined ? "" : L("LogResult", { result: word(o) }));
  const by = e.by ? esc(e.by.n) : null;
  switch (e.k) {
    case "atk": return L(tg ? "LogAttackTarget" : "LogAttack", { a, target: tg, with: it ? L("LogWith", { item: it }) : "" }) + res(attackResult, e.o) + nat;
    case "dealt": return L("LogDealt", { a, amount: e.amt, target: tg ?? L("SomeoneLower") }) + (it ? ` (${it})` : "");
    case "healdone": return L("LogHealDone", { a, amount: e.amt, target: tg ?? L("SomeoneLower") }) + (it ? ` (${it})` : "");
    case "save": return L("LogSave", { a, save: esc(e.s ? saveLabel(e.s) : L("Saving")) }) + res(checkResult, e.o) + nat;
    case "skill": return L("LogSkill", { a, skill: esc(skillLabel(e.s)) }) + res(checkResult, e.o) + nat;
    case "rec": return L("LogRecovery", { a }) + res(checkResult, e.o);
    case "spell": return L(it ? "LogSpell" : "LogSpellUnknown", { a, spell: it });
    case "ability": return L(it ? "LogAbility" : "LogAbilityUnknown", { a, ability: it });
    case "down": return L("LogDown", { a }) + (by ? ` (${by})` : "");
    case "kill": return e.a ? L("LogKillBy", { foe: esc(e.v?.n ?? L("AFoe")), a }) : L("LogKill", { foe: esc(e.v?.n ?? L("AFoe")) });
    case "up": return by ? L("LogUpBy", { a, by }) : L("LogUp", { a });
    // HP changed with no chat card claiming it: applied by hand
    case "taken": return e.m ? null : L(by ? "LogTakenHandBy" : "LogTakenHand", { a, amount: e.amt, by });
    case "healed": return e.m ? null : L(by ? "LogHealedHandBy" : "LogHealedHand", { a, amount: e.amt, by });
    case "dying": return L("LogDying", { a, value: e.v ?? "" });
    case "dead": return L("LogDead", { a });
    case "reroll": return L(e.hero ? "LogRerollHero" : "LogReroll", { a }) + res(checkResult, e.to);
    case "hero": return e.lost ? null : L(e.n === 1 ? "LogHeroOne" : "LogHeroMany", { a, n: e.n });
    default: return null;
  }
}

/** Every d20 rolled, per character, tagged with the kind of check. */
function diceData(events) {
  const out = new Map();
  const push = (w, v, kind) => {
    if (!w?.k || !(v >= 1 && v <= 20)) return;
    if (!out.has(w.k)) out.set(w.k, { k: w.k, n: w.n, p: w.p, rolls: [] });
    out.get(w.k).rolls.push({ v, kind });
  };
  for (const e of events) {
    if (e.fx) continue;
    if (e.k === "atk") push(e.a, e.nat0 ?? e.nat, "atk");
    else if (e.k === "save") push(e.a, e.nat0 ?? e.nat, "save");
    else if (e.k === "skill") push(e.a, e.nat0 ?? e.nat, ["perception", "initiative"].includes(e.s) ? "perc" : "skill");
    else if (e.k === "rec") push(e.a, e.nat0 ?? e.nat, "rec");
    else if (e.k === "reroll") push(e.a, e.nat, "reroll");
  }
  return out;
}

function diceStats(vals) {
  const n = vals.length;
  if (!n) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((x, y) => x + y, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const counts = Array(21).fill(0);
  for (const v of vals) counts[v]++;
  const top = Math.max(...counts);
  const mode = top > 1 ? counts.map((c, i) => (c === top ? i : null)).filter((x) => x).join(", ") : "–";
  return { n, mean, median, mode, counts, nat20: counts[20], nat1: counts[1], luck: mean - 10.5 };
}

/**
 * How a set of d20s compares with a fair die, judged against what chance alone explains: a fair d20's average wanders
 * by about 5.77 / sqrt(rolls) either way. Within that it's about average; beyond twice that, running hot or cold; in
 * between, just the number.
 */
function luckText(st) {
  if (st.n < 10) return L("LuckFew");
  const l = st.luck;
  const spread = 5.77 / Math.sqrt(st.n);
  if (Math.abs(l) <= spread) return L("LuckAverage");
  if (Math.abs(l) > 2 * spread) return L(l > 0 ? "LuckHot" : "LuckCold");
  return `${l > 0 ? "+" : "−"}${Math.abs(l).toFixed(1)}`;
}

/** d20 histogram as inline SVG: one bar per face, a dashed line where a fair die would sit. */
function histogram(st) {
  const W = 680, H = 240, PL = 34, R = 10, T = 12, B = 26;
  const pw = W - PL - R, ph = H - T - B, bw = pw / 20;
  const expected = st.n / 20;
  const peak = Math.max(...st.counts.slice(1), expected, 1);
  const step = Math.max(1, Math.ceil(peak / 4));
  const top = step * Math.ceil(peak / step);
  const y = (v) => T + ph - (v / top) * ph;
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line class="pcl-grid-line" x1="${PL}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="pcl-axis" x="${PL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  const bars = [];
  for (let f = 1; f <= 20; f++) {
    const c = st.counts[f];
    const x = PL + (f - 1) * bw + 1, w = bw - 2;
    const h = (c / top) * ph;
    if (h > 0) {
      const r = Math.min(4, h, w / 2), y0 = T + ph - h, y1 = T + ph;
      bars.push(`<path class="pcl-bar" d="M${x},${y1} V${y0 + r} Q${x},${y0} ${x + r},${y0} H${x + w - r} Q${x + w},${y0} ${x + w},${y0 + r} V${y1} Z"/>`);
    }
    const share = Math.round((c / st.n) * 100);
    bars.push(`<rect class="pcl-hit" x="${x - 1}" y="${T}" width="${bw}" height="${ph}"${tipAttr(L(c === 1 ? "HistOne" : "HistMany", { face: f, n: c, share }))}/>`);
    bars.push(`<text class="pcl-axis" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${f}</text>`);
  }
  const ey = y(expected);
  const exp = `<line class="pcl-expected" x1="${PL}" x2="${W - R}" y1="${ey}" y2="${ey}"/><text class="pcl-axis pcl-expected-label" x="${W - R}" y="${ey - 5}" text-anchor="end">${esc(L("HistFair", { n: expected.toFixed(1) }))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid.join("")}${bars.join("")}${exp}</svg>`;
}

/** A day as the Campaign Journal writes a recap's "played" date: "Sun 15 Nov". */
function journalDay(t) {
  const d = new Date(t);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`;
}

/**
 * Who was at the table for a session, from a Bayard's Campaign Journal recap played the same day: the characters of the
 * players ticked there (a player without a character by name). Null when there's no such recap.
 */
function journalAttendance(s) {
  if (!s?.start || !game.modules.get("bayards-campaign-journal")?.active) return null;
  const days = new Set([journalDay(s.start), journalDay(s.end ?? s.start)]);
  for (const j of game.journal ?? []) {
    const f = j.flags?.["bayards-campaign-journal"];
    if (f?.kind !== "recap" || !days.has(f.played) || !Array.isArray(f.attended) || !f.attended.length) continue;
    const names = f.attended.map((id) => game.users.get(id)).filter(Boolean).map((u) => u.character?.name ?? u.name);
    if (names.length) return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }
  return null;
}

/** Who was there: the Journal's attendance for that day, else `names` (the characters who did something in it). */
const presentFor = (s, names) => journalAttendance(s) ?? names ?? null;

/** The player characters who did anything in a set of events (allies left out): [{ k, n }], with the names recorded. */
function presentKeys(events) {
  const seen = new Map();
  for (const e of events) {
    const w = e?.a;
    // A Hero Point reset touches every character, there or not
    if (!w?.p || typeof w.k !== "string" || isAlly(w) || (e.k === "hero" && e.lost)) continue;
    seen.set(w.k, { k: w.k, n: w.n });
  }
  return [...seen.values()];
}

/** Characters [{ k, n }] by their names today (a character renamed since shows under the new name), sorted. */
const namesOf = (list) => (Array.isArray(list) ? list : []).map((w) => (typeof w === "string" ? w : w.k?.startsWith("a:") ? (game.actors.get(w.k.slice(2))?.name ?? w.n) : w.n)).sort((a, b) => a.localeCompare(b));

/** The player characters who did anything in a set of events (allies left out), by their names today. */
const presentIn = (events) => namesOf(presentKeys(events));

/** Copper as coins: "12 gp 5 sp". */
function fmtCoins(cp) {
  const n = Math.round(Math.abs(cp));
  const parts = [[Math.floor(n / 100), "CoinGp"], [Math.floor((n % 100) / 10), "CoinSp"], [n % 10, "CoinCp"]].filter(([v]) => v).map(([v, key]) => L(key, { n: v }));
  return parts.join(" ") || L("CoinGp", { n: 0 });
}

/**
 * Recap lines from the author's other modules, when they're on: clues found (Campaign Trackers), money spent and
 * earned at the market (Marketplace, GM only), people met (NPC Attitudes). Each one line, only when there is
 * something to say, and only what the players already know.
 */
function otherModulesLines(s, { b, t }) {
  const from = s.start;
  const to = s.end ?? now();
  const within = (x) => typeof x === "number" && x >= from && x <= to;
  const lines = [];
  try {
    const api = game.modules.get("pf2e-campaign-trackers")?.active ? game.modules.get("pf2e-campaign-trackers").api : null;
    if (typeof api?.list === "function") {
      let n = 0;
      const quests = new Set();
      for (const q of api.list() ?? []) {
        if (q?.kind !== "quest" || !q.revealed) continue;
        for (const e of q.entries ?? []) if (e?.revealed && within(e.revealedAt)) {
          n++;
          quests.add(q.name);
        }
      }
      if (n) lines.push(L("RecapClues", { n, quests: [...quests].map((x) => t(x)).join(", ") }));
    }
  } catch (e) {
    console.warn(MOD, "couldn't read Campaign Trackers", e);
  }
  try {
    const mp = game.modules.get("pf2e-marketplace");
    if (game.user.isGM && mp?.active) {
      // Marketplace's own read where it has one; buys and sells only (not vault deposits and withdrawals, or trades)
      const log = typeof mp.api?.trades === "function" ? mp.api.trades({ from, to }) : game.settings.get("pf2e-marketplace", "log");
      let spent = 0, earned = 0, trades = 0;
      for (const e of Array.isArray(log) ? log : []) {
        if (!within(e?.t) || typeof e.cp !== "number") continue;
        if (e.kind === "buy") spent += e.cp;
        else if (e.kind === "sell") earned += e.cp;
        else continue;
        trades++;
      }
      if (trades) lines.push(L("RecapMarket", { spent: fmtCoins(spent), earned: fmtCoins(earned) }));
    }
  } catch (e) {
    console.warn(MOD, "couldn't read the Marketplace trade log", e);
  }
  try {
    const api = game.modules.get("pf2e-npc-attitudes")?.active ? game.modules.get("pf2e-npc-attitudes").api : null;
    if (typeof api?.record === "function") {
      const met = game.actors
        .filter((a) => a.type === "npc")
        .filter((a) => {
          const r = api.record(a);
          return r?.met && !r.archived && within(r.metOn);
        })
        .map((a) => (typeof api.knownName === "function" ? api.knownName(a) : a.name));
      if (met.length) lines.push(L("RecapMet", { names: met.map((x) => b(x)).join(", ") }));
    }
  } catch (e) {
    console.warn(MOD, "couldn't read NPC Attitudes", e);
  }
  return lines;
}

/** A session's numbers as Markdown, to go beside a recap: who was there, the highlights, the party table. */
async function statsMarkdown(sessionId) {
  const r = await recapLines(sessionId, { b: (x) => `**${mdEscape(String(x))}**`, t: (x) => mdEscape(String(x)) });
  if (!r) return null;
  const cols = [["MdCharacter", (a) => mdEscape(a.n)], ["MdAttacks", (a) => a.atk], ["MdHitPct", (a) => pct(a.hit, a.atkKnown)], ["MdCrits", (a) => a.crit], ["MdDamage", (a) => a.dealt], ["MdFriendlyFire", (a) => a.ff], ["MdKills", (a) => a.kills], ["MdTaken", (a) => a.taken], ["MdHealing", (a) => a.healDone], ["MdDowned", (a) => a.down], ["MdNat20", (a) => a.nat20], ["MdNat1", (a) => a.nat1]].map(([key, f]) => [L(key), f]);
  const table = (rows) => [`| ${cols.map(([h]) => h).join(" | ")} |`, `|${cols.map(() => " --- ").join("|")}|`, ...rows.map((a) => `| ${cols.map(([, f]) => f(a) ?? 0).join(" | ")} |`)].join("\n");
  const byName = (x, y) => x.n.localeCompare(y.n);
  const chars = r.party.filter((a) => !isAlly(a)).sort(byName);
  const allies = r.party.filter(isAlly).sort(byName);
  const out = [`# ${mdEscape(r.s.name)}`, "", [fmtDate(r.s.start), ...r.sub].join(" · ")];
  if (r.present.length) out.push("", L("MdPresent", { names: r.present.map((x) => mdEscape(x)).join(", ") }));
  if (r.lines.length) out.push("", `## ${L("MdByNumbers")}`, "", ...r.lines.map((l) => `- ${l}`));
  if (chars.length) out.push("", `## ${L("MdParty")}`, "", table(chars));
  if (allies.length) out.push("", `## ${L("Allies")}`, "", table(allies));
  return `${out.join("\n")}\n`;
}

async function exportStats(sessionId) {
  const md = await statsMarkdown(sessionId);
  if (!md) return ui.notifications.warn(L("NothingRecorded"));
  const s = Store.index.sessions.find((x) => x.id === sessionId);
  const name = (s?.name ?? "session").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || "session";
  const date = s?.start ? `-${new Date(s.start).toISOString().slice(0, 10)}` : "";
  foundry.utils.saveDataToFile(md, "text/markdown", `${name}${date}-stats.md`);
}

/**
 * Per-session party totals for the Sessions tab (who was there, and the trend lines): { present, hit, known, dealt,
 * taken, down }, from the session's events. Kept per session until its events change.
 */
const summaries = new Map();
// Bumped when what a summary holds or how it's counted changes: older stored ones are worked out again
const SUM_VERSION = 2;
function summaryValue(data) {
  const rows = [...aggregate(data.events).values()].filter((a) => a.p);
  const sum = (k) => rows.reduce((x, a) => x + (a[k] ?? 0), 0);
  return { v: SUM_VERSION, present: presentKeys(data.events), hit: sum("hit"), known: sum("atkKnown"), dealt: sum("dealt"), taken: sum("taken"), down: sum("down") };
}
/** An ended session's summary as stored in the index, when it's current. */
const storedSum = (s) => (s?.end && s.sum?.v === SUM_VERSION ? s.sum : null);

/** Store summaries of ended sessions in the index (sid -> summary), writing only what changed. */
function storeSummaries(sums) {
  if (!game.user.isGM || !sums.size) return Promise.resolve();
  return Store.mutateIndex((ix) => {
    let changed = false;
    for (const s of ix.sessions) {
      const v = sums.get(s.id);
      if (!v || !s.end || JSON.stringify(s.sum) === JSON.stringify(v)) continue;
      s.sum = v;
      changed = true;
    }
    return changed ? true : SKIP;
  });
}

function summaryOf(sid, data) {
  // (new or removed events change the length or the last id; a correction moves Store.fixes)
  const key = `${data.events.length}|${data.events.at(-1)?.id ?? ""}|${Store.fixes}`;
  const had = summaries.get(sid);
  if (had?.key === key) return had.v;
  const v = summaryValue(data);
  summaries.set(sid, { key, v });
  return v;
}

/**
 * One small line chart: a value per session, oldest first. Each point carries its session and value in a plain-text
 * tooltip, and the latest value is written at the end.
 */
function trendChart(title, points, fmt) {
  const W = 240, H = 64, pad = 8;
  const vals = points.map((p) => p.v).filter((v) => typeof v === "number");
  if (vals.length < 2) return "";
  const max = Math.max(...vals, 1);
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, points.length - 1);
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const pts = points.map((p, i) => (typeof p.v === "number" ? [x(i), y(p.v), p] : null)).filter(Boolean);
  const path = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const dots = pts.map(([px, py, p]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" class="pcl-trend-dot"${tipAttr(`${p.name}: ${fmt(p.v)}`)}></circle>`).join("");
  const last = pts.at(-1)[2];
  return `<figure class="pcl-trend"><figcaption>${esc(title)} <strong>${esc(fmt(last.v))}</strong></figcaption>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(L("TrendLabel", { title, points: pts.map(([, , p]) => `${p.name} ${fmt(p.v)}`).join("; ") }))}">
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="pcl-trend-base"></line>
      <path d="${path}" class="pcl-trend-line"></path>${dots}</svg></figure>`;
}

/**
 * What the recap says about a session, for the chat card and the Markdown export: { s, data, party, sub, present,
 * lines }, with names put through `b` (bold) or `t` (plain), or null when nothing was recorded.
 */
async function recapLines(sessionId, { b, t }) {
  const s = Store.index.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const data = await Store.load(sessionId);
  if (!data.events.length) return null;
  const party = [...aggregate(data.events).values()].filter((a) => a.p);
  const top = (key) => party.filter((a) => a[key] > 0).sort((x, y) => y[key] - x[key])[0];
  const total = (key) => party.reduce((x, a) => x + (a[key] ?? 0), 0);
  const li = [];
  const big = top("dealtBest");
  if (big) li.push(L(big.dealtBestIt ? "RecapBiggestWith" : "RecapBiggest", { name: b(big.n), n: big.dealtBest, item: big.dealtBestIt ? t(big.dealtBestIt) : "" }));
  const dmg = top("dealt");
  if (dmg) li.push(L("RecapMostDamage", { name: b(dmg.n), n: dmg.dealt }));
  const crit = top("crit");
  if (crit) li.push(L("RecapMostCrits", { name: b(crit.n), n: crit.crit }));
  const kills = total("kills");
  const killer = top("kills");
  if (kills) li.push(killer ? L("RecapFelledBy", { n: kills, name: b(killer.n), most: killer.kills }) : L("RecapFelled", { n: kills }));
  // Names with how many times, when more than once: "Vance ×2"
  const times = (key) => party.filter((a) => a[key]).map((a) => (a[key] > 1 ? L("Times", { name: t(a.n), n: a[key] }) : t(a.n))).join(", ");
  const downs = times("down");
  if (downs) li.push(L("RecapDown", { names: downs }));
  const savers = times("revivedBy");
  if (savers) li.push(L("RecapRevived", { names: savers }));
  const spells = top("spellN");
  if (spells) li.push(L("RecapSpells", { name: b(spells.n), n: spells.spellN }));
  const forced = top("forcedFail");
  if (forced) li.push(L("RecapForced", { name: b(forced.n), n: forced.forcedFail, of: forced.forced }));
  const skills = top("skillPass");
  if (skills) li.push(L("RecapSkills", { name: b(skills.n), n: skills.skillPass }));
  const heal = top("healDone");
  if (heal) li.push(L("RecapHealing", { name: b(heal.n), n: heal.healDone }));
  const n20 = times("nat20");
  if (n20) li.push(L("RecapNat20", { names: n20 }));
  const n1 = times("nat1");
  if (n1) li.push(L("RecapNat1", { names: n1 }));
  const ff = party.filter((a) => a.ff).sort((x, y) => y.ff - x.ff).map((a) => `${t(a.n)} (${a.ff})`);
  if (ff.length) li.push(L("RecapFriendlyFire", { names: ff.join(", ") }));
  const hero = total("hero");
  if (hero) li.push(L("RecapHero", { n: hero }));
  // Quests (recorded from Campaign Trackers): objectives done and failed, by quest, and quests revealed
  const byQuest = (v) => {
    const goals = data.events.filter((e) => e.k === "goal" && e.v === v);
    return goals.length ? { n: goals.length, quests: [...new Set(goals.map((e) => e.q))].map((x) => t(x)).join(", ") } : null;
  };
  const done = byQuest("done");
  if (done) li.push(L("RecapGoalsDone", done));
  const failed = byQuest("failed");
  if (failed) li.push(L("RecapGoalsFailed", failed));
  const revealed = [...new Set(data.events.filter((e) => e.k === "quest").map((e) => e.q))];
  if (revealed.length) li.push(L("RecapNewQuests", { names: revealed.map((x) => b(x)).join(", ") }));
  li.push(...otherModulesLines(s, { b, t }));
  const encs = data.encounters.length;
  const sub = [fmtDuration((s.end ?? now()) - s.start), L(encs === 1 ? "EncountersOne" : "EncountersMany", { n: encs })].filter((x) => x && x !== "–");
  return { s, data, party, sub, present: presentFor(s, presentIn(data.events)), lines: li };
}

/** The recap card for a session, or null if nothing was recorded. */
async function recapHTML(sessionId) {
  const r = await recapLines(sessionId, { b: (x) => `<b>${esc(x)}</b>`, t: esc });
  if (!r) return null;
  const present = r.present.length ? `<p class="pcl-recap-sub">${esc(r.present.join(", "))}</p>` : "";
  return `<div class="pcl-recap"><h3><i class="fa-solid fa-book-open-reader"></i> ${esc(r.s.name)}</h3>${r.sub.length ? `<p class="pcl-recap-sub">${r.sub.join(" · ")}</p>` : ""}${present}<ul>${r.lines.map((l) => `<li>${l}</li>`).join("")}</ul></div>`;
}

async function postRecap(sessionId, { manual = false, auto = false } = {}) {
  const content = await recapHTML(sessionId);
  if (!content) return false;
  const mode = game.settings.get(MOD, "recap");
  // An evening that ended by itself is noticed at the start of the next one: its recap goes to the GM to repost
  const gmOnly = mode === "gm" || auto || (manual && mode === "off");
  await ChatMessage.create({
    content,
    speaker: { alias: L("Title") },
    whisper: gmOnly ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : [],
  });
  return true;
}


export { attackResult, checkResult, ENTRY_KEYS, entryWord, describe, diceData, diceStats, luckText, histogram, journalDay, journalAttendance, presentFor, presentKeys, namesOf, presentIn, fmtCoins, otherModulesLines, statsMarkdown, exportStats, summaries, SUM_VERSION, summaryValue, storedSum, storeSummaries, summaryOf, trendChart, recapLines, recapHTML, postRecap };
