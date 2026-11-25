'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPro2Trades}=require('./pro2-trades');
class FakeWS{
  static list=[];
  constructor(url){this.url=url;this.readyState=0;this.handlers={};this.sent=[];FakeWS.list.push(this)}
  addEventListener(key,fn){(this.handlers[key]??=[]).push(fn)}
  send(v){this.sent.push(v)}
  emit(key,payload={}){for(const fn of this.handlers[key]||[])fn(payload)}
  opened(){this.readyState=1;this.emit('open')}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close',{code:1000})}
  message(data){this.emit('message',{data:JSON.stringify(data)})}
}
function setup(){
  const markets=new Map();
  for(let i=0;i<20;i++){
    const symbol=i===0?'BTCUSDT':i===19?'SKHYUSDT':'PAIR'+i+'USDT';
    markets.set(symbol,{symbol,exchange:'binance',apiSymbol:symbol,quoteVolume24h:100000000-i*1000000});
  }
  markets.set('OKX:BTC-USDT-SWAP',{symbol:'OKX:BTC-USDT-SWAP',exchange:'okx',contractType:'SWAP',apiSymbol:'BTC-USDT-SWAP',tradeUnitBase:.01,quoteVolume24h:50_000_000});
  const initial=globalThis.WebSocket;globalThis.WebSocket=FakeWS;FakeWS.list=[];
  const engine=createPro2Trades({markets,log:()=>{},stopped:()=>false});
  return {engine,restore(){engine.stop();globalThis.WebSocket=initial}};
}
test('Binance aggTrade uses new market-routed endpoint and counts real amount',()=>{
  const {engine,restore}=setup();try{
    engine._test.tick();const sock=FakeWS.list.find(s=>s.url.includes('btcusdt@aggTrade'));
    assert.ok(sock);assert.ok(sock.url.startsWith('wss://fstream.binance.com/market/stream?streams='));
    assert.equal(engine.getMicro('BTCUSDT').covered,false);
    sock.opened();assert.equal(engine.getMicro('BTCUSDT').ready,false);
    const at=Date.now();sock.message({stream:'btcusdt@aggTrade',data:{e:'aggTrade',s:'BTCUSDT',p:'65000',q:'20',T:at,m:false,a:1}});
    const micro=engine.getMicro('BTCUSDT');assert.equal(micro.covered,true);assert.equal(micro.ready,true);
    assert.equal(engine.getStats('BTCUSDT').buy,1300000);
    assert.equal(engine.getStats('BTCUSDT').sell,0);
    assert.ok(engine.health().receiving>0);
  }finally{restore()}
});
test('Opening a low-volume detail activates bounded real trade subscription',()=>{
 const {engine,restore}=setup();try{
  engine._test.tick();assert.equal(engine.getMicro('SKHYUSDT').covered,false);
  assert.equal(engine.watch('SKHYUSDT'),true);
  let sock=FakeWS.list.find(s=>s.url.includes('skhyusdt@aggTrade'));
  assert.ok(sock,'detail should create a watch socket for SKHYUSDT');sock.opened();
  sock.message({stream:'skhyusdt@aggTrade',data:{e:'aggTrade',s:'SKHYUSDT',p:'5',q:'22000',T:Date.now(),m:true,a:3}});
  assert.equal(engine.getMicro('SKHYUSDT').ready,true);
  assert.equal(engine.getStats('SKHYUSDT').buy,0);
  assert.equal(engine.getStats('SKHYUSDT').sell,0);
  assert.equal(engine.getMicro('SKHYUSDT').large30m.largeSellCount,1);
  // No forced reconnection of the dynamic socket while it is still connecting / open.
  const before=FakeWS.list.length;engine.watch('SKHYUSDT');engine._test.tick();assert.equal(FakeWS.list.length,before);
 }finally{restore()}
});
test('OKX trades use the public endpoint and correct contract notional',()=>{
 const {engine,restore}=setup();try{
  engine._test.tick();const sock=FakeWS.list.find(s=>s.url.includes('ws.okx.com'));assert.ok(sock);assert.ok(sock.url.endsWith('/ws/v5/public'));sock.opened();
  assert.match(sock.sent[0],/"channel":"trades"/);
  sock.message({event:'subscribe',arg:{channel:'trades',instId:'BTC-USDT-SWAP'}});
  sock.message({arg:{channel:'trades',instId:'BTC-USDT-SWAP'},data:[{px:'65000',sz:'2',side:'buy',ts:String(Date.now())}]});
  assert.equal(engine.getMicro('OKX:BTC-USDT-SWAP').ready,true);
  assert.equal(engine.getStats('OKX:BTC-USDT-SWAP').buy,0);
  assert.equal(engine.getStats('OKX:BTC-USDT-SWAP').covered,true);
 }finally{restore()}
});
test('Invalid timestamps cannot create fabricated flow and disconnected sockets are unavailable',()=>{
 const {engine,restore}=setup();try{
  engine._test.tick();const sock=FakeWS.list.find(s=>s.url.includes('btcusdt@aggTrade'));sock.opened();
  sock.message({data:{e:'aggTrade',s:'BTCUSDT',p:'50000',q:'100',T:Date.now()-300000,m:false}});
  assert.equal(engine.getMicro('BTCUSDT').ready,false);
  sock.close();assert.equal(engine.getMicro('BTCUSDT').covered,false);
  assert.equal(engine.getStats('BTCUSDT').covered,false);
 }finally{restore()}
});
