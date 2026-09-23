// ─── TaskFlo Admin Dashboard (static, Firebase REST, no SDK) ───
(function () {
  'use strict';
  const CFG = window.TF_ADMIN_CFG || {};
  const SESS_KEY = 'tfAdminSession';
  let session = null;
  let usersCache = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function err(m) { const e = $('dashErr'); if (e) { e.textContent = m; e.style.display = 'block'; } }
  function ok(m) { const e = $('dashOk'); if (e) { e.textContent = m; e.style.display = 'block'; setTimeout(() => { e.style.display = 'none'; }, 3000); } }
  function clearMsg() { const e = $('dashErr'); if (e) e.style.display = 'none'; }
  function base() { return 'https://firestore.googleapis.com/v1/projects/' + CFG.projectId + '/databases/(default)/documents'; }
  function fv(v) {
    if (!v) return '';
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    return '';
  }
  function fmtDT(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return String(iso).slice(0, 16); }
  }
  function todayKey(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  async function fb(path, opts) {
    const res = await fetch(base() + path, opts);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const em = (j && j.error && j.error.message) || res.status;
      throw new Error(em);
    }
    return j;
  }
  function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.idToken };
  }

  // ─── Auth ───
  async function login(email, password) {
    const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + CFG.apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j && j.error && j.error.message) || res.status);
    if (j.localId !== CFG.ADMIN_UID && String(email).toLowerCase() !== String(CFG.ADMIN_EMAIL).toLowerCase()) {
      throw new Error('الحساب ده مش أدمن');
    }
    session = { uid: j.localId, email: j.email || email, idToken: j.idToken, refreshToken: j.refreshToken };
    try { localStorage.setItem(SESS_KEY, JSON.stringify(session)); } catch (e) {}
    return session;
  }
  function logout() {
    session = null;
    try { localStorage.removeItem(SESS_KEY); } catch (e) {}
    showLogin();
  }
  function showLogin() {
    $('viewLogin').classList.remove('hidden');
    $('viewDash').classList.add('hidden');
  }
  function showDash() {
    $('viewLogin').classList.add('hidden');
    $('viewDash').classList.remove('hidden');
    $('adminEmailLine').textContent = session.email;
    refreshAll();
  }

  // ─── Users + subscriptions ───
  async function listUsers() {
    const j = await fb('/documents:runQuery', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'profile', allDescendants: true }],
        limit: 200
      } })
    });
    return (Array.isArray(j) ? j : []).filter(x => x && x.document).map(x => {
      const parts = String(x.document.name || '').split('/');
      const i = parts.indexOf('users');
      const f = x.document.fields || {};
      return { uid: i >= 0 ? parts[i + 1] : '', email: fv(f.email), updatedAt: fv(f.updatedAt) };
    }).filter(u => u.uid).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  async function getSub(uid) {
    try {
      const j = await fb('/users/' + encodeURIComponent(uid) + '/meta/subscription', { headers: authHeaders() });
      const f = (j && j.fields) || {};
      return { plan: fv(f.plan) || 'مجاني', expiresAt: fv(f.expiresAt) || '', active: f.active ? !!fv(f.active) : true };
    } catch (e) {
      if (/404|NOT_FOUND/i.test(e.message)) return null;
      throw e;
    }
  }
  async function setSub(uid, sub) {
    await fb('/users/' + encodeURIComponent(uid) + '/meta/subscription', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ fields: {
        plan: { stringValue: String(sub.plan || 'مجاني') },
        expiresAt: { stringValue: String(sub.expiresAt || '') },
        active: { booleanValue: !!sub.active },
        updatedAt: { stringValue: new Date().toISOString() }
      } })
    });
  }
  async function getTaskCount(uid) {
    try {
      const j = await fb('/users/' + encodeURIComponent(uid) + '/data/main', { headers: authHeaders() });
      const f = (j && j.fields) || {};
      const payload = f.payload && f.payload.stringValue;
      if (!payload) return 0;
      const obj = JSON.parse(payload);
      const d = obj.data || obj;
      return Array.isArray(d.tasks) ? d.tasks.length : 0;
    } catch (e) { return null; }
  }
  function subBadge(sub) {
    if (!sub) return '<span class="badge b-mut">كامل (بدون قيد)</span>';
    const expired = sub.expiresAt && new Date(sub.expiresAt).getTime() <= Date.now();
    if (sub.active === false || expired) return '<span class="badge b-no">⛔ ' + esc(sub.plan || '') + ' منتهي</span>';
    return '<span class="badge b-ok">✅ ' + esc(sub.plan || '') + '</span>';
  }
  async function renderUsers(filter) {
    const body = $('usersBody');
    body.innerHTML = '<tr><td colspan="5">⏳ جاري التحميل...</td></tr>';
    try {
      const users = await listUsers();
      usersCache = users;
      const q = (filter || '').trim().toLowerCase();
      const rows = users.filter(u => !q || String(u.email || '').toLowerCase().includes(q) || u.uid.includes(q));
      // stats
      $('stUsers').textContent = users.length;
      $('stActive').textContent = users.filter(u => String(u.updatedAt || '').slice(0, 10) === todayKey()).length;
      // per-user sub + tasks (parallel, best-effort)
      const infos = await Promise.all(rows.map(async (u) => {
        let sub = null, tc = null;
        try { sub = await getSub(u.uid); } catch (e) {}
        try { tc = await getTaskCount(u.uid); } catch (e) {}
        return { u, sub, tc };
      }));
      let activeSubs = 0, totalTasks = 0;
      infos.forEach(x => {
        if (x.sub && x.sub.active !== false && !(x.sub.expiresAt && new Date(x.sub.expiresAt).getTime() <= Date.now())) activeSubs++;
        if (typeof x.tc === 'number') totalTasks += x.tc;
      });
      $('stSubs').textContent = activeSubs;
      $('stTasks').textContent = totalTasks;
      body.innerHTML = '';
      if (!infos.length) body.innerHTML = '<tr><td colspan="5">لا نتائج</td></tr>';
      infos.forEach((x, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><b>' + esc(x.u.email || x.u.uid.slice(0, 8)) + '</b><br><code class="dir">' + esc(x.u.uid.slice(0, 12)) + '…</code></td>' +
          '<td>' + esc(fmtDT(x.u.updatedAt)) + '</td>' +
          '<td>' + (x.tc === null ? '—' : x.tc) + '</td>' +
          '<td class="subcell">' + subBadge(x.sub) + (x.sub && x.sub.expiresAt ? '<br><span style="font-size:11px;color:var(--muted)">حتى ' + esc(fmtDT(x.sub.expiresAt)) + '</span>' : '') + '</td>' +
          '<td class="row-view"><button class="btn ghost sm" data-edit>⚙️</button></td>' +
          '<td class="row-edit"><select data-plan style="margin-bottom:6px"><option>مجاني</option><option>شهري</option><option>سنوي</option><option>مدى الحياة</option></select>' +
          '<input data-exp type="datetime-local" style="margin-bottom:6px" />' +
          '<label style="font-size:12px"><input data-act type="checkbox" checked /> مفعّل</label> ' +
          '<button class="btn sm" data-save>💾 حفظ</button></td>';
        const plan = tr.querySelector('[data-plan]'), exp = tr.querySelector('[data-exp]'), act = tr.querySelector('[data-act]');
        if (x.sub) {
          if (['مجاني', 'شهري', 'سنوي', 'مدى الحياة'].includes(x.sub.plan)) plan.value = x.sub.plan;
          try { if (x.sub.expiresAt) exp.value = new Date(x.sub.expiresAt).toISOString().slice(0, 16); } catch (e) {}
          act.checked = x.sub.active !== false;
        }
        tr.querySelector('[data-edit]').addEventListener('click', () => tr.classList.add('editing'));
        tr.querySelector('[data-save]').addEventListener('click', async () => {
          try {
            let ex = exp.value ? new Date(exp.value).toISOString() : '';
            if (plan.value === 'مدى الحياة') ex = '2099-12-31T00:00:00.000Z';
            await setSub(x.u.uid, { plan: plan.value, expiresAt: ex, active: act.checked });
            ok('💾 حُفظ اشتراك ' + (x.u.email || x.u.uid.slice(0, 8)));
            renderUsers($('userSearch').value);
          } catch (e) { err('❌ ' + e.message); }
        });
        body.appendChild(tr);
        void idx;
      });
    } catch (e) { err('❌ ' + e.message); }
  }

  // ─── Announcements ───
  async function listAds() {
    const j = await fb('/documents/announcements', { headers: authHeaders() }).catch(() => ({}));
    return ((j && j.documents) || []).map(d => {
      const f = d.fields || {};
      return { id: String(d.name || '').split('/').pop(), title: fv(f.title), kind: fv(f.kind) || 'image', content: fv(f.content), active: f.active ? !!fv(f.active) : true };
    });
  }
  async function renderAds() {
    const list = $('adsList');
    list.innerHTML = '⏳...';
    try {
      const ads = await listAds();
      list.innerHTML = ads.length ? '' : '<div style="color:var(--muted);font-size:13px">لا إعلانات</div>';
      ads.forEach(a => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px';
        row.innerHTML = '<div style="flex:1"><b>' + (a.kind === 'image' ? '🖼️' : a.kind === 'video' ? '🎬' : '🧩') + ' ' + esc(a.title || '(بدون عنوان)') + '</b><br><span style="color:var(--muted);font-size:11px">' + esc(String(a.content || '').slice(0, 60)) + '</span></div>';
        const tg = document.createElement('button');
        tg.className = 'btn ghost sm';
        tg.textContent = a.active ? 'إخفاء' : 'إظهار';
        tg.addEventListener('click', async () => {
          try {
            await fb('/documents/announcements/' + encodeURIComponent(a.id), { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ fields: { active: { booleanValue: !a.active } } }) });
            renderAds();
          } catch (e) { err('❌ ' + e.message); }
        });
        const del = document.createElement('button');
        del.className = 'btn danger sm';
        del.textContent = 'حذف';
        del.addEventListener('click', async () => {
          if (!confirm('حذف الإعلان؟')) return;
          try {
            await fb('/documents/announcements/' + encodeURIComponent(a.id), { method: 'DELETE', headers: authHeaders() });
            renderAds();
          } catch (e) { err('❌ ' + e.message); }
        });
        row.appendChild(tg);
        row.appendChild(del);
        list.appendChild(row);
      });
    } catch (e) { err('❌ ' + e.message); }
  }
  async function refreshAll() {
    clearMsg();
    await renderUsers($('userSearch').value);
    await renderAds();
  }

  // ─── Boot ───
  document.getElementById('btnLogin').addEventListener('click', async () => {
    const le = $('loginErr');
    le.style.display = 'none';
    try {
      await login($('loginEmail').value.trim(), $('loginPass').value);
      showDash();
    } catch (e) { le.textContent = '❌ ' + e.message; le.style.display = 'block'; }
  });
  $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnLogin').click(); });
  document.getElementById('btnLogout').addEventListener('click', logout);
  document.getElementById('btnRefresh').addEventListener('click', refreshAll);
  $('userSearch').addEventListener('input', () => renderUsers($('userSearch').value));
  document.getElementById('btnAdAdd').addEventListener('click', async () => {
    try {
      const title = $('adTitle').value.trim(), kind = $('adKind').value, content = $('adContent').value.trim();
      if (!content) { err('⚠️ اكتب الرابط أو الكود'); return; }
      if (kind !== 'code' && !/^\s*https:\/\//i.test(content)) { err('⚠️ الرابط لازم يبدأ بـ https://'); return; }
      await fb('/documents/announcements', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ fields: {
          title: { stringValue: title }, kind: { stringValue: kind }, content: { stringValue: content },
          active: { booleanValue: true }, updatedAt: { stringValue: new Date().toISOString() }
        } })
      });
      $('adTitle').value = '';
      $('adContent').value = '';
      ok('📢 اتنشر الإعلان');
      renderAds();
    } catch (e) { err('❌ ' + e.message); }
  });

  window.TaskfloAdminDash = { login, listUsers };
  try {
    const s = localStorage.getItem(SESS_KEY);
    if (s) {
      session = JSON.parse(s);
      if (session && (session.uid === CFG.ADMIN_UID || String(session.email || '').toLowerCase() === String(CFG.ADMIN_EMAIL).toLowerCase())) showDash();
      else { session = null; showLogin(); }
    } else showLogin();
  } catch (e) { showLogin(); }
})();
