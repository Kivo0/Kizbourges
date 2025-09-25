import ical from 'ical';
import { DateTime } from 'luxon';
import fs from 'fs';
import fetch from 'node-fetch';

const ICS_URL = process.env.GCAL_ICS_URL;
const TZ = 'Europe/Paris';
const NOW = DateTime.now().setZone(TZ);

if (!ICS_URL) {
  console.error('Missing GCAL_ICS_URL');
  process.exit(1);
}

function parseKeys(desc = '') {
  const out = { EventURL: '', TicketURL: '', Cover: '' };
  desc.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*(EventURL|TicketURL|Cover)\s*:\s*(.+)\s*$/i);
    if (m) out[m[1]] = m[2].trim();
  });
  return out;
}

function toCSV(rows) {
  const esc = v => {
    if (!v) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['id','name','start_time','place','cover','event_url','ticket_url'];
  return [header.join(',')]
    .concat(rows.map(r => [
      esc(r.id), esc(r.name), esc(r.start_time),
      esc(r.place), esc(r.cover), esc(r.event_url), esc(r.ticket_url)
    ].join(',')))
    .join('\n');
}

function normalize(ev, key) {
  if (ev.type !== 'VEVENT') return null;
  const start = ev.start ? DateTime.fromJSDate(ev.start).setZone(TZ) : null;
  if (!start || start < NOW) return null;

  const { EventURL, TicketURL, Cover } = parseKeys(ev.description || '');
  const id = `${(ev.uid || key).replace(/@.*/,'')}_${start.toFormat("yyyyLLdd'T'HHmm")}`;

  return {
    id,
    name: ev.summary || 'Événement',
    start_time: start.toISO(),
    place: ev.location || '',
    cover: Cover,
    event_url: EventURL,
    ticket_url: TicketURL
  };
}

(async () => {
  try {
    const res = await fetch(ICS_URL);
    if (!res.ok) throw new Error('Fetch failed');
    const text = await res.text();
    const data = ical.parseICS(text);

    const rows = Object.keys(data)
      .map(k => normalize(data[k], k))
      .filter(Boolean)
      .sort((a,b) => new Date(a.start_time) - new Date(b.start_time));

    fs.writeFileSync('kizbourges_events_template1.csv', toCSV(rows));
    console.log(`Wrote ${rows.length} events`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
