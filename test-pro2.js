'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {STEP,normBinance,normOkx,analyzeBars,createPro2}=require('./pro2-engine');
const t=STEP*4000;
const bar=(i,base=100)=>({t:t+i*STEP,o:base,h:base+2,l:base-2,c:base+1,v:100,closed:true});
const now=t+64*STEP+6000;
test('Binance and OKX 2H candles reject open / invalid bars',()=>{
  const raw=[t,'100','104','98','101','200',t+STEP-1,'1','3','150'];
  assert.ok(normBinance(raw,t+STEP+6000));
  assert.equal(normBinance(raw,t+STEP-3000),null);
  assert.equal(normBinance([t,'100','96','98','101','200',t+STEP-1],now),null);
  assert.ok(normOkx([String(t),'100','104','98','101','200','','','1'],t+STEP+6000));
  assert.equal(normOkx([String(t),'100','104','98','101','200','','','0'],now),null);
});
test('2H scanner requires 20 consecutive closed candles and fresh expected close',()=>{
  const rows=Array.from({length:64},(_,i)=>bar(i));
  const a=analyzeBars(rows,now);
  assert.equal(a.ready,true);
  assert.ok(a.volumeRatio===1);
  assert.ok(a.matches.every(x=>x.period===120));
  const unclosed=analyzeBars(rows.slice(0,-1),now);
  assert.equal(unclosed.ready,false);
  const broken=analyzeBars([...rows.slice(0,50),...rows.slice(54)],now);
  assert.equal(broken.ready,false);
});
test('snapshot and detail use the 120-minute source only',()=>{
  const markets=new Map([['BTCUSDT',{symbol:'BTCUSDT',displaySymbol:'BTCUSDT',apiSymbol:'BTCUSDT',exchange:'binance',exchangeLabel:'币安U本位',price:100,priceAt:now,quoteVolume24h:1e8,change24h:1,
    pro2:{...analyzeBars(Array.from({length:64},(_,i)=>bar(i)),now),rows:Array.from({length:64},(_,i)=>bar(i))}}]]);
  const scanner=createPro2({markets,json:async()=>[],binance:'https://example.com',okx:'https://example.com',log:()=>{},stopped:()=>true,dataDir:'/tmp'});
  const d=scanner.detail('BTCUSDT');
  assert.equal(d.symbol,'BTCUSDT');
  assert.equal(d.charts[120].length,64);
  const s=scanner.snapshot();
  assert.equal(s.intervalMinutes,120);
  assert.equal(s.counts.eligible,1);
});
