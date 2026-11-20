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
  await test('Mobile layout fits 320, 375 and 414px', async () => {
    for (const width of [320,375,414]) {
      await page.setViewportSize({width,height:812});
      const d=await page.evaluate(()=>{
        const app=document.querySelector('.app');
        const offenders=[...document.querySelectorAll('.app *')].filter(el=>{
          const r=el.getBoundingClientRect();
          return r.width>0 && (r.right>innerWidth+1 || r.left<-1) && getComputedStyle(el).display!=='none';
        }).slice(0,10).map(el=>({tag:el.tagName,id:el.id,cls:String(el.className).slice(0,50),right:Math.round(el.getBoundingClientRect().right)}));
        return {screen:innerWidth,doc:document.documentElement.scrollWidth,app:app.scrollWidth,offenders};
      });
      assert.ok(d.doc <= d.screen+1,JSON.stringify(d));
      assert.equal(d.offenders.length,0,JSON.stringify(d));
    }
    await page.setViewportSize({width:375,height:812});
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
  await test('Sheet copy controls update the print sheet immediately', async () => {
    assert.equal(await page.locator('#sheetQuantity').isVisible(),true);
    assert.equal(await page.locator('#sheetCopyInput').inputValue(),'2');
    await page.locator('#sheetInc').click();
    assert.equal(await page.locator('#printRoot .sheet-card').count(),3);
    await page.locator('#sheetDec').click();
    assert.equal(await page.locator('#printRoot .sheet-card').count(),2);
    await page.locator('#sheetCopyInput').fill('5');
    assert.equal(await page.locator('#printRoot .sheet-card').count(),5);
    await page.locator('#sheetCopyInput').fill('2');
    assert.equal(await page.locator('#printRoot .sheet-card').count(),2);
  });
  await page.locator('.mobile-nav [data-pane="images"]').click();
  await test('Image editor contains two clearly named actions, no copies stepper', async () => {
    const tile=page.locator('#gallery .tile').first();
    assert.equal(await tile.getByRole('button',{name:'Изменить кадр изображения'}).count(),1);
    assert.equal(await tile.getByRole('button',{name:'Удалить изображение из набора'}).count(),1);
    assert.equal(await tile.locator('.copy-input').count(),0);
  });
  await page.locator('.crop-btn').click();
  await test('Crop dialog and large visible slider are available', async () => {
    assert.equal(await page.locator('#cropDialog').isVisible(),true);
    const size=await page.locator('#cropZoom').boundingBox();assert.ok(size?.height>=35);
  });
  await page.locator('#cropZoom').evaluate(el => { el.value='2'; el.dispatchEvent(new Event('input',{bubbles:true})); });
  await test('Cropping supports zooming', async () => {
    assert.match(await page.locator('#cropImage').getAttribute('style'),/scale\(2\)/);
  });
  await test('Simulated finger drag changes cropped image position', async () => {
    const rect=await page.locator('#cropStage').boundingBox();
    const x=rect.x+rect.width/2,y=rect.y+rect.height/2;
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+24,y:y+18}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await cdp.detach();
    const transform=await page.locator('#cropImage').evaluate(el=>el.style.transform);
    assert.ok(!transform.includes('translate(0%, 0%)'),transform);
  });
  await page.locator('#cropCaption').fill('Вторая подпись');
  await page.locator('#cropApply').click();
  await test('Gallery thumbnail reflects applied crop', async () => {
    const galleryImage=page.locator('#gallery .tile-crop-viewport img').first();
    const printedImage=page.locator('#printRoot .pic img').first();
    assert.equal(await galleryImage.evaluate(el=>el.style.transform),
      await printedImage.evaluate(el=>el.style.transform));
    const ratio=await page.locator('#gallery .tile-crop-viewport').first().evaluate(el=>{
      const r=el.getBoundingClientRect(); return r.width/r.height;
    });
    const expected=await page.evaluate(()=>{const p=layoutPlan(),v=cropViewport(p,true);return v.w/v.h;});
    assert.ok(Math.abs(ratio-expected)<.03, JSON.stringify({ratio,expected}));
  });
  await test('Updated caption survives cropping', async () => {
    assert.equal(await page.locator('#printRoot .cap').first().textContent(),'Вторая подпись');
    assert.match(await page.locator('#printRoot .pic img').first().getAttribute('style'),/scale\(2\)/);
  });
  await page.locator('.mobile-nav [data-pane="sheet"]').click();
  await test('Sheet selector targets only chosen image', async () => {
    const result=await page.evaluate(()=>{
      const a=state.items[0];
      state.items.push({id:'e2e2',url:a.url,caption:'Второй образец',copies:1,crop:null});
      renderGallery();renderOutput();
      return [...document.querySelectorAll('#sheetImageSelect option')].map(o=>o.textContent);
    });
    assert.equal(result.length,2);
    await page.locator('#sheetImageSelect').selectOption('e2e2');
    await page.locator('#sheetInc').click();
    const counts=await page.evaluate(()=>state.items.map(i=>i.copies));
    assert.deepEqual(counts,[2,2]);
    await page.locator('#sheetImageSelect').selectOption('e2e');
    await page.locator('#sheetInc').click();
    const counts2=await page.evaluate(()=>state.items.map(i=>i.copies));
    assert.deepEqual(counts2,[3,2]);
    await page.evaluate(()=>{state.items=state.items.slice(0,1);state.items[0].copies=2;renderGallery();renderOutput();});
  });
  await test('Cut marks present and nonoverlapping', async () => {
    await page.evaluate(()=>{ state.cutLines=true; state.gap=2; renderOutput(); });
    assert.equal(await page.locator('#printRoot .cut-corner').count(),8);
    const length=await page.locator('#printRoot .cut-guide').first().evaluate(el=>parseFloat(el.style.getPropertyValue('--mark-size')));
    assert.ok(length<1, String(length));
  });
  await test('Actual PDF export has correct A4 page size and page count', async () => {
    const result=await page.evaluate(async()=>{
      const file=await buildPdfFile();
      const raw=await file.arrayBuffer();
      const bytes=new Uint8Array(raw);
      const text=new TextDecoder('latin1').decode(bytes);
      return {type:file.type,name:file.name,signature:text.slice(0,8),
        pageCount:(text.match(/\/Type \/Page \/Parent/g)||[]).length,
        box:text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)?.slice(1),
        size:bytes.length,end:text.trim().endsWith('%%EOF')};
    });
    assert.equal(result.type,'application/pdf');
    assert.ok(result.signature.startsWith('%PDF-1.4'));
    assert.equal(result.pageCount,1);
    assert.ok(Math.abs(Number(result.box[0])-595.2756)<.1,JSON.stringify(result));
    assert.ok(Math.abs(Number(result.box[1])-841.8898)<.1,JSON.stringify(result));
    assert.ok(result.end && result.size>2000,JSON.stringify(result));
  });
  await test('PNG export builds valid image', async () => {
    const result=await page.evaluate(async()=>{
      const file=await buildPngFile(), b=new Uint8Array(await file.arrayBuffer());
      return {type:file.type,name:file.name,start:[...b.slice(0,8)],size:b.length};
    });
    assert.equal(result.type,'image/png');
    assert.deepEqual(result.start,[137,80,78,71,13,10,26,10]);
    assert.ok(result.size>1000);
  });
  await test('Multipage PNG export produces ZIP and PDF retains all pages', async () => {
    const result=await page.evaluate(async()=>{
      const previous=state.items[0].copies;
      state.items[0].copies=30;
      try {
        const png=await buildPngFile(), pdf=await buildPdfFile();
        const z=new Uint8Array(await png.arrayBuffer());
        const text=new TextDecoder('latin1').decode(await pdf.arrayBuffer());
        return {type:png.type,name:png.name,zipMagic:[...z.slice(0,4)],
          pdfPages:(text.match(/\/Type \/Page \/Parent/g)||[]).length};
      } finally { state.items[0].copies=previous; }
    });
    assert.equal(result.type,'application/zip');
    assert.deepEqual(result.zipMagic,[80,75,3,4]);
    assert.equal(result.pdfPages,2);
  });
  await test('Native share receives a PDF file when supported', async () => {
    const shared=await page.evaluate(async()=>{
      const originalCanShare=navigator.canShare,originalShare=navigator.share;
      let received=null;
      Object.defineProperty(navigator,'canShare',{configurable:true,value:input=>Array.isArray(input.files)});
      Object.defineProperty(navigator,'share',{configurable:true,value:async input=>{
        received={fileName:input.files[0].name,type:input.files[0].type,size:input.files[0].size};
      }});
      try { await exportAction('share'); return received; }
      finally {
        if(originalCanShare)Object.defineProperty(navigator,'canShare',{configurable:true,value:originalCanShare});
        else delete navigator.canShare;
        if(originalShare)Object.defineProperty(navigator,'share',{configurable:true,value:originalShare});
        else delete navigator.share;
      }
    });
    assert.equal(shared?.type,'application/pdf');
    assert.equal(shared?.fileName,'ADK-kartochki.pdf');
    assert.ok(shared.size>1000);
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
