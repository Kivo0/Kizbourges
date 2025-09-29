// scripts/ics_to_csv.js  (ESM, Node 20)
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import fetch from "node-fetch";
import ical from "ical";
import { DateTime } from "luxon";
import Papa from "papaparse";

/**
 * ENV
 * - GCAL_ICS_URL (required)
 * - TZ (optional, default Europe/Paris)
 * - REMOVAL_DELAY_HOURS (optional, default 24)
 */
const ICS_URL = process.env.GCAL_ICS_URL;
if (!ICS_URL) {
  console.error("Missing env GCAL_ICS_URL");
  process.exit(1);
}
const ZONE = process.env.TZ || "Europe/Paris";
const REMOVAL_DELAY_HOURS = Number(process.env.REMOVAL_DELAY_HOURS ?? 24);
const CSV_PATH = "kizbourges_events_template1.csv";

/* ---------------- helpers ---------------- */
const clean = (s) => (s ?? "").toString().replace(/\s+/g, " ").trim();

function slug(s) {
  return clean(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toISOWithOffset(d) {
  return DateTime.fromJSDate(d, { zone: ZONE })
    .toISO({ suppressMilliseconds: true });
}

/** Round to minute, keep local zone */
function roundToMinuteISO(iso) {
  const dt = DateTime.fromISO(iso, { zone: ZONE });
  return dt.startOf("minute").toISO({ suppressMilliseconds: true });
}

/** Canonical key that survives “different ids” for the same event */
function canonicalKey(row) {
  const s = roundToMinuteISO(row.start_time); // normalized to minute
  const n = slug(row.name);
  // include place (lightly normalized) to avoid accidental merges
  const p = slug(row.place || "");
  return `${n}__${s}__${p}`;
}

function richnessScore(r) {
  // prefer rows that have more useful info
  let sc = 0;
  if (r.cover) sc += 3;
  if (r.event_url) sc += 2;
  if (r.ticket_url) sc += 2;
  if (r.place) sc += 1;
  return sc;
}

function mergeRows(a, b) {
  // prefer non-empty, richer fields
  const pick = (x, y) => clean(y || x);
  const r = { ...a };
  r.id         = pick(a.id,         b.id);
  r.name       = pick(a.name,       b.name);
  r.start_time = pick(a.start_time, b.start_time);
  r.place      = richnessScore(b) > richnessScore(a) ? pick(a.place, b.place) : pick(b.place, a.place);
  r.cover      = (b.cover && !/^images\/logo|logo/i.test(b.cover)) ? b.cover : (a.cover || b.cover || "");
  r.event_url  = pick(a.event_url,  b.event_url);
  r.ticket_url = pick(a.ticket_url, b.ticket_url);
  return r;
}

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return (parsed.data || []).map((r) => ({
    id: clean(r.id),
    name: clean(r.name),
    start_time: clean(r.start_time),
    place: clean(r.place),
    cover: clean(r.cover),
    event_url: clean(r.event_url),
    ticket_url: clean(r.ticket_url),
  })).filter(r => r.name && r.start_time);
}

function unparseCSV(rows) {
  return Papa.unparse(rows, {
    header: true,
    columns: ["id","name","start_time","place","cover","event_url","ticket_url"],
  }) + "\n";
}

function toRowFromICS(ev) {
  const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
  return {
    id: clean(ev.uid || ev.id || ev.summary),
    name: clean(ev.summary),
    start_time: toISOWithOffset(start),
    place: clean(ev.location || ev.geo || ""),
    cover: "",       // keep if you map posters programmatically
    event_url: clean(ev.url || ev.source || ""),
    ticket_url: ""
  };
}

/* ---------------- main ---------------- */
async function main() {
  const now = DateTime.now().setZone(ZONE);

  // 1) load existing as “database”
  let existing = [];
  if (existsSync(CSV_PATH)) {
    const txt = await fs.readFile(CSV_PATH, "utf8").catch(() => "");
    existing = parseCSV(txt);
  }

  // 2) fetch/parse ICS
  const res = await fetch(ICS_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`ICS download failed: ${res.status} ${res.statusText}`);
  const data = ical.parseICS(await res.text());

  const incoming = [];
  for (const k of Object.keys(data)) {
    const ev = data[k];
    if (!ev || ev.type !== "VEVENT" || !ev.start || !ev.summary) continue;
    incoming.push(toRowFromICS(ev));
  }

  // 3) merge:
  //    - start from existing rows
  //    - add incoming rows
  //    - dedupe by canonicalKey (name+rounded start+place)
  const map = new Map();

  function addOrMerge(r) {
    // normalize start to minute for stable keys
    r.start_time = roundToMinuteISO(r.start_time);
    const ck = canonicalKey(r);
    const ex = map.get(ck);
    if (!ex) map.set(ck, r);
    else map.set(ck, mergeRows(ex, r));
  }

  existing.forEach(addOrMerge);
  incoming.forEach(addOrMerge);

  // 4) remove past rows once start+delay has passed
  const kept = [];
  for (const r of map.values()) {
    const start = DateTime.fromISO(r.start_time, { zone: ZONE });
    if (!start.isValid) continue;
    const removeAt = start.plus({ hours: REMOVAL_DELAY_HOURS });
    if (now >= removeAt) continue; // drop
    kept.push(r);
  }

  // 5) sort & write
  kept.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  await fs.writeFile(CSV_PATH, unparseCSV(kept), "utf8");

  console.log(`Saved ${kept.length} unique upcoming rows (deduped by name+minute+place, removed past beyond +${REMOVAL_DELAY_HOURS}h).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
