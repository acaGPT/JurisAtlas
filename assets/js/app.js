/* 《法理学》课程地图 —— 页面逻辑
   用途：读取数据层，渲染单元与章节卡片，并提供检索、筛选与主题切换。
   用法：由 index.html 以 <script> 引入；数据取自 assets/data/*.json。
*/

(function () {
  'use strict';

  var DATA_DIR = 'assets/data/';
  var THEME_KEY = 'jcm-theme';
  var CLAMP_AT = 200;
  var DEBOUNCE_MS = 110;
  var NUMERALS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  var state = { q: '', unit: 'all', cover: 'all' };
  var dataset = null;
  var index = null;
  var showEn = false;
  var timer = null;

  var el = {
    stats: document.getElementById('stats'),
    units: document.getElementById('units'),
    q: document.getElementById('q'),
    unitFilter: document.getElementById('unit-filter'),
    coverFilter: document.getElementById('cover-filter'),
    count: document.getElementById('count'),
    reset: document.getElementById('reset'),
    toggleEn: document.getElementById('toggle-en'),
    theme: document.getElementById('theme')
  };

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function plainText(html) {
    return String(html).replace(/<[^>]+>/g, '');
  }

  /* 在文本节点内标记命中词；跳过标签本身，避免破坏 <em> 等结构。 */
  function highlight(html, query) {
    if (!query) return html;
    var re = new RegExp(escapeRegExp(query), 'gi');
    return String(html)
      .split(/(<[^>]+>)/)
      .map(function (segment) {
        if (!segment || segment.charAt(0) === '<') return segment;
        return segment.replace(re, function (hit) {
          return '\u0001' + hit + '\u0002';
        });
      })
      .join('')
      .replace(/\u0001/g, '<mark>')
      .replace(/\u0002/g, '</mark>');
  }

  function matches(chapter) {
    if (state.unit !== 'all' && String(chapter.unit) !== state.unit) return false;
    if (state.cover !== 'all' && (chapter.preclass ? 'has' : 'todo') !== state.cover) {
      return false;
    }
    if (!state.q) return true;
    return index.get(chapter.code).indexOf(state.q.toLowerCase()) !== -1;
  }

  function cardHtml(chapter) {
    var has = !!chapter.preclass;
    var url = has ? chapter.preclass.url : chapter.syllabus_url;
    var action = has ? '阅读课前概览' : '查看大纲条目';
    var descClass = plainText(chapter.desc_zh).length > CLAMP_AT ? 'desc clamp' : 'desc';

    return '<article class="card" data-unit="' + chapter.unit + '"' +
      ' data-cover="' + (has ? 'has' : 'todo') + '">' +
      '<div class="card-top">' +
      '<span class="code">' + chapter.code + '</span>' +
      '<span class="badge ' + (has ? 'has' : 'todo') + '">' +
      (has ? '已有课前概览' : '课前概览待撰写') + '</span>' +
      '</div>' +
      '<h3><a href="' + url + '">' + highlight(chapter.title_zh, state.q) + '</a></h3>' +
      '<p class="en-title">' + highlight(chapter.title_en, state.q) + '</p>' +
      '<p class="' + descClass + '">' + highlight(chapter.desc_zh, state.q) + '</p>' +
      '<details class="en"' + (showEn ? ' open' : '') + '><summary>English</summary>' +
      '<p>' + highlight(chapter.desc_en, state.q) + '</p></details>' +
      '<div class="card-foot">' +
      '<span>经典文献 ' + chapter.refs_count + '</span>' +
      '<span>延伸阅读 ' + chapter.further_count + '</span>' +
      '<a class="go" href="' + url + '">' + action + ' →</a>' +
      '</div>' +
      '</article>';
  }

  function unitHtml(unit, chapters) {
    return '<section class="unit" id="unit-' + unit.num + '">' +
      '<div class="unit-head">' +
      '<span class="unit-num">第' + NUMERALS[unit.num] + '单元</span>' +
      '<h2>' + unit.title_zh + '</h2>' +
      '<span class="unit-en">' + unit.title_en + '</span>' +
      '</div>' +
      '<div class="cards">' + chapters.map(cardHtml).join('') + '</div>' +
      '</section>';
  }

  function render() {
    var visible = 0;
    var html = '';

    dataset.units.forEach(function (unit) {
      var chapters = dataset.chapters.filter(function (chapter) {
        return chapter.unit === unit.num && matches(chapter);
      });
      if (!chapters.length) return;
      visible += chapters.length;
      html += unitHtml(unit, chapters);
    });

    el.units.innerHTML = html || '<p class="empty">没有符合条件的章节。' +
      '可换个关键词，或点「清除筛选」恢复全部。</p>';

    el.count.textContent = '显示 ' + visible + ' / ' + dataset.chapters.length + ' 章';
    el.reset.hidden = state.q === '' && state.unit === 'all' && state.cover === 'all';
  }

  function chip(label, value, count, pressed, datasetName, title) {
    return '<button type="button" data-' + datasetName + '="' + value + '"' +
      (title ? ' title="' + title + '"' : '') +
      ' aria-pressed="' + pressed + '">' + label +
      (count == null ? '' : '<span class="num">' + count + '</span>') + '</button>';
  }

  function renderChips() {
    var total = dataset.chapters.length;
    var hasCount = dataset.chapters.filter(function (c) { return c.preclass; }).length;

    el.unitFilter.innerHTML =
      chip('全部', 'all', total, state.unit === 'all' ? 'true' : 'false', 'unit') +
      dataset.units.map(function (unit) {
        var n = dataset.chapters.filter(function (c) { return c.unit === unit.num; }).length;
        return chip(NUMERALS[unit.num], String(unit.num), n,
          state.unit === String(unit.num) ? 'true' : 'false', 'unit', unit.title_zh);
      }).join('');

    el.coverFilter.innerHTML =
      chip('不限进度', 'all', null, state.cover === 'all' ? 'true' : 'false', 'cover') +
      chip('已有课前概览', 'has', hasCount, state.cover === 'has' ? 'true' : 'false', 'cover') +
      chip('待撰写', 'todo', total - hasCount,
        state.cover === 'todo' ? 'true' : 'false', 'cover');
  }

  function renderStats(meta) {
    var items = [
      ['单元', meta.stats.units],
      ['章', meta.stats.chapters],
      ['经典文献', meta.stats.refs],
      ['延伸阅读', meta.stats.further],
      ['已有课前概览', meta.stats.preclass + ' / ' + meta.stats.chapters]
    ];
    el.stats.innerHTML = items.map(function (pair) {
      return '<div><dt>' + pair[0] + '</dt><dd>' + pair[1] + '</dd></div>';
    }).join('');
  }

  function buildIndex() {
    index = new Map();
    dataset.chapters.forEach(function (chapter) {
      index.set(chapter.code, [
        chapter.code, chapter.title_zh, chapter.title_en,
        chapter.desc_zh, chapter.desc_en
      ].map(plainText).join(' ').toLowerCase());
    });
  }

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
        render();
      }, DEBOUNCE_MS);
    });

    el.unitFilter.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-unit]');
      if (!button) return;
      state.unit = button.getAttribute('data-unit');
      renderChips();
      render();
      if (state.unit !== 'all') {
        var target = document.getElementById('unit-' + state.unit);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    el.coverFilter.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-cover]');
      if (!button) return;
      state.cover = button.getAttribute('data-cover');
      renderChips();
      render();
    });

    el.reset.addEventListener('click', function () {
      state.q = '';
      state.unit = 'all';
      state.cover = 'all';
      el.q.value = '';
      renderChips();
      render();
      el.q.focus();
    });

    el.toggleEn.addEventListener('click', function () {
      showEn = !showEn;
      el.toggleEn.setAttribute('aria-pressed', showEn ? 'true' : 'false');
      el.toggleEn.textContent = showEn ? '隐藏英文' : '显示英文';
      Array.prototype.forEach.call(
        el.units.querySelectorAll('details.en'),
        function (node) { node.open = showEn; }
      );
    });

    el.theme.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'light' : 'dark';
      applyTheme(next);
    });

    document.addEventListener('keydown', function (event) {
      var active = document.activeElement;
      var typing = !!active && /^(INPUT|TEXTAREA)$/.test(active.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        el.q.focus();
      } else if (event.key === 'Escape' && typing) {
        el.q.value = '';
        state.q = '';
        el.q.blur();
        render();
      }
    });
  }

  function fail(message) {
    el.units.innerHTML = '<p class="empty">' + message +
      '　可直接前往 <a href="https://github.com/acaGPT/Jurisprudence/wiki/Course-Syllabus">' +
      '课程 Wiki 大纲</a>。</p>';
  }

  function boot() {
    initTheme();
    bindEvents();

    Promise.all([
      fetch(DATA_DIR + 'syllabus.json').then(function (r) { return r.json(); }),
      fetch(DATA_DIR + 'meta.json').then(function (r) { return r.json(); })
    ]).then(function (results) {
      dataset = results[0];
      buildIndex();
      renderStats(results[1]);
      renderChips();
      render();
    }).catch(function () {
      fail('数据层未能载入。');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
