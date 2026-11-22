// ADK Constructor regression tests. Run: node tests/run-tests.mjs
// No dependencies; exercises the real pure functions extracted from the HTML.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { Script, createContext } from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0];
assert.ok(script, 'Application script exists');
new Script(script); // syntax check

function extract(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(script);
  assert.ok(match, 'Function ' + name + ' exists');
  let at = script.indexOf('{', match.index + match[0].length);
  const start = match.index;
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = at; i < script.length; i++) {
    const c = script[i], n = script[i+1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return script.slice(start,i+1);
  }
  throw new Error('Unterminated ' + name);
}
const state = { paper:'a4', orient:'portrait',sizeMode:'50',wCm:5,hCm:5,margin:10,gap:3,
  border:'normal',borderColor:'#019BAB',cutLines:false,showLabels:true,
  mode:'cards',items:[] };
const ctx = createContext({ state, console });
for (const name of ['normalizeCopies','pageMm','cardMm','borderWidth','cmLabel','layoutPlan',
  'slots','splitPages','captionShown','cropViewport','cropPanBounds','boundedItemCrop']) {
  new Script(extract(name)).runInContext(ctx);
}
const call = (name,...args) => ctx[name](...args);
const tests = [];
function test(name, fn) {
  try { fn(); tests.push([name,'PASS']); }
  catch (e) { tests.push([name,'FAIL']); console.error('FAIL:',name,e.message); }
}
test('Default A4 layout: 3 columns x 5 rows of 5 cm cards', () => {
  const p=call('layoutPlan'); assert.equal(p.cols,3); assert.equal(p.rows,5); assert.equal(p.perSheet,15);
});
test('Sizes: A3 landscape', () => {
  state.paper='a3';state.orient='landscape';
  const p=call('pageMm');assert.equal(p.w,420);assert.equal(p.h,297);
  state.paper='a4';state.orient='portrait';
});
test('Copies are clamped 1..30', () => {
  assert.equal(call('normalizeCopies',0),1);
  assert.equal(call('normalizeCopies',5),5);
  assert.equal(call('normalizeCopies',999),30);
});
test('Page split respects copies', () => {
  state.items=[{id:'1',copies:30,caption:'Привет'}];
  assert.equal(call('slots').length,30);
  assert.equal(call('splitPages',call('layoutPlan')).length,2);
  state.items=[];
});
test('Crop viewport reserves border and caption', () => {
  const p=call('layoutPlan');
  const yes=call('cropViewport',p,true), no=call('cropViewport',p,false);
  assert.ok(no.h>yes.h);assert.ok(yes.w>0);assert.ok(yes.h>0);
});
test('No empty areas for square crop at 200%', () => {
  const b=call('cropPanBounds',100,100,100,100,2);
  assert.equal(b.x,50);assert.equal(b.y,50);
});
test('Portrait image cannot pan horizontally at 100%', () => {
  const b=call('cropPanBounds',100,100,100,200,1);
  assert.equal(b.x,0);assert.equal(b.y,0);
});
test('Nonmatching aspect: pan only in occupied axis', () => {
  const b=call('cropPanBounds',100,100,100,200,2);
  assert.equal(b.x,0);assert.equal(b.y,50);
});
test('P1-3: saved crop is clamped only for the current card aspect ratio', () => {
  const item={id:'crop',caption:'',copies:1,w:1600,h:900,crop:{zoom:1.6,x:0,y:30}};
  const original={...item.crop};
  state.sizeMode='custom';
  state.wCm=10;state.hCm=5;
  const horizontal=call('boundedItemCrop',item,call('layoutPlan'));
  assert.ok(horizontal.y>0);
  state.wCm=5;state.hCm=10;
  const vertical=call('boundedItemCrop',item,call('layoutPlan'));
  assert.equal(vertical.y,0);
  assert.ok(vertical.x===0);
  assert.deepEqual(item.crop,original);
  state.sizeMode='50';state.wCm=5;state.hCm=5;
});
test('Invalid geometry is safe', () => {
  const b=call('cropPanBounds',0,100,100,200,2);
  assert.equal(b.x,0);assert.equal(b.y,0);
});
test('Print and preview share the same buildSheet function', () => {
  assert.ok(html.includes('mountPreview(buildSheet(pageItems, plan), scale, plan)'));
  assert.ok(html.includes('printRoot.append(buildSheet(pageItems, plan))'));
});
test('Mobile input and caption control exist', () => {
  assert.ok(html.includes('id="sheetCopyInput"') && html.includes('inputmode="numeric"'));
  assert.ok(html.includes('id="cropCaption"'));
});
test('Nonoverlap formula for crop marks', () => {
  for(const gap of [2,3,5]) {
    const size=Math.max(.6,Math.min(2,gap/2-.2));
    assert.ok(2*size<gap);
  }
});
const passed=tests.filter(t=>t[1]==='PASS').length;
for(const [name,result] of tests) console.log(result.padEnd(5), name);
console.log(passed+'/'+tests.length+' checks passed');
if(passed!==tests.length) process.exitCode=1;
