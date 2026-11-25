'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const html=readFileSync('./public/index.html','utf8');
const js=readFileSync('./public/app.js','utf8');
const css=readFileSync('./public/style.css','utf8');
test('V4 still loads the 2H scanner, not an old 15m frontend',()=>{
 assert.match(html,/MARKET INTELLIGENCE \/ PRO 2H/);
 assert.match(js,/intervalMinutes!==120/);
 assert.match(js,/api\/pro2\/detail/);
});
test('classic mobile dialog is connected to row selection and close control',()=>{
 assert.match(html,/id="classicBackdrop"/);
 assert.match(html,/id="classicClose"/);
 assert.match(js,/openClassicModal\(\);void refreshDetail\(\)/);
 assert.match(js,/closeClassicModal/);
});
test('live buy/sell progress uses record counts and the screenshot wave and pencil',()=>{
 assert.match(js,/classicBar\(valid\?buy:0,valid\?sell:0/);
 assert.match(js,/classic-progress-green/);
 assert.match(js,/classic-progress-red/);
 assert.match(js,/classic-pencil/);
 assert.match(js,/classic-waves/);
 assert.match(css,/classic-waves/);
});
