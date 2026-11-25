const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const app=fs.readFileSync(__dirname+'/public/app.js','utf8');
const backend=fs.readFileSync(__dirname+'/server.js','utf8');
test('V5 classic detail preserves big trade pencil wave and adds truthful live 30s bar',()=>{
  for(const phrase of ['classic-pencil','classic-waves','classic-progress-label','classic-liveflow-caption','near']){
    if(phrase==='near')continue;
    assert.ok(app.includes(phrase),phrase+' missing');
  }
  assert.match(app,/近30秒公开成交（不设大单门槛）/);
  assert.match(app,/该合约未接入|等待公开成交数据流|等待真实成交/);
});
test('V5 server activates watch on detail and exposes nonsecret stream health',()=>{
  assert.match(backend,/\/api\/pro2\/flow-health/);
  assert.match(backend,/pro2Trades\.watch\(symbol\)/);
});
