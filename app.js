// Demo Stock frontend — no build step, plain JS.
// Auth: GET /api/me returns { authenticated, canEdit, authMode }.
//  - gate (default): unauthenticated -> login screen only, nothing readable.
//  - readonly: unauthenticated -> can read, cannot edit; backend blocks
//    every write with 401, the frontend only hides the buttons as well.
// canEdit is the single source of truth for showing edit UI. The password
// itself is never stored (no localStorage password) — login sets an
// httpOnly cookie that lasts 30 days, so the 2nd visit needs no password.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    items: [], movements: [], canEdit: false, authenticated: false,
    authMode: 'gate', tab: 'items', filterStorage: 'all', filterStatus: 'all',
    query: '', editingCode: null, qtyCode: null, scannerStream: null,
  };

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.message || data.error || `HTTP ${res.status}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function showError(msg) {
    const el = $('error-banner');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }

  function setCounts() {
    const total = state.items.length;
    const c1 = state.items.filter((i) => (i.storage || '').includes('1F')).length;
    const c2 = state.items.filter((i) => (i.storage || '').includes('2F')).length;
    const low = state.items.filter((i) => i.lowStock !== null && i.lowStock !== undefined && i.qty <= i.lowStock).length;
    const shelf = state.items.filter((i) => i.shelfStatus === '補貨架').length;
    $('count-total').textContent = total;
    $('count-1f').textContent = c1;
    $('count-2f').textContent = c2;
    $('count-low').textContent = low;
    $('count-shelf').textContent = shelf;
  }

  function isLow(item) {
    return item.lowStock !== null && item.lowStock !== undefined && item.qty <= item.lowStock;
  }

  function filteredItems() {
    const q = state.query.trim().toLowerCase();
    return state.items.filter((it) => {
      if (state.filterStorage === '1F' && !(it.storage || '').includes('1F')) return false;
      if (state.filterStorage === '2F' && !(it.storage || '').includes('2F')) return false;
      if (state.filterStorage === 'unassigned' && ((it.storage || '').includes('1F') || (it.storage || '').includes('2F'))) return false;
      if (state.filterStatus === 'low' && !isLow(it)) return false;
      if (state.filterStatus === 'shelf' && it.shelfStatus !== '補貨架') return false;
      if (!q) return true;
      return [it.code, it.zhName, it.enName, it.barcode, it.packing]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderItems() {
    setCounts();
    const list = filteredItems();
    const el = $('items-list');
    $('empty-state').hidden = list.length !== 0;
    el.innerHTML = list.map((it) => {
      const badges = [
        it.storage ? `<span class="badge storage">${esc(it.storage)}</span>` : '',
        isLow(it) ? `<span class="badge low">低存量（≤ ${esc(it.lowStock)}）</span>` : '',
        it.shelfStatus === '補貨架' ? '<span class="badge shelf">補貨架</span>' : '',
      ].join('');
      // Edit buttons are rendered only when canEdit — and the backend
      // re-checks the session on every write anyway.
      const actions = state.canEdit ? `
        <div class="item-actions">
          <button class="btn" data-act="qty" data-code="${esc(it.code)}">入貨 / 出貨</button>
          <button class="btn" data-act="edit" data-code="${esc(it.code)}">編輯</button>
          <button class="btn" data-act="shelf" data-code="${esc(it.code)}">${it.shelfStatus === '補貨架' ? '已補好' : '要補貨架'}</button>
          <button class="btn danger" data-act="delete" data-code="${esc(it.code)}">刪除</button>
        </div>` : '';
      return `<article class="item-card">
        <div class="item-head">
          <div><span class="item-code">${esc(it.code)}</span>
            <div class="item-name">${esc(it.zhName || it.enName || '（未命名）')}${it.enName && it.zhName ? ` <span class="en">${esc(it.enName)}</span>` : ''}</div>
          </div>
          <div class="item-qty">${esc(it.qty)} ${esc(it.unit || '')}</div>
        </div>
        <div class="item-meta">${esc(it.packing || '')}${it.barcode ? ` · 條碼 ${esc(it.barcode)}` : ''}</div>
        <div>${badges}</div>
        ${it.remark ? `<div class="item-meta">備註：${esc(it.remark)}</div>` : ''}
        ${actions}
      </article>`;
    }).join('');
  }

  function renderMovements() {
    const el = $('movements-list');
    el.innerHTML = state.movements.map((m) => `
      <div class="mv-row">
        <div><strong>${esc(m.name || m.code)}</strong>
          <div class="muted small">${esc(m.date)} · ${esc(m.kind)}${m.note ? ` · ${esc(m.note)}` : ''}</div>
        </div>
        <div style="text-align:right">
          <span class="mv-delta ${m.delta >= 0 ? 'pos' : 'neg'}">${m.delta > 0 ? '+' : ''}${esc(m.delta)}</span>
          ${state.canEdit ? `<div><button class="btn" data-mv="${esc(m.id)}">改</button></div>` : ''}
        </div>
      </div>`).join('') || '<p class="muted">暫時未有出入記錄。</p>';
  }

  async function loadItems() {
    try {
      const data = await api('/api/items');
      state.items = data.items || [];
      showError('');
      renderItems();
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      showError('讀唔到 Google Sheet：' + e.message + '。而家顯示嘅唔係最新數據，唔好憑舊數據改貨。');
      state.items = [];
      renderItems();
    }
  }

  async function loadMovements() {
    try {
      const data = await api('/api/movements');
      state.movements = data.movements || [];
      renderMovements();
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      $('movements-list').innerHTML = '<p class="error">讀唔到出入記錄：' + esc(e.message) + '</p>';
    }
  }

  async function loadStatus() {
    try {
      const s = await api('/api/status');
      $('status-line').textContent = s.connected
        ? `共 ${s.total} 隻貨${s.lastUpdated ? ` · 最後更新 ${s.lastUpdated}（Winnipeg）` : ''}`
        : 'Google Sheet 連唔到 — 未有最新數據';
    } catch { $('status-line').textContent = '狀態讀唔到'; }
  }

  function applyAuthUI() {
    // canEdit drives all edit UI. In readonly mode unauthenticated users
    // still see the list, with an "入密碼先可以改" button.
    $('add-btn').hidden = !state.canEdit;
    $('logout-btn').hidden = !state.authenticated;
    $('edit-mode-btn').hidden = state.authenticated;
    $('edit-mode-btn').textContent = '入密碼先可以改';
    if (state.authMode === 'gate' && !state.authenticated) { showLogin(); return; }
    $('login-view').hidden = true;
    $('app-view').hidden = false;
  }

  function showLogin() {
    $('app-view').hidden = true;
    $('login-view').hidden = false;
    $('password').focus();
  }

  async function refreshAuth() {
    try {
      const me = await api('/api/me');
      state.authenticated = !!me.authenticated;
      state.canEdit = !!me.canEdit;
      state.authMode = me.authMode || 'gate';
    } catch {
      state.authenticated = false; state.canEdit = false; state.authMode = 'gate';
    }
    applyAuthUI();
  }

  // ---- item dialogs ----
  function openItemDialog(item) {
    if (!state.canEdit) return;
    state.editingCode = item ? item.code : null;
    $('item-dialog-title').textContent = item ? `編輯 ${item.code}` : '加貨品';
    $('f-code-current').value = item ? item.code : '';
    $('f-code').value = item ? item.code : '';
    $('f-zh').value = item ? item.zhName : '';
    $('f-en').value = item ? item.enName : '';
    $('f-packing').value = item ? item.packing : '';
    $('f-barcode').value = item ? item.barcode : '';
    $('f-source').value = item ? item.source : '';
    $('f-qty').value = item ? item.qty : 0;
    $('f-unit').value = item ? item.unit : '';
    $('f-storage').value = item ? (item.storage || '冷凍 1F') : '冷凍 1F';
    $('f-low').value = item && item.lowStock !== null && item.lowStock !== undefined ? item.lowStock : '';
    $('f-shelf').value = item ? item.shelfStatus : 'ok';
    $('f-remark').value = item ? item.remark : '';
    $('item-form-error').hidden = true;
    $('item-dialog').showModal();
  }

  function openQtyDialog(code) {
    if (!state.canEdit) return;
    const it = state.items.find((i) => i.code === code);
    if (!it) return;
    state.qtyCode = code;
    $('qty-title').textContent = `${it.code} — ${it.zhName || it.enName}`;
    $('qty-current').textContent = `而家數量：${it.qty} ${it.unit || ''}`;
    $('qty-set').value = it.qty;
    $('qty-note').value = '';
    $('qty-error').hidden = true;
    $('qty-dialog').showModal();
  }

  // ---- barcode scan ----
  async function startScanner() {
    $('scanner').hidden = false;
    const video = $('scanner-video');
    try {
      if (!('BarcodeDetector' in window)) throw new Error('no-detector');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      state.scannerStream = stream;
      video.srcObject = stream;
      await video.play();
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
      const tick = async () => {
        if ($('scanner').hidden) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) { onScanned(codes[0].rawValue); return; }
        } catch { /* keep trying */ }
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Fallback: photo upload decode via ZXing (CDN), or manual entry.
      $('scan-file').focus();
    }
  }

  function stopScanner() {
    if (state.scannerStream) { state.scannerStream.getTracks().forEach((t) => t.stop()); state.scannerStream = null; }
    $('scanner').hidden = true;
  }

  async function onScanned(value) {
    stopScanner();
    state.query = String(value || '').trim();
    $('search').value = state.query;
    renderItems();
    if (filteredItems().length === 0) showError(`掃到條碼 ${state.query}，但倉入面搵唔到呢隻貨。`);
  }

  async function decodePhoto(file) {
    try {
      const ZXing = window.ZXingBrowser;
      if (!ZXing) throw new Error('ZXing 未載入');
      const reader = new ZXing.BrowserMultiFormatReader();
      const url = URL.createObjectURL(file);
      try {
        const result = await reader.decodeFromImageUrl(url);
        await onScanned(result.getText());
      } finally { URL.revokeObjectURL(url); }
    } catch (e) { showError('呢張相解唔到條碼，請再影過或者手動輸入。' + e.message); }
  }

  // ---- events ----
  document.addEventListener('DOMContentLoaded', async () => {
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('login-error').hidden = true;
      try {
        await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
        $('password').value = '';
        await refreshAuth();
        await loadItems(); await loadMovements(); await loadStatus();
      } catch (err) {
        $('login-error').hidden = false;
        if (err.status !== 401) $('login-error').textContent = '登入唔到：' + err.message;
      }
    });
    $('logout-btn').addEventListener('click', async () => {
      try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
      state.authenticated = false; state.canEdit = false;
      await refreshAuth();
    });
    $('edit-mode-btn').addEventListener('click', () => showLogin());

    $('search').addEventListener('input', (e) => { state.query = e.target.value; renderItems(); });
    $('scan-btn').addEventListener('click', startScanner);
    $('scan-close').addEventListener('click', stopScanner);
    $('scan-file').addEventListener('change', (e) => { if (e.target.files[0]) decodePhoto(e.target.files[0]); });

    document.querySelectorAll('[data-filter-storage]').forEach((b) => b.addEventListener('click', () => {
      state.filterStorage = b.dataset.filterStorage;
      document.querySelectorAll('[data-filter-storage]').forEach((x) => x.classList.toggle('active', x === b));
      renderItems();
    }));
    document.querySelectorAll('[data-filter-status]').forEach((b) => b.addEventListener('click', () => {
      state.filterStatus = b.dataset.filterStatus;
      document.querySelectorAll('[data-filter-status]').forEach((x) => x.classList.toggle('active', x === b));
      renderItems();
    }));

    $('tab-items').addEventListener('click', () => {
      state.tab = 'items';
      $('tab-items').classList.add('active'); $('tab-movements').classList.remove('active');
      $('items-list').hidden = false; $('movements-list').hidden = true;
    });
    $('tab-movements').addEventListener('click', () => {
      state.tab = 'movements';
      $('tab-movements').classList.add('active'); $('tab-items').classList.remove('active');
      $('items-list').hidden = true; $('movements-list').hidden = false;
      loadMovements();
    });

    $('add-btn').addEventListener('click', () => openItemDialog(null));
    $('item-cancel').addEventListener('click', () => $('item-dialog').close());
    $('item-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        code: $('f-code').value.trim(),
        zhName: $('f-zh').value.trim(), enName: $('f-en').value.trim(),
        packing: $('f-packing').value.trim(), barcode: $('f-barcode').value.trim(),
        source: $('f-source').value.trim(), qty: Number($('f-qty').value || 0),
        unit: $('f-unit').value, storage: $('f-storage').value,
        lowStock: $('f-low').value === '' ? null : Number($('f-low').value),
        shelfStatus: $('f-shelf').value, remark: $('f-remark').value.trim(),
      };
      try {
        if (state.editingCode) {
          // ALWAYS send the explicit current code, even if unchanged.
          await api('/api/update-item', { method: 'PUT', body: JSON.stringify({ ...payload, code: state.editingCode, newCode: payload.code || state.editingCode }) });
        } else {
          await api('/api/items', { method: 'POST', body: JSON.stringify(payload) });
        }
        $('item-dialog').close();
        await loadItems(); await loadStatus();
      } catch (err) {
        const el = $('item-form-error'); el.hidden = false; el.textContent = err.message;
        if (err.status === 401) showLogin();
      }
    });

    $('items-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !state.canEdit) return;
      const code = btn.dataset.code;
      const act = btn.dataset.act;
      if (act === 'edit') openItemDialog(state.items.find((i) => i.code === code));
      if (act === 'qty') openQtyDialog(code);
      if (act === 'shelf') {
        const it = state.items.find((i) => i.code === code);
        try {
          await api('/api/shelf-status', { method: 'POST', body: JSON.stringify({ code, shelfStatus: it.shelfStatus === '補貨架' ? 'ok' : '補貨架' }) });
          await loadItems();
        } catch (err) { showError(err.message); }
      }
      if (act === 'delete') {
        if (!confirm(`真係要刪除 ${code}？出入記錄會保留。`)) return;
        try {
          await api('/api/delete-item', { method: 'DELETE', body: JSON.stringify({ code }) });
          await loadItems(); await loadStatus();
        } catch (err) { showError(err.message); }
      }
    });

    $('qty-minus').addEventListener('click', async () => {
      try {
        await api('/api/adjust', { method: 'POST', body: JSON.stringify({ code: state.qtyCode, delta: -1, kind: 'out' }) });
        await loadItems(); openQtyDialog(state.qtyCode);
      } catch (err) { const el = $('qty-error'); el.hidden = false; el.textContent = err.message; }
    });
    $('qty-plus').addEventListener('click', async () => {
      try {
        await api('/api/adjust', { method: 'POST', body: JSON.stringify({ code: state.qtyCode, delta: 1, kind: 'in' }) });
        await loadItems(); openQtyDialog(state.qtyCode);
      } catch (err) { const el = $('qty-error'); el.hidden = false; el.textContent = err.message; }
    });
    $('qty-cancel').addEventListener('click', () => $('qty-dialog').close());
    $('qty-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/set-quantity', { method: 'POST', body: JSON.stringify({ code: state.qtyCode, qty: Number($('qty-set').value), note: $('qty-note').value.trim() }) });
        $('qty-dialog').close();
        await loadItems(); await loadStatus();
      } catch (err) { const el = $('qty-error'); el.hidden = false; el.textContent = err.message; }
    });

    $('movements-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mv]');
      if (!btn || !state.canEdit) return;
      const mv = state.movements.find((m) => m.id === btn.dataset.mv);
      if (!mv) return;
      $('mv-id').value = mv.id;
      $('mv-info').textContent = `${mv.name || mv.code} · ${mv.date}`;
      $('mv-delta').value = mv.delta;
      $('mv-kind').value = mv.kind || 'in';
      $('mv-note').value = mv.note || '';
      $('mv-error').hidden = true;
      $('movement-dialog').showModal();
    });
    $('mv-cancel').addEventListener('click', () => $('movement-dialog').close());
    $('movement-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/update-movement', { method: 'PUT', body: JSON.stringify({ id: $('mv-id').value, delta: Number($('mv-delta').value), kind: $('mv-kind').value, note: $('mv-note').value.trim() }) });
        $('movement-dialog').close();
        await loadMovements(); await loadItems();
      } catch (err) { const el = $('mv-error'); el.hidden = false; el.textContent = err.message; }
    });

    await refreshAuth();
    // gate + unauthenticated: refreshAuth already showed the login screen.
    // readonly + unauthenticated: load the read-only list.
    if (state.authenticated || state.authMode === 'readonly') {
      await loadItems(); await loadMovements(); await loadStatus();
    }
  });
})();
