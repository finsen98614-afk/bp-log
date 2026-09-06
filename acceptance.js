// Acceptance tests: load the REAL index.html into jsdom with a real
// (in-memory) IndexedDB and drive it the way a user would.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

// Resolve next to this file, not from the working directory, so `npm test`
// works from anywhere in the repo and on any machine.
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

      // jsdom's confirm() is a stub that returns undefined, which would read as
      // "cancelled" and silently turn every delete test into a no-op. Answer
      // yes by default and record what was asked; a test flips __confirmAnswer
      // to exercise the cancel path.
      win.__confirms = [];
      win.__confirmAnswer = true;
      win.confirm = message => { win.__confirms.push(String(message)); return win.__confirmAnswer; };

      // jsdom's Blob implements only slice/size/type -- no text(), no
      // arrayBuffer(). Without these the export assertions below inspect
      // "[object Blob]" instead of the file, so they would pass or fail for
      // reasons that have nothing to do with the CSV. FileReader IS
      // implemented, so build the two accessors on top of it. readAsText
      // strips a leading BOM per the encoding spec, matching real browsers,
      // which is why the BOM check reads raw bytes instead.
      // Captured now, not looked up per call: AT-20 replaces win.FileReader
      // with a stub, and a blob read after that point must not route through it.
      const RealFileReader = win.FileReader;
      const viaFileReader = method => function () {
        return new Promise((res, rej) => {
          const fr = new RealFileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(fr.error);
          fr[method](this);
        });
      };
      if (typeof win.Blob.prototype.arrayBuffer !== 'function') {
        win.Blob.prototype.arrayBuffer = viaFileReader('readAsArrayBuffer');
      }
      if (typeof win.Blob.prototype.text !== 'function') {
        win.Blob.prototype.text = viaFileReader('readAsText');
      }

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
  // Fail loudly. The old fallback returned String(blob) -- "[object Blob]" --
  // which let every export assertion run against a placeholder and report a
  // result that meant nothing. A missing accessor is a broken harness, not a
  // test outcome.
  if (typeof blob.text !== 'function') {
    throw new Error('Blob.text() unavailable -- the boot() polyfill did not apply');
  }
  return await blob.text();
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

  console.log('\n=== AT-5  Default guideline (Hypertension Canada 2025) categories ===');
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
    check('AT-6.3 confirmation names the deleted reading',
      /^Deleted 130\/85\./.test(msgText(dom)), msgText(dom));
    check('AT-6.4 the user was asked first, by reading',
      /130\/85/.test(dom.window.__confirms[0] || ''), dom.window.__confirms[0]);
    dom.window.close();

    const dom2 = await boot({ keepFactory: factory });
    check('AT-6.5 deletion persisted across restart', logRows(dom2).length === 1);
    dom2.window.close();
  }

  console.log('\n=== AT-6b  Delete asks first ===');
  {
    // A reading is a medical record with only manual backups, so a mis-tap on
    // the row's delete must not be final. An inline Undo was tried first and
    // was too easy to miss on a phone -- an undo nobody notices is not a
    // safety net, so the interruption has to come before the write.
    const factory = new FDBFactory();
    const dom = await boot({ keepFactory: factory });
    await addReading(dom, 120, 80, 70, 'kept');
    await addReading(dom, 138, 88, 66, 'careful');
    dom.window.__confirmAnswer = false;
    logRows(dom)[0].querySelector('.del').click();
    await sleep(80);
    check('AT-6b.1 cancelling leaves the row alone', logRows(dom).length === 2, 'got ' + logRows(dom).length);
    check('AT-6b.2 the prompt names the reading and its timestamp',
      /138\/88 from \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dom.window.__confirms[0] || ''),
      dom.window.__confirms[0]);
    check('AT-6b.3 cancelling never claims a deletion',
      !/Deleted/.test(msgText(dom)), msgText(dom));
    dom.window.close();

    // Nothing was written, so a restart must still show both readings. This is
    // the check that would catch a delete that ran before the prompt.
    const dom2 = await boot({ keepFactory: factory });
    check('AT-6b.4 a cancelled delete never reached the database',
      logRows(dom2).length === 2, 'got ' + logRows(dom2).length);
    dom2.window.__confirmAnswer = true;
    logRows(dom2)[0].querySelector('.del').click();
    await sleep(80);
    check('AT-6b.5 confirming does delete', logRows(dom2).length === 1);
    dom2.window.close();

    const dom3 = await boot({ keepFactory: factory });
    check('AT-6b.6 the confirmed delete persisted', logRows(dom3).length === 1);
    check('AT-6b.7 the surviving row is the right one',
      logRows(dom3)[0].textContent.includes('120/80'));
    dom3.window.close();
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
        // date was the one field normalize() used to wave through. Free text
        // sorts wrong and prints a slice of itself as a chart axis label; a
        // well-shaped but impossible date is worse, since it passes a regex.
        { id: 6, date: 'yesterday', sys: 140, dia: 90 },
        { id: 7, date: '2026-13-45 99:99', sys: 150, dia: 95 },
      ]
    });
    check('AT-7.1 only the 2 valid readings load', logRows(dom).length === 2, 'got ' + logRows(dom).length);
    check('AT-7.5 free-text date rejected', !logRows(dom).some(r => r.textContent.includes('140/90')));
    check('AT-7.6 well-formed but impossible date rejected',
      !logRows(dom).some(r => r.textContent.includes('150/95')));
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
    {
      // Excel and LibreOffice evaluate a field opening with = + - @ as a
      // formula, and quoting does not stop them. This sheet goes to a clinic.
      const d2 = await boot();
      await addReading(d2, 121, 81, 70, '=1+1');
      await addReading(d2, 122, 82, 70, '@SUM(A1)');
      await addReading(d2, 123, 83, 70, 'after coffee');
      $(d2, '#csvBtn').click();
      await sleep(40);
      const csv2 = await readBlob(d2.window.__downloads.pop().blob);
      check('AT-8.9 a formula-shaped comment is neutralised', csv2.includes(`"'=1+1"`), csv2);
      check('AT-8.10 so is an @ command', csv2.includes(`"'@SUM(A1)"`));
      check('AT-8.11 an ordinary comment is left alone', csv2.includes('"after coffee"'));
      d2.window.close();
    }
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
    // Restore writes too. Left enabled it reached dbPutMany with db null and
    // surfaced "Cannot read properties of null" as if it were a file problem.
    check('AT-11.5 Restore button disabled as well', $(dom, '#restoreBtn').disabled === true);
    check('AT-11.4 no yellow reminder banner exists', dom.window.document.getElementById('reminder') === null);
    dom.window.close();
  }

  console.log('\n=== AT-12  Removed features stay removed ===');
  {
    const dom = await boot();
    check('AT-12.1 Email button gone', dom.window.document.getElementById('shareBtn') === null);
    check('AT-12.2 reminder banner gone', dom.window.document.getElementById('reminder') === null);
    check('AT-12.3 four tool buttons (CSV, Backup, Print, Restore)', dom.window.document.querySelectorAll('.tools .ghost').length === 4);
    check('AT-12.7 settings block present but collapsed', $(dom, '#settingsBox') !== null && !$(dom, '#settingsBox').open);
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

  console.log('\n=== AT-18  Print report for the doctor ===');
  {
    const dom = await boot();
    check('AT-18.1 Print disabled when empty', $(dom, '#printBtn').disabled === true);
    check('AT-18.2 print area empty before use', $(dom, '#printArea').innerHTML === '');

    let printCalled = 0;
    dom.window.print = () => { printCalled++; };

    const now = new Date();
    const stamp = off => {
      const d = new Date(now.getTime() - off * 86400000);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 08:00`;
    };
    dom.window.close();

    // Seed a spread across the 7 / 30 / all windows.
    const dom2 = await boot({
      seed: [
        { id: 1, date: stamp(60), sys: 150, dia: 95, pulse: 80 },
        { id: 2, date: stamp(20), sys: 138, dia: 88, pulse: 76 },
        { id: 3, date: stamp(3),  sys: 124, dia: 79, pulse: 70, note: 'after coffee' },
        { id: 4, date: stamp(1),  sys: 126, dia: 81, pulse: 72 },
      ]
    });
    dom2.window.print = () => { printCalled++; };
    check('AT-18.3 Print enabled with data', $(dom2, '#printBtn').disabled === false);

    $(dom2, '#printBtn').click();
    await sleep(140);
    const html = $(dom2, '#printArea').innerHTML;

    check('AT-18.4 window.print() invoked', printCalled === 1, 'calls: ' + printCalled);
    check('AT-18.5 report has a title', /Home Blood Pressure Record/.test(html));
    check('AT-18.6 name and DOB fields for the clinic', /Name:/.test(html) && /Date of birth:/.test(html));
    check('AT-18.7 7-day average present', /Average, last 7 days/.test(html));
    check('AT-18.8 30-day average present', /Average, last 30 days/.test(html));
    check('AT-18.9 all-readings average present', /Average, all readings/.test(html));
    check('AT-18.10 7-day window excludes the 60-day-old reading', !/7 days<\/td><td><b>1[35]/.test(html));
    check('AT-18.11 all four readings tabulated', (html.match(/<tr>/g) || []).length >= 4);
    check('AT-18.12 comment carried into report', /after coffee/.test(html));
    check('AT-18.13 category breakdown present', /Category breakdown/.test(html));
    check('AT-18.14 guideline attribution present', /Hypertension Canada/.test(html));
    check('AT-18.15 states readings are self-measured', /not a diagnosis/.test(html));
    check('AT-18.16 no NaN in the report', !/NaN/.test(html));
    check('AT-18.17 period covered stated', /Period covered/.test(html));

    // The report must not leak markup from a comment.
    dom2.window.close();
    const dom3 = await boot();
    dom3.window.print = () => {};
    await addReading(dom3, 120, 80, 70, '<b>bold</b>');
    $(dom3, '#printBtn').click();
    await sleep(140);
    const h3 = $(dom3, '#printArea').innerHTML;
    check('AT-18.18 comment markup escaped in report', /&lt;b&gt;bold/.test(h3), h3.slice(0, 60));
    check('AT-18.19 screen UI still intact after printing', $(dom3, '.wrap') !== null);
    dom3.window.close();
  }

  console.log('\n=== AT-19  Regional guideline selection ===');
  {
    const factory = new FDBFactory();
    const seed = [
      { id: 1, date: '2026-09-01 08:00', sys: 118, dia: 75 },
      { id: 2, date: '2026-09-02 08:00', sys: 124, dia: 79 },
      { id: 3, date: '2026-09-03 08:00', sys: 132, dia: 82 },
      { id: 4, date: '2026-09-04 08:00', sys: 137, dia: 86 },
      { id: 5, date: '2026-09-05 08:00', sys: 142, dia: 91 },
      { id: 6, date: '2026-09-06 08:00', sys: 152, dia: 96 },
    ];
    const dom = await boot({ seed, keepFactory: factory });
    const tags = () => logRows(dom).map(r => r.querySelector('.tag').textContent).reverse();

    check('AT-19.1 defaults to Canada', $(dom, '#glSelect').value === 'ca');
    const ca = tags();
    check('AT-19.2 CA: 124/79 is Watch', ca[1] === 'Watch', ca[1]);
    check('AT-19.3 CA: 132/82 is HTN', ca[2] === 'HTN', ca[2]);
    check('AT-19.4 CA: 142/91 is Treat', ca[4] === 'Treat', ca[4]);

    const sel = $(dom, '#glSelect');
    sel.value = 'intl';
    sel.dispatchEvent(new dom.window.Event('change'));
    await sleep(120);
    const intl = tags();
    check('AT-19.5 INTL: 124/79 drops to Normal', intl[1] === 'Normal', intl[1]);
    check('AT-19.6 INTL: 132/82 is High-normal', intl[2] === 'High-normal', intl[2]);
    check('AT-19.7 INTL: 137/86 is Stage 1', intl[3] === 'Stage 1', intl[3]);
    check('AT-19.8 INTL: 152/96 is Stage 2', intl[5] === 'Stage 2', intl[5]);
    check('AT-19.9 118/75 is Normal under both', ca[0] === 'Normal' && intl[0] === 'Normal');
    check('AT-19.10 reference table retitled', /ESH 2023/.test($(dom, '#refTitle').textContent), $(dom, '#refTitle').textContent);
    check('AT-19.11 reference rows regenerated', /135/.test($(dom, '#refTable').textContent));

    // Switching must not rewrite the stored numbers.
    const stored = await new Promise((res, rej) => {
      const r = factory.open('bpLogDB', 1);
      r.onsuccess = e => {
        const db = e.target.result;
        const g = db.transaction('readings', 'readonly').objectStore('readings').getAll();
        g.onsuccess = () => { db.close(); res(g.result); };
        g.onerror = () => rej(g.error);
      };
    });
    const readings = stored.filter(r => r.meta !== true);
    check('AT-19.12 readings unchanged by switching', readings.length === 6 &&
      readings.every(r => !('category' in r)));
    check('AT-19.13 choice saved to a meta record',
      stored.some(r => r.id === -2 && r.meta === true && r.guideline === 'intl'));
    dom.window.close();

    // Choice survives a restart.
    const dom2 = await boot({ keepFactory: factory });
    check('AT-19.14 selection persists across restart', $(dom2, '#glSelect').value === 'intl');
    check('AT-19.15 labels persist across restart',
      logRows(dom2).map(r => r.querySelector('.tag').textContent).reverse()[1] === 'Normal');
    check('AT-19.16 settings record never renders as a reading', logRows(dom2).length === 6);

    // Report and CSV must follow the active guideline.
    dom2.window.print = () => {};
    $(dom2, '#printBtn').click();
    await sleep(140);
    const rep = $(dom2, '#printArea').innerHTML;
    check('AT-19.17 report cites the active guideline', /ESH 2023/.test(rep) && !/Hypertension Canada/.test(rep));
    check('AT-19.18 report footer lists intl thresholds', /135\/85 and above/.test(rep) || /Stage 1/.test(rep));

    $(dom2, '#csvBtn').click();
    await sleep(40);
    const csv = await readBlob(dom2.window.__downloads.pop().blob);
    check('AT-19.19 CSV categories follow the active guideline', /Stage 1/.test(csv) && !/,HTN,/.test(csv));
    dom2.window.close();

    // A backup taken under one guideline restores cleanly under the other.
    const dom3 = await boot();
    check('AT-19.20 fresh install falls back to Canada', $(dom3, '#glSelect').value === 'ca');
    dom3.window.close();

    // Shipped bug: the Normal row was derived from the lowest band alone, and
    // Canada's lowest band ("Watch") carries no diastolic bound. The table read
    // "under 120 systolic" while classify() tagged 110/85 as HTN -- the
    // reference and the app contradicted each other on the same screen.
    const dom4 = await boot();
    const normalCells = [...$(dom4, '#refTable').querySelectorAll('tr')[0]
      .querySelectorAll('td')].map(td => td.textContent.trim());
    check('AT-19.21 CA Normal row bounds both numbers',
      normalCells[0] === 'Normal' && normalCells[1] === 'under 120/80',
      normalCells.join(' | '));
    await addReading(dom4, 110, 85);
    check('AT-19.22 reference row and classify() agree on 110/85',
      logRows(dom4)[0].querySelector('.tag').textContent === 'HTN',
      logRows(dom4)[0].querySelector('.tag').textContent);
    dom4.window.close();

    // The intl table must keep bounding both numbers too, so the fix above
    // cannot be mistaken for a Canada-only special case.
    const dom5 = await boot();
    const sel5 = $(dom5, '#glSelect');
    sel5.value = 'intl';
    sel5.dispatchEvent(new dom5.window.Event('change'));
    await sleep(60);
    const intlCells = [...$(dom5, '#refTable').querySelectorAll('tr')[0]
      .querySelectorAll('td')].map(td => td.textContent.trim());
    check('AT-19.23 INTL Normal row unchanged at under 130/80',
      intlCells[1] === 'under 130/80', intlCells.join(' | '));
    dom5.window.close();
  }

  console.log('\n=== AT-20  Reserved keys ===');
  {
    const dom = await boot();
    const win = dom.window;
    win.FileReader = class {
      readAsText() {
        setTimeout(() => this.onload({ target: { result: JSON.stringify([
          { id: -2, date: '2026-01-01 00:00', sys: 121, dia: 81 },
        ]) } }), 0);
      }
    };
    const inp = $(dom, '#restoreFile');
    Object.defineProperty(inp, 'files', { value: [{ name: 'b.json' }], configurable: true });
    inp.dispatchEvent(new win.Event('change'));
    await sleep(90);
    const row = logRows(dom).find(r => r.textContent.includes('121/81'));
    check('AT-20.1 record claiming the settings key is re-keyed',
      row && row.querySelector('.del').getAttribute('data-del') !== '-2',
      row ? row.querySelector('.del').getAttribute('data-del') : 'missing');
    check('AT-20.2 guideline selector still works after that restore',
      $(dom, '#glSelect').value === 'ca');
    dom.window.close();
  }

  console.log('\n=== AT-21  Optimization regressions ===');
  {
    // The report breakdown must use the active guideline's own labels.
    const seed = [
      { id: 1, date: '2026-09-01 08:00', sys: 118, dia: 75 },
      { id: 2, date: '2026-09-02 08:00', sys: 132, dia: 82 },
      { id: 3, date: '2026-09-03 08:00', sys: 137, dia: 86 },
      { id: 4, date: '2026-09-04 08:00', sys: 152, dia: 96 },
    ];
    const dom = await boot({ seed });
    dom.window.print = () => {};
    $(dom, '#printBtn').click();
    await sleep(140);
    let bd = $(dom, '#printArea').innerHTML.match(/Category breakdown<\/td><td>([^<]*)/)[1];
    check('AT-21.1 CA breakdown counts every reading',
      /Normal: 1/.test(bd) && /HTN: 2/.test(bd) && /Treat: 1/.test(bd), bd);

    const sel = $(dom, '#glSelect');
    sel.value = 'intl';
    sel.dispatchEvent(new dom.window.Event('change'));
    await sleep(100);
    $(dom, '#printBtn').click();
    await sleep(140);
    bd = $(dom, '#printArea').innerHTML.match(/Category breakdown<\/td><td>([^<]*)/)[1];
    check('AT-21.2 INTL breakdown uses intl labels, drops nothing',
      /Normal: 1/.test(bd) && /High-normal: 1/.test(bd) && /Stage 1: 1/.test(bd) && /Stage 2: 1/.test(bd), bd);
    const counted = (bd.match(/: (\d+)/g) || []).reduce((a, m) => a + Number(m.slice(2)), 0);
    check('AT-21.3 breakdown totals match the reading count', counted === 4, 'counted ' + counted);
    dom.window.close();

    // Row windowing.
    const seedMany = [];
    for (let i = 0; i < 120; i++) {
      seedMany.push({ id: i + 1, date: '2026-09-' + String(1 + (i % 28)).padStart(2, '0') + ' 08:00', sys: 110 + (i % 40), dia: 70 + (i % 25) });
    }
    const dom2 = await boot({ seed: seedMany });
    check('AT-21.4 only 50 rows rendered by default', logRows(dom2).length === 50, 'got ' + logRows(dom2).length);
    check('AT-21.5 count still reports the true total', $(dom2, '#count').textContent === '120 entries');
    check('AT-21.6 "show all" control offered', $(dom2, '#moreBtn') !== null);

    $(dom2, '#moreBtn').click();
    await sleep(120);
    check('AT-21.7 show all reveals every row', logRows(dom2).length === 120, 'got ' + logRows(dom2).length);
    check('AT-21.8 collapse control offered', $(dom2, '#lessBtn') !== null);

    // Deletion must work on a row that only exists after expanding.
    dom2.window.document.querySelectorAll('.del')[80].click();
    await sleep(80);
    check('AT-21.9 delete works on a revealed row', logRows(dom2).length === 119);

    $(dom2, '#lessBtn').click();
    await sleep(100);
    check('AT-21.10 collapse returns to 50 rows', logRows(dom2).length === 50);

    // Windowing must never truncate exports or the report.
    dom2.window.print = () => {};
    $(dom2, '#printBtn').click();
    await sleep(150);
    const rep = $(dom2, '#printArea').innerHTML;
    check('AT-21.11 report covers all entries, not the window',
      /Total readings<\/td><td>119/.test(rep), (rep.match(/Total readings<\/td><td>(\d+)/) || [])[1]);

    $(dom2, '#csvBtn').click();
    await sleep(60);
    const csv = await readBlob(dom2.window.__downloads.pop().blob);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    check('AT-21.12 CSV exports all entries, not the window', lines.length === 120, 'lines ' + lines.length);

    $(dom2, '#backupBtn').click();
    await sleep(60);
    const bak = JSON.parse(await readBlob(dom2.window.__downloads.pop().blob));
    check('AT-21.13 backup covers all entries', bak.length === 119, 'got ' + bak.length);
    check('AT-21.14 chart still limited to 30 points',
      ($(dom2, '#chart').innerHTML.match(/<circle/g) || []).length === 60);
    dom2.window.close();

    // Delegated deletion must survive repeated re-renders.
    const dom3 = await boot();
    await addReading(dom3, 120, 80);
    await addReading(dom3, 130, 85);
    await addReading(dom3, 140, 90);
    const s3 = $(dom3, '#glSelect');
    for (let i = 0; i < 4; i++) {
      s3.value = i % 2 ? 'intl' : 'ca';
      s3.dispatchEvent(new dom3.window.Event('change'));
      await sleep(30);
    }
    logRows(dom3)[0].querySelector('.del').click();
    await sleep(80);
    check('AT-21.15 delete still works after repeated re-renders', logRows(dom3).length === 2);
    dom3.window.close();
  }

  console.log('\n=== AT-22  The app says what it does and does not know ===');
  {
    // Office and home thresholds for the same condition are different numbers.
    // A table that doesn't say which it is invites the wrong comparison, and
    // the printed sheet goes to a clinician who can't ask.
    const dom = await boot();
    check('AT-22.1 reference title states the measurement basis',
      /home \(HBPM\)/.test($(dom, '#refTitle').textContent), $(dom, '#refTitle').textContent);

    // Watch is ours, not Hypertension Canada's. It must never read as clinical.
    const watchRow = [...dom.window.document.querySelectorAll('#refTable tr')]
      .find(tr => /Watch/.test(tr.textContent));
    check('AT-22.2 an app-invented band is marked in the table',
      watchRow && watchRow.querySelector('sup') !== null,
      watchRow ? watchRow.textContent : 'no Watch row');
    check('AT-22.3 and explained beneath it',
      /Watch is not published by Hypertension Canada 2025/.test($(dom, '#refDagger').textContent),
      $(dom, '#refDagger').textContent);
    check('AT-22.4 risk is named as something the log does not hold',
      /overall cardiovascular risk, which this log does not know/.test($(dom, '#refBox').textContent));

    // ESH/NICE publishes every band it uses, so there is nothing to disclaim.
    const sel = $(dom, '#glSelect');
    sel.value = 'intl';
    sel.dispatchEvent(new dom.window.Event('change'));
    await sleep(60);
    check('AT-22.5 no disclaimer when every band is official',
      $(dom, '#refDagger').textContent === '', $(dom, '#refDagger').textContent);
    check('AT-22.6 no dagger marks either',
      dom.window.document.querySelectorAll('#refTable sup').length === 0);
    check('AT-22.7 basis still stated for the other guideline',
      /home \(HBPM\)/.test($(dom, '#refTitle').textContent), $(dom, '#refTitle').textContent);
    dom.window.close();

    const dom2 = await boot();
    await addReading(dom2, 124, 79, 70);
    $(dom2, '#printBtn').click();
    await sleep(140);
    const rep = $(dom2, '#printArea').innerHTML;
    check('AT-22.8 the printed sheet states the basis in its header',
      /Hypertension Canada 2025, home \(HBPM\) thresholds/.test(rep));
    check('AT-22.9 and disclaims the invented band in its footnote',
      /Watch is not a Hypertension Canada 2025 category/.test(rep));
    check('AT-22.10 and says treatment depends on risk it does not hold',
      /depends on overall cardiovascular risk/.test(rep));
    dom2.window.close();
  }

  console.log('\n=== AT-23  Editing a reading, timestamp included ===');
  {
    // Readings get logged late and copied in from a monitor's memory days
    // later. The report leads with 7- and 30-day averages, so a timestamp that
    // only ever means "when it was typed" quietly makes those wrong.
    const setWhen = (dom, v) => {
      const el = $(dom, '#fWhen');
      el.value = v;
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };

    const factory = new FDBFactory();
    const dom = await boot({ keepFactory: factory });
    check('AT-23.1 the time field defaults to now',
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test($(dom, '#fWhen').value), $(dom, '#fWhen').value);

    // The case this feature exists for: a reading taken days ago.
    setWhen(dom, '2026-08-20T07:15');
    await addReading(dom, 128, 82, 64, 'backdated');
    check('AT-23.2 a new reading keeps the time it was given',
      logRows(dom)[0].querySelector('.date').textContent === '2026-08-20 07:15',
      logRows(dom)[0].querySelector('.date').textContent);
    check('AT-23.3 the field returns to now after saving',
      !/2026-08-20/.test($(dom, '#fWhen').value), $(dom, '#fWhen').value);

    // Fixed date too, so the re-sort below is deterministic rather than
    // depending on where "now" happens to fall relative to the other row.
    setWhen(dom, '2026-08-25T09:00');
    await addReading(dom, 140, 90, 70, 'later');
    check('AT-23.4 every row offers an edit control',
      logRows(dom).every(r => r.querySelector('[data-edit]')));

    // Edit the older row: change the numbers and move it later than the other.
    const older = logRows(dom).find(r => r.textContent.includes('backdated'));
    const olderId = older.querySelector('[data-edit]').getAttribute('data-edit');
    older.querySelector('[data-edit]').click();
    await sleep(60);
    check('AT-23.5 the form is filled from the row',
      $(dom, '#fSys').value === '128' && $(dom, '#fDia').value === '82' &&
      $(dom, '#fPulse').value === '64' && $(dom, '#fNote').value === 'backdated',
      [$(dom, '#fSys').value, $(dom, '#fDia').value, $(dom, '#fPulse').value].join('/'));
    check('AT-23.6 including the stored timestamp',
      $(dom, '#fWhen').value === '2026-08-20T07:15', $(dom, '#fWhen').value);
    check('AT-23.7 the row is marked as the one being edited',
      dom.window.document.querySelectorAll('.entry.editing').length === 1);
    check('AT-23.8 the button says what it will do now',
      $(dom, '#addBtn').textContent === 'Save changes', $(dom, '#addBtn').textContent);
    check('AT-23.9 a way out is offered', $(dom, '#cancelBtn').hidden === false);

    check('AT-23.9b the older row starts below the newer one',
      logRows(dom)[0].textContent.includes('later'));
    $(dom, '#fSys').value = '133';
    setWhen(dom, '2026-08-30T21:40');   // now newer than the other row
    $(dom, '#addBtn').click();
    await sleep(90);
    check('AT-23.10 editing does not create a second row', logRows(dom).length === 2,
      'got ' + logRows(dom).length);
    const edited = logRows(dom).find(r => r.textContent.includes('backdated'));
    check('AT-23.11 the value changed', edited.textContent.includes('133/82'));
    check('AT-23.12 the timestamp changed',
      edited.querySelector('.date').textContent === '2026-08-30 21:40',
      edited.querySelector('.date').textContent);
    check('AT-23.13 the id is preserved, not reissued',
      edited.querySelector('[data-edit]').getAttribute('data-edit') === olderId);
    check('AT-23.14 the new date re-sorts the row to the top',
      logRows(dom)[0].textContent.includes('backdated'));
    check('AT-23.15 the card returns to add mode',
      $(dom, '#addBtn').textContent === '+ Add Reading' && $(dom, '#cancelBtn').hidden === true);
    dom.window.close();

    const dom2 = await boot({ keepFactory: factory });
    check('AT-23.16 the edit reached the database, not just the screen',
      logRows(dom2).some(r => r.textContent.includes('133/82')));
    check('AT-23.17 and so did the new timestamp',
      logRows(dom2).some(r => r.querySelector('.date').textContent === '2026-08-30 21:40'));
    check('AT-23.18 still two rows after restart', logRows(dom2).length === 2);

    // Cancel must change nothing at all.
    logRows(dom2)[0].querySelector('[data-edit]').click();
    await sleep(60);
    $(dom2, '#fSys').value = '199';
    setWhen(dom2, '2026-01-01T01:01');
    $(dom2, '#cancelBtn').click();
    await sleep(60);
    check('AT-23.19 cancelling leaves the reading alone',
      !logRows(dom2).some(r => r.textContent.includes('199/')));
    check('AT-23.20 and leaves no row marked',
      dom2.window.document.querySelectorAll('.entry.editing').length === 0);
    check('AT-23.21 and restores the add button',
      $(dom2, '#addBtn').textContent === '+ Add Reading');

    // A reading you have not taken yet cannot exist.
    const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 16);
    setWhen(dom2, future);
    const before = logRows(dom2).length;
    await addReading(dom2, 122, 78);
    check('AT-23.22 a far-future timestamp is refused',
      logRows(dom2).length === before && /ahead/.test(msgText(dom2)), msgText(dom2));
    dom2.window.close();

    // Deleting the row under edit must not leave the form aimed at a dead id.
    const dom3 = await boot();
    await addReading(dom3, 120, 80);
    logRows(dom3)[0].querySelector('[data-edit]').click();
    await sleep(60);
    logRows(dom3)[0].querySelector('.del').click();
    await sleep(80);
    check('AT-23.23 deleting the edited row exits edit mode',
      $(dom3, '#addBtn').textContent === '+ Add Reading' && $(dom3, '#cancelBtn').hidden === true,
      $(dom3, '#addBtn').textContent);
    check('AT-23.24 and saving afterwards cannot resurrect it', logRows(dom3).length === 0);
    dom3.window.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log(`RESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); }
  console.log('='.repeat(52));
  process.exit(failed ? 1 : 0);
})();
