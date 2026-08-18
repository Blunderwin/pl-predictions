/**
 * Turning chat exports into timestamped messages.
 *
 * Two sources, because the group moved platform on Christmas Day 2024:
 * Snapchat from August 2021 to 22 December 2024, WhatsApp from the
 * 25th onward. They don't overlap, so the two together are continuous.
 *
 * Both emit the same shape: { ts: Date, author: string, text: string }.
 * Timestamps are UK local in both exports and come out as real UTC
 * instants, so a 15:00 message in August is 14:00Z.
 */

export function bstOffsetMs(utcMs){
  const y = new Date(utcMs).getUTCFullYear();
  const lastSun = (month) => {
    const d = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, d.getUTCDate() - d.getUTCDay(), 1);
  };
  return (utcMs >= lastSun(2) && utcMs < lastSun(9)) ? 3600e3 : 0;
}
const ukInstant = (y, m, d, hh, mm, ss = 0) => {
  const naive = Date.UTC(y, m, d, hh, mm, ss);
  return new Date(naive - bstOffsetMs(naive));
};

/* ---------- WhatsApp ---------- */
// iOS:     [05/08/2022, 19:15:23] Ben Wright: HAHHA
// Android: 05/08/2022, 19:15 - Ben Wright: HAHHA
const WA_IOS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?\]\s*([^:]{1,40}):\s*(.*)$/i;
const WA_AND = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?\s+-\s+([^:]{1,40}):\s*(.*)$/i;

export function parseWhatsApp(text){
  const out = [];
  for(const raw of text.split(/\r?\n/)){
    const line = raw.replace(/‎/g, "");
    const m = line.match(WA_IOS) || line.match(WA_AND);
    if(!m){                                   // continuation of a multi-line message
      if(out.length) out[out.length - 1].text += "\n" + line;
      continue;
    }
    let [, d, mo, y, hh, mm, ss, ampm, author, body] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    hh = Number(hh);
    if(ampm){ const pm = /p/i.test(ampm); if(hh === 12) hh = pm ? 12 : 0; else if(pm) hh += 12; }
    out.push({ ts: ukInstant(y, mo - 1, Number(d), hh, Number(mm), Number(ss || 0)),
               author: author.trim(), text: body.trim() });
  }
  return clean(out);
}

/* ---------- Snapchat ---------- */
// A copied conversation rather than a structured export:
//
//   22 December 2024        <- date separator, applies to what FOLLOWS
//   Ben Wright              <- author
//   10:47                   <- time
//   AHADA                   <- message, one or more lines
//
// The date separator preceding its messages is load-bearing and was
// checked against the data: "Tomorrow D" sits under 12 August 2021,
// and the 2021/22 season opened on the 13th.
const SNAP_DATE = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/;
const SNAP_TIME = /^(\d{1,2}):(\d{2})$/;
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

export function parseSnapchat(text, authors){
  const known = new Set(authors);
  const lines = text.split(/\r?\n/);
  const out = [];
  let date = null, cur = null, orphaned = 0;

  for(let i = 0; i < lines.length; i++){
    const L = lines[i].trim();

    const d = L.match(SNAP_DATE);
    if(d){ date = { y:+d[3], m:MONTHS.indexOf(d[2]), d:+d[1] }; cur = null; continue; }

    let ahead = 1;
    while(/^\(edited\)$/i.test((lines[i + ahead] || "").trim())) ahead++;
    const t = (lines[i + ahead] || "").trim().match(SNAP_TIME);
    if(known.has(L) && t){
      i += ahead;                             // consume "(Edited)" and the time line
      if(!date){ orphaned++; cur = null; continue; }   // before the first separator
      cur = { ts: ukInstant(date.y, date.m, date.d, +t[1], +t[2]), author: L, text: "" };
      out.push(cur);
      continue;
    }

    if(cur && L) cur.text += (cur.text ? "\n" : "") + L;
  }
  return { messages: clean(out), orphaned };
}

// Snapchat's author list isn't in the file, so read it off the lines
// that sit directly above a time.
export function sniffSnapchatAuthors(text){
  const lines = text.split(/\r?\n/);
  const tally = new Map();
  for(let i = 0; i < lines.length - 1; i++){
    const a = lines[i].trim();
    if(!a || a.length > 40 || SNAP_DATE.test(a)) continue;
    let ahead = 1;
    while(/^\(edited\)$/i.test((lines[i + ahead] || "").trim())) ahead++;
    if(!SNAP_TIME.test((lines[i + ahead] || "").trim())) continue;
    tally.set(a, (tally.get(a) || 0) + 1);
  }
  // A real author appears constantly; stray lines that happen to precede
  // a time appear once or twice.
  return [...tally.entries()].filter(([, n]) => n >= 10).map(([a]) => a);
}

export function looksLikeSnapchat(text){
  const head = text.split(/\r?\n/).slice(0, 400);
  return !head.some(l => WA_IOS.test(l.replace(/‎/g, "")) || WA_AND.test(l))
      && head.filter(l => SNAP_TIME.test(l.trim())).length >= 5;
}

export function parseChat(text){
  if(looksLikeSnapchat(text)){
    const authors = sniffSnapchatAuthors(text);
    const { messages, orphaned } = parseSnapchat(text, authors);
    return { source:"snapchat", messages, authors, orphaned };
  }
  return { source:"whatsapp", messages: parseWhatsApp(text), authors: null, orphaned: 0 };
}

const clean = list => list.map(m => ({
  ...m, text: m.text.replace(/\s*<This message was edited>\s*/gi, "")
                    .replace(/\s*\(Edited\)\s*$/i, "").trim()
}));
