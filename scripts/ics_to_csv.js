// scripts/ics_to_csv.js
// ESM / Node 20
//
// KizBourges — Google Calendar → CSV
//
// FEATURES
// ---------------------------------------------------------
// EVENTS:
// - Imported automatically from Google Calendar
// - Recurrences supported
// - Accepts human-readable Calendar descriptions
// - Supports Facebook cover URLs in:
//
//      Cover: https://...
//
//   or:
//
//      Cover: [https://...](https://...)
//
//   or HTML links.
//
// - Supports:
//      Cover:
//      EventURL:
//      TicketURL:
//      Place:
//      Category:
//      pinned:
//
// - Facebook URLs with escaped characters such as \_ and \&
//   are automatically cleaned.
//
// COURSES:
// ---------------------------------------------------------
// Generated automatically by this script.
// They do NOT depend on Google Calendar.
//
// Every Tuesday:
//   20:00 → 21:00  Cours Kizomba
//   21:00 → 22:00  Pratique
//
// Both always use:
//   Images/events/cid.jpg
//
// After Tuesday at 22:00, the displayed course date
// automatically moves to the following Tuesday.
//
// ---------------------------------------------------------

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { DateTime } from "luxon";
import Papa from "papaparse";
import IcalExpander from "ical-expander";

/* =========================================================
   ENV
========================================================= */

const ICS_URL = process.env.GCAL_ICS_URL;

if (!ICS_URL) {
  console.error("❌ Missing env GCAL_ICS_URL");
  process.exit(1);
}

const ZONE = process.env.TZ || "Europe/Paris";

const CSV_PATH = "kizbourges_events_template1.csv";

const REMOVAL_DELAY_HOURS = Number(
  process.env.REMOVAL_DELAY_HOURS ?? 24
);

const PAST_DAYS = Number(
  process.env.PAST_DAYS ?? 7
);

const FUTURE_DAYS = Number(
  process.env.FUTURE_DAYS ?? 120
);

/* =========================================================
   WEEKLY COURSE CONFIGURATION
========================================================= */

const COURSE_COVER = "Images/events/cid.jpg";

const COURSE_PLACE =
  "Salle Baptiste Marcet, 2 Rue Parmentier, 18000 Bourges";

const WEEKLY_COURSES = [
  {
    id: "kizbourges-weekly-course",
    name: "Cours Kizomba",
    startHour: 20,
    startMinute: 0,
    endHour: 21,
    endMinute: 0,
  },
  {
    id: "kizbourges-weekly-practice",
    name: "Pratique",
    startHour: 21,
    startMinute: 0,
    endHour: 22,
    endMinute: 0,
  },
];

/* =========================================================
   BASIC HELPERS
========================================================= */

const clean = (value) =>
  (value ?? "")
    .toString()
    .replace(/\s+/g, " ")
    .trim();

function slug(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function jsDateToISO(date) {
  return DateTime.fromJSDate(date, {
    zone: ZONE,
  }).toISO({
    suppressMilliseconds: true,
  });
}

function dateTimeToISO(dt) {
  return dt.toISO({
    suppressMilliseconds: true,
  });
}

function roundToMinuteISO(iso) {
  if (!iso) return "";

  const dt = DateTime.fromISO(iso, {
    setZone: true,
  }).setZone(ZONE);

  if (!dt.isValid) {
    return clean(iso);
  }

  return dt
    .startOf("minute")
    .toISO({
      suppressMilliseconds: true,
    });
}

/* =========================================================
   FACEBOOK / URL CLEANING
========================================================= */

/*
 * Handles URLs copied from formatted Google Calendar text,
 * Markdown, Facebook, etc.
 *
 * Examples:
 *
 * \_   -> _
 * \&   -> &
 * &amp; -> &
 */
function cleanExtractedUrl(url = "") {
  return clean(url)
    .replace(/\\(?=[^A-Za-z0-9\s])/g, "")
    .replace(/&amp;/gi, "&")
    .trim();
}

/*
 * Supported:
 *
 * 1)
 * https://example.com/image.jpg
 *
 * 2)
 * [https://example.com/image.jpg](https://example.com/image.jpg)
 *
 * 3)
 * <a href="https://example.com/image.jpg">image</a>
 */
function extractUrlFromText(text = "") {
  if (!text) return "";

  const value = text.trim();

  /* ---------- MARKDOWN LINK ---------- */

  const markdown = value.match(
    /\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)/i
  );

  if (markdown) {
    return cleanExtractedUrl(markdown[1]);
  }

  /* ---------- HTML LINK ---------- */

  const html = value.match(
    /<a\s+[^>]*href=["']([^"']+)["']/i
  );

  if (html) {
    return cleanExtractedUrl(html[1]);
  }

  /* ---------- PLAIN URL ---------- */

  const plain = value.match(
    /https?:\/\/[^\s"<>()\]]+/i
  );

  if (plain) {
    return cleanExtractedUrl(plain[0]);
  }

  return "";
}

/* =========================================================
   LOCK HELPERS
========================================================= */

function isLocked(value) {
  return (
    typeof value === "string" &&
    /^\s*!/.test(value)
  );
}

function unlock(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(/^\s*!/, "")
    .trim();
}

/* =========================================================
   CATEGORY
========================================================= */

function normalizeCategory(value = "") {
  const category = clean(value).toLowerCase();

  if (
    category === "course" ||
    category === "cours"
  ) {
    return "course";
  }

  return "event";
}

/* =========================================================
   GOOGLE CALENDAR DESCRIPTION PARSER
========================================================= */

/*
 * The Calendar description can remain natural/human-readable.
 *
 * Example:
 *
 * Kiz’Bourges & Vinapava vous propose une soirée Danse.
 *
 * Cover: [https://facebook-image....](https://facebook-image....)
 *
 * Mercredi ...
 * Beaucoup de texte...
 *
 * EventURL: https://facebook.com/events/...
 *
 *
 * Only specifically tagged lines are extracted.
 *
 * The words "cours de Bachata" elsewhere in the description
 * DO NOT turn the event into a KizBourges course.
 */
function parseDescTags(desc = "") {
  const out = {};

  const patterns = {
    cover:
      /(!)?\s*(cover|image|poster)\s*:\s*([^\n\r]+)/i,

    ticket:
      /(!)?\s*(ticketurl|ticket_url|ticket|billet|tickets)\s*:\s*([^\n\r]+)/i,

    event:
      /(!)?\s*(eventurl|event_url|eventlink|event_link)\s*:\s*([^\n\r]+)/i,

    place:
      /(!)?\s*(place|adresse|address)\s*:\s*([^\n\r]+)/i,

    category:
      /\s*(category|categorie|catégorie|type)\s*:\s*(course|cours|event|evenement|événement)\s*$/im,

    pinned:
      /\s*(pinned|pin)\s*:\s*(true|false|1|0|yes|no)\s*$/im,
  };

  /* ---------- URL / TEXT TAGS ---------- */

  for (const key of [
    "cover",
    "ticket",
    "event",
    "place",
  ]) {
    const match = desc.match(patterns[key]);

    if (!match) continue;

    const bang = match[1];

    const raw = clean(match[3]);

    /*
     * Try extracting a URL.
     *
     * If it's not a URL, preserve the text.
     * This allows:
     *
     * Place: Salle Baptiste Marcet
     *
     * and:
     *
     * Cover: Images/events/photo.jpg
     */
    const extracted = extractUrlFromText(raw);

    const value = extracted || raw;

    out[key] = bang
      ? `!${value}`
      : value;
  }

  /* ---------- CATEGORY ---------- */

  const categoryMatch = desc.match(
    patterns.category
  );

  if (categoryMatch) {
    out.category = normalizeCategory(
      categoryMatch[2]
    );
  }

  /* ---------- PINNED ---------- */

  const pinnedMatch = desc.match(
    patterns.pinned
  );

  if (pinnedMatch) {
    out.pinned = clean(
      pinnedMatch[2]
    ).toLowerCase();
  }

  return out;
}

/* =========================================================
   NEXT TUESDAY
========================================================= */

/*
 * Luxon weekdays:
 *
 * Monday    = 1
 * Tuesday   = 2
 * Wednesday = 3
 * ...
 * Sunday    = 7
 *
 * Behaviour:
 *
 * Monday -> next day
 *
 * Tuesday before 22:00 ->
 * current Tuesday
 *
 * Tuesday >= 22:00 ->
 * following Tuesday
 *
 * Wednesday-Sunday ->
 * following Tuesday
 */
function getCourseTuesday(now) {
  const TUESDAY = 2;

  const daysUntilTuesday =
    (TUESDAY - now.weekday + 7) % 7;

  let tuesday = now
    .startOf("day")
    .plus({
      days: daysUntilTuesday,
    });

  if (now.weekday === TUESDAY) {
    const endOfPractice = tuesday.set({
      hour: 22,
      minute: 0,
      second: 0,
      millisecond: 0,
    });

    /*
     * At 22:00 or later, move immediately
     * to next Tuesday.
     */
    if (
      now.toMillis() >=
      endOfPractice.toMillis()
    ) {
      tuesday = tuesday.plus({
        days: 7,
      });
    }
  }

  return tuesday;
}

/* =========================================================
   CREATE WEEKLY COURSE ROWS
========================================================= */

function createWeeklyCourseRows(now) {
  const tuesday = getCourseTuesday(now);

  return WEEKLY_COURSES.map((course) => {
    const start = tuesday.set({
      hour: course.startHour,
      minute: course.startMinute,
      second: 0,
      millisecond: 0,
    });

    const end = tuesday.set({
      hour: course.endHour,
      minute: course.endMinute,
      second: 0,
      millisecond: 0,
    });

    return {
      id: course.id,

      name: course.name,

      start_time:
        dateTimeToISO(start),

      end_time:
        dateTimeToISO(end),

      place:
        COURSE_PLACE,

      cover:
        COURSE_COVER,

      event_url:
        "",

      ticket_url:
        "",

      category:
        "course",

      pinned:
        "",
    };
  });
}

/* =========================================================
   CSV
========================================================= */

function parseCSV(text) {
  if (!text?.trim()) {
    return [];
  }

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data
    .map((row) => ({
      id:
        clean(row.id),

      name:
        clean(row.name),

      start_time:
        clean(row.start_time),

      end_time:
        clean(row.end_time),

      place:
        row.place?.trim() || "",

      cover:
        row.cover?.trim() || "",

      event_url:
        row.event_url?.trim() || "",

      ticket_url:
        row.ticket_url?.trim() || "",

      category:
        clean(row.category),

      pinned:
        clean(row.pinned),
    }))
    .filter(
      (row) =>
        row.name &&
        row.start_time
    );
}

function unparseCSV(rows) {
  return (
    Papa.unparse(rows, {
      header: true,

      columns: [
        "id",
        "name",
        "start_time",
        "end_time",
        "place",
        "cover",
        "event_url",
        "ticket_url",
        "category",
        "pinned",
      ],
    }) + "\n"
  );
}

/* =========================================================
   MERGE RULES
========================================================= */

/*
 * Standard merge:
 *
 * Existing value beginning with ! is protected.
 *
 * Otherwise Google Calendar incoming value wins
 * when it exists.
 */
function preferICS(
  existingValue,
  incomingValue
) {
  if (isLocked(existingValue)) {
    return clean(existingValue);
  }

  return clean(
    incomingValue ||
    existingValue
  );
}

/*
 * Cover behaviour:
 *
 * - locked CSV cover -> keep
 * - new Calendar Cover: -> use it
 * - no new Calendar cover -> preserve existing
 *
 * Therefore you can update the Facebook poster simply
 * by changing Cover: in Google Calendar.
 */
function mergeCover(
  existingValue,
  incomingValue
) {
  if (isLocked(existingValue)) {
    return clean(existingValue);
  }

  const incoming = clean(
    incomingValue
  );

  if (incoming) {
    return incoming;
  }

  return clean(existingValue);
}

function mergeRows(
  existing,
  incoming
) {
  return {
    id:
      existing.id ||
      incoming.id,

    name:
      preferICS(
        existing.name,
        incoming.name
      ),

    start_time:
      preferICS(
        existing.start_time,
        incoming.start_time
      ),

    end_time:
      preferICS(
        existing.end_time,
        incoming.end_time
      ),

    place:
      preferICS(
        existing.place,
        incoming.place
      ),

    cover:
      mergeCover(
        existing.cover,
        incoming.cover
      ),

    event_url:
      preferICS(
        existing.event_url,
        incoming.event_url
      ),

    ticket_url:
      preferICS(
        existing.ticket_url,
        incoming.ticket_url
      ),

    category:
      preferICS(
        existing.category,
        incoming.category
      ),

    pinned:
      preferICS(
        existing.pinned,
        incoming.pinned
      ),
  };
}

/* =========================================================
   ICS EVENT → WEBSITE ROW
========================================================= */

function toRowFromICS(ev) {
  const start =
    ev.start instanceof Date
      ? ev.start
      : new Date(ev.start);

  const end =
    ev.end instanceof Date
      ? ev.end
      : ev.end
        ? new Date(ev.end)
        : null;

  const tags = parseDescTags(
    ev.description || ""
  );

  const name = clean(
    ev.summary
  );

  /*
   * Calendar entries default to EVENT.
   *
   * This is intentional.
   *
   * Example:
   *
   * Vinapava description contains:
   * "Cours de Bachata"
   *
   * It still remains an event.
   */
  const category = normalizeCategory(
    tags.category || "event"
  );

  /* ---------- COVER ---------- */

  const cover =
    tags.cover
      ? cleanExtractedUrl(
          unlock(tags.cover)
        )
      : "";

  /* ---------- EVENT URL ---------- */

  const eventUrl =
    tags.event
      ? cleanExtractedUrl(
          unlock(tags.event)
        )
      : cleanExtractedUrl(
          clean(ev.url || "")
        );

  /* ---------- TICKET ---------- */

  const ticketUrl =
    tags.ticket
      ? cleanExtractedUrl(
          unlock(tags.ticket)
        )
      : "";

  /* ---------- PLACE ---------- */

  const place =
    tags.place
      ? unlock(tags.place)
      : clean(
          ev.location || ""
        );

  return {
    id:
      clean(
        ev.uid ||
        ev.id ||
        ev.summary
      ),

    name,

    start_time:
      jsDateToISO(start),

    end_time:
      end
        ? jsDateToISO(end)
        : "",

    place,

    cover,

    event_url:
      eventUrl,

    ticket_url:
      ticketUrl,

    category,

    pinned:
      tags.pinned || "",
  };
}

/* =========================================================
   UNIQUE EVENT KEY
========================================================= */

function keyOf(row) {
  const dt = DateTime.fromISO(
    row.start_time,
    {
      setZone: true,
    }
  ).setZone(ZONE);

  const stamp = dt.isValid
    ? dt.toFormat(
        "yyyy-LL-dd'T'HH-mm"
      )
    : clean(row.start_time);

  return (
    `event__${slug(row.name)}__${stamp}`
  );
}

/* =========================================================
   PINNED
========================================================= */

function isPinnedValue(value) {
  const normalized = clean(value)
    .toLowerCase();

  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes"
  );
}

/* =========================================================
   DETECT OLD COURSE ROWS
========================================================= */

function isCourseRow(row) {
  if (
    normalizeCategory(
      row.category
    ) === "course"
  ) {
    return true;
  }

  const name = clean(
    row.name
  );

  return /(^|\b)(cours|course|pratique|hebdo|weekly)(\b|$)/i.test(
    name
  );
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  const now = DateTime
    .now()
    .setZone(ZONE);

  /* =======================================================
     READ EXISTING CSV
  ======================================================= */

  const existingRaw =
    existsSync(CSV_PATH)
      ? parseCSV(
          await fs.readFile(
            CSV_PATH,
            "utf8"
          )
        )
      : [];

  /*
   * Delete old previously generated course rows.
   *
   * We regenerate exactly TWO correct rows later:
   *
   * 20:00-21:00
   * 21:00-22:00
   */
  const existingEvents =
    existingRaw.filter(
      (row) =>
        !isCourseRow(row)
    );

  /* =======================================================
     FETCH GOOGLE CALENDAR
  ======================================================= */

  const response =
    await fetch(ICS_URL);

  if (!response.ok) {
    throw new Error(
      `ICS fetch failed (${response.status})`
    );
  }

  const icsText =
    await response.text();

  /* =======================================================
     EXPAND CALENDAR RECURRENCES
  ======================================================= */

  const expander =
    new IcalExpander({
      ics: icsText,
      maxIterations: 5000,
    });

  const rangeStart = now
    .minus({
      days: PAST_DAYS,
    })
    .toJSDate();

  const rangeEnd = now
    .plus({
      days: FUTURE_DAYS,
    })
    .toJSDate();

  const {
    events,
    occurrences,
  } = expander.between(
    rangeStart,
    rangeEnd
  );

  /* =======================================================
     NORMAL / NON-RECURRING EVENTS
  ======================================================= */

  const singleRows =
    (events || [])
      .filter(
        (event) =>
          event?.startDate &&
          event?.summary
      )
      .map((event) =>
        toRowFromICS({
          uid:
            event.uid,

          id:
            event.uid,

          summary:
            event.summary,

          start:
            event.startDate.toJSDate(),

          end:
            event.endDate
              ? event.endDate.toJSDate()
              : null,

          location:
            event.location,

          description:
            event.description,

          url:
            event.url,
        })
      );

  /* =======================================================
     RECURRING GOOGLE CALENDAR EVENTS
  ======================================================= */

  const occurrenceRows =
    (occurrences || [])
      .filter(
        (occurrence) =>
          occurrence?.startDate &&
          occurrence?.item?.summary
      )
      .map((occurrence) => {
        const event =
          occurrence.item;

        const startJS =
          occurrence.startDate.toJSDate();

        const endJS =
          occurrence.endDate
            ? occurrence.endDate.toJSDate()
            : null;

        const stamp =
          DateTime.fromJSDate(
            startJS,
            {
              zone: ZONE,
            }
          ).toFormat(
            "yyyyLLdd_HHmm"
          );

        const occurrenceId =
          `${
            clean(
              event.uid ||
              event.id ||
              event.summary
            )
          }__${stamp}`;

        return toRowFromICS({
          uid:
            occurrenceId,

          id:
            occurrenceId,

          summary:
            event.summary,

          start:
            startJS,

          end:
            endJS,

          location:
            event.location,

          description:
            event.description,

          url:
            event.url,
        });
      });

  /* =======================================================
     GOOGLE CALENDAR ITEMS
  ======================================================= */

  /*
   * We ignore Calendar entries explicitly marked:
   *
   * Category: course
   *
   * because the regular Tuesday course/practice
   * is generated locally below.
   *
   * Vinapava remains an event even if its description
   * contains "Cours de Bachata", because category detection
   * does NOT inspect the body text.
   */
  const calendarEvents =
    [
      ...singleRows,
      ...occurrenceRows,
    ].filter(
      (row) =>
        row.category !==
        "course"
    );

  /* =======================================================
     MERGE EXISTING CSV + CALENDAR
  ======================================================= */

  const map =
    new Map();

  for (
    const rawRow of [
      ...existingEvents,
      ...calendarEvents,
    ]
  ) {
    const row = {
      ...rawRow,
    };

    row.start_time =
      roundToMinuteISO(
        row.start_time
      );

    if (row.end_time) {
      row.end_time =
        roundToMinuteISO(
          row.end_time
        );
    }

    /*
     * Everything here is an event.
     */
    row.category =
      "event";

    const key =
      keyOf(row);

    if (map.has(key)) {
      map.set(
        key,
        mergeRows(
          map.get(key),
          row
        )
      );
    } else {
      map.set(
        key,
        row
      );
    }
  }

  /* =======================================================
     REMOVE OLD EVENTS
  ======================================================= */

  let finalRows =
    [...map.values()].filter(
      (row) => {
        /*
         * Pinned events stay forever.
         */
        if (
          isPinnedValue(
            row.pinned
          )
        ) {
          return true;
        }

        const start =
          DateTime.fromISO(
            row.start_time,
            {
              setZone: true,
            }
          ).setZone(ZONE);

        if (!start.isValid) {
          return false;
        }

        return (
          now.toMillis() <
          start
            .plus({
              hours:
                REMOVAL_DELAY_HOURS,
            })
            .toMillis()
        );
      }
    );

  /* =======================================================
     ADD WEEKLY COURSE + PRATIQUE
  ======================================================= */

  const weeklyCourses =
    createWeeklyCourseRows(
      now
    );

  finalRows.push(
    ...weeklyCourses
  );

  /* =======================================================
     SORT BY DATE
  ======================================================= */

  finalRows.sort(
    (a, b) => {
      const dateA =
        DateTime.fromISO(
          a.start_time,
          {
            setZone: true,
          }
        ).toMillis();

      const dateB =
        DateTime.fromISO(
          b.start_time,
          {
            setZone: true,
          }
        ).toMillis();

      return dateA - dateB;
    }
  );

  /* =======================================================
     WRITE CSV
  ======================================================= */

  await fs.writeFile(
    CSV_PATH,
    unparseCSV(
      finalRows
    ),
    "utf8"
  );

  /* =======================================================
     LOG
  ======================================================= */

  const eventCount =
    finalRows.filter(
      (row) =>
        row.category ===
        "event"
    ).length;

  const courseCount =
    finalRows.filter(
      (row) =>
        row.category ===
        "course"
    ).length;

  const nextTuesday =
    getCourseTuesday(
      now
    );

  console.log("");
  console.log(
    "✅ KizBourges synchronization complete"
  );

  console.log(
    `📅 ${eventCount} event(s)`
  );

  console.log(
    `💃 ${courseCount} course/practice entries`
  );

  console.log(
    `🗓️ Course date: ${nextTuesday.toFormat(
      "dd/LL/yyyy"
    )}`
  );

  console.log(
    "🕗 Cours: 20:00 → 21:00"
  );

  console.log(
    "🕘 Pratique: 21:00 → 22:00"
  );

  console.log(
    `🖼️ Course image: ${COURSE_COVER}`
  );

  console.log("");
}

/* =========================================================
   RUN
========================================================= */

main().catch((error) => {
  console.error(
    "❌ Synchronization failed:"
  );

  console.error(error);

  process.exit(1);
});
