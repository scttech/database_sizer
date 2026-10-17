(function () {
  'use strict';
  const D = window.DBS;
  const { TYPES, TYPE_BY_ID, VENDORS, calcModel, newColumn, newTable, normalizeModel, parseCount, fmtBytes: fb, fmtNum } = D;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KEY = 'dbsizer.v1';
  const HELP = D.HELP;
  const help = (k) => (HELP[k] ? `<button type="button" class="help" data-help="${k}" aria-label="Help: ${esc(HELP[k].t)}">?</button>` : '');

  const SETTINGS = [
    ['Text', null],
    ['bpc', 'Avg bytes per character', 'select', [[1, '1 – ASCII / Latin-1'], [2, '2 – mixed'], [3, '3 – utf8 (3-byte)'], [4, '4 – utf8mb4 worst case']]],
    ['Storage', null],
    ['dataFill', 'Data page fill %', 'num', 'vendor default'],
    ['indexFill', 'Index page fill %', 'num', 'vendor default'],
    ['comp', 'Compression saving %', 'num'],
    ['frag', 'Bloat / free space %', 'num'],
    ['logPct', 'WAL / redo / undo / log %', 'num'],
    ['tempPct', 'Temp / sort space %', 'num'],
    ['Resilience', null],
    ['replicas', 'Replicas (full copies)', 'num'],
    ['backups', 'Full backups retained', 'num'],
    ['backupRatio', 'Backup size % of data', 'num'],
    ['Growth', null],
    ['growth', 'Row growth % per year', 'num'],
    ['years', 'Years to project', 'num'],
    ['Memory', null],
    ['hotPct', 'Hot data (working set) %', 'num'],
    ['idxPct', 'Index kept cached %', 'num'],
    ['connections', 'Concurrent connections', 'num'],
    ['connMB', 'MB per connection', 'num', 'vendor default'],
    ['baseMB', 'Base / system overhead MB', 'num', 'vendor default'],
  ];

  function sample() {
    const col = (name, type, o) => newColumn({ name, type, nullable: false, ...o });
    return normalizeModel({
      vendor: 'postgres',
      settings: {},
      tables: [
        { name: 'customers', rows: 2000000, columns: [col('id', 'int8', { pk: true }), col('email', 'varchar', { len: 255, avg: 28 }), col('name', 'varchar', { len: 100, avg: 22 }), col('created_at', 'timestamp'), col('country', 'char', { len: 2 }), col('phone', 'varchar', { len: 30, nullable: true })], indexes: [{ name: 'ux_customers_email', columns: ['email'], unique: true }, { name: 'ix_customers_created', columns: ['created_at'] }] },
        { name: 'orders', rows: 15000000, columns: [col('id', 'int8', { pk: true }), col('customer_id', 'int8'), col('status', 'varchar', { len: 20, avg: 8 }), col('total', 'decimal', { len: 12, scale: 2 }), col('placed_at', 'timestamp'), col('notes', 'text', { nullable: true, avg: 120 })], indexes: [{ name: 'ix_orders_customer', columns: ['customer_id', 'placed_at'] }, { name: 'ix_orders_status', columns: ['status'] }] },
        { name: 'order_items', rows: 60000000, columns: [col('order_id', 'int8', { pk: true }), col('line_no', 'int4', { pk: true }), col('product_id', 'int8'), col('qty', 'int4'), col('unit_price', 'decimal', { len: 10, scale: 2 })], indexes: [{ name: 'ix_items_product', columns: ['product_id'] }] },
        { name: 'products', rows: 50000, columns: [col('id', 'int8', { pk: true }), col('sku', 'varchar', { len: 40, avg: 14 }), col('title', 'varchar', { len: 200, avg: 60 }), col('attributes', 'json', { nullable: true, avg: 500 })], indexes: [{ name: 'ux_products_sku', columns: ['sku'], unique: true }] },
      ],
    });
  }

  /* ---------- modal messages (replace alert/confirm) ---------- */
  const msgDlg = $('#msg-dialog');
  let msgDone = null;
  // Resolves true when confirmed, false when cancelled/dismissed. cancelText null hides the cancel button.
  function ask({ title, message, items, confirmText = 'OK', cancelText = 'Cancel', danger = false, kind = 'info' }) {
    $('#msg-title').textContent = title;
    $('#msg-body').textContent = message || '';
    $('#msg-list').innerHTML = (items || []).map((i) => `<li>${esc(i)}</li>`).join('');
    $('#msg-list').hidden = !(items && items.length);
    msgDlg.dataset.kind = kind;
    const ok = $('#msg-ok'), cancel = $('#msg-cancel');
    ok.textContent = confirmText;
    ok.className = danger ? 'danger-solid' : 'primary';
    cancel.textContent = cancelText || '';
    cancel.hidden = !cancelText;
    return new Promise((resolve) => {
      msgDone = resolve;
      msgDlg.showModal();
      (danger && cancelText ? cancel : ok).focus();
    });
  }
  const notify = (title, message, items, kind) => ask({ title, message, items, cancelText: null, kind });
  function closeMsg(result) { if (msgDlg.open) msgDlg.close(); if (msgDone) { const d = msgDone; msgDone = null; d(result); } }
  $('#msg-ok').onclick = () => closeMsg(true);
  $('#msg-cancel').onclick = () => closeMsg(false);
  msgDlg.addEventListener('cancel', (e) => { e.preventDefault(); closeMsg(false); });
  msgDlg.addEventListener('click', (e) => { if (e.target === msgDlg) closeMsg(false); });

  let model;
  try { model = normalizeModel(JSON.parse(localStorage.getItem(KEY))); } catch (e) { model = sample(); }

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(model)); } catch (e) { /* storage unavailable */ } }, 300);
  }

  /* ---------- settings ---------- */
  function renderSettings() {
    const v = VENDORS[model.vendor];
    $('#settings').innerHTML = SETTINGS.map(([k, label, kind, extra]) => {
      if (!kind) return `<div class="grp">${k}</div>`;
      if (kind === 'select') return `<div class="f"><label for="s-${k}">${label}</label>${help(k)}<select id="s-${k}" data-s="${k}">${extra.map(([val, l]) => `<option value="${val}" ${+model.settings[k] === val ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
      const def = v.defaults[k];
      const val = model.settings[k];
      return `<div class="f"><label for="s-${k}">${label}</label>${help(k)}<input id="s-${k}" type="number" min="0" step="any" data-s="${k}" value="${val ?? ''}" placeholder="${def !== undefined ? def : ''}"></div>`;
    }).join('');
  }
  $('#settings').addEventListener('input', (e) => {
    const k = e.target.dataset.s;
    if (!k) return;
    model.settings[k] = e.target.value === '' ? null : +e.target.value;
    changed();
  });

  /* ---------- editor ---------- */
  const hasLen = (t) => !!TYPE_BY_ID[t].len;
  const hasScale = (t) => !!TYPE_BY_ID[t].scale;
  const hasAvg = (t) => !!TYPE_BY_ID[t].avg;

  function colRow(c, j) {
    const ty = TYPE_BY_ID[c.type];
    return `<div class="row" data-c="${j}">
      <input data-f="name" value="${esc(c.name)}" placeholder="column" aria-label="Column name">
      <select data-f="type" aria-label="Type">${TYPES.map((t) => `<option value="${t.id}" ${t.id === c.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
      <input data-f="len" type="number" min="1" value="${c.len ?? ''}" ${hasLen(c.type) ? '' : 'disabled'} placeholder="${c.type === 'decimal' ? 'prec' : 'len'}" aria-label="Length or precision">
      <input data-f="scale" type="number" min="0" value="${c.scale ?? ''}" ${hasScale(c.type) ? '' : 'disabled'} placeholder="scale" aria-label="Scale">
      <input data-f="avg" type="number" min="0" value="${c.avg ?? ''}" ${hasAvg(c.type) ? '' : 'disabled'} placeholder="${hasAvg(c.type) ? D.defAvg(c) : 'avg'}" aria-label="Average length">
      <input data-f="nullable" type="checkbox" ${c.nullable ? 'checked' : ''} ${c.pk ? 'disabled' : ''} aria-label="Nullable">
      <input data-f="pk" type="checkbox" ${c.pk ? 'checked' : ''} aria-label="Primary key">
      <button class="icon" data-act="del-col" title="Remove column" aria-label="Remove column">×</button>
    </div>`;
  }
  function idxRow(x, j) {
    return `<div class="row" data-x="${j}">
      <input data-f="iname" value="${esc(x.name)}" placeholder="index name" aria-label="Index name">
      <input data-f="icols" value="${esc((x.columns || []).join(', '))}" placeholder="col1, col2" aria-label="Index columns">
      <input data-f="iunique" type="checkbox" ${x.unique ? 'checked' : ''} aria-label="Unique">
      <button class="icon" data-act="del-idx" title="Remove index" aria-label="Remove index">×</button>
    </div>`;
  }
  function tableCard(t, i) {
    return `<details class="card tcard" data-t="${i}" ${t.collapsed ? '' : 'open'}>
      <summary>
        <input class="tname" data-f="name" value="${esc(t.name)}" placeholder="table name" aria-label="Table name">
        <input class="rows" data-f="rows" value="${t.rows}" inputmode="numeric" title="Rows (e.g. 2.5M, 400k)" aria-label="Row count"> rows ${help('rows')}
        <span class="tres"></span>
        <button class="icon" data-act="dup-table" title="Duplicate table">⧉</button>
        <button class="icon" data-act="del-table" title="Remove table">🗑</button>
      </summary>
      <div class="grid-wrap">
        <div class="cgrid">
          <div class="h">Column</div><div class="h">Type${help('col_type')}</div><div class="h">Len/Prec${help('col_len')}</div><div class="h">Scale${help('col_scale')}</div><div class="h">Avg len${help('col_avg')}</div><div class="h">Null${help('col_null')}</div><div class="h">PK${help('col_pk')}</div><div></div>
          ${t.columns.map(colRow).join('')}
        </div>
      </div>
      <button class="mini" data-act="add-col">+ Column</button>
      <div class="sub">Indexes ${help('indexes')} <span class="hint">(primary key index is added automatically)</span></div>
      <div class="grid-wrap">
        <div class="igrid">${t.indexes.length ? `<div class="h">Name</div><div class="h">Columns (comma separated)${help('idx_cols')}</div><div class="h">Uniq${help('idx_unique')}</div><div></div>` : ''}${t.indexes.map(idxRow).join('')}</div>
      </div>
      <button class="mini" data-act="add-idx">+ Index</button>
    </details>`;
  }
  function renderTables() {
    $('#tables').innerHTML = model.tables.map(tableCard).join('') || '<div class="empty">No tables yet. Add one, paste DDL, or load the sample.</div>';
    updateResults();
  }
  function renderNotes() {
    const v = VENDORS[model.vendor];
    $('#vendor-notes').innerHTML = `<h2>How ${esc(v.label)} stores data</h2><ul>${D.VENDOR_NOTES[v.id].map((n) => `<li>${n}</li>`).join('')}</ul>`;
  }
  function renderAll() {
    renderNotes();
    $('#vendor').innerHTML = Object.values(VENDORS).map((v) => `<option value="${v.id}" ${v.id === model.vendor ? 'selected' : ''}>${v.label}</option>`).join('');
    renderSettings();
    renderTables();
  }

  const tablesEl = $('#tables');
  tablesEl.addEventListener('input', (e) => {
    const el = e.target, f = el.dataset.f;
    const card = el.closest('[data-t]');
    if (!f || !card) return;
    const t = model.tables[+card.dataset.t];
    const crow = el.closest('[data-c]'), irow = el.closest('[data-x]');
    if (crow) {
      const c = t.columns[+crow.dataset.c];
      if (el.type === 'checkbox') c[f] = el.checked;
      else if (el.type === 'number') c[f] = el.value === '' ? null : +el.value;
      else c[f] = el.value;
      if (f === 'type') { syncCol(crow, c); }
      if (f === 'pk') { if (c.pk) c.nullable = false; crow.querySelector('[data-f=nullable]').checked = c.nullable; crow.querySelector('[data-f=nullable]').disabled = c.pk; }
    } else if (irow) {
      const x = t.indexes[+irow.dataset.x];
      if (f === 'iname') x.name = el.value;
      if (f === 'icols') x.columns = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (f === 'iunique') x.unique = el.checked;
    } else if (f === 'name') t.name = el.value;
    else if (f === 'rows') {
      const n = parseCount(el.value);
      el.classList.toggle('invalid', n === null);
      if (n !== null) t.rows = n;
    }
    changed();
  });
  // Firefox toggles <details> on space-keyup inside a summary input.
  tablesEl.addEventListener('keyup', (e) => { if (e.key === ' ' && e.target.closest('summary') && e.target.tagName === 'INPUT') e.preventDefault(); });
  tablesEl.addEventListener('focusout', (e) => {
    if (e.target.dataset.f === 'rows') { const t = model.tables[+e.target.closest('[data-t]').dataset.t]; e.target.value = t.rows; e.target.classList.remove('invalid'); }
  });
  function syncCol(row, c) {
    const set = (f, on, ph) => { const i = row.querySelector(`[data-f=${f}]`); i.disabled = !on; if (ph !== undefined) i.placeholder = ph; if (!on) { i.value = ''; c[f] = null; } };
    set('len', hasLen(c.type), c.type === 'decimal' ? 'prec' : 'len');
    set('scale', hasScale(c.type));
    set('avg', hasAvg(c.type), hasAvg(c.type) ? D.defAvg(c) : 'avg');
    if (hasLen(c.type) && c.len == null) { c.len = c.type === 'decimal' ? 18 : c.type === 'char' ? 1 : 50; row.querySelector('[data-f=len]').value = c.len; }
  }
  tablesEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('[data-t]');
    const t = model.tables[+card.dataset.t];
    const act = b.dataset.act;
    if (b.closest('summary')) e.preventDefault();
    if (act === 'add-col') t.columns.push(newColumn({ name: `col${t.columns.length + 1}` }));
    else if (act === 'del-col') t.columns.splice(+b.closest('[data-c]').dataset.c, 1);
    else if (act === 'add-idx') t.indexes.push({ name: `ix_${t.name}_${t.indexes.length + 1}`, columns: [], unique: false });
    else if (act === 'del-idx') t.indexes.splice(+b.closest('[data-x]').dataset.x, 1);
    else if (act === 'del-table') {
      const idx = +card.dataset.t;
      ask({ title: 'Remove table?', message: `"${t.name}" and its columns and indexes will be removed.`, confirmText: 'Remove', danger: true }).then((ok) => { if (ok) { model.tables.splice(idx, 1); save(); renderTables(); } });
      return;
    }
    else if (act === 'dup-table') model.tables.splice(+card.dataset.t + 1, 0, JSON.parse(JSON.stringify({ ...t, name: t.name + '_copy' })));
    save();
    renderTables();
  });
  tablesEl.addEventListener('toggle', (e) => {
    const card = e.target.closest && e.target.closest('[data-t]');
    if (card && e.target === card) { model.tables[+card.dataset.t].collapsed = !card.open; save(); }
  }, true);

  $('#btn-add-table').onclick = () => { model.tables.push(newTable({ name: `table_${model.tables.length + 1}` })); save(); renderTables(); };
  $('#vendor').onchange = (e) => { model.vendor = e.target.value; renderSettings(); renderNotes(); changed(); };

  /* ---------- results ---------- */
  function changed() { save(); updateResults(); }

  function breakdownRow(label, val, cls) {
    return `<tr class="${cls || ''}"><td>${label}</td><td>${fb(val)}</td></tr>`;
  }
  function updateResults() {
    const r = calcModel(model, model.vendor);
    const s = r.settings;

    $('#tiles').innerHTML = [
      ['Disk per node', fb(r.perNode), `data ${fb(r.data)} + indexes ${fb(r.index)}`],
      ['Disk, whole deployment', fb(r.diskTotal), `${s.replicas} replica(s), ${s.backups} backup(s)`],
      ['Memory (RAM)', fb(r.mem.total), `cache ${fb(r.mem.cache)}`],
      [`Disk in ${s.years} yr`, fb(0), 'at ' + s.growth + '% growth'],
    ].map(([k, v, sub], i) => `<div class="tile" ${i === 3 ? 'id="tile-future"' : ''}><div class="k"><span>${k}</span>${help(['tile_node', 'tile_total', 'tile_mem', 'tile_future'][i])}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

    const warn = [...new Set(r.warnings)];
    $('#warnings').innerHTML = warn.length ? `<div class="warn"><strong>Heads up</strong><ul>${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

    $('#breakdown').innerHTML = `<table><tbody>
      ${breakdownRow('Table data', r.data)}${breakdownRow('Indexes', r.index)}
      ${s.comp ? breakdownRow(`Compression (−${s.comp}%)`, -r.compSaved, 'sub') : ''}
      ${breakdownRow(`Bloat / free space (+${s.frag}%)`, r.fragExtra, 'sub')}
      ${breakdownRow('Storage', r.storage, 'total')}
      ${breakdownRow('WAL / redo / undo / log', r.logs)}${breakdownRow('Temp / sort', r.temp)}
      ${breakdownRow('Disk per node', r.perNode, 'total')}
      ${s.replicas ? breakdownRow(`Replicas ×${s.replicas}`, r.replicas) : ''}
      ${s.backups ? breakdownRow(`Backups ×${s.backups}`, r.backups) : ''}
      ${breakdownRow('Whole deployment', r.diskTotal, 'total')}</tbody></table>`;

    $('#membreakdown').innerHTML = `<table><tbody>
      ${breakdownRow(`Buffer cache (${s.hotPct}% data + ${s.idxPct}% indexes)`, r.mem.cache)}
      ${breakdownRow(`Connections (${fmtNum(s.connections)} × ${s.connMB} MB)`, r.mem.conns)}
      ${breakdownRow('Base / system overhead', r.mem.base)}
      ${breakdownRow('Total RAM', r.mem.total, 'total')}</tbody></table>
      <p class="hint">Leave extra headroom for the OS file cache and peaks.</p>`;

    $('#detail').innerHTML = `<table><thead><tr><th>Table</th><th>Rows</th><th>Row bytes</th><th>Rows/page</th><th>Data</th><th>Indexes</th><th>Total</th></tr></thead><tbody>
      ${r.tables.map((t) => `<tr><td>${esc(t.name)}</td><td>${fmtNum(t.rows)}</td><td>${fmtNum(t.rowBytes)}</td><td>${t.rowsPerPage >= 1 ? fmtNum(t.rowsPerPage) : '<1'}</td><td>${fb(t.dataBytes)}</td><td>${fb(t.indexBytes)}</td><td>${fb(t.totalBytes)}</td></tr>
        ${t.indexes.map((x) => `<tr class="sub"><td>${esc(x.name)}</td><td></td><td>${x.entryBytes} B/entry</td><td></td><td></td><td>${fb(x.bytes)}</td><td></td></tr>`).join('')}
        ${t.notes.map((n) => `<tr><td colspan="7" class="note">${esc(t.name)}: ${esc(n)}</td></tr>`).join('')}`).join('')}
      <tr class="total"><td>Total</td><td></td><td></td><td></td><td>${fb(r.data)}</td><td>${fb(r.index)}</td><td>${fb(r.raw)}</td></tr></tbody></table>`;

    document.querySelectorAll('#tables [data-t]').forEach((card) => {
      const t = r.tables[+card.dataset.t];
      const el = card.querySelector('.tres');
      if (t && el) el.textContent = `${fmtNum(t.rowBytes)} B/row · ${fb(t.totalBytes)}`;
    });

    drawCharts(r);
  }

  function drawCharts(r) {
    const years = Math.min(10, Math.max(1, Math.round(r.settings.years)));
    const g = r.settings.growth / 100;
    const pts = [];
    for (let y = 0; y <= years; y++) {
      const p = y === 0 ? r : calcModel(model, model.vendor, Math.pow(1 + g, y));
      pts.push({ disk: p.perNode, mem: p.mem.total });
    }
    const fut = $('#tile-future');
    if (fut) { fut.querySelector('.k span').textContent = `Disk per node in ${years} yr`; fut.querySelector('.v').textContent = fb(pts[years].disk); }
    D.charts.tableChart($('#chart-tables'), r.tables);
    D.charts.growthChart($('#chart-growth'), pts);
    D.charts.vendorChart($('#chart-vendors'), Object.values(VENDORS).map((v) => { const x = calcModel(model, v.id); return { id: v.id, label: v.label, disk: x.perNode, mem: x.mem.total }; }), model.vendor);
  }
  let rz;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(updateResults, 120); }).observe($('.results'));

  /* ---------- import / export ---------- */
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('#btn-export').onclick = () => download('database-model.json', JSON.stringify(model, null, 2), 'application/json');
  $('#btn-csv').onclick = () => {
    const r = calcModel(model, model.vendor);
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [['table', 'rows', 'row_bytes', 'data_bytes', 'index_bytes', 'total_bytes'].join(',')];
    r.tables.forEach((t) => lines.push([q(t.name), t.rows, t.rowBytes, Math.round(t.dataBytes), Math.round(t.indexBytes), Math.round(t.totalBytes)].join(',')));
    download(`database-sizes-${model.vendor}.csv`, lines.join('\n'), 'text/csv');
  };
  $('#btn-import').onclick = () => $('#file').click();
  $('#file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { model = normalizeModel(JSON.parse(rd.result)); save(); renderAll(); } catch (err) { notify('Could not import file', err.message, null, 'error'); }
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  const loadSample = () => { const v = model.vendor; model = sample(); model.vendor = v; save(); renderAll(); };
  $('#btn-sample').onclick = () => { if (!model.tables.length) return loadSample(); ask({ title: 'Load sample data?', message: 'This replaces your current tables and assumptions.', confirmText: 'Replace' }).then((ok) => ok && loadSample()); };
  $('#btn-reset').onclick = () => ask({ title: 'Clear everything?', message: 'All tables and assumptions will be removed. Export the model first if you want to keep it.', confirmText: 'Clear all', danger: true }).then((ok) => { if (ok) { model = normalizeModel({ vendor: model.vendor, tables: [] }); save(); renderAll(); } });

  const dlg = $('#ddl-dialog');
  $('#btn-ddl').onclick = () => { $('#ddl-msg').textContent = ''; dlg.showModal(); };
  $('#ddl-cancel').onclick = () => dlg.close();
  $('#ddl-go').onclick = () => {
    const res = D.parseDDL($('#ddl-text').value);
    if (!res.tables.length) { $('#ddl-msg').textContent = res.warnings.join(' '); return; }
    const replace = document.querySelector('input[name=ddl-mode]:checked').value === 'replace';
    model.tables = (replace ? [] : model.tables).concat(res.tables);
    save();
    renderTables();
    if (res.warnings.length) notify(`Imported ${res.tables.length} table(s)`, 'Some parts of the DDL could not be fully understood:', res.warnings, 'warn');
    dlg.close();
  };

  /* ---------- help popover ---------- */
  const pop = document.createElement('div');
  pop.id = 'help-pop';
  pop.setAttribute('role', 'dialog');
  pop.hidden = true;
  document.body.appendChild(pop);
  let popFor = null;
  function closePop() { pop.hidden = true; if (popFor) popFor.setAttribute('aria-expanded', 'false'); popFor = null; }
  function openPop(btn) {
    const h = HELP[btn.dataset.help];
    const extra = h.v && h.v[model.vendor];
    pop.innerHTML = `<strong>${esc(h.t)}</strong><p>${h.b}</p>${extra ? `<p class="vnote"><em>${esc(VENDORS[model.vendor].label)}:</em> ${extra}</p>` : ''}`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    popFor = btn;
    btn.setAttribute('aria-expanded', 'true');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.help');
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      const same = popFor === b;
      closePop();
      if (!same) openPop(b);
    } else if (!e.target.closest('#help-pop')) closePop();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  addEventListener('resize', closePop);
  document.addEventListener('scroll', closePop, true);

  renderAll();
})();
