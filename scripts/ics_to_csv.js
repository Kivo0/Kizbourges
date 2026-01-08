// scripts/ics_to_csv.js  (ESM, Node 20)
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import ical from "ical";
import { DateTime } from "luxon";
import Papa from "papaparse";

/* ================= ENV ================= */
const ICS_URL = process.env.GCAL_ICS_URL;
if (!ICS_URL) {
  console.error("Missing env GCAL_ICS_URL");
  process.exit(1);
}
const ZONE = process.env.TZ || "Europe/Paris";
const REMOVAL_DELAY_HOURS = Number(process.env.REMOVAL_DELAY_HOURS ?? 24);
const CSV_PATH = "kizbourges_events_template1.csv";

/* ================= HELPERS ================= */
const clean = (s) => (s ?? "").toString().replace(/\s+/g, " ").trim();

function slug(s) {
  return clean(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toISOWithOffset(d) {
  return DateTime.fromJSDate(d, { zone: ZONE })
    .toISO({ suppressMilliseconds: true });
}

function roundToMinuteISO(iso) {
  return DateTime.fromISO(iso, { zone: ZONE })
    .startOf("minute")
    .toISO({ suppressMilliseconds: true });
}

/* ================= URL EXTRACTION (🔥 KEY FIX) ================= */
function extractUrlFromText(text = "") {
  if (!text) return "";

  // HTML anchor <a href="...">
  const html = text.match(/<a\s+[^>]*href=["']([^"']+)["']/i);
  if (html) return clean(html[1]);

  // Plain URL
  const plain = text.match(/https?:\/\/[^\s"<>()]+/i);
  if (plain) return clean(plain[0]);

  return "";
}

/* ================= LOCK HELPERS ================= */
function isLocked(v) {
  return typeof v === "string" && /^\s*!/.test(v);
}
function unlock(v) {
  return typeof v === "string" ? v.replace(/^\s*!/, "").trim() : v;
}

/* ================= MERGE POLICY ================= */
/**
 * Rule:
 * - If locked → keep
 * - Else → always prefer ICS
 */
function preferICS(existingVal, incomingVal) {
  if (isLocked(existingVal)) return unlock(existingVal);
  return clean(incomingVal || existingVal);
}

/* ================= DESC TAG PARSER ================= */
function parseDescTags(desc = "") {
  const out = {};
  const patterns = {
    cover: /(!)?\s*(cover|image|poster)\s*:\s*([^\n\r]+)/i,
    ticket: /(!)?\s*(ticket|billet|tickets)\s*:\s*([^\n\r]+)/i,
    event: /(!)?\s*(event|link|url)\s*:\s*([^\n\r]+)/i,
    place: /(!)?\s*(place|adresse)\s*:\s*([^\n\r]+)/i,
  };

  for (const key in patterns) {
    const m = desc.match(patterns[key]);
    if (!m) continue;
    const bang = m[1];
    const raw = m[3];
    const val = extractUrlFromText(raw) || clean(raw);
    out[key] = bang ? "!" + val : val;
  }
  return out;
}

/* ================= COVER / TICKET ================= */
function extractCoverFromICS(ev) {
  return extractUrlFromText(ev.description || "");
}

function extractTicketFromICS(ev) {
  return extractUrlFromText(ev.description || "");
}

/* ================= CSV ================= */
function parseCSV(text) {
  if (!text?.trim()) return [];
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data
    .map(r => ({
      id: clean(r.id),
      name: clean(r.name),
      start_time: clean(r.start_time),
      place: r.place?.trim() || "",
      cover: r.cover?.trim() || "",
      event_url: r.event_url?.trim() || "",
      ticket_url: r.ticket_url?.trim() || "",
    }))
    .filter(r => r.name && r.start_time);
}

function unparseCSV(rows) {
  return Papa.unparse(rows, {
    header: true,
    columns: ["id","name","start_time","place","cover","event_url","ticket_url"],
  }) + "\n";
}

/* ================= ICS → ROW ================= */
function toRowFromICS(ev) {
  const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
  const tags = parseDescTags(ev.description || "");

  return {
    id: clean(ev.uid || ev.id || ev.summary),
    name: clean(ev.summary),
    start_time: toISOWithOffset(start),
    place: tags.place ?? clean(ev.location || ""),
    cover: tags.cover ?? extractCoverFromICS(ev),
    event_url: tags.event ?? clean(ev.url || ""),
    ticket_url: tags.ticket ?? extractTicketFromICS(ev),
  };
}

/* ================= MERGE ================= */
function mergeRows(existing, incoming) {
  return {
    id: existing.id || incoming.id,
    name: preferICS(existing.name, incoming.name),
    start_time: preferICS(existing.start_time, incoming.start_time),
    place: preferICS(existing.place, incoming.place),
    cover: preferICS(existing.cover, incoming.cover),
    event_url: preferICS(existing.event_url, incoming.event_url),
    ticket_url: preferICS(existing.ticket_url, incoming.ticket_url),
  };
}

function keyOf(r) {
  return `event__${slug(r.name)}__${r.start_time.split("T")[0]}`;
}

/* ================= MAIN ================= */
async function main() {
  const now = DateTime.now().setZone(ZONE);

  const existing = existsSync(CSV_PATH)
    ? parseCSV(await fs.readFile(CSV_PATH, "utf8"))
    : [];

  const res = await fetch(ICS_URL);
  if (!res.ok) throw new Error("ICS fetch failed");
  const data = ical.parseICS(await res.text());

  const incoming = Object.values(data)
    .filter(e => e?.type === "VEVENT" && e.start && e.summary)
    .map(toRowFromICS);

  const map = new Map();

  [...existing, ...incoming].forEach(r => {
    r.start_time = roundToMinuteISO(r.start_time);
    const k = keyOf(r);
    map.set(k, map.has(k) ? mergeRows(map.get(k), r) : r);
  });

  const finalRows = [...map.values()].filter(r => {
    const start = DateTime.fromISO(r.start_time, { zone: ZONE });
    return now < start.plus({ hours: REMOVAL_DELAY_HOURS });
  });

  finalRows.sort((a,b)=>new Date(a.start_time)-new Date(b.start_time));
  await fs.writeFile(CSV_PATH, unparseCSV(finalRows), "utf8");

  console.log(`✅ Synced ${finalRows.length} events (HTML-safe, auto-updating, locks respected).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
