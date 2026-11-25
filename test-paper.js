'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {createPaperTrader,walk,confidence,CONFIG}=require('./paper');
const MIN=60000;

test('walks order book, rounds to lot size and refuses insufficient depth',()=>{
  const rows=[[100,50],[101,150]];
  const order=walk(rows,1,{cash:15000,step:0.01,minQty:.01});
  assert.ok(order.price>100&&order.price<101.02);
  assert.ok(order.value<=15000&&order.value>14998);
  assert.equal(walk([[100,10]],-1,{quantity:100}),null);
  assert.ok(confidence(60,100)>confidence(6,10));
});
test('a paper order reserves margin, marks an adverse move, settles after 20m and survives restart',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'paper-contract-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.now();
  let marketAt=start,price=100.12;
  let samples=19;
  const options={file:path.join(root,'ledger.json'),durable:false,log:()=>{},
    quality:()=>({samples,wins:Math.floor(samples*.7),net:.08}),
    funding:async()=>[],
    fetchDepth:async()=>({at:marketAt,bids:[[price-.01,10000]],asks:[[price+.01,10000]]})};
  const ledger=createPaperTrader(options);
  const m={symbol:'TESTUSDT',displaySymbol:'TESTUSDT',apiSymbol:'TESTUSDT',exchange:'binance',
    contractType:'CURRENT_QUARTER',paperProduct:{unit:1,minQty:.001,step:.001},paperNames:['阳包阴','W底'],
    paperDecision:{reviewed:true,direction:'up',closedAt:start-MIN,confirmedAt:start-1000,key:100,invalid:96,obstacle:112,atr:1}};
  const markets=new Map([[m.symbol,m]]);
  const tick=async()=>{ledger.advance(markets,marketAt);await new Promise(resolve=>setImmediate(resolve));return ledger.snapshot(marketAt);};
  assert.equal((await tick()).open.length,0);
  samples=20;
  let view=await tick();
  assert.equal(view.open.length,1);
  assert.equal(view.available,CONFIG.capital-CONFIG.margin);
  assert.ok(view.open[0].notional<=15000);
  marketAt=start+30000;price=99.8;
  view=await tick();
  assert.ok(view.open[0].firstMinuteMae>.003);
  marketAt=start+20*MIN;price=100.7;
  view=await tick();
  assert.equal(view.open.length,0);
  assert.equal(view.closed[0].exit.reason,'持有到期');
  assert.ok(view.closed[0].net>0);
  assert.ok(view.closed[0].exit.tradingFees>0);
  assert.equal(createPaperTrader(options).snapshot(marketAt).balance,view.balance);
});

test('the one-off trial takes same-direction patterns with no sample, deduplicates and settles at 20m',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'paper-trial-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.now();
  let now=start,price=100;
  const options={file:path.join(root,'ledger.json'),log:()=>{},quality:()=>null,
    funding:async()=>[],trial:{id:'trial',from:start,until:start+8*MIN},
    fetchDepth:async()=>({at:now,bids:[[price-.01,10000]],asks:[[price+.01,10000]]})};
  let ledger=createPaperTrader(options);
  const make=(symbol,asset,volume,directions)=>({symbol,apiSymbol:symbol,baseAsset:asset,exchange:'binance',
    quoteVolume24h:volume,priceAt:start,paperProduct:{unit:1,minQty:.001,step:.001},
    paperDecision:{status:'waiting',invalid:99.9},paperTrialHits:directions.map((direction,i)=>(
      {direction,names:[i?'W底':'阳包阴']}
    ))});
  const rows=[make('MIXEDUSDT','MIXED',1000,['up','down']),make('TESTUSDT','TEST',200,['up','up']),
    make('OTHERTESTUSDT','TEST',100,['up','up'])];
  const markets=new Map(rows.map(m=>[m.symbol,m]));
  const tick=async(minutes)=>{
    now=start+minutes*MIN;
    for(const m of rows)m.priceAt=now;
    ledger.advance(markets,now);
    await new Promise(resolve=>setImmediate(resolve));
    return ledger.snapshot(now);
  };
  let view=await tick(0);
  assert.deepEqual(view.open.map(p=>p.symbol),['TESTUSDT']);
  assert.equal(view.open[0].trialId,'trial');
  assert.equal(view.open[0].sample,null);
  ledger=createPaperTrader(options);
  price=99.5;
  view=await tick(.5);
  assert.equal(view.open.length,1);
  assert.ok(view.open[0].firstMinuteMae>0);
  view=await tick(20);
  assert.equal(view.open.length,0);
  assert.equal(view.trial.entered,1);
  assert.equal(view.closed[0].exit.reason,'持有到期');
  assert.ok(view.closed[0].net<0);
});

test('all-multiple mode mirrors the tab, including same-name signals and independent venues',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'paper-multiple-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.now();
  let now=start;
  const options={file:path.join(root,'ledger.json'),log:()=>{},quality:()=>null,funding:async()=>[],allMultiple:true,
    fetchDepth:async()=>({at:now,bids:[[99.99,10000]],asks:[[100.01,10000]]})};
  let ledger=createPaperTrader(options);
  const make=(symbol,volume,directions,product=true)=>({symbol,apiSymbol:symbol,baseAsset:'SAME',
    quoteVolume24h:volume,paperProduct:product?{unit:1,minQty:.001,step:.001}:null,
    review:{status:'invalid'},paperDecision:{status:'invalid'},
    paperTrialHits:directions.map(direction=>({direction,closedAt:start-1,names:['阳包阴']}))});
  const rows=[make('CONFLICT',400,['up','down']),make('FIRST',300,['up','up']),make('SECOND',200,['down','down']),
    make('UNSUPPORTED',150,['down','down'],false),make('SINGLES',100,['up'])];
  const markets=new Map(rows.map(m=>[m.symbol,m]));
  const tick=async(minutes)=>{
    now=start+minutes*MIN;
    ledger.advance(markets,now);
    await new Promise(resolve=>setImmediate(resolve));
    return ledger.snapshot(now);
  };
  const first=await tick(0);
  assert.deepEqual(first.multiple.map(row=>row.status),['conflict','open','ready','unsupported']);
  const second=await tick(.1);
  assert.deepEqual(second.open.map(p=>[p.symbol,p.side]),[['FIRST',1],['SECOND',-1]]);
  assert.equal(second.available,CONFIG.capital-2*CONFIG.margin);
  ledger=createPaperTrader(options);
  const settled=await tick(21);
  const final=await tick(21.1);
  assert.equal(settled.closed.length,1);
  assert.deepEqual(final.multiple.map(row=>row.status),['conflict','done','done','unsupported']);
  assert.equal(final.closed.length,2);
  assert.equal(final.open.length,0);
});

test('the 30,000 U deposit is applied once to the running ledger',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'paper-deposit-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'ledger.json');
  const old={version:1,startedAt:Date.now(),balance:9090,open:[{symbol:'TEST',exit:{at:100}}],
    closed:[{id:'closed-trade'}],claimed:{TEST:123},total:{count:1,net:-910}};
  require('node:fs').writeFileSync(file,JSON.stringify(old));
  const options={file,log:()=>{}};
  let snapshot=createPaperTrader(options).snapshot(Date.now());
  assert.equal(snapshot.capitalTopUp,30000);
  assert.equal(snapshot.balance,39090);
  assert.equal(snapshot.available,38090);
  assert.equal(snapshot.config.maxPositions,40);
  assert.deepEqual(snapshot.closed,old.closed);
  assert.equal(snapshot.open[0].symbol,'TEST');
  snapshot=createPaperTrader(options).snapshot(Date.now());
  assert.equal(snapshot.balance,39090);
});

test('stopping settles prior positions and cannot open a qualifying replacement',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'paper-stop-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.now(),file=path.join(root,'ledger.json');
  let now=start;
  const base={file,log:()=>{},quality:()=>null,funding:async()=>[],allMultiple:true,
    fetchDepth:async()=>({at:now,bids:[[99.99,10000]],asks:[[100.01,10000]]})};
  const row={symbol:'TEST',apiSymbol:'TEST',quoteVolume24h:100,contractType:'CURRENT_QUARTER',
    paperProduct:{unit:1,minQty:.001,step:.001},paperTrialHits:[{direction:'up',closedAt:start-100,names:['W底','三重底']}]};
  const other={...row,symbol:'OTHER',apiSymbol:'OTHER',quoteVolume24h:10};
  const markets=new Map([[row.symbol,row],[other.symbol,other]]);
  const running=createPaperTrader(base);
  running.advance(markets,now);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(running.snapshot(now).open.length,1);
  now=start+1000;
  const halted=createPaperTrader({...base,stoppedAt:now});
  halted.advance(markets,now);
  await new Promise(resolve=>setImmediate(resolve));
  const snapshot=halted.snapshot(now);
  assert.equal(snapshot.open.length,0);
  assert.equal(snapshot.closed.length,1);
  assert.equal(snapshot.closed[0].exit.reason,'停止模拟平仓');
});

test('reverse paper mode starts with 30,000 U and takes the opposite side of both signals',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'paper-reverse-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.now();
  let now=start;
  const options={file:path.join(root,'reverse.json'),log:()=>{},quality:()=>null,funding:async()=>[],
    allMultiple:true,reverse:true,fetchDepth:async()=>({at:now,bids:[[99.9,10000]],asks:[[100.1,10000]]})};
  const make=(symbol,direction,volume)=>({symbol,apiSymbol:symbol,quoteVolume24h:volume,
    paperProduct:{unit:1,minQty:.001,step:.001},
    paperTrialHits:[{direction,closedAt:start-100,names:['第一形态','第二形态']}]});
  const markets=new Map([['UP',make('UP','up',10)],['DOWN',make('DOWN','down',5)]]);
  const ledger=createPaperTrader(options);
  const initial=ledger.snapshot(now);
  assert.equal(initial.balance,30000);
  assert.equal(initial.capitalTopUp,0);
  assert.equal(initial.config.maxPositions,30);
  for(let i=0;i<2;i++){
    now+=1000;
    ledger.advance(markets,now);
    await new Promise(resolve=>setImmediate(resolve));
  }
  const {open}=ledger.snapshot(now);
  assert.deepEqual(open.map(p=>[p.signalDirection,p.side]),[['up',-1],['down',1]]);
  assert.ok(open[0].entry<100&&open[1].entry>100);
  assert.ok(open.every(p=>p.id.startsWith('reverse-')));
});
