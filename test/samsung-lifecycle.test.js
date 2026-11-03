const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const http = require('node:http');
require('./helpers/electron-stub');

class Socket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  constructor() { super(); Socket.instances.push(this); }
  terminate() { this.terminated = true; this.emit('error', new Error('Handshake cancelled')); this.emit('close'); }
  close() { this.emit('close'); }
}
const originalLoad = Module._load;
Module._load = function(request, ...rest) { return request === 'ws' ? Socket : originalLoad.call(this, request, ...rest); };
const { SamsungDriver } = require('../dist/main/drivers/samsung');
Module._load = originalLoad;
const context = { id:'samsung:test', kind:'samsung', host:'192.0.2.1', port:8002, name:'Test TV', appVersion:'test' };
function fixture() {
  const originalGet = http.get;
  const requests = [];
  http.get = (_url, _opts, callback) => {
    const req = new EventEmitter();
    requests.push(() => { const res = new EventEmitter(); callback(res); res.emit('data', Buffer.from('{"device":{"modelName":"Test"}}')); res.emit('end'); });
    return req;
  };
  const driver = new SamsungDriver(context);
  // These tests exercise connection lifecycle only, not HTTP polling.
  driver.startVolumePoll = driver.startPowerPoll = driver.startAppPoll = () => {};
  return { driver, requests, restore: () => { http.get = originalGet; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Samsung only asks for Allow after its websocket opens', async () => {
  const f = fixture(); let prompts = 0;
  f.driver.on('pairingRequested', () => prompts++);
  try {
    const pending = f.driver.connect(); f.requests[0](); await flush();
    const ws = Socket.instances.at(-1);
    assert.equal(f.driver.state.state, 'connecting'); assert.equal(prompts, 0);
    ws.readyState = Socket.OPEN; ws.emit('open');
    assert.equal(f.driver.state.state, 'pairing'); assert.equal(prompts, 1);
    ws.emit('message', Buffer.from('{"event":"ms.channel.connect"}'));
    await pending; assert.equal(f.driver.state.state, 'connected');
  } finally { await f.driver.disconnect(); f.restore(); }
});
test('cancelling a pending Samsung websocket settles without uncaught errors', async () => {
  const f = fixture();
  try {
    const pending = f.driver.connect(); f.requests[0](); await flush();
    const ws = Socket.instances.at(-1);
    await f.driver.disconnect(); await pending;
    assert.equal(ws.terminated, true); assert.equal(f.driver.state.state, 'disconnected');
    assert.equal(f.driver.reconnectTimer, undefined); assert.equal(f.driver.cancelOpen, undefined);
  } finally { await f.driver.disconnect(); f.restore(); }
});
test('a late Samsung device-info response cannot reconnect after disconnect', async () => {
  const f = fixture(); const before = Socket.instances.length;
  try {
    const pending = f.driver.connect(); await f.driver.disconnect();
    f.requests[0](); await pending;
    assert.equal(Socket.instances.length, before); assert.equal(f.driver.state.state, 'disconnected');
    assert.equal(f.driver.state.model, undefined);
  } finally { await f.driver.disconnect(); f.restore(); }
});
test('an older Samsung info request cannot replace a newer connection', async () => {
  const f = fixture();
  try {
    const old = f.driver.connect(); await f.driver.disconnect();
    const current = f.driver.connect(); f.requests[1](); await flush();
    const ws = Socket.instances.at(-1);
    ws.readyState = Socket.OPEN; ws.emit('open'); ws.emit('message', Buffer.from('{"event":"ms.channel.connect"}'));
    await current; const count = Socket.instances.length;
    f.requests[0](); await old;
    assert.equal(Socket.instances.length, count); assert.equal(f.driver.state.state, 'connected');
    assert.equal(f.driver.ws, ws);
  } finally { await f.driver.disconnect(); f.restore(); }
});
