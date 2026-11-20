// UI regression checks in a real Chromium browser.
// Run after: npm install --no-save playwright@1.56.1
// Then: node tests/browser-e2e.mjs
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const checks = [];
async function test(name, fn) {
  try { await fn(); checks.push({ name, status: 'PASS' }); console.log('PASS', name); }
  catch(e) { checks.push({name,status:'FAIL'});console.error('FAIL',name,e.message); process.exitCode=1; }
}
try {
  const page = await browser.newPage({viewport:{width:375,height:812},deviceScaleFactor:2,hasTouch:true,isMobile:true});
  await page.goto(pathToFileURL(resolve('ADK_Card_Designer.html')).href);
  await test('Mobile initial layout fits 375px', async () => {
    const d=await page.evaluate(()=>({screen:innerWidth,doc:document.documentElement.scrollWidth,app:document.querySelector('.app').scrollWidth}));
    assert.ok(d.doc <= d.screen+1,JSON.stringify(d));
    assert.ok(d.app <= d.screen+1,JSON.stringify(d));
  });
  await page.evaluate(() => {
    const img='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0c8AAAAASUVORK5CYII=';
    state.items.push({ id:'e2e',url:img,caption:'Первый текст',copies:2,crop:null });
    renderGallery(); renderOutput();
  });
  await test('Print output contains two cards and captions', async () => {
    assert.equal(await page.locator('#printRoot .sheet-card').count(),2);
    assert.equal(await page.locator('#printRoot .cap').count(),2);
    assert.equal(await page.locator('#printRoot .cap').first().textContent(),'Первый текст');
  });
  await page.locator('.mobile-nav [data-pane="images"]').click();
  await page.locator('.crop-btn').click();
  await test('Crop dialog and large visible slider are available', async () => {
    assert.equal(await page.locator('#cropDialog').isVisible(),true);
    const size=await page.locator('#cropZoom').boundingBox();assert.ok(size?.height>=35);
  });
  await page.locator('#cropZoom').evaluate(el => { el.value='2'; el.dispatchEvent(new Event('input',{bubbles:true})); });
  await test('Cropping supports zooming', async () => {
    assert.match(await page.locator('#cropImage').getAttribute('style'),/scale\(2\)/);
  });
  await page.locator('#cropCaption').fill('Вторая подпись');
  await page.locator('#cropApply').click();
  await test('Updated caption survives cropping', async () => {
    assert.equal(await page.locator('#printRoot .cap').first().textContent(),'Вторая подпись');
    assert.match(await page.locator('#printRoot .pic img').first().getAttribute('style'),/scale\(2\)/);
  });
  await test('Cut marks present and nonoverlapping', async () => {
    await page.evaluate(()=>{ state.cutLines=true; state.gap=2; renderOutput(); });
    assert.equal(await page.locator('#printRoot .cut-corner').count(),8);
    const length=await page.locator('#printRoot .cut-guide').first().evaluate(el=>parseFloat(el.style.getPropertyValue('--mark-size')));
    assert.ok(length<1, String(length));
  });
  await test('Browser can generate a print CSS PDF', async () => {
    const pdf=await page.pdf({printBackground:true,preferCSSPageSize:true});
    assert.ok(pdf.length>2500);
    assert.equal(pdf.toString('utf8',0,4),'%PDF');
  });
  await page.setViewportSize({width:1280,height:800});
  await test('Desktop layout displays the two columns', async () => {
    const display=await page.locator('#cardsPanel').evaluate(el=>getComputedStyle(el).display);
    assert.notEqual(display,'none');
  });
  await page.close();
} finally {
  await browser.close();
}
console.log(checks.filter(c=>c.status==='PASS').length+'/'+checks.length+' browser checks passed');
