// Small localStorage wrapper — never throws, degrades to no-op if storage is
// unavailable (private browsing, disabled cookies, etc.)
const Storage = (() => {
  function ok() {
    try {
      const k = '__tm_test__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  const available = ok();

  function get(key, fallback) {
    if (!available) return fallback;
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function set(key, val) {
    if (!available) return;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  return { available, get, set };
})();
