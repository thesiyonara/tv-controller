const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bindRemotePress } = require('../src/renderer/remote-input');
class Surface {
  constructor() { this.listeners = {}; this.disabled = false; this.hidden = false; this.classes = new Set(); this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c) }; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  fire(name, fields = {}) { const e = { button: 0, pointerId: 1, isPrimary: true, preventDefault() { this.prevented = true; }, ...fields }; for (const fn of this.listeners[name] || []) fn(e); return e; }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture() { this.captured = undefined; this.fire('lostpointercapture'); }
}
function setup() {
  const button = new Surface(), win = new Surface(), doc = new Surface(), sent = [], timers = new Map(); let target = 'tv-a', seq = 0;
  const binding = bindRemotePress(button, { window: win, document: doc, target: () => target, send: (...args) => sent.push(args), setTimeout: (fn) => { timers.set(++seq, fn); return seq; }, clearTimeout: (id) => timers.delete(id) });
  return { button, win, doc, sent, binding, target: (v) => target = v, hold: () => { for (const fn of [...timers.values()]) fn(); } };
}
test('tap sends one short press; subsequent pointer click does not duplicate it', () => {
  const t = setup(); t.button.fire('pointerdown'); t.button.fire('pointerup'); t.button.fire('click', { detail: 1 }); t.hold(); assert.deepEqual(t.sent, [['tv-a', 'SHORT']]); assert.equal(t.button.classes.size, 0);
});
test('hold sends balanced start/end even when released outside the button', () => {
  const t = setup(); t.button.fire('pointerdown'); t.button.fire('pointerleave'); t.hold(); assert.ok(t.button.classes.has('held')); t.button.fire('pointerup'); assert.deepEqual(t.sent, [['tv-a', 'START_LONG'], ['tv-a', 'END_LONG']]);
});
test('cancelled tap sends nothing', () => { const t = setup(); t.button.fire('pointerdown'); t.button.fire('pointercancel'); t.hold(); assert.deepEqual(t.sent, []); });
for (const reason of ['pointercancel', 'lostpointercapture', 'window blur', 'document hidden']) test(`held key releases on ${reason}`, () => {
  const t = setup(); t.button.fire('pointerdown'); t.hold();
  if (reason === 'window blur') t.win.fire('blur'); else if (reason === 'document hidden') { t.doc.hidden = true; t.doc.fire('visibilitychange'); } else t.button.fire(reason);
  t.button.fire('pointerup'); assert.deepEqual(t.sent, [['tv-a', 'START_LONG'], ['tv-a', 'END_LONG']]);
});
test('switching TVs releases the original TV and never presses the new one', () => {
  const t = setup(); t.button.fire('pointerdown'); t.hold(); t.target('tv-b'); t.binding.reconcile(); t.button.fire('pointerup'); assert.deepEqual(t.sent, [['tv-a', 'START_LONG'], ['tv-a', 'END_LONG']]);
});
test('switching targets before hold cancels the pending press', () => { const t = setup(); t.button.fire('pointerdown'); t.target('tv-b'); t.hold(); t.button.fire('pointerup'); assert.deepEqual(t.sent, []); });
test('disabling a held button releases it', () => { const t = setup(); t.button.fire('pointerdown'); t.hold(); t.button.disabled = true; t.binding.reconcile(); assert.deepEqual(t.sent, [['tv-a', 'START_LONG'], ['tv-a', 'END_LONG']]); });
test('secondary mouse and non-primary touch never send a key', () => { const t = setup(); t.button.fire('pointerdown', { button: 2 }); t.button.fire('pointerup', { button: 2 }); t.button.fire('pointerdown', { isPrimary: false }); t.hold(); assert.deepEqual(t.sent, []); });
test('another pointer cannot release the active hold', () => { const t = setup(); t.button.fire('pointerdown'); t.hold(); t.button.fire('pointerup', { pointerId: 2 }); assert.equal(t.sent.length, 1); t.button.fire('pointerup'); assert.equal(t.sent.length, 2); });
test('keyboard repeat is one held press and keyup releases it', () => { const t = setup(); t.button.fire('keydown', { key: ' ' }); t.button.fire('keydown', { key: ' ', repeat: true }); t.hold(); t.button.fire('keyup', { key: ' ' }); assert.deepEqual(t.sent, [['tv-a', 'START_LONG'], ['tv-a', 'END_LONG']]); });
test('keyboard focus loss cancels an uncommitted tap', () => { const t = setup(); t.button.fire('keydown', { key: 'Enter' }); t.button.fire('blur'); t.button.fire('keyup', { key: 'Enter' }); assert.deepEqual(t.sent, []); });
test('assistive activation sends a short press, disabled controls send nothing', () => { const t = setup(); t.button.fire('click', { detail: 0 }); t.button.disabled = true; t.button.fire('click', { detail: 0 }); t.button.fire('pointerdown'); t.hold(); assert.deepEqual(t.sent, [['tv-a', 'SHORT']]); });
