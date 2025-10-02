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

/* ---------- cover helpers ---------- */


/* ---------- ticket helpers ---------- */

function firstUrlFromText(text) {
  if (!text) return "";
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : "";
}

// Known ticketing hosts
const TICKET_HOSTS = /(?:helloasso\.com|eventbrite\.[a-z.]+|billetweb\.fr|weezevent\.com|yurplan\.com|shotgun\.live|dice\.fm|ti\.to|tito\.io|billetterie|yvent\.io|leetchi\.com|payasso|pay\.asso)/i;

// “Tickets: …”, “Billets: …”, “Billetterie: …”, “Réservation: …”, “Inscription: …”
function ticketDirectiveFromDescription(desc) {
  if (!desc) return "";
  const m = desc.match(/\b(?:tickets?|billets?|billetterie|reservations?|réservations?|reservation|réservation|inscriptions?)\s*[:=-]\s*(\S+)/i);
  return m && m[1] ? m[1] : "";
}

function normalizeTicketUrl(u) {
  if (!u) return "";
  u = clean(u);

  // Prefer public HelloAsso pages over widgets
  // https://www.helloasso.com/.../widget  ->  https://www.helloasso.com/...
  if (/^https?:\/\/www\.helloasso\.com\/.+\/widget(?:\/)?$/i.test(u)) {
    return u.replace(/\/widget\/?$/i, "");
  }
  return u;
}

function extractTicketFromICS(ev) {
  const desc = ev.description || ev.summary || "";

  // 1) Directive in description
  const direct = ticketDirectiveFromDescription(desc);
  if (direct) return normalizeTicketUrl(direct);

  // 2) Any ticketing URL in description
  const anyUrl = firstUrlFromText(desc);
  if (anyUrl && TICKET_HOSTS.test(anyUrl)) {
    return normalizeTicketUrl(anyUrl);
  }

  // 3) Fallback: if ev.url looks like a ticketing link, use it
  const evUrl = clean(ev.url || ev.source || "");
  if (evUrl && TICKET_HOSTS.test(evUrl)) {
    return normalizeTicketUrl(evUrl);
  }

  return "";
}


// your public host (used to resolve relative image paths)
const SITE_ORIGIN = "https://kizbourges.fr";

function normalizeCoverUrl(u) {
  if (!u) return "";
  u = clean(u);

  // Accept data URLs as-is
  if (/^data:image\//i.test(u)) return u;

  // Fix GitHub "blob" to raw content
  if (/^https?:\/\/github\.com\/.+\/blob\//i.test(u)) {
    return u
      .replace(/^https?:\/\/github\.com\//i, "https://raw.githubusercontent.com/")
      .replace("/blob/", "/");
  }

  // Allow GitHub Pages (kivo0.github.io) as-is
  // Allow absolute http(s) as-is
  if (/^https?:\/\//i.test(u)) return u;

  // Resolve site-relative/short paths => https://kizbourges.fr/Images/...
  // Accept "Images/..." or "/Images/..." or "images/..."
  const short = u.replace(/^\/+/, ""); // remove leading slash
  if (/^(images|Images)\//.test(short)) {
    return `${SITE_ORIGIN}/${short}`;
  }

  // Fallback: return original
  return u;
}

// Extract the first image-like URL from a string
function firstImageFromText(text) {
  if (!text) return "";
  // markdown ![](url) or plain http(s)://...ext
  const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+?\.(?:jpe?g|png|webp|gif))\)/i);
  if (md && md[1]) return md[1];

  const plain = text.match(/https?:\/\/[^\s)]+?\.(?:jpe?g|png|webp|gif)/i);
  if (plain && plain[0]) return plain[0];

  return "";
}

// Try to read a "Cover:" / "Affiche:" / "Image:" directive from DESCRIPTION
function coverDirectiveFromDescription(desc) {
  if (!desc) return "";
  // e.g. "Cover: https://example.com/image.jpg"
  const m = desc.match(/\b(?:cover|couverture|affiche|image)\s*[:=-]\s*(\S+)/i);
  if (m && m[1]) return m[1];
  return "";
}

/**
 * Find a cover image URL inside an ical event.
 * Supports ATTACH / attachments, description directive, generic image URLs, vendor fields.
 */
function extractCoverFromICS(ev) {
  // 1) ATTACH / attachments
  // node-ical may expose "attachments" as array or single value.
  const attachCandidates = [];
  const rawAttach = ev.attach || ev.attachment || ev.attachments || ev.ATTACH || ev.ATTACHMENT;
  if (rawAttach) {
    const pushVal = (val) => {
      if (!val) return;
      if (typeof val === "string") attachCandidates.push(val);
      else if (Array.isArray(val)) val.forEach(pushVal);
      else if (val.value) attachCandidates.push(val.value);
      else if (val.uri) attachCandidates.push(val.uri);
      else if (val.params && val.params.VALUE) attachCandidates.push(val.params.VALUE);
    };
    pushVal(rawAttach);
  }
  const attachImg = attachCandidates.find((x) => /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(x || ""));
  if (attachImg) return normalizeCoverUrl(attachImg);

  // 2) Vendor fields sometimes present
  const vendorImg =
    ev.image || ev.photo || ev["x-image"] || ev["X-IMAGE"] || ev["X-APPLE-STRUCTURED-LOCATION"]; // last one unlikely
  if (typeof vendorImg === "string" && /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(vendorImg)) {
    return normalizeCoverUrl(vendorImg);
  }

  // 3) DESCRIPTION directive
  const desc = ev.description || ev.summary || "";
  const directive = coverDirectiveFromDescription(desc);
  if (directive) return normalizeCoverUrl(directive);

  // 4) Any image URL in description
  const any = firstImageFromText(desc);
  if (any) return normalizeCoverUrl(any);

  return ""; // nothing found
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
  const coverUrl  = extractCoverFromICS(ev);      // from the cover helpers you added earlier
  const ticketUrl = extractTicketFromICS(ev);     // <-- new

  return {
    id: clean(ev.uid || ev.id || ev.summary),
    name: clean(ev.summary),
    start_time: toISOWithOffset(start),
    place: clean(ev.location || ev.geo || ""),
    cover: coverUrl,
    event_url: clean(ev.url || ev.source || ""),   // keep event page URL if provided
    ticket_url: ticketUrl                          // <-- populated only if found
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
