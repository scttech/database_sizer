/* Learning content: field help popovers and per-vendor storage notes.
 * Entries are { t: title, b: body HTML, v: { vendorId: extra HTML } }. Content is static and trusted. */
(function (g) {
  'use strict';
  const DBS = (g.DBS = g.DBS || {});

  const H = {
    vendor: {
      t: 'Database vendor',
      b: 'Each engine lays rows out on disk differently (page size, per-row headers, how indexes reference rows), so the same table can be a noticeably different size. The "Vendor comparison" chart shows your model on all four.',
    },
    rows: {
      t: 'Row count',
      b: 'The number of rows you expect in this table. Size scales roughly linearly with it. Suffixes work: <code>400k</code>, <code>2.5M</code>, <code>1b</code>. Tip: estimate for the peak you need to support, then use the growth setting for the future.',
    },
    col_type: {
      t: 'Column type',
      b: 'Types are generic and mapped to each vendor\'s closest native type (for example <em>timestamp</em> is <code>timestamptz</code>, <code>datetime2</code>, <code>DATETIME</code> or <code>TIMESTAMP</code>). Fixed-width types always cost the same; variable-width types (varchar, text, blob, json) cost what you actually store.',
      v: {
        oracle: 'Oracle has no native integer type: integers are <code>NUMBER</code>, which uses about one byte per two digits plus one.',
        postgres: 'PostgreSQL has no 1-byte integer, so <em>tinyint</em> uses 2 bytes.',
      },
    },
    col_len: {
      t: 'Length / precision',
      b: 'For <strong>char/varchar</strong> this is the declared maximum characters. For <strong>decimal</strong> it is the precision (total digits). A declared varchar maximum rarely changes the storage of a short value, but char(n) is always padded to n.',
    },
    col_scale: {
      t: 'Scale',
      b: 'Digits after the decimal point for decimal/numeric columns, e.g. <code>decimal(12,2)</code> has precision 12 and scale 2. It matters most for MySQL, which packs integer and fractional digits separately.',
    },
    col_avg: {
      t: 'Average length',
      b: 'The <em>typical actual</em> length of the value (characters for text, bytes for binary), not the maximum. A <code>varchar(255)</code> email column averages maybe 28. This is usually the most important number for variable-width columns. Blank uses a default (half the max, or 200 for text, 1024 for blob).',
    },
    col_null: {
      t: 'Nullable',
      b: 'Nullable columns need a NULL-bitmap bit per row in most engines. The estimate assumes values are stored (NULLs are not assumed to save space), which is slightly conservative.',
    },
    col_pk: {
      t: 'Primary key',
      b: 'Mark every column that is part of the primary key. This matters a lot: in <strong>MySQL InnoDB</strong> and <strong>SQL Server</strong> the table is stored <em>in</em> the primary key order and every other index repeats the key, so a wide key makes all indexes larger. In <strong>PostgreSQL</strong> and <strong>Oracle</strong> the key becomes a separate index.',
    },
    indexes: {
      t: 'Indexes',
      b: 'Secondary indexes are B-trees storing the indexed columns plus a pointer back to the row. Each one costs disk <em>and</em> memory, and slows writes. The primary key index is added for you where the engine uses a separate one.',
    },
    idx_cols: {
      t: 'Index columns',
      b: 'Comma-separated column names that exist in this table, e.g. <code>customer_id, placed_at</code>. Key size is the sum of the column sizes, so indexing a long varchar is expensive.',
    },
    idx_unique: {
      t: 'Unique',
      b: 'Recorded for documentation. Unique and non-unique indexes are sized the same here.',
    },

    bpc: {
      t: 'Bytes per character',
      b: 'How many bytes an average character of text takes. English/ASCII text is 1 byte in UTF-8; accented Latin about 1.1 to 2; CJK 3. <code>utf8mb4</code> allows 4 but typical data uses fewer. Does not affect nvarchar on SQL Server/Oracle, which use 2 bytes.',
    },
    dataFill: {
      t: 'Data page fill %',
      b: 'Pages are rarely packed 100% full. Engines reserve space for updates (PostgreSQL <em>fillfactor</em>, Oracle <em>PCTFREE</em>, SQL Server <em>fill factor</em>) or leave gaps after page splits. Leave blank for the vendor default.',
      v: { postgres: 'Default heap fillfactor is 100.', mysql: 'InnoDB keeps 1/16 of each page free (about 94%).', sqlserver: 'Default fill factor 0 means 100%.', oracle: 'Default PCTFREE is 10, so 90%.' },
    },
    indexFill: {
      t: 'Index page fill %',
      b: 'B-tree pages are fuller after a bulk build and emptier after random inserts and splits (often around 70 to 75%). Lower = bigger indexes. Leave blank for the vendor default.',
      v: { postgres: 'New B-tree leaves default to 90%.' },
    },
    comp: {
      t: 'Compression saving',
      b: 'Percent saved if you use table/page compression (PostgreSQL TOAST/LZ4, InnoDB page compression, SQL Server ROW/PAGE, Oracle Advanced Compression). Typical savings are 30 to 60% for text-heavy data, little for already-compressed blobs. Memory sizing ignores it because pages are cached uncompressed.',
    },
    frag: {
      t: 'Bloat / free space',
      b: 'Extra space beyond live data: dead rows awaiting cleanup, deleted-row gaps, unused extents, and room to grow. 10 to 30% is common on busy tables.',
      v: { postgres: 'MVCC keeps old row versions until VACUUM, so update-heavy tables bloat.', mysql: 'Undo and purge lag plus fragmentation after deletes.' },
    },
    logPct: {
      t: 'Transaction log space',
      b: 'Disk for the write-ahead log that makes commits durable and recoverable, as a percentage of storage. It depends on write rate and checkpoint/retention settings rather than data size, so treat this as a rough sizing.',
      v: { postgres: 'WAL (<code>pg_wal</code>), driven by <code>max_wal_size</code> and archiving.', mysql: 'Redo log, undo tablespaces and the binary log.', sqlserver: 'The transaction log (.ldf); grows with the recovery model and log backups.', oracle: 'Online redo, undo tablespace and archived redo logs.' },
    },
    tempPct: {
      t: 'Temp / sort space',
      b: 'Scratch disk for large sorts, hash joins, index builds and temp tables, as a percentage of storage.',
      v: { sqlserver: 'tempdb', oracle: 'TEMP tablespace', postgres: 'temp files and temp tables', mysql: 'tmpdir / temp tablespace' },
    },
    replicas: {
      t: 'Replicas',
      b: 'Number of additional full copies (standbys, read replicas, cluster nodes). Each replica needs roughly the same disk and memory as the primary node.',
    },
    backups: {
      t: 'Full backups retained',
      b: 'How many full backups you keep online. Incremental/log backups are not included.',
    },
    backupRatio: {
      t: 'Backup size %',
      b: 'Size of one backup as a percentage of storage. Compressed backups are often 30 to 50%; uncompressed dumps of text data can be similar because indexes are not stored in a logical dump.',
    },
    growth: {
      t: 'Annual growth',
      b: 'Percent increase in rows each year, compounded: after <em>n</em> years rows = rows × (1 + g)<sup>n</sup>. All tables grow at the same rate; adjust row counts for tables that behave differently.',
    },
    years: { t: 'Projection years', b: 'How far to project on the growth chart (1 to 10).' },
    hotPct: {
      t: 'Hot data (working set)',
      b: 'The share of table data accessed regularly. For good performance the working set should fit in the buffer cache; data outside it is read from disk on demand. Typical OLTP systems: 5 to 30%. Reporting that scans everything: closer to 100%.',
    },
    idxPct: {
      t: 'Index kept cached',
      b: 'The share of index pages to keep in memory. Indexes are accessed far more often than table data, so keeping all of them cached (100%) is a good starting point.',
    },
    connections: {
      t: 'Concurrent connections',
      b: 'Peak simultaneous sessions. Each session uses memory for sort/join work areas and session state.',
      v: { postgres: 'Each connection is a separate OS process; consider a pooler such as PgBouncer.' },
    },
    connMB: {
      t: 'Memory per connection',
      b: 'Memory per session. Depends on sort/work-area settings (<code>work_mem</code>, <code>sort_buffer_size</code>, PGA, workspace memory). Leave blank for the vendor default.',
    },
    baseMB: {
      t: 'Base / system overhead',
      b: 'Memory the engine needs even when idle: catalogs, lock tables, log buffers, query plan cache, background workers. Leave blank for the vendor default.',
    },

    tile_node: { t: 'Disk per node', b: 'Storage for one database server: table data + indexes (after compression and bloat) + transaction log + temp space.' },
    tile_total: { t: 'Whole deployment', b: 'Disk per node multiplied across replicas, plus retained backups.' },
    tile_mem: { t: 'Memory (RAM)', b: 'Buffer cache for the hot data and indexes, plus per-connection memory and base overhead. This is the database\'s own memory; leave headroom for the OS and file cache.' },
    tile_future: { t: 'Future disk', b: 'Disk per node after the projection period, using the annual growth rate.' },
    r_tables: { t: 'Size by table', b: 'Where the space goes. Blue is the table itself; orange is its indexes. If orange dominates, review whether every index is needed.' },
    r_growth: { t: 'Growth projection', b: 'Disk and memory over time. Sizes are recomputed at each year\'s row counts, not just scaled, because page rounding and index depth change as tables grow.' },
    r_disk: { t: 'Disk breakdown', b: 'How per-node disk is built up. "Storage" is data plus indexes after compression and bloat; log and temp are added on top.' },
    r_mem: { t: 'Memory breakdown', b: 'Cache for hot data and indexes plus fixed and per-connection overhead.' },
    r_detail: { t: 'Table details', b: '<strong>Row bytes</strong>: stored size of one row including headers and padding. <strong>Rows/page</strong>: how many fit on a page after fill factor. Indented lines are individual indexes with the size of one entry.' },
    r_vendors: { t: 'Vendor comparison', b: 'Your model estimated on each engine. Differences come from row headers, alignment, page sizes and how indexes point to rows.' },
  };

  const NOTES = {
    postgres: [
      '<strong>8 KB pages</strong>. Each row has a 23-byte header plus a 4-byte pointer, and the next column is padded to its alignment, so column order matters (put 8-byte columns first).',
      'The primary key is a separate B-tree; tables are heaps with no clustered order.',
      'Updates write a new row version. Old versions linger until <strong>VACUUM</strong> (bloat).',
      'Values over about 2 KB move to <strong>TOAST</strong> storage and may be compressed.',
      'Caching: <code>shared_buffers</code> plus the OS page cache.',
    ],
    mysql: [
      '<strong>16 KB pages</strong>. The table <em>is</em> a B-tree ordered by primary key (the clustered index).',
      'Every secondary index entry stores the <strong>primary key</strong> too, so a wide key inflates all indexes. With no key, a hidden 6-byte row id is used.',
      'Each row carries a 5-byte header, 6-byte transaction id and 7-byte rollback pointer.',
      'Long values spill to overflow pages (a full page each).',
      'Caching: the <code>innodb_buffer_pool_size</code>.',
    ],
    sqlserver: [
      '<strong>8 KB pages</strong>. A primary key is clustered by default: table data is stored in key order.',
      'Nonclustered index entries include the clustering key (or an 8-byte row id on a heap).',
      'Row header 4 bytes plus a null bitmap and an offset array for variable-length columns.',
      'Overflow values go to row-overflow or LOB pages.',
      'Caching: the buffer pool (<code>max server memory</code>).',
    ],
    oracle: [
      '<strong>8 KB blocks</strong> by default with <code>PCTFREE</code> 10% reserved for row growth.',
      '<code>NUMBER</code> is variable-length (about one byte per two digits). Every column has a 1-byte length prefix (3 over 250 bytes).',
      'Index entries hold the key plus a 6-byte <strong>ROWID</strong>.',
      'Large LOBs are stored out-of-line in chunks.',
      'Caching: the SGA buffer cache plus per-session PGA.',
    ],
  };

  DBS.HELP = H;
  DBS.VENDOR_NOTES = NOTES;
})(window);
