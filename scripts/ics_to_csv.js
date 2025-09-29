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
 * - REMOVAL_DELAY_HOURS (optional, default 24)  -> remove rows when now >= start + delay
 */
const ICS_URL = process.env.GCAL_ICS_URL;
if (!ICS_URL) {
  console.error("Missing env GCAL_ICS_URL");
  process.exit(1);
}
const ZONE = process.env.TZ || "Europe/Paris";
const REMOVAL_DELAY_HOURS = Number(process.env.REMOVAL_DELAY_HOURS ?? 24);

const CSV_PATH = "kizbourges_events_template1.csv";

// ----------------- helpers -----------------
const toISOWithOffset = (d) =>
  DateTime.fromJSDate(d, { zone: ZONE }).toISO({ suppressMilliseconds: true });

const clean = (s) => (s ?? "").toString().replace(/\s+/g, " ").trim();

const keyOf = (row) => `${row.id}__${row.start_time}`;

function toRow({ uid, summary, start, location, url }) {
  return {
    id: uid || clean(summary),
    name: clean(summary),
    start_time: toISOWithOffset(start),
    place: clean(location),
    cover: "",       // optional: map poster URLs here if you have them
    event_url: clean(url),
    ticket_url: ""
  };
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
  })).filter(r => r.id && r.name && r.start_time);
}

function unparseCSV(rows) {
  return Papa.unparse(rows, {
    header: true,
    columns: ["id","name","start_time","place","cover","event_url","ticket_url"],
  }) + "\n";
}

// ----------------- main -----------------
async function main() {
  const now = DateTime.now().setZone(ZONE);

  // 1) Load existing CSV (acts as our “database” to keep/append)
  let existing = [];
  if (existsSync(CSV_PATH)) {
    const txt = await fs.readFile(CSV_PATH, "utf8").catch(() => "");
    existing = parseCSV(txt);
  }

  // Index existing rows by composite key
  const existingMap = new Map(existing.map(r => [keyOf(r), r]));

  // 2) Fetch & parse ICS
  const res = await fetch(ICS_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`ICS download failed: ${res.status} ${res.statusText}`);
  const icsText = await res.text();
  const data = ical.parseICS(icsText);

  // 3) Build rows from ICS and merge into existing
  let addedCount = 0;
  for (const k of Object.keys(data)) {
    const ev = data[k];
    if (!ev || ev.type !== "VEVENT" || !ev.start || !ev.summary) continue;

    const start = ev.start instanceof Date ? ev.start : new Date(ev.start);

    const row = toRow({
      uid: ev.uid || ev.id || ev.summary,
      summary: ev.summary,
      start,
      location: ev.location || ev.geo || "",
      url: ev.url || ev.source || ""
    });

    const key = keyOf(row);
    if (!existingMap.has(key)) {
      existingMap.set(key, row); // append new
      addedCount++;
    } else {
      // Optional: update mutable fields (e.g., place, event_url) if they changed
      const old = existingMap.get(key);
      const merged = { ...old, ...row };
      existingMap.set(key, merged);
    }
  }

  // 4) Drop rows that are past the removal threshold (start + REMOVAL_DELAY_HOURS)
  const kept = [];
  for (const r of existingMap.values()) {
    const start = DateTime.fromISO(r.start_time, { zone: ZONE });
    if (!start.isValid) continue; // skip malformed
    const removeAt = start.plus({ hours: REMOVAL_DELAY_HOURS });
    if (now >= removeAt) {
      // drop it
      continue;
    }
    kept.push(r);
  }

  // 5) Sort by start_time ascending
  kept.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  // 6) Write CSV (overwrite with merged list)
  await fs.writeFile(CSV_PATH, unparseCSV(kept), "utf8");

  console.log(`Merged CSV: +${addedCount} new, total ${kept.length} rows (removed past events beyond +${REMOVAL_DELAY_HOURS}h).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
