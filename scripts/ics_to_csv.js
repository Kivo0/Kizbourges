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
function dedupeKey(row) {
  const name = String(row.name || '').trim().toLowerCase().replace(/\s+/g,' ');
  const t = (row.start_time || '').slice(0,16); // YYYY-MM-DDTHH:MM
  return `${name}__${t}`;
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
    const existing = readExistingCSV('kizbourges_events_template1.csv');

    // Build maps by dedupe key
    const existingByKey = new Map();
    for (const r of existing) {
      existingByKey.set(dedupeKey(r), r);
    }

    // Merge logic:
    // - If an existing MANUAL row exists for the same key -> keep manual, DO NOT add auto duplicate.
    // - Else if an existing AUTO row exists for the same key -> replace it with the new auto (refresh).
    // - Else -> insert new auto row.
    const mergedByKey = new Map();
    // Start with all existing rows
    for (const r of existing) {
      mergedByKey.set(dedupeKey(r), r);
    }

    for (const auto of autoRows) {
      const key = dedupeKey(auto);
      const prev = mergedByKey.get(key);
      if (!prev) {
        // No existing row -> add auto
        mergedByKey.set(key, auto);
      } else {
        if (isManual(prev)) {
          // Keep manual row as-is (more precise)
          // Do nothing
        } else {
          // Previous was auto -> refresh/replace with new auto
          // Preserve 'source' as 'auto'
          mergedByKey.set(key, { ...auto, source: 'auto' });
        }
      }
    }

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
