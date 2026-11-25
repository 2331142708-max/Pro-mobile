'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {matchPatterns,sides}=require('./patterns');
const {QUARTER,binanceBar,receiveBars,frameBars,analyze,buySell}=require('./pattern-feed');
const k=(o,h,l,c,v=100)=>({o,h,l,c,v});
const history=Array.from({length:12},(_,i)=>k(125-i,125.4-i,123.8-i,124-i));
const mirror=rows=>rows.map(b=>({...b,o:250-b.o,c:250-b.c,h:250-b.l,l:250-b.h}));
test('exact pattern catalogue and directional candle context',()=>{
  assert.equal(sides.up.length,12);
  assert.equal(sides.down.length,13);
  const shape=k(112.9,113,110.8,112.8);
  assert.ok(matchPatterns([...history,shape]).up.includes('锤子线'));
  const top=k(137.7,137.9,135.6,137.6);
  assert.ok(matchPatterns([...mirror(history),top]).down.includes('上吊线'));
  const set=[...history,k(113,113.2,111,111.2),k(111,114.3,110.8,114),k(114,115.2,113.9,115)];
  assert.ok(matchPatterns(set).up.includes('三外升'));
  assert.ok(matchPatterns(mirror(set)).down.includes('三外降'));
  assert.ok(matchPatterns(set.slice(0,-1)).up.includes('阳包阴'));
  assert.ok(matchPatterns(mirror(set.slice(0,-1))).down.includes('阴包阳'));
});
test('multiple patterns can be retained independently on one close',()=>{
  const bars=[...history,k(113.1,113.2,110.65,111),k(111,111.15,110.7,110.92),k(110.8,113.5,110.7,113.3)];
  const result=matchPatterns(bars);
  assert.ok(result.up.includes('早晨之星'));
  assert.ok(result.up.includes('阳包阴'));
  assert.ok(matchPatterns(mirror(bars)).down.includes('黄昏之星'));
});
test('30m contains exactly two continuous closed bars from one market',()=>{
  const rows=[0,1,2,3,4,6,7].map((i)=>({...k(100+i,101+i,99+i,100+i),t:i*QUARTER,closed:i!==7}));
  const out=frameBars(rows,30,9*QUARTER);
  assert.deepEqual(out.map(b=>b.t),[0,2*QUARTER]);
  assert.deepEqual(out[0],{t:0,o:100,h:102,l:99,c:101,v:200,closed:true});
});
test('scan expires the old pattern even with a still-forming candle',()=>{
  const input=[...history,k(112.9,113,110.8,112.8),k(113,114,112,113)];
  const rows=input.map((b,i)=>({...b,t:i*QUARTER,closed:i!==13,buy:60}));
  const m={bars15:rows};
  assert.ok(analyze(m,13*QUARTER+5000).matches.some(h=>h.period===15&&h.names.includes('锤子线')));
  assert.equal(analyze(m,14*QUARTER+5000).matches.length,0);
  assert.deepEqual(buySell(m,13*QUARTER+5000),{buyPct:60,sellPct:40,partial:false,window:'当前15分钟'});
  assert.equal(buySell(m,14*QUARTER+5000),null);
});
test('coin and USD contracts use corresponding volume and taker volume fields',()=>{
  const b=binanceBar([0,'10','12','9','11','10',899999,'300',4,'7','260',0]);
  assert.equal(b.v,10);
  assert.equal(b.buy,7);
  const m={exchange:'okx',aggressor:{t:QUARTER,buy:3,sell:1,since:QUARTER+4000,socket:{readyState:1}}};
  assert.deepEqual(buySell(m,QUARTER+5000),{buyPct:75,sellPct:25,partial:true,window:'当前15分钟'});
  m.aggressor.socket.readyState=3;
  assert.equal(buySell(m,QUARTER+5000),null);
});
test('unfinished updates do not erase a confirmed close',()=>{
  const m={};
  const b={...k(10,12,9,11),t:QUARTER,buy:60,closed:true};
  receiveBars(m,[b],true);
  receiveBars(m,[{...b,c:10.5,closed:false}],true);
  assert.equal(m.bars15[0].c,11);
  assert.equal(m.bars15[0].closed,true);
});

function interpolate(points, finalIndex, radius=0.15) {
  return Array.from({length:finalIndex+1},(_,i)=>{
    const j=points.findIndex(([at])=>at>=i);
    const [right,price]=points[j], [left,base]=points[Math.max(0,j-1)];
    const close=right===left?price:base+(price-base)*(i-left)/(right-left);
    const open=i===finalIndex?close-0.6:close;
    return k(open,close+radius,open-radius,close);
  });
}
test('double and triple reversals need a just-closed neckline break',()=>{
  const w=interpolate([[0,110],[5,102],[10,106],[15,101.9],[20,105],[21,106.9]],21);
  assert.ok(matchPatterns(w).up.includes('W底'));
  assert.ok(matchPatterns(mirror(w)).down.includes('M顶'));
  assert.ok(!matchPatterns(w.slice(0,-1)).up.includes('W底'));
  const triple=interpolate([[0,110],[5,102],[10,106],[15,101.9],[20,106],[25,102],[30,105],[31,107]],31);
  assert.ok(matchPatterns(triple).up.includes('三重底'));
  assert.ok(matchPatterns(mirror(triple)).down.includes('三重顶'));
  const shoulder=interpolate([[0,110],[5,102],[10,105],[15,100],[20,105],[25,102],[30,104],[31,107]],31);
  assert.ok(matchPatterns(shoulder).up.includes('头肩底'));
  assert.ok(matchPatterns(mirror(shoulder)).down.includes('头肩顶'));
});
test('contracting boundaries / mirror produce wedges and triangles only after the break',()=>{
  const wedge=interpolate([[0,110],[3,113],[7,103],[11,109],[15,102],[19,106],[23,101],[26,103],[27,105.5]],27);
  assert.ok(matchPatterns(wedge).up.includes('下降楔形'));
  assert.ok(matchPatterns(mirror(wedge)).down.includes('上升楔形'));
  const triangle=interpolate([[0,102],[3,110],[7,103],[11,110],[15,105],[19,110],[23,107],[26,109],[27,111]],27);
  assert.ok(matchPatterns(triangle).up.includes('上升三角'));
  assert.ok(matchPatterns(mirror(triangle)).down.includes('下降三角'));
});
