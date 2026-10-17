/* Lightweight CREATE TABLE / CREATE INDEX parser covering the common dialects of the four vendors.
 * It is not a full SQL parser: unrecognised constructs are skipped and reported as warnings. */
(function (g) {
  'use strict';
  const DBS = (g.DBS = g.DBS || {});

  const TYPE_RULES = [
    [/^(?:timestamp|datetime2?|smalldatetime|datetimeoffset)\b/, 'timestamp'],
    [/^time\b/, 'time'],
    [/^date\b/, 'date'],
    [/^tinyint\b/, 'int1'],
    [/^(?:smallint|int2|smallserial)\b/, 'int2'],
    [/^(?:bigint|int8|bigserial)\b/, 'int8'],
    [/^(?:mediumint|integer|int4|int|serial)\b/, 'int4'],
    [/^(?:smallmoney)\b/, 'decimal', { len: 10, scale: 4 }],
    [/^(?:money)\b/, 'decimal', { len: 19, scale: 4 }],
    [/^(?:decimal|numeric|dec|number)\b/, 'decimal'],
    [/^(?:float4|real|binary_float)\b/, 'float4'],
    [/^(?:double\s+precision|float8|double|binary_double)\b/, 'float8'],
    [/^float\b/, 'float'],
    [/^(?:boolean|bool|bit)\b/, 'bool'],
    [/^(?:national\s+character\s+varying|national\s+varchar|nvarchar2?)\b/, 'nvarchar'],
    [/^(?:nchar|national\s+char(?:acter)?)\b/, 'nchar'],
    [/^(?:character\s+varying|varchar2?)\b/, 'varchar'],
    [/^(?:character|char)\b/, 'char'],
    [/^(?:longtext|mediumtext|tinytext|text|clob|nclob|ntext|long)\b/, 'text'],
    [/^(?:long\s+raw|longblob|mediumblob|tinyblob|blob|bytea|image|varbinary|binary|raw)\b/, 'blob'],
    [/^(?:uuid|uniqueidentifier)\b/, 'uuid'],
    [/^(?:jsonb|json|xml|xmltype)\b/, 'json'],
  ];

  const unquote = (s) => s.trim().replace(/^["`\[]|["`\]]$/g, '');
  const lastPart = (s) => unquote(s.trim().split('.').pop());

  function splitTop(s) {
    const parts = [];
    let depth = 0, cur = '', q = null;
    for (const ch of s) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function colList(s) {
    return splitTop(s)
      .map((p) => unquote(p.replace(/\(\s*\d+\s*\)/, '').replace(/\s+(asc|desc)\b.*$/i, '').split(/\s+/)[0]))
      .filter((n) => /^[\w$#@ -]+$/.test(n));
  }

  function parseColumn(def, warnings, tname) {
    const m = def.match(/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)\s+([\s\S]*)$/);
    if (!m) return null;
    const name = unquote(m[1]);
    const rest = m[2].trim();
    const low = rest.toLowerCase();
    let type = null, forced = null, matched = '';
    for (const [re, t, f] of TYPE_RULES) {
      const mm = low.match(re);
      if (mm) { type = t; forced = f; matched = mm[0]; break; }
    }
    const col = DBS.newColumn({ name });
    let after = rest.slice(matched.length);
    if (!type) {
      warnings.push(`${tname}.${name}: unknown type "${rest.split(/[\s(]/)[0]}"; assumed varchar(50).`);
      col.type = 'varchar'; col.len = 50;
      after = rest;
    } else {
      let args = [];
      const am = after.match(/^\s*\(([^)]*)\)/);
      if (am) {
        after = after.slice(am[0].length);
        args = am[1].split(',').map((x) => x.trim());
      }
      const a0 = parseInt(args[0], 10);
      const a1 = parseInt(args[1], 10);
      const max = /^max$/i.test(args[0] || '');
      switch (type) {
        case 'float': col.type = a0 && a0 <= 24 ? 'float4' : 'float8'; break;
        case 'nchar': col.type = 'nvarchar'; col.len = a0 || 1; col.avg = a0 || 1; break;
        case 'decimal':
          col.type = 'decimal';
          col.len = forced ? forced.len : Number.isFinite(a0) ? a0 : 18;
          col.scale = forced ? forced.scale : Number.isFinite(a1) ? a1 : 0;
          break;
        case 'varchar': case 'nvarchar':
          if (max) { col.type = 'text'; } else { col.type = type; col.len = Number.isFinite(a0) ? a0 : 50; }
          break;
        case 'char': col.type = 'char'; col.len = Number.isFinite(a0) ? a0 : 1; break;
        case 'blob':
          col.type = 'blob';
          if (Number.isFinite(a0) && !/^(?:tiny|medium|long)?blob|image|bytea/.test(matched)) col.avg = a0;
          break;
        default: col.type = type;
      }
    }
    const tail = after.toLowerCase();
    if (/\bprimary\s+key\b/.test(tail)) { col.pk = true; col.nullable = false; }
    if (/\bnot\s+null\b/.test(tail)) col.nullable = false;
    col.nullable = col.nullable && !col.pk;
    col.__unique = /\bunique\b/.test(tail);
    return col;
  }

  function parseDDL(sqlText) {
    const warnings = [];
    const tables = [];
    const sql = sqlText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    const stmts = sql.split(';').map((x) => x.trim()).filter(Boolean);
    const find = (n) => tables.find((t) => t.name.toLowerCase() === n.toLowerCase());
    const pending = [];

    for (const st of stmts) {
      let m = st.match(/^create\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?temporary\s+|unlogged\s+|external\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$#.])+)\s*\(([\s\S]*)\)[^)]*$/i);
      if (m) {
        const t = DBS.newTable({ name: lastPart(m[1]), columns: [], indexes: [] });
        const pks = [];
        for (const part of splitTop(m[2])) {
          let pm = part.match(/^(?:constraint\s+\S+\s+)?primary\s+key\b[^(]*\(([^)]*)\)/i);
          if (pm) { pks.push(...colList(pm[1])); continue; }
          pm = part.match(/^(?:constraint\s+\S+\s+)?(unique)?\s*(?:key|index)?\s*(?:(?!\()\S+\s*)?\(([^)]*)\)/i);
          if (/^(?:constraint\s+\S+\s+)?(?:unique|key|index|fulltext|spatial)\b/i.test(part) && pm) {
            const nm = part.match(/^(?:constraint\s+\S+\s+)?(?:unique\s+)?(?:key|index)?\s*([^\s(]+)?\s*\(/i);
            const cols = colList(pm[2]);
            const nameGuess = nm && nm[1] && !/^(unique|key|index)$/i.test(nm[1]) ? unquote(nm[1]) : `ix_${t.name}_${t.indexes.length + 1}`;
            if (cols.length) t.indexes.push({ name: nameGuess, columns: cols, unique: /unique/i.test(part) });
            continue;
          }
          if (/^(?:constraint\s+\S+\s+)?(?:foreign|check|exclude|period|like)\b/i.test(part)) continue;
          if (/^constraint\b/i.test(part)) continue;
          const col = parseColumn(part, warnings, t.name);
          if (col) {
            if (col.__unique) t.indexes.push({ name: `uq_${t.name}_${col.name}`, columns: [col.name], unique: true });
            delete col.__unique;
            t.columns.push(col);
          }
        }
        pks.forEach((n) => {
          const c = t.columns.find((x) => x.name.toLowerCase() === n.toLowerCase());
          if (c) { c.pk = true; c.nullable = false; }
        });
        tables.push(t);
        continue;
      }
      m = st.match(/^create\s+(?:(unique|bitmap|fulltext|clustered|nonclustered)\s+)*index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\S+)\s+on\s+(?:only\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$#.])+)\s*(?:using\s+\w+\s*)?\(([\s\S]*?)\)(?:\s+include\s*\(([^)]*)\))?/i);
      if (m) {
        pending.push({ table: lastPart(m[3]), ix: { name: unquote(m[2]), columns: colList(m[4]).concat(m[5] ? colList(m[5]) : []), unique: /\bunique\b/i.test(st.slice(0, 30)) } });
        continue;
      }
      m = st.match(/^alter\s+table\s+(?:only\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$#.])+)\s+add\s+(?:constraint\s+\S+\s+)?primary\s+key\b[^(]*\(([^)]*)\)/i);
      if (m) { pending.push({ table: lastPart(m[1]), pk: colList(m[2]) }); continue; }
      if (/^create\s/i.test(st) && !/^create\s+(?:or\s+replace\s+)?(?:view|sequence|function|procedure|trigger|schema|extension|type|database|materialized)/i.test(st)) {
        warnings.push(`Skipped unrecognised statement: ${st.slice(0, 60).replace(/\s+/g, ' ')}…`);
      }
    }
    for (const p of pending) {
      const t = find(p.table);
      if (!t) { warnings.push(`Index/constraint references unknown table "${p.table}".`); continue; }
      if (p.pk) p.pk.forEach((n) => { const c = t.columns.find((x) => x.name.toLowerCase() === n.toLowerCase()); if (c) { c.pk = true; c.nullable = false; } });
      if (p.ix && p.ix.columns.length) t.indexes.push(p.ix);
    }
    if (!tables.length) warnings.push('No CREATE TABLE statements were found.');
    return { tables, warnings };
  }

  DBS.parseDDL = parseDDL;
})(typeof window !== 'undefined' ? window : globalThis);
