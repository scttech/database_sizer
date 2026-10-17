/* Sizing engine: per-vendor row/index layout models and the roll-up (disk, memory, growth).
 * All numbers are ESTIMATES derived from documented storage formats; real usage varies with
 * data distribution, NULL ratios, compression, versions and configuration. */
(function (g) {
  'use strict';
  const DBS = (g.DBS = g.DBS || {});

  const TYPES = [
    { id: 'int1', label: 'tinyint (1 B)' },
    { id: 'int2', label: 'smallint (2 B)' },
    { id: 'int4', label: 'int (4 B)' },
    { id: 'int8', label: 'bigint (8 B)' },
    { id: 'decimal', label: 'decimal / numeric', len: true, scale: true },
    { id: 'float4', label: 'float / real (4 B)' },
    { id: 'float8', label: 'double (8 B)' },
    { id: 'bool', label: 'boolean / bit' },
    { id: 'char', label: 'char(n)', len: true },
    { id: 'varchar', label: 'varchar(n)', len: true, avg: true },
    { id: 'nvarchar', label: 'nvarchar(n) unicode', len: true, avg: true },
    { id: 'text', label: 'text / clob', avg: true },
    { id: 'blob', label: 'binary / blob', avg: true },
    { id: 'date', label: 'date' },
    { id: 'time', label: 'time' },
    { id: 'timestamp', label: 'timestamp / datetime' },
    { id: 'uuid', label: 'uuid' },
    { id: 'json', label: 'json / xml', avg: true },
  ];
  const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));

  const DEFAULT_SETTINGS = {
    bpc: 1, // average bytes per character in text data
    dataFill: null, // % of each data page used (null = vendor default)
    indexFill: null,
    comp: 0, // % saved by compression
    frag: 10, // % bloat / free space / fragmentation
    logPct: 15, // WAL / redo / undo / transaction log, % of storage
    tempPct: 5, // temp / sort space, % of storage
    replicas: 0,
    backups: 2, // full backups retained
    backupRatio: 40, // backup size as % of storage
    growth: 20, // % row growth per year
    years: 3,
    hotPct: 20, // % of table data in the working set
    idxPct: 100, // % of index data kept cached
    connections: 100,
    connMB: null,
    baseMB: null,
  };

  const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
  const alignUp = (n, a) => Math.ceil(n / a) * a;
  const isVar = (t) => t === 'varchar' || t === 'nvarchar' || t === 'text' || t === 'blob' || t === 'json';

  function defAvg(c) {
    switch (c.type) {
      case 'char': return num(c.len, 1);
      case 'varchar':
      case 'nvarchar': return Math.max(1, Math.ceil(num(c.len, 50) / 2));
      case 'text': return 200;
      case 'blob': return 1024;
      case 'json': return 256;
    }
    return 0;
  }
  function avgLen(c) {
    let a = num(c.avg, defAvg(c));
    if ((c.type === 'varchar' || c.type === 'nvarchar') && num(c.len, 0) > 0) a = Math.min(a, c.len);
    return Math.max(0, a);
  }
  const prec = (c) => Math.min(38, Math.max(1, Math.round(num(c.len, 18))));
  const scl = (c) => Math.min(prec(c), Math.max(0, Math.round(num(c.scale, 0))));
  const fixedInfo = (size, align) => ({ size, align: align || 1 });

  /* ---------- helpers ---------- */
  // Move the largest variable-length values off-row until the row fits `limit`.
  function layoutSpill(infos, layout, limit, ptr, overFn) {
    const sizes = infos.map((i) => i.size);
    let over = 0;
    infos.forEach((i) => (over += i.over || 0));
    let spilled = 0;
    while (layout(sizes) > limit) {
      let bi = -1;
      infos.forEach((ci, i) => {
        if (ci.spill && sizes[i] > ptr && (bi < 0 || sizes[i] > sizes[bi])) bi = i;
      });
      if (bi < 0) break;
      over += overFn(sizes[bi]);
      sizes[bi] = ptr;
      spilled++;
    }
    return { bytes: layout(sizes), over, spilled };
  }
  const pkCols = (t) => t.columns.filter((c) => c.pk);

  /* ---------- vendors ---------- */
  const pgVar = (a) => ({ size: a + (a > 126 ? 4 : 1), align: 1, spill: true });
  const PG = {
    id: 'postgres',
    label: 'PostgreSQL',
    pageSize: 8192,
    dataUsable: 8168,
    indexUsable: 8152,
    clustered: () => false,
    defaults: { dataFill: 100, indexFill: 90, connMB: 10, baseMB: 300 },
    info(c, s) {
      switch (c.type) {
        case 'int1':
        case 'int2': return fixedInfo(2, 2);
        case 'int4': return fixedInfo(4, 4);
        case 'int8': return fixedInfo(8, 8);
        case 'decimal': return { size: 3 + 2 * Math.ceil(prec(c) / 4), align: 1 };
        case 'float4': return fixedInfo(4, 4);
        case 'float8': return fixedInfo(8, 8);
        case 'bool': return fixedInfo(1, 1);
        case 'date': return fixedInfo(4, 4);
        case 'time':
        case 'timestamp': return fixedInfo(8, 8);
        case 'uuid': return fixedInfo(16, 1);
        case 'char': { const b = num(c.len, 1) * s.bpc; return { size: b + (b > 126 ? 4 : 1), align: 1 }; }
        case 'blob': return pgVar(avgLen(c));
        default: return pgVar(avgLen(c) * s.bpc);
      }
    },
    row(t, s) {
      const infos = t.columns.map((c) => this.info(c, s));
      const hasNull = t.columns.some((c) => c.nullable);
      const base = alignUp(23 + (hasNull ? Math.ceil(t.columns.length / 8) : 0), 8);
      const layout = (sz) => {
        let off = base;
        infos.forEach((ci, i) => { off = alignUp(off, ci.align) + sz[i]; });
        return alignUp(off, 8) + 4; // + line pointer
      };
      const r = layoutSpill(infos, layout, 2032, 18, (x) => x * 1.05);
      return { ...r, note: r.spilled ? 'Large values moved to TOAST (compression not modelled).' : '' };
    },
    entry(t, cols, s) {
      let off = 8;
      cols.forEach((c) => { const ci = this.info(c, s); off = alignUp(off, ci.align) + ci.size; });
      if (cols.some((c) => c.nullable)) off += 4;
      return alignUp(off, 8) + 4;
    },
    clusterKey: () => 0,
  };

  const mysqlDec = (p, sc) => {
    const f = [0, 1, 1, 2, 2, 3, 3, 4, 4];
    const part = (n) => Math.floor(n / 9) * 4 + f[n % 9];
    return part(p - sc) + part(sc);
  };
  const MYSQL = {
    id: 'mysql',
    label: 'MySQL / MariaDB (InnoDB)',
    pageSize: 16384,
    dataUsable: 16252,
    indexUsable: 16252,
    clustered: () => true,
    defaults: { dataFill: 94, indexFill: 75, connMB: 6, baseMB: 250 },
    info(c, s) {
      const bpc = s.bpc;
      switch (c.type) {
        case 'int1': return fixedInfo(1);
        case 'int2': return fixedInfo(2);
        case 'int4': return fixedInfo(4);
        case 'int8': return fixedInfo(8);
        case 'decimal': return fixedInfo(mysqlDec(prec(c), scl(c)));
        case 'float4': return fixedInfo(4);
        case 'float8': return fixedInfo(8);
        case 'bool': return fixedInfo(1);
        case 'date':
        case 'time': return fixedInfo(3);
        case 'timestamp': return fixedInfo(5);
        case 'uuid': return fixedInfo(16);
        case 'char': return fixedInfo(num(c.len, 1) * bpc);
        case 'varchar':
        case 'nvarchar': return { size: avgLen(c) * bpc + (num(c.len, 0) * bpc > 255 ? 2 : 1), spill: true };
        case 'blob': return { size: avgLen(c) + 2, spill: true };
        default: return { size: avgLen(c) * bpc + 2, spill: true };
      }
    },
    row(t, s) {
      const infos = t.columns.map((c) => this.info(c, s));
      const hidden = pkCols(t).length ? 0 : 6;
      const nb = Math.ceil(t.columns.filter((c) => c.nullable).length / 8);
      const layout = (sz) => 5 + 6 + 7 + hidden + nb + sz.reduce((a, b) => a + b, 0) + 2;
      const r = layoutSpill(infos, layout, 8100, 20, (x) => Math.ceil(x / 16330) * 16384);
      return { ...r, note: r.spilled ? 'Large values stored off-page (one overflow page each, uncompressed).' : '' };
    },
    clusterKey(t, s) {
      const pk = pkCols(t);
      return pk.length ? pk.reduce((a, c) => a + this.info(c, s).size, 0) : 6;
    },
    entry(t, cols, s) {
      const pk = pkCols(t).filter((p) => !cols.includes(p));
      const key = cols.reduce((a, c) => a + this.info(c, s).size, 0);
      const pks = pkCols(t).length ? pk.reduce((a, c) => a + this.info(c, s).size, 0) : 6;
      return 5 + key + pks + (cols.some((c) => c.nullable) ? 1 : 0) + 2;
    },
  };

  const msDec = (p) => (p <= 9 ? 5 : p <= 19 ? 9 : p <= 28 ? 13 : 17);
  const MSSQL = {
    id: 'sqlserver',
    label: 'SQL Server',
    pageSize: 8192,
    dataUsable: 8096,
    indexUsable: 8096,
    clustered: (t) => pkCols(t).length > 0,
    defaults: { dataFill: 100, indexFill: 80, connMB: 3, baseMB: 1024 },
    info(c, s) {
      const bpc = s.bpc;
      switch (c.type) {
        case 'int1': return fixedInfo(1);
        case 'int2': return fixedInfo(2);
        case 'int4': return fixedInfo(4);
        case 'int8': return fixedInfo(8);
        case 'decimal': return fixedInfo(msDec(prec(c)));
        case 'float4': return fixedInfo(4);
        case 'float8': return fixedInfo(8);
        case 'bool': return fixedInfo(1);
        case 'date': return fixedInfo(3);
        case 'time': return fixedInfo(5);
        case 'timestamp': return fixedInfo(8);
        case 'uuid': return fixedInfo(16);
        case 'char': return fixedInfo(num(c.len, 1) * bpc);
        case 'nvarchar':
        case 'json': return { size: avgLen(c) * 2, isVar: true, spill: true };
        case 'blob': return { size: avgLen(c), isVar: true, spill: true };
        default: return { size: avgLen(c) * bpc, isVar: true, spill: true };
      }
    },
    row(t, s) {
      const infos = t.columns.map((c) => this.info(c, s));
      const nvar = infos.filter((i) => i.isVar).length;
      const base = 4 + 2 + Math.ceil(t.columns.length / 8) + (nvar ? 2 + 2 * nvar : 0) + 2;
      const layout = (sz) => base + sz.reduce((a, b) => a + b, 0);
      const r = layoutSpill(infos, layout, 8060, 24, (x) => x * 1.03);
      return { ...r, note: r.spilled ? 'Large values moved to row-overflow / LOB pages.' : '' };
    },
    clusterKey(t, s) {
      const pk = pkCols(t);
      return pk.length ? pk.reduce((a, c) => a + this.info(c, s).size, 0) : 8;
    },
    entry(t, cols, s) {
      const infos = cols.map((c) => this.info(c, s));
      const nvar = infos.filter((i) => i.isVar).length;
      const ck = pkCols(t).length ? pkCols(t).filter((p) => !cols.includes(p)).reduce((a, c) => a + this.info(c, s).size, 0) : 8;
      return 1 + infos.reduce((a, i) => a + i.size, 0) + ck + 3 + (nvar ? 2 + 2 * nvar : 0) + 2;
    },
  };

  const ORA = {
    id: 'oracle',
    label: 'Oracle',
    pageSize: 8192,
    dataUsable: 8062,
    indexUsable: 8030,
    clustered: () => false,
    defaults: { dataFill: 90, indexFill: 75, connMB: 5, baseMB: 800 },
    info(c, s) {
      const bpc = s.bpc;
      const lob = (a) => (a > 3900 ? { size: 36, over: Math.ceil(a / 8000) * 8192 } : { size: a });
      switch (c.type) {
        case 'int1': return fixedInfo(3);
        case 'int2': return fixedInfo(4);
        case 'int4': return fixedInfo(6);
        case 'int8': return fixedInfo(11);
        case 'decimal': return fixedInfo(Math.min(21, Math.ceil(prec(c) / 2) + 1));
        case 'float4': return fixedInfo(4);
        case 'float8': return fixedInfo(8);
        case 'bool': return fixedInfo(2);
        case 'date':
        case 'time': return fixedInfo(7);
        case 'timestamp': return fixedInfo(11);
        case 'uuid': return fixedInfo(16);
        case 'char': return fixedInfo(num(c.len, 1) * bpc);
        case 'varchar': return { size: avgLen(c) * bpc };
        case 'nvarchar': return { size: avgLen(c) * 2 };
        case 'blob': return lob(avgLen(c));
        default: return lob(avgLen(c) * bpc);
      }
    },
    row(t, s) {
      const infos = t.columns.map((c) => this.info(c, s));
      const body = infos.reduce((a, i) => a + i.size + (i.size > 250 ? 3 : 1), 0);
      const over = infos.reduce((a, i) => a + (i.over || 0), 0);
      return { bytes: Math.max(11, 3 + body + 2), over, note: over ? 'Large LOBs stored out-of-line in 8 KB chunks.' : '' };
    },
    clusterKey: () => 0,
    entry(t, cols, s) {
      const key = cols.reduce((a, c) => { const z = this.info(c, s).size; return a + z + (z > 250 ? 3 : 1); }, 0);
      return 2 + key + 7 + 2;
    },
  };

  const VENDORS = { postgres: PG, mysql: MYSQL, sqlserver: MSSQL, oracle: ORA };

  /* ---------- roll-up ---------- */
  function resolveSettings(v, s) {
    const d = v.defaults;
    const r = { ...DEFAULT_SETTINGS, ...s };
    for (const k of Object.keys(DEFAULT_SETTINGS)) r[k] = num(r[k], DEFAULT_SETTINGS[k]);
    r.dataFill = num(s.dataFill, d.dataFill);
    r.indexFill = num(s.indexFill, d.indexFill);
    r.connMB = num(s.connMB, d.connMB);
    r.baseMB = num(s.baseMB, d.baseMB);
    r.bpc = Math.max(1, r.bpc);
    r.dataFill = Math.min(100, Math.max(10, r.dataFill));
    r.indexFill = Math.min(100, Math.max(10, r.indexFill));
    return r;
  }

  function btreeBytes(v, rows, entry, fill) {
    if (rows <= 0) return 0;
    const usable = (v.indexUsable * fill) / 100;
    const per = Math.max(1, Math.floor(usable / entry));
    let n = Math.ceil(rows / per);
    const fan = Math.max(2, per);
    let pages = n;
    while (n > 1) { n = Math.ceil(n / fan); pages += n; }
    return pages * v.pageSize;
  }

  function calcTable(v, t, s, scale, warnings) {
    const rows = Math.round(num(t.rows, 0) * scale);
    const name = t.name || '(unnamed)';
    const notes = [];
    if (!t.columns.length) {
      warnings.push(`${name}: no columns defined.`);
      return { name, rows, rowBytes: 0, rowsPerPage: 0, dataBytes: 0, indexes: [], indexBytes: 0, totalBytes: 0, notes };
    }
    const r = v.row(t, s);
    if (r.note) notes.push(r.note);
    const usable = (v.dataUsable * s.dataFill) / 100;
    let rpp, pages;
    if (r.bytes <= usable) {
      rpp = Math.max(1, Math.floor(usable / r.bytes));
      pages = Math.ceil(rows / rpp);
    } else {
      rpp = 1 / Math.ceil(r.bytes / usable);
      pages = rows * Math.ceil(r.bytes / usable);
      notes.push('Row is wider than a page; rows span multiple pages.');
    }
    const dataBytes = rows ? pages * v.pageSize + rows * r.over : 0;

    const byName = Object.fromEntries(t.columns.map((c) => [String(c.name).toLowerCase(), c]));
    const defs = [];
    const pk = pkCols(t);
    const clustered = v.clustered(t);
    if (!clustered && pk.length) defs.push({ name: 'PK (implicit)', cols: pk });
    (t.indexes || []).forEach((ix) => {
      const cols = (ix.columns || []).map((n) => byName[String(n).toLowerCase()]).filter(Boolean);
      if (!cols.length) { warnings.push(`${name}.${ix.name || 'index'}: no matching columns; ignored.`); return; }
      if ((ix.columns || []).length !== cols.length) warnings.push(`${name}.${ix.name || 'index'}: some columns not found; using the rest.`);
      defs.push({ name: ix.name || 'index', cols });
    });
    const indexes = defs.map((d) => {
      const entry = v.entry(t, d.cols, s);
      return { name: d.name, entryBytes: entry, bytes: btreeBytes(v, rows, entry, s.indexFill) };
    });
    if (clustered) {
      // Clustered index leaf level IS the data; only the non-leaf levels cost extra.
      const ck = v.clusterKey(t, s) + 8;
      const per = Math.max(2, Math.floor((v.indexUsable * s.indexFill) / 100 / ck));
      let n = pages, internal = 0;
      while (n > 1) { n = Math.ceil(n / per); internal += n; }
      indexes.unshift({ name: pk.length ? 'clustered PK (non-leaf)' : 'hidden row id (non-leaf)', entryBytes: ck, bytes: internal * v.pageSize });
    }
    const indexBytes = indexes.reduce((a, i) => a + i.bytes, 0);
    return { name, rows, rowBytes: r.bytes, rowsPerPage: rpp, dataBytes, indexes, indexBytes, totalBytes: dataBytes + indexBytes, notes };
  }

  function calcModel(model, vendorId, scale) {
    const v = VENDORS[vendorId || model.vendor] || PG;
    const s = resolveSettings(v, model.settings || {});
    scale = scale || 1;
    const warnings = [];
    const tables = model.tables.map((t) => calcTable(v, t, s, scale, warnings));
    const data = tables.reduce((a, t) => a + t.dataBytes, 0);
    const index = tables.reduce((a, t) => a + t.indexBytes, 0);
    const raw = data + index;
    const MB = 1024 * 1024;
    const compSaved = (raw * s.comp) / 100;
    const storageNoFrag = raw - compSaved;
    const fragExtra = (storageNoFrag * s.frag) / 100;
    const storage = storageNoFrag + fragExtra;
    const logs = (storage * s.logPct) / 100;
    const temp = (storage * s.tempPct) / 100;
    const perNode = storage + logs + temp;
    const replicas = perNode * s.replicas;
    const backups = (storage * s.backups * s.backupRatio) / 100;
    const cache = (data * s.hotPct) / 100 + (index * s.idxPct) / 100;
    const conns = s.connections * s.connMB * MB;
    const base = s.baseMB * MB;
    return {
      vendor: v, settings: s, tables, warnings,
      data, index, raw, compSaved, fragExtra, storage, logs, temp, perNode, replicas, backups,
      diskTotal: perNode + replicas + backups,
      mem: { cache, conns, base, total: cache + conns + base },
    };
  }

  /* ---------- model helpers ---------- */
  function newColumn(o) {
    return Object.assign({ name: '', type: 'int4', len: null, scale: null, avg: null, nullable: true, pk: false }, o);
  }
  function newTable(o) {
    return Object.assign({ name: 'new_table', rows: 100000, columns: [newColumn({ name: 'id', type: 'int8', nullable: false, pk: true })], indexes: [], collapsed: false }, o);
  }
  function normalizeModel(m) {
    if (!m || !Array.isArray(m.tables)) throw new Error('Not a database sizer model (missing "tables").');
    const out = { version: 1, vendor: VENDORS[m.vendor] ? m.vendor : 'postgres', settings: {}, tables: [] };
    out.settings = { ...DEFAULT_SETTINGS, ...(m.settings || {}) };
    out.tables = m.tables.map((t) => ({
      name: String(t.name || ''),
      rows: Math.max(0, num(t.rows, 0)),
      collapsed: !!t.collapsed,
      columns: (t.columns || []).map((c) => {
        const col = newColumn(c);
        if (!TYPE_BY_ID[col.type]) col.type = 'varchar';
        col.nullable = !!col.nullable && !col.pk;
        return col;
      }),
      indexes: (t.indexes || []).map((i) => ({ name: String(i.name || ''), columns: (i.columns || []).map(String), unique: !!i.unique })),
    }));
    return out;
  }

  function parseCount(s) {
    if (typeof s === 'number') return s;
    const m = String(s).trim().replace(/[,_\s]/g, '').match(/^(\d*\.?\d+)([kmbt]?)$/i);
    if (!m) return null;
    const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2].toLowerCase()];
    return Math.round(parseFloat(m[1]) * mult);
  }
  function fmtBytes(b) {
    if (!Number.isFinite(b)) return '–';
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? Math.round(b) : b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2)) + ' ' + u[i];
  }
  const fmtNum = (n) => Math.round(n).toLocaleString('en-US');

  Object.assign(DBS, { TYPES, TYPE_BY_ID, VENDORS, DEFAULT_SETTINGS, calcModel, newColumn, newTable, normalizeModel, parseCount, fmtBytes, fmtNum, defAvg, isVar });
})(typeof window !== 'undefined' ? window : globalThis);
