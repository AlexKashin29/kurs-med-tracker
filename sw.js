const CACHE = 'kurs-v2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// сеть → кэш-фолбэк: приложение работает офлайн
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

/* ---------- IndexedDB (зеркало данных приложения) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('kurs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('kv').objectStore('kv').get(k);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbSet(k, v) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/* ---------- push: сервер шлёт пустой сигнал, дозу вычисляем локально ---------- */
const FORMS = { tab: 'табл.', cap: 'капс.', drop: 'капли', ml: 'мл', inj: 'укол', other: 'приём' };
const dkey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dueDoses(db, now) {
  const k = dkey(now);
  const dow = (now.getDay() + 6) % 7;
  const winFrom = new Date(now.getTime() - 3 * 60000);
  const out = [];
  for (const m of db.meds || []) {
    const [y, mo, dd] = m.start.split('-').map(Number);
    const start = new Date(y, mo - 1, dd);
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d0 < start) continue;
    if (m.duration && Math.round((d0 - start) / 864e5) >= m.duration) continue;
    if (m.days && m.days.length && !m.days.includes(dow)) continue;
    for (const t of m.times) {
      const [h, mi] = t.split(':');
      const at = new Date(d0); at.setHours(+h, +mi, 0, 0);
      if (at < winFrom || at > now) continue;
      const key = `${m.id}|${t}`;
      if ((db.log?.[k] || {})[key]) continue; // уже отмечено
      out.push({ med: m, time: t, date: k, key });
    }
  }
  return out;
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const db = await idbGet('db').catch(() => null);
    const doses = db ? dueDoses(db, new Date()) : [];
    if (!doses.length) {
      // на push обязаны показать уведомление, даже если доза уже отмечена
      return self.registration.showNotification('Курс', {
        body: 'Время приёма лекарств — открой приложение', icon: 'icon.svg', badge: 'icon.svg', tag: 'kurs-generic',
      });
    }
    for (const d of doses) {
      await self.registration.showNotification(`${d.time} — ${d.med.name}`, {
        body: `${d.med.dose || ''} ${FORMS[d.med.form] || ''}`.trim() || 'Время приёма',
        icon: 'icon.svg', badge: 'icon.svg', tag: 'dose-' + d.key,
        requireInteraction: true,
        actions: [{ action: 'taken', title: '✓ Принял' }],
        data: { date: d.date, key: d.key },
      });
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    if (e.action === 'taken' && e.notification.data?.key) {
      const pending = (await idbGet('pending').catch(() => null)) || [];
      pending.push({ date: e.notification.data.date, key: e.notification.data.key, s: 't', at: Date.now() });
      await idbSet('pending', pending);
      const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) c.postMessage({ type: 'pending' });
      return;
    }
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('./');
  })());
});
