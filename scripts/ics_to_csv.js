// scripts/ics_to_csv.js (ESM, Node 20)
// - Recurrences expanded (weekly courses work)
// - Locks preserved with "!" (e.g., !cover: Images/events/cid.jpg)
// - "pinned: true" keeps rows forever (ignores removal delay)
// - Cover merge policy: if CSV already has a cover, DO NOT replace it (unless you clear it or lock it)
// - Supports EventURL: / TicketURL: in descriptions

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { DateTime } from "luxon";
import Papa from "papaparse";
import IcalExpander from "ical-expander";

/* ================= ENV ================= */
const ICS_URL = process.env.GCAL_ICS_URL;
if (!ICS_URL) {
  console.error("Missing env GCAL_ICS_URL");
  process.exit(1);
}

const ZONE = process.env.TZ || "Europe/Paris";
const CSV_PATH = "kizbourges_events_template1.csv";

const REMOVAL_DELAY_HOURS = Number(process.env.REMOVAL_DELAY_HOURS ?? 24);
const PAST_DAYS = Number(process.env.PAST_DAYS ?? 7);
const FUTURE_DAYS = Number(process.env.FUTURE_DAYS ?? 120);

/* ================= HELPERS ================= */
const clean = (s) => (s ?? "").toString().replace(/\s+/g, " ").trim();

function slug(s) {
  return clean(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toISOWithOffset(d) {
  return DateTime.fromJSDate(d, { zone: ZONE }).toISO({
    suppressMilliseconds: true,
  });
}

function roundToMinuteISO(iso) {
  return DateTime.fromISO(iso, { zone: ZONE })
    .startOf("minute")
    .toISO({ suppressMilliseconds: true });
}

/* ================= URL EXTRACTION ================= */
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

/* ================= MERGE POLICIES ================= */
/**
 * Default policy:
 * - If existing is locked (starts with "!") → keep EXACTLY as-is (keep the "!")
 * - Else → prefer incoming (ICS) when present
 */
function preferICS(existingVal, incomingVal) {
  if (isLocked(existingVal)) return clean(existingVal); // keep "!" forever
  return clean(incomingVal || existingVal);
}

/**
 * Keep-existing policy (for cover images):
 * - If existing is locked → keep as-is
 * - Else if existing is non-empty → keep existing (do NOT replace)
 * - Else → take incoming
 */
function keepExistingIfSet(existingVal, incomingVal) {
  if (isLocked(existingVal)) return clean(existingVal);
  const ex = clean(existingVal);
  if (ex) return ex;
  return clean(incomingVal || "");
}

/* ================= DESC TAG PARSER =================
Supported (case-insensitive):
- !cover: ...
- !ticket: ...
- !event: ...
- !place: ...
- pinned: true/false/1/0/yes/no

Also supports:
- EventURL: ...
- TicketURL: ...
*/
function parseDescTags(desc = "") {
  const out = {};

  const patterns = {
    cover: /(!)?\s*(cover|image|poster)\s*:\s*([^\n\r]+)/i,
    ticket: /(!)?\s*(ticketurl|ticket_url|ticket|billet|tickets)\s*:\s*([^\n\r]+)/i,
    event: /(!)?\s*(eventurl|event_url|event|link|url)\s*:\s*([^\n\r]+)/i,
    place: /(!)?\s*(place|adresse)\s*:\s*([^\n\r]+)/i,
    pinned: /\s*(pinned|pin)\s*:\s*(true|false|1|0|yes|no)\s*$/im,
  };

  for (const key of ["cover", "ticket", "event", "place"]) {
    const m = desc.match(patterns[key]);
    if (!m) continue;

    const bang = m[1];
    const raw = m[3];

    // Allows either:
    // - URLs (https://...)
    // - local paths (Images/events/cid.jpg)
    const val = extractUrlFromText(raw) || clean(raw);

    out[key] = bang ? "!" + val : val;
  }

  const mp = desc.match(patterns.pinned);
  if (mp) out.pinned = clean(mp[2]).toLowerCase();

  return out;
}

/* ================= FALLBACK EXTRACTORS ================= */
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
    .map((r) => ({
      id: clean(r.id),
      name: clean(r.name),
      start_time: clean(r.start_time),
      place: r.place?.trim() || "",
      cover: r.cover?.trim() || "",
      event_url: r.event_url?.trim() || "",
      ticket_url: r.ticket_url?.trim() || "",
      pinned: clean(r.pinned),
    }))
    .filter((r) => r.name && r.start_time);
}

function unparseCSV(rows) {
  return (
    Papa.unparse(rows, {
      header: true,
      columns: [
        "id",
        "name",
        "start_time",
        "place",
        "cover",
        "event_url",
        "ticket_url",
        "pinned",
      ],
    }) + "\n"
  );
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
    pinned: tags.pinned ?? "",
  };
}

/* ================= MERGE ================= */
function mergeRows(existing, incoming) {
  return {
    id: existing.id || incoming.id,
    name: preferICS(existing.name, incoming.name),
    start_time: preferICS(existing.start_time, incoming.start_time),
    place: preferICS(existing.place, incoming.place),

    // ✅ main change: don't replace an existing cover already in the CSV
    cover: keepExistingIfSet(existing.cover, incoming.cover),

    event_url: preferICS(existing.event_url, incoming.event_url),
    ticket_url: preferICS(existing.ticket_url, incoming.ticket_url),
    pinned: preferICS(existing.pinned, incoming.pinned),
  };
}

function keyOf(r) {
  // Prevent collisions: same name same day but different time
  const dt = DateTime.fromISO(r.start_time, { zone: ZONE });
  const stamp = dt.toFormat("yyyy-LL-dd'T'HH-mm"); // minute precision
  return `event__${slug(r.name)}__${stamp}`;
}

function isPinnedValue(v) {
  const s = clean(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/* ================= MAIN ================= */
async function main() {
  const now = DateTime.now().setZone(ZONE);

  const existing = existsSync(CSV_PATH)
    ? parseCSV(await fs.readFile(CSV_PATH, "utf8"))
    : [];

  const res = await fetch(ICS_URL);
  if (!res.ok) throw new Error(`ICS fetch failed (${res.status})`);
  const icsText = await res.text();

  // Expand recurring events into occurrences for a useful website horizon
  const expander = new IcalExpander({ ics: icsText, maxIterations: 5000 });

  const rangeStart = now.minus({ days: PAST_DAYS }).toJSDate();
  const rangeEnd = now.plus({ days: FUTURE_DAYS }).toJSDate();

  const { events, occurrences } = expander.between(rangeStart, rangeEnd);

  // Non-recurring events
  const singleRows = (events || [])
    .filter((e) => e?.startDate && e?.summary)
    .map((e) =>
      toRowFromICS({
        uid: e.uid,
        id: e.uid,
        summary: e.summary,
        start: e.startDate.toJSDate(),
        location: e.location,
        description: e.description,
        url: e.url,
      })
    );

  // Recurring occurrences (each instance becomes its own row)
  const occRows = (occurrences || [])
    .filter((o) => o?.startDate && o?.item?.summary)
    .map((o) => {
      const e = o.item; // master event
      const startJS = o.startDate.toJSDate();

      // Stable per-occurrence id
      const stamp = DateTime.fromJSDate(startJS, { zone: ZONE }).toFormat(
        "yyyyLLdd_HHmm"
      );
      const occId = `${clean(e.uid || e.id || e.summary)}__${stamp}`;

      return toRowFromICS({
        uid: occId,
        id: occId,
        summary: e.summary,
        start: startJS,
        location: e.location,
        description: e.description,
        url: e.url,
      });
    });

  const incoming = [...singleRows, ...occRows];

  // Merge existing + incoming
  const map = new Map();
  for (const r of [...existing, ...incoming]) {
    r.start_time = roundToMinuteISO(r.start_time);
    const k = keyOf(r);
    map.set(k, map.has(k) ? mergeRows(map.get(k), r) : r);
  }

  // Removal policy:
  // - keep pinned rows forever
  // - otherwise keep until start_time + REMOVAL_DELAY_HOURS
  const finalRows = [...map.values()].filter((r) => {
    if (isPinnedValue(r.pinned)) return true;
    const start = DateTime.fromISO(r.start_time, { zone: ZONE });
    return now < start.plus({ hours: REMOVAL_DELAY_HOURS });
  });

  finalRows.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  await fs.writeFile(CSV_PATH, unparseCSV(finalRows), "utf8");

  console.log(
    `✅ Synced ${finalRows.length} events (recurrences expanded, locks preserved, pinned supported, cover preserved).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
