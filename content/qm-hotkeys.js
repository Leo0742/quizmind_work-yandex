((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.__QM = root.__QM || {};
    root.__QM.hotkeys = api;
  }
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  function match(event, shortcut) {
    if (!event || !shortcut) return false;
    const parts = String(shortcut).split('+').map((part) => part.trim());
    const needCtrl = parts.includes('Ctrl');
    const needShift = parts.includes('Shift');
    const needAlt = parts.includes('Alt');
    const main = parts[parts.length - 1];
    if (Boolean(event.ctrlKey || event.metaKey) !== needCtrl) return false;
    if (Boolean(event.shiftKey) !== needShift) return false;
    if (Boolean(event.altKey) !== needAlt) return false;
    let key;
    if (event.altKey && event.code) {
      if (event.code.startsWith('Key')) key = event.code.slice(3);
      else if (event.code.startsWith('Digit')) key = event.code.slice(5);
      else key = event.key?.length === 1 ? event.key.toUpperCase() : event.key;
    } else {
      key = event.key?.length === 1 ? event.key.toUpperCase() : event.key;
    }
    const names = { ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→', ' ':'Space' };
    return (names[key] || key) === main;
  }

  return { match };
});
