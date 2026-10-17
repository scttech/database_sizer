/* d3-based charts. Colours come from CSS variables so light/dark themes just work. */
(function (g) {
  'use strict';
  const DBS = (g.DBS = g.DBS || {});
  const fb = (b) => DBS.fmtBytes(b);

  function setup(el, height, margin) {
    const w = Math.max(280, el.clientWidth || 520);
    el.textContent = '';
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${height}`).attr('role', 'img');
    const inner = svg.append('g').attr('transform', `translate(${margin.l},${margin.t})`);
    return { svg, inner, iw: w - margin.l - margin.r, ih: height - margin.t - margin.b };
  }
  function legend(el, items) {
    const d = document.createElement('div');
    d.className = 'legend';
    d.innerHTML = items.map(([c, l]) => `<span><i style="background:var(${c})"></i>${l}</span>`).join('');
    el.prepend(d);
  }
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // Horizontal stacked bars: data vs. index per table.
  function tableChart(el, tables) {
    const rows = tables.filter((t) => t.totalBytes > 0).sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 15);
    if (!rows.length) { el.innerHTML = '<div class="empty">Add tables with columns and a row count to see sizes.</div>'; return; }
    const bar = 22;
    const { svg, inner, iw } = setup(el, rows.length * (bar + 8) + 34, { t: 4, r: 70, b: 24, l: 110 });
    const x = d3.scaleLinear([0, d3.max(rows, (d) => d.totalBytes)], [0, iw]).nice();
    const y = d3.scaleBand(rows.map((d) => d.name), [0, rows.length * (bar + 8)]).padding(0.25);
    inner.append('g').attr('class', 'grid').call(d3.axisBottom(x).ticks(4).tickSize(rows.length * (bar + 8)).tickFormat('')).select('.domain').remove();
    inner.append('g').attr('class', 'axis').attr('transform', `translate(0,${rows.length * (bar + 8)})`).call(d3.axisBottom(x).ticks(4).tickFormat(fb));
    const g1 = inner.selectAll('.r').data(rows).join('g').attr('transform', (d) => `translate(0,${y(d.name)})`);
    g1.append('rect').attr('height', y.bandwidth()).attr('width', (d) => x(d.dataBytes)).style('fill', 'var(--c-data)')
      .append('title').text((d) => `${d.name}: data ${fb(d.dataBytes)}`);
    g1.append('rect').attr('x', (d) => x(d.dataBytes)).attr('height', y.bandwidth()).attr('width', (d) => x(d.indexBytes)).style('fill', 'var(--c-index)')
      .append('title').text((d) => `${d.name}: indexes ${fb(d.indexBytes)}`);
    g1.append('text').attr('x', -6).attr('y', y.bandwidth() / 2).attr('dy', '0.35em').attr('text-anchor', 'end').text((d) => trunc(d.name, 16));
    g1.append('text').attr('x', (d) => x(d.totalBytes) + 5).attr('y', y.bandwidth() / 2).attr('dy', '0.35em').text((d) => fb(d.totalBytes));
    legend(el, [['--c-data', 'Table data'], ['--c-index', 'Indexes']]);
  }

  // Lines for disk (per node) and memory over the projection horizon.
  function growthChart(el, pts) {
    if (!pts.length || pts[pts.length - 1].disk <= 0) { el.innerHTML = '<div class="empty">Nothing to project yet.</div>'; return; }
    const { svg, inner, iw, ih } = setup(el, 220, { t: 10, r: 16, b: 28, l: 66 });
    const x = d3.scaleLinear([0, Math.max(1, pts.length - 1)], [0, iw]);
    const y = d3.scaleLinear([0, d3.max(pts, (d) => Math.max(d.disk, d.mem))], [ih, 0]).nice();
    inner.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(4).tickSize(-iw).tickFormat('')).select('.domain').remove();
    inner.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(4).tickFormat(fb));
    inner.append('g').attr('class', 'axis').attr('transform', `translate(0,${ih})`)
      .call(d3.axisBottom(x).ticks(pts.length - 1 || 1).tickFormat((i) => (i === 0 ? 'Now' : `Yr ${i}`)));
    [['disk', '--c-data', 'Disk'], ['mem', '--c-mem', 'Memory']].forEach(([k, c, label]) => {
      const line = d3.line().x((d, i) => x(i)).y((d) => y(d[k]));
      inner.append('path').datum(pts).attr('fill', 'none').style('stroke', `var(${c})`).attr('stroke-width', 2.5).attr('d', line);
      inner.selectAll(`.p-${k}`).data(pts).join('circle').attr('cx', (d, i) => x(i)).attr('cy', (d) => y(d[k])).attr('r', 4).style('fill', `var(${c})`)
        .append('title').text((d, i) => `${label}, ${i === 0 ? 'now' : 'year ' + i}: ${fb(d[k])}`);
    });
    legend(el, [['--c-data', 'Disk per node'], ['--c-mem', 'Memory']]);
  }

  // Grouped horizontal bars comparing vendors (disk per node and memory).
  function vendorChart(el, list, selected) {
    if (!list.length || list.every((d) => d.disk <= 0)) { el.innerHTML = '<div class="empty">Nothing to compare yet.</div>'; return; }
    const h = 36;
    const { svg, inner, iw } = setup(el, list.length * (h * 2 + 18) + 30, { t: 4, r: 70, b: 24, l: 120 });
    const x = d3.scaleLinear([0, d3.max(list, (d) => Math.max(d.disk, d.mem))], [0, iw]).nice();
    const y = d3.scaleBand(list.map((d) => d.id), [0, list.length * (h * 2 + 18)]).padding(0.15);
    inner.append('g').attr('class', 'axis').attr('transform', `translate(0,${y.range()[1]})`).call(d3.axisBottom(x).ticks(4).tickFormat(fb));
    const gr = inner.selectAll('.v').data(list).join('g').attr('transform', (d) => `translate(0,${y(d.id)})`);
    const bh = y.bandwidth() / 2 - 2;
    gr.append('text').attr('x', -6).attr('y', y.bandwidth() / 2).attr('dy', '0.35em').attr('text-anchor', 'end')
      .attr('font-weight', (d) => (d.id === selected ? 700 : 400)).text((d) => d.label.replace(/ \(.*\)/, ''));
    [['disk', '--c-data', 0], ['mem', '--c-mem', 1]].forEach(([k, c, i]) => {
      gr.append('rect').attr('y', i * (bh + 4)).attr('height', bh).attr('width', (d) => x(d[k])).style('fill', `var(${c})`)
        .attr('opacity', (d) => (d.id === selected ? 1 : 0.65)).append('title').text((d) => `${d.label}: ${fb(d[k])}`);
      gr.append('text').attr('x', (d) => x(d[k]) + 5).attr('y', i * (bh + 4) + bh / 2).attr('dy', '0.35em').text((d) => fb(d[k]));
    });
    legend(el, [['--c-data', 'Disk per node'], ['--c-mem', 'Memory']]);
  }

  DBS.charts = { tableChart, growthChart, vendorChart };
})(window);
