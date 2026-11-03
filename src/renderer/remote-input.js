/* Shared pointer/keyboard press lifecycle. Captures the target so release never goes to another TV. */
(function (root) {
  function bindRemotePress(button, options) {
    const win = options.window || window;
    const doc = options.document || document;
    const later = options.setTimeout || setTimeout;
    const clear = options.clearTimeout || clearTimeout;
    let press = null;
    function finish(cancelled = false) {
      const active = press;
      if (!active) return;
      press = null;
      clear(active.timer);
      button.classList.remove('held');
      if (active.long) options.send(active.target, 'END_LONG');
      else if (!cancelled && !button.disabled && options.target() === active.target) options.send(active.target, 'SHORT');
      if (typeof active.pointer === 'number' && button.hasPointerCapture?.(active.pointer)) button.releasePointerCapture(active.pointer);
    }
    function begin(pointer) {
      if (press || button.disabled) return;
      const target = options.target();
      if (!target) return;
      const active = { target, pointer, long: false, timer: null };
      press = active;
      button.classList.add('held');
      active.timer = later(() => {
        if (press !== active) return;
        if (button.disabled || options.target() !== target) return finish(true);
        active.long = true;
        options.send(target, 'START_LONG');
      }, 400);
    }
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false || press || button.disabled) return;
      begin(event.pointerId);
      if (press) button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointerup', (event) => { if (press?.pointer === event.pointerId) finish(); });
    button.addEventListener('pointercancel', (event) => { if (press?.pointer === event.pointerId) finish(true); });
    button.addEventListener('lostpointercapture', (event) => { if (press?.pointer === event.pointerId) finish(true); });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) begin(event.key);
    });
    button.addEventListener('keyup', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (press?.pointer === event.key) finish();
    });
    // Assistive technology may activate a button without pointer or keyboard events.
    button.addEventListener('click', (event) => {
      if (event.detail === 0 && !press && !button.disabled) {
        const target = options.target();
        if (target) options.send(target, 'SHORT');
      }
    });
    button.addEventListener('blur', () => { if (press && typeof press.pointer === 'string') finish(true); });
    win.addEventListener('blur', () => finish(true));
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) finish(true); });
    return {
      cancel: () => finish(true),
      reconcile: () => { if (press && (button.disabled || options.target() !== press.target)) finish(true); },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { bindRemotePress };
  else root.bindRemotePress = bindRemotePress;
})(typeof window === 'undefined' ? globalThis : window);
