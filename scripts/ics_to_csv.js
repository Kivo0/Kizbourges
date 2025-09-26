// scripts/ics_to_csv.js
// Merges Google Calendar ICS -> CSV, preserving manual rows and skipping auto duplicates.
// Manual rows are detected if id starts with "manual_" OR source==="manual" (extra column allowed).

import ical from 'ical';
import { DateTime } from 'luxon';
import fs from 'fs';
import fetch from 'node-fetch';
import Papa from 'papaparse';

const ICS_URL = process.env.GCAL_ICS_URL;
const TZ = 'Europe/Paris';

if (!ICS_URL) {
  console.error('Missing GCAL_ICS_URL');
  process.exit(1);
}



// Remove accents/diacritics, punctuation, collapse spaces, lowercase
function normalizeText(s = "") {
  return String(s)
    .normalize('NFD')                     // split letters + accents
    .replace(/[\u0300-\u036f]/g, '')     // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')        // drop punctuation/symbols
    .replace(/\s+/g, ' ')                // collapse spaces
    .trim();
}

function minuteKey(iso) {
  // YYYY-MM-DDTHH:MM
  return (iso || '').slice(0,16);
}

// Minimal Levenshtein; good enough for tiny differences like é/e
function levenshtein(a = "", b = "") {
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({length: m+1}, (_,i)=>Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,      // delete
        dp[i][j-1] + 1,      // insert
        dp[i-1][j-1] + cost  // replace
      );
    }
  }
  return dp[m][n];
}

// ---- Utils ----
function parseKeys(desc = '') {
  const out = { EventURL: '', TicketURL: '', Cover: '' };
  desc.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*(EventURL|TicketURL|Cover)\s*:\s*(.+)\s*$/i);
    if (m) out[m[1]] = m[2].trim();
  });
  return out;
}

function normalizeIcsEvent(e, key) {
  if (e.type !== 'VEVENT') return null;

  const start = e.start ? DateTime.fromJSDate(e.start).setZone(TZ) : null;
  if (!start) return null; // require start

  const { EventURL, TicketURL, Cover } = parseKeys(e.description || '');

  // Stable auto id: UID + start time (handles recurrences)
  const base = (e.uid || `ics_${key}`).replace(/@.*/,'');
  const autoId = `${base}_${start.toFormat("yyyyLLdd'T'HHmm")}`.replace(/[^a-zA-Z0-9_-]/g, '_');

  return {
    id: autoId,
    name: e.summary || 'Événement',
    start_time: start.toISO(),
    place: e.location || '',
    cover: Cover || '',
    event_url: EventURL || '',
    ticket_url: TicketURL || '',
    source: 'auto' // mark as auto so we can refresh later
  };
}

function toCSV(rows) {
  const header = ['id','name','start_time','place','cover','event_url','ticket_url','source']; // 'source' optional
  const csv = Papa.unparse(rows, { columns: header });
  return csv;
}

function readExistingCSV(path) {
  if (!fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, 'utf8').trim();
  if (!text) return [];
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return (parsed.data || []).filter(r => r && r.id);
}

// Make a dedupe key that matches manual vs auto for the "same" event.
// We use (normalized name + start time to the minute).
// Normalize URL (strip common trackers)
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid']
      .forEach(p => url.searchParams.delete(p));
    return url.origin + url.pathname + (url.search ? '?' + url.searchParams.toString() : '');
  } catch {
    return (u || '').trim().toLowerCase();
  }
}

function dedupeKey(row) {
  // 1) Strongest: exact event_url
  if (row.event_url) return 'url__' + normalizeUrl(row.event_url);

  // 2) Next: ICS uid_base + minute
  if (row.uid_base)  return 'uid__' + row.uid_base + '__' + minuteKey(row.start_time);

  // 3) Fallback: normalized name + minute + normalized place
  const name = normalizeText(row.name);
  const place = normalizeText(row.place);
  return 'txt__' + name + '__' + minuteKey(row.start_time) + '__' + place;
}


function isManual(row) {
  const id = String(row.id || '');
  const src = String(row.source || '');
  return id.startsWith('manual_') || src.toLowerCase() === 'manual';
}

// ---- Main ----
(async () => {
  try {
    const res = await fetch(ICS_URL);
    if (!res.ok) throw new Error(`ICS fetch failed ${res.status}`);
    const text = await res.text();
    const data = ical.parseICS(text);

    // New auto rows from calendar
    const autoRows = Object.keys(data)
      .map(k => normalizeIcsEvent(data[k], k))
      .filter(Boolean);

    // Existing rows (manual + any previous auto)
// Build an index of existing rows by key
const existing = readExistingCSV('kizbourges_events_template1.csv');
const existingByKey = new Map();
for (const r of existing) existingByKey.set(dedupeKey(r), r);

// To speed fuzzy search, also bucket rows by minute
const byMinute = new Map();
function addToMinuteBucket(row) {
  const mk = minuteKey(row.start_time);
  if (!byMinute.has(mk)) byMinute.set(mk, []);
  byMinute.get(mk).push(row);
}
existing.forEach(addToMinuteBucket);

function isManual(row) {
  const id = String(row.id || '');
  const src = String(row.source || '');
  return id.startsWith('manual_') || src.toLowerCase() === 'manual';
}

// Start from existing rows
const mergedByKey = new Map(existingByKey);

// Merge in auto rows one by one
for (const auto of autoRows) {
  const key = dedupeKey(auto);
  const prev = mergedByKey.get(key);

  if (prev) {
    // Already have one with the same key
    if (!isManual(prev)) mergedByKey.set(key, { ...auto, source: 'auto' }); // refresh auto
    // if manual, keep manual as-is
    continue;
  }

  // --- Fuzzy fallback: same minute, compare normalized name (and place) ---
  const mk = minuteKey(auto.start_time);
  const candidates = byMinute.get(mk) || [];
  const nAutoName = normalizeText(auto.name);
  const nAutoPlace = normalizeText(auto.place);

  let matchedKey = null;
  for (const cand of candidates) {
    const nCandName = normalizeText(cand.name);
    const nCandPlace = normalizeText(cand.place);
    const nameDist = levenshtein(nAutoName, nCandName);
    const placeOK = (!nAutoPlace && !nCandPlace) || nAutoPlace === nCandPlace;

    // Allow tiny differences in name (≤ 2 edits), and same (or empty) place
    if (nameDist <= 2 && placeOK && minuteKey(cand.start_time) === mk) {
      matchedKey = dedupeKey(cand);
      // Respect manual precedence
      if (isManual(cand)) {
        matchedKey = null; // do not insert duplicate; keep manual
      } else {
        // Replace older auto with the fresh one
        mergedByKey.set(dedupeKey(cand), { ...auto, source: 'auto' });
      }
      break;
    }
  }

  if (matchedKey) {
    // already handled via replacement above
    continue;
  }

  // No match → insert as new auto
  mergedByKey.set(key, { ...auto, source: 'auto' });
  addToMinuteBucket(auto); // keep buckets in sync for subsequent autos
}

// Final array, sorted
let merged = Array.from(mergedByKey.values())
  .sort((a,b) => new Date(a.start_time) - new Date(b.start_time));

    // Final array
    let merged = Array.from(mergedByKey.values());

    // Sort by start_time ascending (manuals without valid date go last)
    merged.sort((a, b) => {
      const ta = new Date(a.start_time || 0).getTime();
      const tb = new Date(b.start_time || 0).getTime();
      return ta - tb;
    });

    // Write CSV
    const csv = toCSV(merged);
    fs.writeFileSync('kizbourges_events_template1.csv', csv, 'utf8');
    console.log(`Merged. CSV now has ${merged.length} total rows.`);
  } catch (err) {
    console.error('ICS->CSV merge failed:', err);
    process.exit(1);
  }
})();
