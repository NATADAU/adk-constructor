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
  // Simulate a file-share-capable mobile browser for the existing iPhone tests.
  await page.evaluate(() => {
    Object.defineProperty(navigator,'canShare',{configurable:true,value:input=>Array.isArray(input?.files)});
    Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{}});
  });
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
  await test('P1-2a: large uploads shrink to 3000px and small images stay unchanged', async () => {
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 3200;
      canvas.height = 320;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#019bab';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const fileBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
      const large = new File([fileBlob], 'large.jpg', {type:'image/jpeg'});
      const before = state.items.length;
      await addFiles([large]);
      const item = state.items.at(-1);
      const stored = await fetch(item.url).then(response => response.blob());
      const decoded = await createImageBitmap(stored);
      const resized = {w:item.w,h:item.h,actualW:decoded.width,actualH:decoded.height,type:stored.type};
      decoded.close();
      const smallCanvas = document.createElement('canvas');
      smallCanvas.width = 400;
      smallCanvas.height = 200;
      const smallBlob = await new Promise(resolve => smallCanvas.toBlob(resolve, 'image/png'));
      await addFiles([new File([smallBlob], 'small.png',{type:'image/png'})]);
      const small = state.items.at(-1);
      const smallStored = await fetch(small.url).then(response=>response.blob());
      const smallResult = {w:small.w,h:small.h,type:smallStored.type,size:smallStored.size,originalSize:smallBlob.size};
      state.items.splice(before).forEach(item=>URL.revokeObjectURL(item.url));
      renderGallery();renderOutput();
      return {resized,smallResult};
    });
    assert.deepEqual(result.resized,{w:3000,h:300,actualW:3000,actualH:300,type:'image/jpeg'});
    assert.deepEqual(result.smallResult,{w:400,h:200,type:'image/png',size:result.smallResult.originalSize,originalSize:result.smallResult.originalSize});
  });
  await page.evaluate(() => {
    const img='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0c8AAAAASUVORK5CYII=';
    state.items.push({ id:'e2e',url:img,caption:'Первый текст',copies:2,crop:null });
    renderGallery(); renderOutput();
  });
  await test('P1-1: mobile status is visible on sheet and error survives navigation', async () => {
    await page.setViewportSize({width:375,height:812});
    await page.evaluate(() => {
      state.pane='sheet'; syncPane();
      document.querySelector('#status').textContent='Добавлено: 3 шт.';
    });
    const status=page.locator('#status');
    await assert.equal(await status.isVisible(),true);
    assert.equal(await status.evaluate(el=>el.closest('.pane-settings')),null);
    await page.evaluate(() => {
      document.querySelector('#status').textContent='Этот браузер не поддерживает отправку PDF. Нажмите «Скачать PDF».';
    });
    await page.waitForFunction(()=>document.querySelector('#status').dataset.level==='error');
    assert.equal(await status.isVisible(),true);
    await page.locator('.mobile-nav [data-pane="images"]').click();
    assert.equal(await status.isVisible(),true);
    await page.locator('.mobile-nav [data-pane="sheet"]').click();
    assert.equal(await status.isVisible(),true);
    assert.match(await status.textContent(),/не поддерживает/);
    await page.evaluate(()=>document.querySelector('#status').textContent='');
  });
  await test('Mobile sheet preview has usable height below multirow toolbar', async () => {
    for (const width of [320,375,414]) {
      await page.setViewportSize({width,height:740});
      await page.evaluate(()=>{state.pane='sheet';syncPane();});
      const geometry=await page.locator('#previewScroll').evaluate(el=>{
        const r=el.getBoundingClientRect();
        const parent=el.closest('.preview-panel').getBoundingClientRect();
        return {height:r.height,parentHeight:parent.height};
      });
      assert.ok(geometry.height>=400, JSON.stringify({width,geometry}));
      assert.ok(geometry.parentHeight>=geometry.height, JSON.stringify({width,geometry}));
    }
  });
  await test('Print output contains two cards and captions', async () => {
    assert.equal(await page.locator('#printRoot .sheet-card').count(),2);
    assert.equal(await page.locator('#printRoot .cap').count(),2);
    assert.equal(await page.locator('#printRoot .cap').first().textContent(),'Первый текст');
  });
  await test('Sheet actions are compact and additional actions open from menu', async () => {
    assert.equal(await page.locator('#savePdf').isVisible(),true);
    assert.equal(await page.locator('#sharePdf').isVisible(),true);
    assert.equal(await page.locator('#print').isVisible(),false);
    assert.equal(await page.locator('#savePng').isVisible(),false);
    const order=await page.evaluate(()=>{
      const quantity=document.querySelector('#sheetQuantity').getBoundingClientRect();
      const controls=document.querySelector('.preview-toolbar').getBoundingClientRect();
      const preview=document.querySelector('#previewScroll').getBoundingClientRect();
      return {quantityEnd:quantity.bottom,controlsTop:controls.top,controlsEnd:controls.bottom,previewTop:preview.top};
    });
    assert.ok(order.quantityEnd<=order.controlsTop+2,JSON.stringify(order));
    assert.ok(order.controlsEnd<=order.previewTop+2,JSON.stringify(order));
    await page.locator('#moreActions summary').click();
    assert.equal(await page.locator('#print').isVisible(),true);
    assert.equal(await page.locator('#savePng').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#print').isVisible(),false);
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
    assert.equal(await tile.getByRole('button',{name:'Изменить размер и кадр изображения'}).count(),1);
    assert.equal(await tile.getByRole('button',{name:'Удалить изображение из набора'}).count(),1);
    assert.equal(await tile.locator('.copy-input').count(),0);
  });
  await page.locator('.crop-btn').click();
  await test('Crop dialog and large visible slider are available', async () => {
    assert.equal(await page.locator('#cropDialog').isVisible(),true);
    const size=await page.locator('#cropZoom').boundingBox();assert.ok(size?.height>=35);
  });
  await page.locator('#cropZoom').evaluate(el => { el.value='2'; el.dispatchEvent(new Event('input',{bubbles:true})); });
  await test('Can reduce image to 30% without changing card dimensions', async () => {
    const before=await page.evaluate(()=>({w:layoutPlan().card.w,h:layoutPlan().card.h}));
    await page.locator('#cropZoom').evaluate(el => { el.value='0.3'; el.dispatchEvent(new Event('input',{bubbles:true})); });
    const changed=await page.evaluate(()=>({
      zoom:cropDraft.zoom,
      transform:document.querySelector('#cropImage').style.transform,
      pan:cropPanBounds(300,300,200,200,cropDraft.zoom)
    }));
    assert.equal(changed.zoom,0.3);
    assert.match(changed.transform,/scale\(0\.3\)/);
    assert.deepEqual(changed.pan,{x:0,y:0});
    await page.locator('#cropApply').click();
    const after=await page.evaluate(()=>({
      w:layoutPlan().card.w,h:layoutPlan().card.h,
      printTransform:document.querySelector('#printRoot .pic img').style.transform,
      galleryTransform:document.querySelector('#gallery .tile-crop-viewport img').style.transform
    }));
    assert.deepEqual({w:after.w,h:after.h},before);
    assert.match(after.printTransform,/scale\(0\.3\)/);
    assert.match(after.galleryTransform,/scale\(0\.3\)/);
    await page.locator('.mobile-nav [data-pane="images"]').click();
    await page.locator('.crop-btn').click();
    await page.locator('#cropZoom').evaluate(el => { el.value='2'; el.dispatchEvent(new Event('input',{bubbles:true})); });
  });
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
  await test('Applying crop opens the sheet and the return button opens images', async () => {
    assert.equal(await page.locator('#dropZone').getAttribute('data-pane'),'sheet');
    assert.equal(await page.locator('#backToImages').isVisible(),true);
    await page.locator('#backToImages').click();
    assert.equal(await page.locator('#dropZone').getAttribute('data-pane'),'images');
  });
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
  await test('Cut layout is one contiguous table with no gaps or empty cells', async () => {
    const result=await page.evaluate(()=>{
      state.cutLines=true;state.gap=3;renderOutput();
      const plan=layoutPlan(),pageCards=[...document.querySelectorAll('#printRoot .sheet-card')];
      const marks=[...document.querySelectorAll('#printRoot .cut-grid-line')];
      return {gap:plan.gap,cols:plan.cols,cardCount:pageCards.length,
        secondX:pageCards[1].style.left,
        firstX:pageCards[0].style.left,
        cardWidth:plan.card.w,
        marks:marks.length,segments:gridSegments(pageCards.length,plan),
        extraCells:document.querySelectorAll('#printRoot .cut-corner, #printRoot .cut-guide').length,
        borderStyles:marks.map(el=>getComputedStyle(el)[el.classList.contains('horizontal')?'borderTopStyle':'borderLeftStyle'])};
    });
    assert.equal(result.gap,0);
    assert.equal(result.secondX, (parseFloat(result.firstX)+result.cardWidth)+'mm');
    assert.equal(result.extraCells,0);
    assert.equal(result.marks,result.segments.length);
    assert.ok(result.borderStyles.every(style=>style==='dashed'));
    assert.equal(result.cardCount,2);
  });
  await test('Incomplete bottom row has no phantom cells; print and PDF use same grid', async () => {
    const result=await page.evaluate(()=>{
      const plan=layoutPlan(), six=gridSegments(6,plan), seven=gridSegments(7,plan);
      const lastRow=7-(Math.ceil(7/plan.cols)-1)*plan.cols;
      const bottom=seven.filter(s=>s.direction==='horizontal').at(-1);
      const penultimate=seven.filter(s=>s.direction==='horizontal').at(-2);
      let drawn=0;
      const fake={
        save(){},restore(){},beginPath(){},moveTo(){},lineTo(){drawn++},stroke(){},
        setLineDash(){},set strokeStyle(v){},set lineWidth(v){}
      };
      drawExportCutGrid(fake,plan,7,180);
      return {six,seven,lastRow,bottom,penultimate,drawn,cols:plan.cols};
    });
    assert.equal(result.bottom.length,result.lastRow*50);
    assert.equal(result.penultimate.length,result.cols*50);
    assert.equal(result.drawn,result.seven.length);
    assert.ok(result.seven.length>result.six.length);
  });
  await test('Disabling cut grid restores original card spacing and removes guides', async () => {
    await page.evaluate(()=>{state.cutLines=false;renderOutput();});
    const result=await page.evaluate(()=>{
      const plan=layoutPlan(),cards=[...document.querySelectorAll('#printRoot .sheet-card')];
      return {gap:plan.gap,gridCount:document.querySelectorAll('#printRoot .cut-grid').length,
        firstX:parseFloat(cards[0].style.left),secondX:parseFloat(cards[1].style.left),width:plan.card.w};
    });
    assert.equal(result.gridCount,0);
    assert.equal(result.gap,3);
    assert.equal(result.secondX-result.firstX,result.width+3);
    await page.evaluate(()=>{state.cutLines=true;renderOutput();});
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
  await test('iPhone-style share uses cached PDF inside original user click', async () => {
    // Edits must invalidate the old PDF and prepare a new one BEFORE tapping.
    await page.evaluate(()=>{
      state.items[0].caption='Последняя редакция';
      renderOutput();
    });
    assert.equal(await page.locator('#sharePdf').isDisabled(),true);
    await page.waitForFunction(()=>!document.querySelector('#sharePdf').disabled,{timeout:30000});
    const status=await page.locator('#sharePdf').textContent();
    assert.equal(status,'Поделиться');
    await page.evaluate(()=>{
      window.__capturedShare=null;
      window.__oldCanShare=navigator.canShare;
      window.__oldShare=navigator.share;
      Object.defineProperty(navigator,'canShare',{configurable:true,value:input=>Array.isArray(input.files)});
      Object.defineProperty(navigator,'share',{configurable:true,value:async input=>{
        window.__capturedShare={
          fileName:input.files[0].name,type:input.files[0].type,
          size:input.files[0].size,hasUrl:'url' in input,
          activated:navigator.userActivation?.isActive ?? null
        };
      }});
    });
    await page.locator('#sharePdf').click();
    const shared=await page.evaluate(()=>window.__capturedShare);
    await page.evaluate(()=>{
      if(window.__oldCanShare)Object.defineProperty(navigator,'canShare',{configurable:true,value:window.__oldCanShare});
      else delete navigator.canShare;
      if(window.__oldShare)Object.defineProperty(navigator,'share',{configurable:true,value:window.__oldShare});
      else delete navigator.share;
    });
    assert.equal(shared?.type,'application/pdf');
    assert.equal(shared?.fileName,'ADK-kartochki.pdf');
    assert.equal(shared?.hasUrl,false);
    assert.notEqual(shared?.activated,false,'Share must be called synchronously from the user tap');
    assert.ok(shared.size>1000);
  });
  await test('P1-2d: decoded export image cache is bounded and released', async () => {
    const results = await page.evaluate(async () => {
      clearExportBitmapCache();
      const canvas=document.createElement('canvas');
      canvas.width=2; canvas.height=2;
      const urls=[];
      for (let i=0; i<5; i++) {
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        urls.push(URL.createObjectURL(blob));
      }
      try {
        const items=urls.map((url,id)=>({id:String(id),url}));
        const decoded=await prepareExportImages(items);
        const cached=exportBitmapCache.size;
        const last=decoded.images.get(urls[4]);
        const before=last.width;
        decoded.release();
        const released=last.width;
        clearExportBitmapCache(urls[0]);
        const afterRemoval=exportBitmapCache.size;
        clearExportBitmapCache();
        return {cached,before,released,afterRemoval,final:exportBitmapCache.size};
      } finally {
        clearExportBitmapCache();
        urls.forEach(url=>URL.revokeObjectURL(url));
      }
    });
    assert.deepEqual(results,{cached:4,before:2,released:0,afterRemoval:3,final:0});
  });
  await test('P1-2c: PDF export uses Blob encoding rather than synchronous data URL', async () => {
    const result=await page.evaluate(async () => {
      const original=HTMLCanvasElement.prototype.toDataURL;
      let called=false;
      HTMLCanvasElement.prototype.toDataURL=function() {
        called=true;
        throw Error('Synchronous data URL should not be used for PDF');
      };
      try {
        const file=await buildPdfFile();
        return {called,type:file.type,size:file.size,signature:await file.slice(0,4).text()};
      } finally {
        HTMLCanvasElement.prototype.toDataURL=original;
      }
    });
    assert.equal(result.called,false);
    assert.equal(result.type,'application/pdf');
    assert.ok(result.size>1000);
    assert.equal(result.signature,'%PDF');
  });
  await test('P1-4a: long two-line captions are clamped and export is inset by border', async () => {
    const result=await page.evaluate(() => {
      const item=state.items[0], oldCaption=item.caption, oldLabels=state.showLabels;
      const original={sizeMode:state.sizeMode,wCm:state.wCm,hCm:state.hCm,border:state.border};
      try {
        state.sizeMode='custom';state.wCm=5;state.hCm=10;state.border='normal';
        state.showLabels=true;
        item.caption='Очень длинная подпись которая не должна обрезать третью строку посередине: требуется ограничение в две строки';
        renderOutput();
        const cap=document.querySelector('#printRoot .cap');
        const css=getComputedStyle(cap);
        const plan=layoutPlan(),bw=borderWidth();
        const captured=[];
        const ctx={
          measureText(text){return {width:text.length*5};},
          save(){},beginPath(){},rect(...args){captured.push(args);},clip(){},
          fillText(){},restore(){},
          set fillStyle(v){},set textAlign(v){},set textBaseline(v){},set font(v){}
        };
        drawExportCaption(ctx,item,plan,0,0,180);
        const mmToPixels=(mm)=>exportPixels(mm,180);
        return {
          clamp:css.webkitLineClamp,display:css.display,
          clip:captured[0],
          expectedX:mmToPixels(bw+1.4),
          expectedY:mmToPixels(plan.card.h-bw-Math.max(6,Math.min(12,plan.card.h*.2))),
          expectedW:mmToPixels(plan.card.w-2*bw-2.8)
        };
      } finally {
        item.caption=oldCaption;state.showLabels=oldLabels;Object.assign(state,original);renderOutput();
      }
    });
    assert.equal(result.clamp,'2');
    assert.equal(result.display,'flow-root'===result.display?'flow-root':'-webkit-box');
    assert.ok(Math.abs(result.clip[0]-result.expectedX)<.05,JSON.stringify(result));
    assert.ok(Math.abs(result.clip[1]-result.expectedY)<.05,JSON.stringify(result));
    assert.ok(Math.abs(result.clip[2]-result.expectedW)<.05,JSON.stringify(result));
  });
  await test('P1-3: resizing a card clamps its visible crop without changing the saved crop', async () => {
    const result=await page.evaluate(() => {
      const item=state.items[0], oldCrop=item.crop, oldW=item.w, oldH=item.h;
      const original={sizeMode:state.sizeMode,wCm:state.wCm,hCm:state.hCm};
      try {
        item.w=1600;item.h=900;item.crop={zoom:1.6,x:0,y:30};
        state.sizeMode='custom';state.wCm=10;state.hCm=5;
        renderOutput();
        const before=document.querySelector('#printRoot .pic img').style.transform;
        state.wCm=5;state.hCm=10;
        renderOutput();
        const after=document.querySelector('#printRoot .pic img').style.transform;
        return {before,after,savedY:item.crop.y};
      } finally {
        item.crop=oldCrop;item.w=oldW;item.h=oldH;
        Object.assign(state,original);
        renderOutput();
      }
    });
    assert.ok(result.before.includes('translate(0%, 30%)'),result.before);
    assert.ok(result.after.includes('translate(0%, 0%)'),result.after);
    assert.equal(result.savedY,30);
  });
  await test('P1-2f: large collections show a gentle warning', async () => {
    const result=await page.evaluate(() => {
      const item=state.items[0], before=item.copies;
      const itemsBefore=state.items;
      try {
        state.items=Array.from({length:41},(_,i)=>({...item,id:'warning'+i,copies:1}));
        renderOutput();
        const visible=!document.querySelector('#largeSetNotice').hidden;
        const message=document.querySelector('#largeSetNotice').textContent;
        return {visible,message};
      } finally {
        state.items=itemsBefore;
        item.copies=before;
        renderOutput();
      }
    });
    assert.equal(result.visible,true);
    assert.match(result.message,/41 изображений/);
    assert.equal(await page.locator('#largeSetNotice').isVisible(),false);
  });
  await test('P1-2e: unsupported browsers never prebuild PDF and show a helpful message', async () => {
    await page.evaluate(() => {
      window.__oldPdfBuilder = buildPdfFile;
      window.__unsupportedPdfBuilds = 0;
      buildPdfFile = async function() {
        window.__unsupportedPdfBuilds++;
        return window.__oldPdfBuilder();
      };
      Object.defineProperty(navigator,'canShare',{configurable:true,value:undefined});
      Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
      state.items[0].caption='Проверка браузера без отправки';
      renderOutput();
    });
    assert.equal(await page.locator('#sharePdf').isDisabled(),false);
    await page.waitForTimeout(1150);
    assert.equal(await page.evaluate(()=>window.__unsupportedPdfBuilds),0);
    assert.equal(await page.evaluate(()=>sharePdfCache),null);
    await page.locator('#sharePdf').click();
    assert.match(await page.locator('#status').textContent(),/Этот браузер не поддерживает отправку PDF/);
    assert.equal(await page.locator('#status').isVisible(),true);
    await page.evaluate(() => {
      buildPdfFile = window.__oldPdfBuilder;
      delete window.__oldPdfBuilder;
      Object.defineProperty(navigator,'canShare',{configurable:true,value:input=>Array.isArray(input?.files)});
      Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{}});
      renderOutput();
    });
  });
  await test('P1-2b: rapid caption changes cause only one delayed PDF build', async () => {
    await page.waitForFunction(() => !!sharePdfCache && !document.querySelector('#sharePdf').disabled);
    await page.evaluate(() => {
      window.__oldPdfBuilder = buildPdfFile;
      window.__pdfBuildCount = 0;
      buildPdfFile = async function() {
        window.__pdfBuildCount++;
        return window.__oldPdfBuilder();
      };
      for (let i = 0; i < 10; i++) {
        state.items[0].caption = 'Изменение ' + i;
        renderOutput();
      }
    });
    await page.waitForFunction(() => window.__pdfBuildCount === 1, {timeout:30000});
    await page.waitForFunction(() => !!sharePdfCache && !document.querySelector('#sharePdf').disabled, {timeout:30000});
    const count = await page.evaluate(() => {
      const count = window.__pdfBuildCount;
      buildPdfFile = window.__oldPdfBuilder;
      delete window.__oldPdfBuilder;
      return count;
    });
    assert.equal(count,1);
  });
  await test('P1-2b: PDF download reuses the prepared PDF', async () => {
    const result = await page.evaluate(async () => {
      const originalBuild = buildPdfFile, originalDownload = downloadExportFile;
      let calls = 0, downloaded = null;
      try {
        buildPdfFile = async () => { calls++; return originalBuild(); };
        downloadExportFile = file => { downloaded = {name:file.name,size:file.size,same:file===sharePdfCache}; };
        await exportAction('pdf');
        return {calls,downloaded};
      } finally {
        buildPdfFile = originalBuild;
        downloadExportFile = originalDownload;
      }
    });
    assert.equal(result.calls,0);
    assert.equal(result.downloaded?.same,true);
    assert.equal(result.downloaded?.name,'ADK-kartochki.pdf');
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
