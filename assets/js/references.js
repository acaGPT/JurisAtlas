/* 《法理学》文献库 —— 页面逻辑
   用途：读取文献数据层，渲染可检索、可筛选的文献列表，并导出 BibTeX / RIS。
   用法：由 references.html 以 <script> 引入；数据取自 assets/data/*.json。
*/

(function () {
  'use strict';

  var DATA_DIR = 'assets/data/';
  var THEME_KEY = 'jcm-theme';
  var DEBOUNCE_MS = 110;
  /* 仅 1 条的渠道归入长尾、默认折叠：全部平铺有 30 余个筛选项，长尾占多数却几乎点不到 */
  var CHANNEL_TAIL_MAX = 1;

  var state = { q: '', kind: 'all', access: 'all', channel: 'all', unit: 'all',
                sort: 'course', tailOpen: false };
  var items = [];
  var byId = new Map();          // 条目 id -> 条目（供复制引注取用）
  var chapterTitles = {};   // 章号 -> 中文题名（供分组头与条目悬停提示）
  var index = null;
  var timer = null;

  var el = {
    stats: document.getElementById('stats'),
    list: document.getElementById('list'),
    q: document.getElementById('q'),
    kindFilter: document.getElementById('kind-filter'),
    accessFilter: document.getElementById('access-filter'),
    channelFilter: document.getElementById('channel-filter'),
    unitFilter: document.getElementById('unit-filter'),
    sort: document.getElementById('sort'),
    count: document.getElementById('count'),
    reset: document.getElementById('reset'),
    theme: document.getElementById('theme'),
    exportBibtex: document.getElementById('export-bibtex'),
    exportRis: document.getElementById('export-ris')
  };

  var KIND_LABEL = { classic: '经典文献', further: '延伸阅读' };
  var KIND_LABEL_EN = { classic: 'Classic reference', further: 'Further reading' };
  var ACCESS_LABEL = { fulltext: '全文直读', locator: '需定位或订阅' };

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function highlight(text, query) {
    var safe = escapeHtml(text);
    if (!query) return safe;
    var re = new RegExp(escapeRegExp(escapeHtml(query)), 'gi');
    return safe.replace(re, function (hit) { return '<mark>' + hit + '</mark>'; });
  }

  function matches(item) {
    if (state.kind !== 'all' && item.kind !== state.kind) return false;
    if (state.access !== 'all' && item.access_kind !== state.access) return false;
    if (state.channel !== 'all' && item.access !== state.channel) return false;
    if (state.unit !== 'all' && String(item.unit) !== state.unit) return false;
    if (!state.q) return true;
    return index.get(item.id).indexOf(state.q.toLowerCase()) !== -1;
  }

  function sorted(list) {
    var copy = list.slice();
    if (state.sort === 'author') {
      copy.sort(function (a, b) {
        var an = (a.author || '\uffff').toLowerCase();
        var bn = (b.author || '\uffff').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : a.title.localeCompare(b.title);
      });
    } else if (state.sort === 'year') {
      copy.sort(function (a, b) {
        var ay = a.year == null ? 9999 : a.year;
        var by = b.year == null ? 9999 : b.year;
        return ay - by || a.title.localeCompare(b.title);
      });
    }
    /* course 排序直接沿用数据层顺序（已按单元、章、小节组织） */
    return copy;
  }

  function itemHtml(item) {
    var meta = [];
    if (item.author) meta.push(escapeHtml(item.author));
    if (item.year != null) meta.push('<span class="year">' + item.year + '</span>');
    if (item.parsed === false) meta.push('<span class="warn">原文照录</span>');

    var badge = item.chapter
      ? '<a class="code" href="index.html#unit-' + item.unit + '" ' +
        'title="' + escapeHtml(chapterTitles[item.chapter] || '') + '">' + item.chapter + '</a>'
      : '';

    var avatar = item.avatar
      ? '<img class="ref-avatar" src="' + escapeHtml(item.avatar) + '" alt="" loading="lazy">'
      : '';

    var access = item.access_url
      ? '<a class="channel" href="' + escapeHtml(item.access_url) +
        '" target="_blank" rel="noopener">' + escapeHtml(item.access) + '</a>'
      : '<span class="channel">' + escapeHtml(item.access) + '</span>';

    var kind = '<span class="kind kind-' + item.kind + '">' + KIND_LABEL[item.kind] + '</span>';
    var kindTip = '<span class="kind-en">' + KIND_LABEL_EN[item.kind] + '</span>';

    /* 条目有解析缺陷时以原始行渲染，保证不丢信息 */
    var body = item.parsed === false
      ? '<p class="ref-title">' + highlight(item.raw, state.q) + '</p>'
      : '<p class="ref-title">' +
        (meta.length ? '<span class="ref-meta">' + meta.join(' · ') + '</span> ' : '') +
        highlight(item.title, state.q) + '</p>';

    /* 同一著作在多章出现时标出共引，拼阅读清单时可据此去重 */
    var dup = item.dup_count > 1
      ? '<span class="dup" title="亦见于 ' +
        escapeHtml((item.dup_chapters || []).join('、')) + '">' +
        item.dup_count + ' 章共引</span>'
      : '';

    var cite = '<span class="cite">' +
      '<button type="button" data-cite="apa" data-id="' + escapeHtml(item.id) +
      '" title="复制 APA 引注">APA</button>' +
      '<button type="button" data-cite="mla" data-id="' + escapeHtml(item.id) +
      '" title="复制 MLA 引注">MLA</button></span>';

    return '<li class="ref-item">' +
      '<div class="ref-side">' + avatar + badge + kind + kindTip + '</div>' +
      '<div class="ref-main">' + body +
      '<p class="ref-foot">' + dup + access +
      '<span class="access-kind">' + (ACCESS_LABEL[item.access_kind] || '') + '</span>' +
      cite + '</p>' +
      '</div></li>';
  }

  function groupLabel(item) {
    if (state.sort === 'author') {
      var letter = (item.author || '其他').trim().toUpperCase().charAt(0);
      return /^[A-Z]$/.test(letter) ? letter : '其他';
    }
    if (state.sort === 'year') {
      return item.year == null ? '年份不详' : String(item.year) + ' 年';
    }
    return item.chapter;
  }

  function chapterHead(code) {
    var title = chapterTitles[code];
    return '<span class="code">' + code + '</span>' +
      '<h2>' + escapeHtml(title || '') + '</h2>' +
      '<a class="unit-en" href="https://github.com/acaGPT/Jurisprudence/wiki/Course-Syllabus">大纲原文 →</a>';
  }

  function render() {
    /* 过滤后再排序：course 排序即数据层原序（已按单元、章、小节组织） */
    var visible = sorted(items.filter(matches));
    var html = '';

    if (state.sort === 'course') {
      /* 课程结构：按数据层原序分组到章；作者/年份排序的组在下面处理 */
      var current = null;
      var open = false;
      visible.forEach(function (item) {
        if (item.chapter !== current) {
          if (open) html += '</ul></section>';
          current = item.chapter;
          html += '<section class="ref-group"><div class="unit-head">' +
            chapterHead(current) + '</div><ul class="ref-list">';
          open = true;
        }
        html += itemHtml(item);
      });
      if (open) html += '</ul></section>';
    } else {
      var groups = new Map();
      visible.forEach(function (item) {
        var key = groupLabel(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
      groups.forEach(function (group, key) {
        html += '<section class="ref-group"><div class="unit-head">' +
          '<h2>' + escapeHtml(key) + '</h2>' +
          '<span class="unit-en">' + group.length + ' 条</span>' +
          '</div><ul class="ref-list">' +
          group.map(itemHtml).join('') + '</ul></section>';
      });
    }

    el.list.innerHTML = html ||
      '<p class="empty">没有符合条件的文献。可换个关键词，或点「清除筛选」恢复全部。</p>';
    el.count.textContent = '显示 ' + visible.length + ' / ' + items.length + ' 条' +
      (state.sort === 'course' ? '（按课程结构分组）' : '');
    el.reset.hidden = state.q === '' && state.kind === 'all' &&
      state.access === 'all' && state.channel === 'all' && state.unit === 'all';
  }

  function chip(label, value, count, pressed, name, title) {
    return '<button type="button" data-' + name + '="' + escapeHtml(value) + '"' +
      (title ? ' title="' + escapeHtml(title) + '"' : '') +
      ' aria-pressed="' + pressed + '">' + label +
      (count == null ? '' : '<span class="num">' + count + '</span>') + '</button>';
  }

  function renderChips() {
    var units = [];
    items.forEach(function (item) {
      if (units.indexOf(item.unit) === -1) units.push(item.unit);
    });
    units.sort(function (a, b) { return a - b; });

    var channels = [];
    items.forEach(function (item) {
      if (channels.indexOf(item.access) === -1) channels.push(item.access);
    });
    channels.sort(function (a, b) {
      var ca = items.filter(function (i) { return i.access === a; }).length;
      var cb = items.filter(function (i) { return i.access === b; }).length;
      return cb - ca || a.localeCompare(b);
    });

    function countBy(name, value) {
      return items.filter(function (i) {
        return state.q === '' || index.get(i.id).indexOf(state.q.toLowerCase()) !== -1;
      }).filter(function (i) {
        if (name !== 'kind' && state.kind !== 'all' && i.kind !== state.kind) return false;
        if (name !== 'access' && state.access !== 'all' && i.access_kind !== state.access) return false;
        if (name !== 'unit' && state.unit !== 'all' && String(i.unit) !== state.unit) return false;
        if (name !== 'channel' && state.channel !== 'all' && i.access !== state.channel) return false;
        var target = name === 'kind' ? i.kind
          : name === 'access' ? i.access_kind
          : name === 'unit' ? String(i.unit)
          : i.access;
        return String(target) === String(value);
      }).length;
    }

    var classicCount = countBy('kind', 'classic');
    var furtherCount = countBy('kind', 'further');
    el.kindFilter.innerHTML =
      chip('全部类型', 'all', classicCount + furtherCount, state.kind === 'all' ? 'true' : 'false', 'kind') +
      chip('经典文献', 'classic', classicCount, state.kind === 'classic' ? 'true' : 'false', 'kind') +
      chip('延伸阅读', 'further', furtherCount, state.kind === 'further' ? 'true' : 'false', 'kind');

    var fullCount = countBy('access', 'fulltext');
    var locatorCount = countBy('access', 'locator');
    el.accessFilter.innerHTML =
      chip('全部获取方式', 'all', null, state.access === 'all' ? 'true' : 'false', 'access') +
      chip('全文直读', 'fulltext', fullCount, state.access === 'fulltext' ? 'true' : 'false', 'access') +
      chip('需定位或订阅', 'locator', locatorCount, state.access === 'locator' ? 'true' : 'false', 'access');

    /* 长尾渠道（条目数 <= CHANNEL_TAIL_MAX）默认折叠；选中了长尾渠道时自动展开，
       否则用户筛完会看不到自己选中的那一项 */
    var totalByChannel = {};
    items.forEach(function (item) {
      totalByChannel[item.access] = (totalByChannel[item.access] || 0) + 1;
    });
    var headChannels = channels.filter(function (name) {
      return totalByChannel[name] > CHANNEL_TAIL_MAX;
    });
    var tailChannels = channels.filter(function (name) {
      return totalByChannel[name] <= CHANNEL_TAIL_MAX;
    });
    var showTail = state.tailOpen || tailChannels.indexOf(state.channel) !== -1;

    function channelChips(list) {
      return list.map(function (name) {
        return chip(name, name, countBy('channel', name),
          state.channel === name ? 'true' : 'false', 'channel');
      }).join('');
    }

    el.channelFilter.innerHTML =
      chip('全部渠道', 'all', null, state.channel === 'all' ? 'true' : 'false', 'channel') +
      channelChips(headChannels) +
      (tailChannels.length
        ? '<button type="button" class="tail-toggle" data-tail="1" ' +
          'aria-expanded="' + showTail + '">' +
          (showTail ? '收起长尾渠道' : '展开其余 ' + tailChannels.length + ' 个渠道') +
          '</button>' + (showTail ? channelChips(tailChannels) : '')
        : '');

    el.unitFilter.innerHTML =
      chip('全部单元', 'all', null, state.unit === 'all' ? 'true' : 'false', 'unit') +
      units.map(function (num) {
        return chip(num, String(num), countBy('unit', String(num)),
          state.unit === String(num) ? 'true' : 'false', 'unit');
      }).join('');
  }

  function renderStats() {
    var stats = items.reduce(function (acc, item) {
      acc.total += 1;
      acc[item.kind] += 1;
      acc[item.access_kind] += 1;
      return acc;
    }, { total: 0, classic: 0, further: 0, fulltext: 0, locator: 0 });

    var pairs = [
      ['文献总数', stats.total],
      ['经典文献', stats.classic],
      ['延伸阅读', stats.further],
      ['全文直读', stats.fulltext],
      ['需定位或订阅', stats.locator]
    ];
    el.stats.innerHTML = pairs.map(function (pair) {
      return '<div><dt>' + pair[0] + '</dt><dd>' + pair[1] + '</dd></div>';
    }).join('');
  }

  function buildIndex() {
    index = new Map();
    items.forEach(function (item) {
      index.set(item.id, [
        item.author, item.title, item.year, item.access,
        KIND_LABEL[item.kind], item.raw
      ].join(' ').toLowerCase());
    });
  }

  /* ---------- 导出：固定导出全部条目，不随筛选变化 ---------- */

  function bibtexType(entryType) {
    if (entryType === 'book') return 'book';
    if (entryType === 'article') return 'article';
    return 'misc';
  }

  function bibtexEntry(item) {
    var lines = ['@' + bibtexType(item.entry_type) + '{' + item.id + ','];
    if (item.author) lines.push('  author = {' + item.author.replace(/(?<![A-Z]) and /gi, ' and ') + '}');
    if (item.year != null) lines.push('  year = {' + item.year + '}');
    lines.push('  title = {' + item.title + '}');
    if (item.access_url) lines.push('  url = {' + item.access_url + '}');
    lines.push('  note = {' + KIND_LABEL[item.kind] + '（' + item.chapter + '）；获取：' + item.access + '}');
    lines.push('}');
    return lines.join('\n');
  }

  function risEntry(item) {
    var type = item.entry_type === 'book' ? 'BOOK'
      : item.entry_type === 'article' ? 'JOUR' : 'ELEC';
    var lines = ['TY  - ' + type];
    if (item.author) lines.push('AU  - ' + item.author);
    if (item.year != null) lines.push('PY  - ' + item.year);
    lines.push('TI  - ' + item.title);
    if (item.access_url) lines.push('UR  - ' + item.access_url);
    lines.push('N1  - ' + KIND_LABEL[item.kind] + '（' + item.chapter + '）；获取：' + item.access);
    lines.push('ER  - ');
    return lines.join('\r\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  /* ---------- 单条引注：APA / MLA，纯客户端生成并写入剪贴板 ---------- */

  function plainText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function citation(item, style) {
    /* 解析失败的条目没有作者与题名，退回原始行的纯文本，保证复制出去仍是可用信息 */
    var author = item.author || '';
    var title = item.title || plainText(item.raw);
    var year = item.year == null ? '' : String(item.year);
    if (!author && !title) return plainText(item.raw);

    if (style === 'mla') {
      return [author ? author + '.' : '', title ? title + '.' : '',
              year ? year + '.' : '',
              item.access_url ? item.access_url + '.' : '']
        .filter(Boolean).join(' ');
    }
    return [author ? author + (year ? ' (' + year + ').' : '.')
                   : (year ? '(' + year + ').' : ''),
            title ? title + '.' : '',
            item.access_url || ''].filter(Boolean).join(' ');
  }

  function copyText(text, button) {
    function done(ok) {
      var original = button.getAttribute('data-label') || button.textContent;
      button.setAttribute('data-label', original);
      button.textContent = ok ? '已复制' : '复制失败';
      window.setTimeout(function () { button.textContent = original; }, 1200);
    }

    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
      document.body.removeChild(area);
      done(ok);
    }

    /* 剪贴板 API 需要安全上下文（https 或 localhost）；不满足时退回 execCommand */
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        done(true);
      }, fallback);
      return;
    }
    fallback();
  }

  /* ---------- 主题 ---------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el.theme.textContent = theme === 'dark' ? '浅色' : '深色';
    localStorage.setItem(THEME_KEY, theme);
  }

  function initTheme() {
    var stored = localStorage.getItem(THEME_KEY);
    if (stored !== 'light' && stored !== 'dark') {
      stored = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(stored);
  }

  function bindEvents() {
    el.q.addEventListener('input', function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        state.q = el.q.value.trim();
        renderChips();
        render();
      }, DEBOUNCE_MS);
    });

    [['kindFilter', 'kind'], ['accessFilter', 'access'],
     ['channelFilter', 'channel'], ['unitFilter', 'unit']].forEach(function (pair) {
      el[pair[0]].addEventListener('click', function (event) {
        var button = event.target.closest('button[data-' + pair[1] + ']');
        if (!button) return;
        state[pair[1]] = button.getAttribute('data-' + pair[1]);
        renderChips();
        render();
      });
    });

    el.channelFilter.addEventListener('click', function (event) {
      if (!event.target.closest('button[data-tail]')) return;
      state.tailOpen = !state.tailOpen;
      renderChips();
    });

    el.list.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-cite]');
      if (!button) return;
      var item = byId.get(button.getAttribute('data-id'));
      if (item) copyText(citation(item, button.getAttribute('data-cite')), button);
    });

    el.sort.addEventListener('change', function () {
      state.sort = el.sort.value;
      render();
    });

    el.reset.addEventListener('click', function () {
      state.q = '';
      state.kind = 'all';
      state.access = 'all';
      state.channel = 'all';
      state.unit = 'all';
      el.q.value = '';
      renderChips();
      render();
      el.q.focus();
    });

    el.exportBibtex.addEventListener('click', function () {
      download('jurisprudence-references.bib',
        items.map(bibtexEntry).join('\n\n') + '\n', 'application/x-bibtex');
    });

    el.exportRis.addEventListener('click', function () {
      download('jurisprudence-references.ris',
        items.map(risEntry).join('\r\n\r\n') + '\r\n', 'application/x-research-info-systems');
    });

    el.theme.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'light' : 'dark';
      applyTheme(next);
    });

    document.addEventListener('keydown', function (event) {
      var active = document.activeElement;
      var typing = !!active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        el.q.focus();
      } else if (event.key === 'Escape' && typing) {
        el.q.value = '';
        state.q = '';
        el.q.blur();
        renderChips();
        render();
      }
    });
  }

  function boot() {
    initTheme();
    bindEvents();

    Promise.all([
      fetch(DATA_DIR + 'references.json').then(function (r) { return r.json(); }),
      fetch(DATA_DIR + 'syllabus.json').then(function (r) { return r.json(); })
    ]).then(function (results) {
      items = results[0].items;
      byId = new Map();
      items.forEach(function (item) { byId.set(item.id, item); });
      results[1].chapters.forEach(function (chapter) {
        chapterTitles[chapter.code] = chapter.title_zh;
      });
      buildIndex();
      renderStats();
      renderChips();
      render();
    }).catch(function () {
      el.list.innerHTML = '<p class="empty">文献数据层未能载入。　可直接前往 ' +
        '<a href="https://github.com/acaGPT/Jurisprudence/wiki/Course-Syllabus">课程 Wiki 大纲</a>。</p>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
