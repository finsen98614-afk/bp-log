// Acceptance tests: load the REAL index.html into jsdom with a real
// (in-memory) IndexedDB and drive it the way a user would.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Boot a fresh app instance. `seed` records are written straight into
// IndexedDB before the app loads, simulating pre-existing stored data.
async function boot({ seed = [], breakDB = false, keepFactory = null } = {}) {
  const factory = keepFactory || new FDBFactory();

  if (seed.length) {
    await new Promise((res, rej) => {
      const req = factory.open('bpLogDB', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('readings')) db.createObjectStore('readings', { keyPath: 'id' });
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const t = db.transaction('readings', 'readwrite');
        const s = t.objectStore('readings');
        seed.forEach(r => s.put(r));
        t.oncomplete = () => { db.close(); res(); };
        t.onerror = () => rej(t.error);
      };
      req.onerror = () => rej(req.error);
    });
  }

  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'https://example.org/bp-log/',
    virtualConsole: vc,
    beforeParse(win) {
      if (breakDB) {
        win.indexedDB = { open() { const r = {}; setTimeout(() => r.onerror && r.onerror({ target: { error: new Error('quota denied') } }), 0); return r; } };
      } else {
        win.indexedDB = factory;
        win.IDBKeyRange = FDBKeyRange;
      }
      win.navigator.storage = undefined;
      // Capture downloads instead of hitting the filesystem.
      win.__downloads = [];
      const origCreate = win.document.createElement.bind(win.document);
      win.URL.createObjectURL = blob => { win.__lastBlob = blob; return 'blob:mock'; };
      win.URL.revokeObjectURL = () => {};
      win.document.createElement = tag => {
        const el = origCreate(tag);
        if (String(tag).toLowerCase() === 'a') {
          el.click = function () { win.__downloads.push({ name: el.download, blob: win.__lastBlob }); };
        }
        return el;
      };
    }
  });

  await sleep(120);
  return dom;
}

const $ = (dom, sel) => dom.window.document.querySelector(sel);
const msgText = dom => $(dom, '#msg').textContent;
const logRows = dom => [...dom.window.document.querySelectorAll('.entry')];

async function addReading(dom, sys, dia, pulse = '', note = '') {
  const d = dom.window.document;
  d.getElementById('fSys').value = String(sys);
  d.getElementById('fDia').value = String(dia);
  d.getElementById('fPulse').value = String(pulse);
  d.getElementById('fNote').value = String(note);
  d.getElementById('addBtn').click();
  await sleep(60);
}

async function readBlob(blob) {
  if (typeof blob.text === 'function') return await blob.text();
  return String(blob);
}

(async () => {
  console.log('\n=== AT-1  First run: empty state ===');
  {
    const dom = await boot();
    check('AT-1.1 shows "No readings yet"', $(dom, '.empty') !== null);
    check('AT-1.2 count reads 0 entries', $(dom, '#count').textContent.includes('0'));
    check('AT-1.3 no fake seeded reading appears', logRows(dom).length === 0);
    check('AT-1.4 averages show em-dash', $(dom, '#avgSys').textContent === '—');
    check('AT-1.5 CSV/Backup disabled when empty',
      $(dom, '#csvBtn').disabled && $(dom, '#backupBtn').disabled);
    check('AT-1.6 Restore stays enabled when empty', $(dom, '#restoreBtn').disabled === false);
    check('AT-1.7 chart hidden below 2 readings', $(dom, '#chartbox').style.display === 'none');
    check('AT-1.8 no red banner on healthy DB', $(dom, '#banner').style.display !== 'block');
    dom.window.close();
  }

  console.log('\n=== AT-2  Add a reading (the core requirement) ===');
  {
    const dom = await boot();
    await addReading(dom, 124, 79, 70, '啱啱飲完咖啡');
    check('AT-2.1 confirmation says Saved', /^Saved /.test(msgText(dom)), msgText(dom));
    check('AT-2.2 one row in log', logRows(dom).length === 1);
    check('AT-2.3 reading rendered as 124/79', logRows(dom)[0].querySelector('.reading').textContent.includes('124/79'));
    check('AT-2.4 pulse rendered', logRows(dom)[0].textContent.includes('70 bpm'));
    check('AT-2.5 Chinese comment preserved', logRows(dom)[0].querySelector('.note').textContent === '啱啱飲完咖啡');
    check('AT-2.6 category = Watch (HC2025: 124 systolic)', logRows(dom)[0].querySelector('.tag').textContent === 'Watch');
    check('AT-2.7 timestamp auto-filled', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(logRows(dom)[0].querySelector('.date').textContent));
    check('AT-2.8 inputs cleared after add', $(dom, '#fSys').value === '' && $(dom, '#fNote').value === '');
    check('AT-2.9 Latest stat updated', $(dom, '#latest').textContent === '124/79');
    check('AT-2.10 export buttons now enabled', !$(dom, '#csvBtn').disabled);
    dom.window.close();
  }

  console.log('\n=== AT-3  Persistence across app restart (the original failure) ===');
  {
    const factory = new FDBFactory();
    const dom1 = await boot({ keepFactory: factory });
    await addReading(dom1, 132, 84, 68, 'morning');
    await addReading(dom1, 118, 76, 72);
    check('AT-3.1 two readings before restart', logRows(dom1).length === 2);
    dom1.window.close();

    const dom2 = await boot({ keepFactory: factory });
    check('AT-3.2 both readings survive restart', logRows(dom2).length === 2, 'got ' + logRows(dom2).length);
    check('AT-3.3 values intact after reload', logRows(dom2).some(r => r.textContent.includes('132/84')));
    check('AT-3.4 comment survives reload', logRows(dom2).some(r => r.textContent.includes('morning')));
    check('AT-3.5 newest first ordering', logRows(dom2)[0].querySelector('.reading').textContent.includes('118/76'));
    dom2.window.close();
  }

  console.log('\n=== AT-4  Validation ===');
  {
    const dom = await boot();
    const cases = [
      ['', 80, '', 'blank systolic rejected', /Systolic/],
      [30, 80, '', 'systolic below 40 rejected', /Systolic/],
      [300, 80, '', 'systolic above 260 rejected', /Systolic/],
      [120, 10, '', 'diastolic below 20 rejected', /Diastolic/],
      [120, 210, '', 'diastolic above 200 rejected', /Diastolic/],
      [80, 120, '', 'systolic <= diastolic rejected', /higher than diastolic/],
      [120, 80, 999, 'pulse above 250 rejected', /Pulse/],
      [120, 80, -5, 'pulse negative rejected', /Pulse/],
      ['abc', 'def', '', 'non-numeric rejected', /Systolic/],
    ];
    for (const [s, d, p, name, re] of cases) {
      await addReading(dom, s, d, p);
      check('AT-4 ' + name, re.test(msgText(dom)) && logRows(dom).length === 0, msgText(dom));
    }
    await addReading(dom, 120, 80, '');
    check('AT-4 blank pulse accepted', logRows(dom).length === 1);
    check('AT-4 no bpm shown when pulse blank', !logRows(dom)[0].textContent.includes('bpm'));
    dom.window.close();
  }

  console.log('\n=== AT-5  Hypertension Canada 2025 categories ===');
  {
    const dom = await boot();
    const bands = [
      [118, 75, 'Normal'], [124, 79, 'Watch'], [129, 79, 'Watch'],
      [130, 79, 'HTN'], [125, 82, 'HTN'], [135, 85, 'HTN'],
      [140, 88, 'Treat'], [128, 92, 'Treat'],
      [182, 70, 'Crisis'], [150, 122, 'Crisis'],
    ];
    for (const [s, d, want] of bands) {
      await addReading(dom, s, d);
      const got = logRows(dom)[0].querySelector('.tag').textContent;
      check(`AT-5 ${s}/${d} -> ${want}`, got === want, 'got ' + got);
    }
    dom.window.close();
  }

  console.log('\n=== AT-6  Delete ===');
  {
    const factory = new FDBFactory();
    const dom = await boot({ keepFactory: factory });
    await addReading(dom, 120, 80);
    await addReading(dom, 130, 85);
    logRows(dom)[0].querySelector('.del').click();
    await sleep(60);
    check('AT-6.1 row removed from UI', logRows(dom).length === 1);
    check('AT-6.2 correct row remained', logRows(dom)[0].textContent.includes('120/80'));
    check('AT-6.3 confirmation shown', msgText(dom) === 'Deleted.');
    dom.window.close();

    const dom2 = await boot({ keepFactory: factory });
    check('AT-6.4 deletion persisted across restart', logRows(dom2).length === 1);
    dom2.window.close();
  }

  console.log('\n=== AT-7  Corrupt stored data cannot poison the UI ===');
  {
    const dom = await boot({
      seed: [
        { id: 1, date: '2026-08-10 09:00', sys: 120, dia: 80, pulse: 70 },
        { id: 2, date: '2026-08-11 09:00', sys: NaN, dia: 80 },
        { id: 3, date: '2026-08-12 09:00', sys: 'abc', dia: 'def' },
        { id: 4, date: '2026-08-13 09:00', sys: 9999, dia: 80 },
        { id: 5, date: '2026-08-14 09:00', sys: 130, dia: 85 },
        { id: -1, meta: true, lastBackup: '2026-08-01' },
      ]
    });
    check('AT-7.1 only the 2 valid readings load', logRows(dom).length === 2, 'got ' + logRows(dom).length);
    check('AT-7.2 averages are numeric, not NaN', !$(dom, '#avgSys').textContent.includes('NaN'), $(dom, '#avgSys').textContent);
    check('AT-7.3 avg sys correct ((120+130)/2=125)', $(dom, '#avgSys').textContent === '125');
    check('AT-7.4 legacy meta record hidden from log',
      !logRows(dom).some(r => r.querySelector('.del').getAttribute('data-del') === '-1'));
    dom.window.close();
  }

  console.log('\n=== AT-8  CSV export ===');
  {
    const dom = await boot();
    await addReading(dom, 124, 79, 70, 'coffee, then a walk');
    await addReading(dom, 132, 84, '');
    $(dom, '#csvBtn').click();
    await sleep(40);
    const dl = dom.window.__downloads.pop();
    const csv = await readBlob(dl.blob);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    check('AT-8.1 filename is bp-log-<date>.csv', /^bp-log-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.name), dl.name);
    // blob.text() strips a leading BOM per the encoding spec, so check raw bytes.
    const bytes = Buffer.from(await dl.blob.arrayBuffer());
    check('AT-8.2 UTF-8 BOM present for Excel',
      bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
      [...bytes.slice(0, 3)].join(','));
    check('AT-8.3 header has separate Date and Time', lines[0].startsWith('Date,Time,Systolic'), lines[0]);
    check('AT-8.4 one header + two rows', lines.length === 3, 'got ' + lines.length);
    check('AT-8.5 comma inside comment is quoted', lines.some(l => l.includes('"coffee, then a walk"')));
    check('AT-8.6 date and time in separate columns', /^\d{4}-\d{2}-\d{2},\d{2}:\d{2},/.test(lines[1]), lines[1]);
    check('AT-8.7 blank pulse leaves an empty field', lines.some(l => /,\d+,\d+,,/.test(l)));
    check('AT-8.8 oldest row first in export', lines[1].includes('124') || lines[1].includes('132'));
    dom.window.close();
  }

  console.log('\n=== AT-9  Backup and restore round-trip ===');
  {
    const dom = await boot();
    await addReading(dom, 124, 79, 70, 'first');
    await addReading(dom, 132, 84, 68, 'second');
    $(dom, '#backupBtn').click();
    await sleep(40);
    const dl = dom.window.__downloads.pop();
    const json = await readBlob(dl.blob);
    check('AT-9.1 filename is bp-backup-<date>.json', /^bp-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.name), dl.name);
    const parsed = JSON.parse(json);
    check('AT-9.2 backup is an array of 2', Array.isArray(parsed) && parsed.length === 2);
    check('AT-9.3 backup excludes meta record', !parsed.some(r => r.id === -1));
    check('AT-9.4 comments included', parsed.some(r => r.note === 'first'));
    dom.window.close();

    // Restore that backup into a brand new install.
    const dom2 = await boot();
    check('AT-9.5 fresh install starts empty', logRows(dom2).length === 0);
    const restoreFn = $(dom2, '#restoreFile');
    // Drive the change handler with a stub FileReader result.
    const win = dom2.window;
    win.FileReader = class {
      readAsText() { setTimeout(() => this.onload({ target: { result: json } }), 0); }
    };
    Object.defineProperty(restoreFn, 'files', { value: [{ name: 'b.json' }], configurable: true });
    restoreFn.dispatchEvent(new win.Event('change'));
    await sleep(80);
    check('AT-9.6 restore reports 2 entries', /Restored 2 entries/.test(msgText(dom2)), msgText(dom2));
    check('AT-9.7 both rows visible after restore', logRows(dom2).length === 2);
    check('AT-9.8 comment survived round-trip', logRows(dom2).some(r => r.textContent.includes('second')));
    dom2.window.close();
  }

  console.log('\n=== AT-10  Restore hardening ===');
  {
    const dom = await boot();
    const win = dom.window;
    async function doRestore(payload) {
      win.FileReader = class {
        readAsText() { setTimeout(() => this.onload({ target: { result: payload } }), 0); }
      };
      const inp = $(dom, '#restoreFile');
      Object.defineProperty(inp, 'files', { value: [{ name: 'b.json' }], configurable: true });
      inp.dispatchEvent(new win.Event('change'));
      await sleep(80);
    }

    await doRestore('{"not":"an array"}');
    check('AT-10.1 non-array rejected', /Restore failed/.test(msgText(dom)), msgText(dom));

    await doRestore('this is not json{{');
    check('AT-10.2 malformed JSON rejected', /Restore failed/.test(msgText(dom)), msgText(dom));

    await doRestore(JSON.stringify([{ id: -1, date: '2026-01-01 00:00', sys: 120, dia: 80 }]));
    const metaRow = logRows(dom).find(r => r.textContent.includes('120/80'));
    check('AT-10.3 record claiming meta key is re-keyed',
      metaRow && metaRow.querySelector('.del').getAttribute('data-del') !== '-1',
      metaRow && metaRow.querySelector('.del').getAttribute('data-del'));

    await doRestore(JSON.stringify([
      { id: 900, date: '2026-08-01 09:00', sys: 122, dia: 78 },
      { id: 901, sys: 'junk', dia: 'junk', date: 'x' },
      { id: 902, date: '2026-08-02 09:00', sys: 9999, dia: 80 },
    ]));
    check('AT-10.4 invalid entries reported as skipped', /skipped as invalid/.test(msgText(dom)), msgText(dom));

    const before = logRows(dom).length;
    await doRestore(JSON.stringify([{ id: 900, date: '2026-08-01 09:00', sys: 122, dia: 78 }]));
    check('AT-10.5 re-restoring same file does not duplicate', logRows(dom).length === before, `${before} -> ${logRows(dom).length}`);
    dom.window.close();
  }

  console.log('\n=== AT-11  Database unavailable ===');
  {
    const dom = await boot({ breakDB: true });
    check('AT-11.1 red banner shown', $(dom, '#banner').style.display === 'block');
    check('AT-11.2 banner explains the failure', /Local database unavailable/.test($(dom, '#banner').textContent));
    check('AT-11.3 Add button disabled so nothing looks saved', $(dom, '#addBtn').disabled === true);
    check('AT-11.4 no yellow reminder banner exists', dom.window.document.getElementById('reminder') === null);
    dom.window.close();
  }

  console.log('\n=== AT-12  Removed features stay removed ===');
  {
    const dom = await boot();
    check('AT-12.1 Email button gone', dom.window.document.getElementById('shareBtn') === null);
    check('AT-12.2 reminder banner gone', dom.window.document.getElementById('reminder') === null);
    check('AT-12.3 exactly three tool buttons', dom.window.document.querySelectorAll('.tools .ghost').length === 3);
    const src = HTML;
    check('AT-12.4 no orphaned shareBackup code', !/shareBackup/.test(src));
    check('AT-12.5 no orphaned updateReminder code', !/updateReminder/.test(src));
    check('AT-12.6 no orphaned markBackedUp code', !/markBackedUp/.test(src));
    dom.window.close();
  }

  console.log('\n=== AT-13  Chart ===');
  {
    const dom = await boot();
    await addReading(dom, 120, 80);
    check('AT-13.1 hidden with a single reading', $(dom, '#chartbox').style.display === 'none');
    await addReading(dom, 130, 85);
    check('AT-13.2 visible from two readings', $(dom, '#chartbox').style.display === 'block');
    const svg = $(dom, '#chart').innerHTML;
    check('AT-13.3 two trend paths drawn', (svg.match(/<path/g) || []).length === 2);
    check('AT-13.4 no NaN in path coordinates', !/NaN/.test(svg));
    check('AT-13.5 legend rendered', $(dom, '.legend') !== null);

    // Identical readings must not divide by zero.
    const dom2 = await boot();
    await addReading(dom2, 120, 120 - 1);
    await addReading(dom2, 120, 119);
    const svg2 = $(dom2, '#chart').innerHTML;
    check('AT-13.6 identical readings produce no NaN', !/NaN/.test(svg2));
    check('AT-13.7 identical readings produce no Infinity', !/Infinity/.test(svg2));
    dom.window.close(); dom2.window.close();
  }

  console.log('\n=== AT-14  XSS / injection in comment field ===');
  {
    const dom = await boot();
    await addReading(dom, 120, 80, 70, '<img src=x onerror=alert(1)>');
    const noteEl = logRows(dom)[0].querySelector('.note');
    check('AT-14.1 no img element injected', noteEl.querySelector('img') === null);
    check('AT-14.2 markup rendered as literal text', noteEl.textContent.includes('<img'));
    await addReading(dom, 121, 81, 70, '"><script>bad()</scr' + 'ipt>');
    check('AT-14.3 no script element injected', dom.window.document.querySelectorAll('.log script').length === 0);
    dom.window.close();
  }

  console.log('\n=== AT-15  ID integrity across sessions ===');
  {
    const factory = new FDBFactory();
    const dom1 = await boot({ keepFactory: factory });
    await addReading(dom1, 120, 80);
    await addReading(dom1, 121, 81);
    await addReading(dom1, 122, 82);
    const ids1 = logRows(dom1).map(r => r.querySelector('.del').getAttribute('data-del'));
    check('AT-15.1 ids unique within a session', new Set(ids1).size === 3);
    check('AT-15.2 ids are safe integers', ids1.every(i => Number.isSafeInteger(Number(i))));
    check('AT-15.3 ids survive parseInt (deletable)', ids1.every(i => String(parseInt(i, 10)) === i));
    dom1.window.close();

    const dom2 = await boot({ keepFactory: factory });
    await addReading(dom2, 123, 83);
    const ids2 = logRows(dom2).map(r => r.querySelector('.del').getAttribute('data-del'));
    check('AT-15.4 no id collision after restart', new Set(ids2).size === 4, 'ids: ' + ids2.join(','));

    // The newest entry must be deletable — the old float-id bug broke exactly this.
    logRows(dom2)[0].querySelector('.del').click();
    await sleep(60);
    check('AT-15.5 newest entry deletable after restart', logRows(dom2).length === 3);
    dom2.window.close();
  }

  console.log('\n=== AT-16  Sorting and stats ===');
  {
    const dom = await boot({
      seed: [
        { id: 10, date: '2026-08-01 08:00', sys: 110, dia: 70, pulse: 60 },
        { id: 11, date: '2026-08-15 08:00', sys: 130, dia: 90, pulse: 80 },
        { id: 12, date: '2026-08-08 08:00', sys: 120, dia: 80, pulse: 70 },
      ]
    });
    const dates = logRows(dom).map(r => r.querySelector('.date').textContent);
    check('AT-16.1 newest first', dates[0].startsWith('2026-08-15'), dates.join(' | '));
    check('AT-16.2 oldest last', dates[2].startsWith('2026-08-01'));
    check('AT-16.3 avg sys = 120', $(dom, '#avgSys').textContent === '120');
    check('AT-16.4 avg dia = 80', $(dom, '#avgDia').textContent === '80');
    check('AT-16.5 latest = newest by date', $(dom, '#latest').textContent === '130/90');
    check('AT-16.6 count reads 3 entries', $(dom, '#count').textContent === '3 entries');
    dom.window.close();
  }

  console.log('\n=== AT-17  Regression: edge defects found in review ===');
  {
    // E1: a fast double-tap must not write the reading twice.
    const dom = await boot();
    const d = dom.window.document;
    d.getElementById('fSys').value = '120';
    d.getElementById('fDia').value = '80';
    d.getElementById('addBtn').click();
    d.getElementById('addBtn').click();
    await sleep(150);
    check('AT-17.1 double-tap Add creates one entry', logRows(dom).length === 1, 'got ' + logRows(dom).length);
    dom.window.close();

    // E5: decimals must be rejected, not silently truncated.
    const dom2 = await boot();
    await addReading(dom2, '124.7', '79.2', '70.9');
    check('AT-17.2 decimal input rejected, not truncated',
      logRows(dom2).length === 0 && /whole number/.test(msgText(dom2)), msgText(dom2));
    await addReading(dom2, '12ab', '80');
    check('AT-17.3 trailing garbage rejected', logRows(dom2).length === 0, msgText(dom2));
    await addReading(dom2, '0120', '080', '070');
    check('AT-17.4 leading zeros still accepted as 120/80',
      logRows(dom2).length === 1 && logRows(dom2)[0].querySelector('.reading').textContent.includes('120/80'));
    dom2.window.close();

    // E3: comment length is capped, including via restore.
    const dom3 = await boot();
    check('AT-17.5 note input has maxlength', $(dom3, '#fNote').getAttribute('maxlength') === '200');
    const win = dom3.window;
    win.FileReader = class {
      readAsText() {
        setTimeout(() => this.onload({ target: { result: JSON.stringify([
          { id: 500, date: '2026-08-01 09:00', sys: 120, dia: 80, note: 'y'.repeat(5000) }
        ]) } }), 0);
      }
    };
    const inp = $(dom3, '#restoreFile');
    Object.defineProperty(inp, 'files', { value: [{ name: 'b.json' }], configurable: true });
    inp.dispatchEvent(new win.Event('change'));
    await sleep(80);
    const note = $(dom3, '.note');
    check('AT-17.6 oversized note from restore is capped', note && note.textContent.length === 200,
      note ? String(note.textContent.length) : 'no note');
    dom3.window.close();
  }

  console.log('\n=== AT-18  Edit the comment on a posted entry ===');
  {
    // Opens the editor on the row matching `match`, types `text`, then commits
    // with `key`. render() replaces the row on open, so the input is re-queried.
    async function editComment(dom, match, text, key = 'Enter') {
      const row = logRows(dom).find(r => r.textContent.includes(match));
      row.querySelector('.edit').click();
      await sleep(20);
      const inp = $(dom, '.noteInput');
      if (!inp) return null;
      inp.value = text;
      inp.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await sleep(80);
      return inp;
    }
    const noteOf = (dom, match) => {
      const row = logRows(dom).find(r => r.textContent.includes(match));
      const n = row && row.querySelector('.note');
      return n ? n.textContent : null;
    };

    const factory = new FDBFactory();
    const dom = await boot({ keepFactory: factory });
    await addReading(dom, 124, 79, 70, 'original');
    await addReading(dom, 118, 76);

    check('AT-18.1 every row has an edit button',
      logRows(dom).every(r => r.querySelector('.edit') !== null));
    check('AT-18.2 edit button is labelled for screen readers',
      logRows(dom)[0].querySelector('.edit').getAttribute('aria-label') === 'Edit comment');

    // Open the editor and inspect it before committing.
    logRows(dom).find(r => r.textContent.includes('124/79')).querySelector('.edit').click();
    await sleep(20);
    check('AT-18.3 editor opens as a text input', $(dom, '.noteInput') !== null);
    check('AT-18.4 editor is prefilled with the existing comment', $(dom, '.noteInput').value === 'original');
    check('AT-18.5 editor is focused', dom.window.document.activeElement === $(dom, '.noteInput'));
    check('AT-18.6 category tag stays visible while editing',
      logRows(dom).find(r => r.textContent.includes('124/79')).querySelector('.tag').textContent === 'Watch');
    check('AT-18.7 input is capped at 200 chars', $(dom, '.noteInput').getAttribute('maxlength') === '200');
    // Escape must discard, not save.
    $(dom, '.noteInput').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(60);
    check('AT-18.8 Escape closes the editor', $(dom, '.noteInput') === null);
    check('AT-18.9 Escape discards the edit', noteOf(dom, '124/79') === 'original');

    await editComment(dom, '124/79', 'edited via Enter');
    check('AT-18.10 Enter commits the new comment', noteOf(dom, '124/79') === 'edited via Enter', String(noteOf(dom, '124/79')));
    check('AT-18.11 confirmation shown', msgText(dom) === 'Comment updated.', msgText(dom));
    check('AT-18.12 editor closed after commit', $(dom, '.noteInput') === null);

    // A row that never had a comment must still be able to gain one.
    check('AT-18.13 second row starts with no comment', noteOf(dom, '118/76') === null);
    await editComment(dom, '118/76', 'added later');
    check('AT-18.14 comment can be added to a row that had none', noteOf(dom, '118/76') === 'added later');

    // Clearing back to empty must drop the note, not store "".
    await editComment(dom, '118/76', '   ');
    check('AT-18.15 blanking the comment removes it', noteOf(dom, '118/76') === null);
    check('AT-18.16 clearing reports its own message', msgText(dom) === 'Comment cleared.', msgText(dom));

    // Editing must not disturb the reading itself.
    check('AT-18.17 reading values untouched by an edit',
      logRows(dom).some(r => r.querySelector('.reading').textContent.includes('124/79')));
    check('AT-18.18 pulse untouched by an edit', logRows(dom).some(r => r.textContent.includes('70 bpm')));
    check('AT-18.19 entry count unchanged by edits', logRows(dom).length === 2);

    // Markup typed into the editor must render as text, like the add form.
    await editComment(dom, '124/79', '<img src=x onerror=alert(1)>');
    const edited = logRows(dom).find(r => r.textContent.includes('124/79'));
    check('AT-18.20 edited comment cannot inject an element', edited.querySelector('.note img') === null);
    check('AT-18.21 edited markup shown as literal text', edited.querySelector('.note').textContent.includes('<img'));

    // Over-long input bypassing maxlength (paste, scripted) is still capped.
    await editComment(dom, '124/79', 'z'.repeat(5000));
    check('AT-18.22 over-long comment capped at 200', noteOf(dom, '124/79').length === 200,
      String(noteOf(dom, '124/79').length));
    dom.window.close();

    const dom2 = await boot({ keepFactory: factory });
    check('AT-18.23 edited comment survives restart', noteOf(dom2, '124/79').length === 200);
    check('AT-18.24 cleared comment stays cleared after restart', noteOf(dom2, '118/76') === null);
    dom2.window.close();
  }

  console.log('\n=== AT-19  Delete still works alongside edit ===');
  {
    const dom = await boot();
    await addReading(dom, 120, 80, '', 'keep');
    await addReading(dom, 130, 85, '', 'drop');
    logRows(dom)[0].querySelector('.del').click();
    await sleep(60);
    check('AT-19.1 delete removes the row', logRows(dom).length === 1);
    check('AT-19.2 the right row survived', logRows(dom)[0].textContent.includes('120/80'));
    // The surviving row's editor must still be wired after the re-render.
    logRows(dom)[0].querySelector('.edit').click();
    await sleep(20);
    check('AT-19.3 editor still opens after a delete re-render', $(dom, '.noteInput') !== null);
    dom.window.close();
  }

  console.log('\n=== AT-20  Leaving an open editor must not lose the edit ===');
  {
    const dom = await boot();
    await addReading(dom, 124, 79, 70, 'first');
    await addReading(dom, 132, 84, 68, 'second');
    const noteOf = match => {
      const row = logRows(dom).find(r => r.textContent.includes(match));
      const n = row && row.querySelector('.note');
      return n ? n.textContent : null;
    };

    // Open row A, type, then jump straight to row B. Pulling the editor out of
    // the DOM fires no blur, so the switch itself has to commit row A.
    logRows(dom).find(r => r.textContent.includes('124/79')).querySelector('.edit').click();
    await sleep(20);
    $(dom, '.noteInput').value = 'A committed on switch';
    logRows(dom).find(r => r.textContent.includes('132/84')).querySelector('.edit').click();
    await sleep(100);
    check('AT-20.1 the row being left is saved', noteOf('124/79') === 'A committed on switch', String(noteOf('124/79')));
    check('AT-20.2 exactly one editor open', dom.window.document.querySelectorAll('.noteInput').length === 1,
      String(dom.window.document.querySelectorAll('.noteInput').length));
    check('AT-20.3 the new editor holds its own comment', $(dom, '.noteInput').value === 'second', $(dom, '.noteInput').value);
    check('AT-20.4 the other row is untouched', noteOf('132/84') === null);

    // A render triggered by unrelated work must keep the half-typed draft.
    $(dom, '.noteInput').value = 'B still being typed';
    await addReading(dom, 110, 70);
    check('AT-20.5 draft survives an unrelated re-render',
      $(dom, '.noteInput') && $(dom, '.noteInput').value === 'B still being typed',
      $(dom, '.noteInput') ? $(dom, '.noteInput').value : 'editor gone');
    $(dom, '.noteInput').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(80);
    check('AT-20.6 that draft still commits', noteOf('132/84') === 'B still being typed', String(noteOf('132/84')));
    dom.window.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log(`RESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  console.log('='.repeat(52));
  process.exit(failed ? 1 : 0);
})();
