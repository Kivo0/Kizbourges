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
 * - DEBUG_ICS (optional: "1" to print extracted rows)
 */
const ICS_URL = process.env.GCAL_ICS_URL;
if (!ICS_URL) {
  console.error("Missing env GCAL_ICS_URL");
  process.exit(1);
}
const ZONE = process.env.TZ || "Europe/Paris";
const REMOVAL_DELAY_HOURS = Number(process.env.REMOVAL_DELAY_HOURS ?? 24);
const CSV_PATH = "kizbourges_events_template1.csv";

// -----------------------------------------------------------------------------
// helpers (generic)
// -----------------------------------------------------------------------------
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
  const s = roundToMinuteISO(row.start_time);
  const n = slug(row.name);
  const p = slug(row.place || "");
  return `${n}__${s}__${p}`;
}

// -----------------------------------------------------------------------------
// cover helpers
// -----------------------------------------------------------------------------
const SITE_ORIGIN = "https://kizbourges.fr";

function normalizeCoverUrl(u) {
  if (!u) return "";
  u = clean(u);

  // data: URL accepted as-is
  if (/^data:image\//i.test(u)) return u;

  // GitHub "blob" -> raw
  if (/^https?:\/\/github\.com\/.+\/blob\//i.test(u)) {
    return u
      .replace(/^https?:\/\/github\.com\//i, "https://raw.githubusercontent.com/")
      .replace("/blob/", "/");
  }

  // absolute http(s)
  if (/^https?:\/\//i.test(u)) return u;

  // Images/... or /Images/... -> absolute to site origin
  const short = u.replace(/^\/+/, "");
  if (/^(images|Images)\//.test(short)) {
    return `${SITE_ORIGIN}/${short}`;
  }

  return u;
}

// Extract the first image-like URL from text
function firstImageFromText(text) {
  if (!text) return "";
  const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+?\.(?:jpe?g|png|webp|gif))\)/i);
  if (md?.[1]) return md[1];
  const plain = text.match(/https?:\/\/[^\s)]+?\.(?:jpe?g|png|webp|gif)/i);
  return plain?.[0] || "";
}

// Try "Cover: ..." / "Affiche: ..." / "Image: ..." directive in DESCRIPTION
function coverDirectiveFromDescription(desc) {
  if (!desc) return "";
  const m = desc.match(/\b(?:cover|couverture|affiche|image)\s*[:=-]\s*(\S+)/i);
  return m?.[1] || "";
}

/** Find a cover image URL inside an ical event. */
function extractCoverFromICS(ev) {
  // 1) ATTACH/ATTACHMENT
  const attachCandidates = [];
  const rawAttach = ev.attach || ev.attachment || ev.attachments || ev.ATTACH || ev.ATTACHMENT;
  if (rawAttach) {
    const pushVal = (val) => {
      if (!val) return;
      if (typeof val === "string") attachCandidates.push(val);
      else if (Array.isArray(val)) val.forEach(pushVal);
      else if (val.value) attachCandidates.push(val.value);
      else if (val.uri) attachCandidates.push(val.uri);
      else if (val.params?.VALUE) attachCandidates.push(val.params.VALUE);
    };
    pushVal(rawAttach);
  }
  const attachImg = attachCandidates.find((x) => /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(x || ""));
  if (attachImg) return normalizeCoverUrl(attachImg);

  // 2) vendor-ish fields
  const vendorImg = ev.image || ev.photo || ev["x-image"] || ev["X-IMAGE"];
  if (typeof vendorImg === "string" && /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(vendorImg)) {
    return normalizeCoverUrl(vendorImg);
  }

  // 3) description directive
  const desc = ev.description || ev.summary || "";
  const directive = coverDirectiveFromDescription(desc);
  if (directive) return normalizeCoverUrl(directive);

  // 4) any image in description
  const any = firstImageFromText(desc);
  if (any) return normalizeCoverUrl(any);

  return "";
}

// -----------------------------------------------------------------------------
// ticket helpers
// -----------------------------------------------------------------------------
function firstUrlFromText(text) {
  if (!text) return "";
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : "";
}

// Known ticketing hosts
const TICKET_HOSTS =
  /(?:helloasso\.com|eventbrite\.[a-z.]+|billetweb\.fr|weezevent\.com|yurplan\.com|shotgun\.live|dice\.fm|ti\.to|tito\.io|billetterie|yvent\.io|leetchi\.com|payasso|pay\.asso)/i;

// “Tickets: …”, “Billets: …”, “Billetterie: …”, “Réservation: …”, “Inscription: …”
function ticketDirectiveFromDescription(desc) {
  if (!desc) return "";
  const m = desc.match(/\b(?:tickets?|billets?|billetterie|reservations?|réservations?|reservation|réservation|inscriptions?)\s*[:=-]\s*(\S+)/i);
  return m?.[1] || "";
}

function normalizeTicketUrl(u) {
  if (!u) return "";
  u = clean(u);

  // Prefer public HelloAsso pages over widgets
  if (/^https?:\/\/www\.helloasso\.com\/.+\/widget(?:\/)?$/i.test(u)) {
    return u.replace(/\/widget\/?$/i, "");
  }
  return u;
}

function extractTicketFromICS(ev) {
  const desc = ev.description || ev.summary || "";

  // 1) explicit directive
  const direct = ticketDirectiveFromDescription(desc);
  if (direct) return normalizeTicketUrl(direct);

  // 2) any ticketing URL in description
  const anyUrl = firstUrlFromText(desc);
  if (anyUrl && TICKET_HOSTS.test(anyUrl)) return normalizeTicketUrl(anyUrl);

  // 3) fallback: ev.url looks like ticketing
  const evUrl = clean(ev.url || ev.source || "");
  if (evUrl && TICKET_HOSTS.test(evUrl)) return normalizeTicketUrl(evUrl);

  return "";
}

// -----------------------------------------------------------------------------
// description tags (!cover:, !ticket:, !url:, !place:)
// -----------------------------------------------------------------------------
function parseDescTags(desc = "") {
  const out = {};
  const lines = String(desc).split(/\r?\n/);
  for (const raw of lines) {
    const m = raw.match(/^\s*(!)?\s*(cover|image|poster|ticket|billet|tickets|event|link|url|place|adresse)\s*:\s*(.+)$/i);
    if (!m) continue;
    const [, bang, key, val] = m;
    const v = val.trim();
    const lock = !!bang;
    switch (key.toLowerCase()) {
      case "cover":
      case "image":
      case "poster":
        out.cover = v; out.coverLock = lock; break;
      case "ticket":
      case "billet":
      case "tickets":
        out.ticket_url = v; out.ticketLock = lock; break;
      case "event":
      case "link":
      case "url":
        out.event_url = v; out.eventLock = lock; break;
      case "place":
      case "adresse":
        out.place = v; out.placeLock = lock; break;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// merging priorities (manual first, with locks)
// -----------------------------------------------------------------------------
function isLocked(v)   { return typeof v === "string" && /^\s*!/.test(v); }
function unlock(v)     { return typeof v === "string" ? v.replace(/^\s*!/, "").trim() : v; }
function hasVal(v)     { return !!clean(v); }
function isGenericLogo(u){ return /(?:^|\/)(logo|logo2)\.(?:png|jpe?g|webp)$/i.test(u||""); }

// For manual-first fields (cover, event_url, ticket_url)
function keepManual(existingVal, incomingVal) {
  if (isLocked(existingVal)) return unlock(existingVal);
  if (hasVal(existingVal))  return existingVal;  // keep manual
  return clean(incomingVal);                     // fill only if empty
}

// For ICS-managed fields (start_time, name, place) unless locked
function preferICS(existingVal, incomingVal) {
  if (isLocked(existingVal)) return unlock(existingVal);
  return hasVal(incomingVal) ? clean(incomingVal) : clean(existingVal);
}

function safeCover(existingVal, incomingVal) {
  const picked = keepManual(existingVal, incomingVal);
  return isGenericLogo(picked) ? (clean(existingVal) || "") : picked;
}

function mergeRowsManualFirst(existing, incoming) {
  return {
    id:         keepManual(existing.id,         incoming.id),
    name:       preferICS(existing.name,       incoming.name),
    start_time: preferICS(existing.start_time, incoming.start_time),
    place:      preferICS(existing.place,      incoming.place),
    cover:      safeCover(existing.cover,      incoming.cover),
    event_url:  keepManual(existing.event_url,  incoming.event_url),
    ticket_url: keepManual(existing.ticket_url, incoming.ticket_url),
  };
}

// Use UID when possible, else canonical (name+minute+place)
function keyOf(row) {
  const byId = clean(row.id);
  if (byId) return "id__" + byId;
  return "ck__" + canonicalKey(row);
}

// -----------------------------------------------------------------------------
// CSV helpers
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// ICS -> row (with auto extractors + description-tag overrides)
// -----------------------------------------------------------------------------
function toRowFromICS(ev) {
  const start = ev.start instanceof Date ? ev.start : new Date(ev.start);

  // Auto-detected values (normalized)
  const autoCover  = normalizeCoverUrl(extractCoverFromICS(ev));
  const autoTicket = normalizeTicketUrl(extractTicketFromICS(ev));

  const row = {
    id:         clean(ev.uid || ev.id || ev.summary),
    name:       clean(ev.summary),
    start_time: toISOWithOffset(start),
    place:      clean(ev.location || ev.geo || ""),
    cover:      autoCover || "",
    event_url:  clean(ev.url || ev.source || ""),
    ticket_url: autoTicket || "",
  };

  // Description directives (with optional leading "!" to lock)
  const tags = parseDescTags(ev.description || "");
  if (tags.place)      row.place      = tags.placeLock  ? "!" + tags.place                        : tags.place;
  if (tags.cover)      row.cover      = tags.coverLock  ? "!" + normalizeCoverUrl(tags.cover)     : normalizeCoverUrl(tags.cover);
  if (tags.event_url)  row.event_url  = tags.eventLock  ? "!" + tags.event_url                     : tags.event_url;
  if (tags.ticket_url) row.ticket_url = tags.ticketLock ? "!" + normalizeTicketUrl(tags.ticket_url): normalizeTicketUrl(tags.ticket_url);

  if (process.env.DEBUG_ICS === "1") {
    console.log("[ICS]", row.start_time, row.name, { cover: row.cover, ticket: row.ticket_url, event: row.event_url });
  }
  return row;
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------
async function main() {
  const now = DateTime.now().setZone(ZONE);

  // 1) load existing csv
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

  // 3) merge (manual CSV first, then ICS; dedupe by UID or canonical key)
  const map = new Map();

  function addOrMerge(r) {
    r.start_time = roundToMinuteISO(r.start_time);
    const key = keyOf(r);
    const ex = map.get(key);
    if (!ex) map.set(key, r);
    else map.set(key, mergeRowsManualFirst(ex, r));
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

  console.log(
    `Saved ${kept.length} unique upcoming rows (manual-first, locks respected, deduped by UID/canonical, removed past beyond +${REMOVAL_DELAY_HOURS}h).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
