/* 《法理学》周报 —— 页面逻辑
   用途：读取周报数据层，渲染「主题 → 事件类型 → 条目」三层结构，并给每条挂
        Law / Tech 两个并列标签（默认 Law），标记存在浏览器本地，可导出交回。
   用法：由 weekly.html 以 <script> 引入；数据取自 assets/data/weekly*.json。
*/

(function () {
  'use strict';

  var DATA_DIR = 'assets/data/';
  var THEME_KEY = 'jcm-theme';
  var MARK_KEY_PREFIX = 'jcm-weekly-marks:';
  var DEBOUNCE_MS = 110;

  var state = { q: '', topic: 'all', mark: 'all' };
  /* id -> 'law' | 'tech'。没有键就是「没表过态」，页面按默认 Law 呈现。 */
  var marks = {};
  var markKey = '';
  var data = null;
  var meta = null;
  var timer = null;

  var el = {
    weekLine: document.getElementById('week-line'),
    stats: document.getElementById('stats'),
    overview: document.getElementById('overview'),
    topics: document.getElementById('topics'),
    q: document.getElementById('q'),
    topicFilter: document.getElementById('topic-filter'),
    markFilter: document.getElementById('mark-filter'),
    count: document.getElementById('count'),
    note: document.getElementById('mark-note'),
    toggleOverview: document.getElementById('toggle-overview'),
    copyLabels: document.getElementById('copy-labels'),
    downloadLabels: document.getElementById('download-labels'),
    resetLabels: document.getElementById('reset-labels'),
    theme: document.getElementById('theme'),
    wikiLink: document.getElementById('wiki-link'),
    provenance: document.getElementById('provenance')
  };

  var MARK_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'none', label: '未标记' },
    { key: 'law', label: '已标 Law' },
    { key: 'tech', label: '已标 Tech' }
  ];

  /* ---------------- 工具 ---------------- */

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function markOf(id) {
    return marks[id] || 'unset';
  }

  function loadMarks() {
    try {
      marks = JSON.parse(localStorage.getItem(markKey) || '{}') || {};
    } catch (error) {
      marks = {};
    }
  }

  function saveMarks() {
    try {
      localStorage.setItem(markKey, JSON.stringify(marks));
    } catch (error) {
      /* 隐私模式下列浏览器禁用写入：标记当次有效，不拦路 */
    }
  }

  function allItems() {
    var out = [];
    (data.topics || []).forEach(function (topic) {
      (topic.groups || []).forEach(function (group) {
        (group.items || []).forEach(function (item) {
          out.push({ topic: topic.name, group: group.name, item: item });
        });
      });
    });
    return out;
  }

  function countMarks() {
    var law = 0;
    var tech = 0;
    Object.keys(marks).forEach(function (id) {
      if (marks[id] === 'tech') { tech += 1; }
      else if (marks[id] === 'law') { law += 1; }
    });
    return { law: law, tech: tech, total: law + tech };
  }

  /* ---------------- 渲染 ---------------- */

  function renderHead() {
    el.weekLine.textContent = data.week_line || '';
    var period = data.period || {};
    if (period.start && period.end) {
      el.weekLine.textContent += '　·　' + period.start + ' — ' + period.end;
    }
    el.weekLine.className = 'week-line';

    var counts = data.counts || {};
    el.stats.innerHTML = [
      stat(counts.items, '条信息'),
      stat(counts.events, '件有后续的事'),
      stat(counts.topics, '个制度主题'),
      stat(Object.keys(marks).length, '条已标记')
    ].join('');

    el.overview.innerHTML = (data.overview || [])
      .map(function (para) { return '<p>' + esc(para) + '</p>'; })
      .join('');

    if (data.source_url) { el.wikiLink.href = data.source_url; }
  }

  /* 站点的 .stats 约定：dt 是名目（小字、靠右），dd 是数值（大字、靠左），
     靠 CSS 的 order 把数值提到前面。别按书写顺序想当然。 */
  function stat(value, label) {
    return '<div><dt>' + esc(label) + '</dt><dd>' +
      esc(value == null ? 0 : value) + '</dd></div>';
  }

  function stageSummary(item) {
    if (item.kind !== 'event' || !item.stages || !item.stages.length) {
      return item.date || '';
    }
    var dates = item.stages.map(function (stage) { return stage.date; });
    var first = dates[0];
    var last = dates[dates.length - 1];
    return first === last ? first : first + '—' + last;
  }

  function linksHtml(links) {
    return (links || []).map(function (link, index) {
      var label = index === 0 ? '原文' : '原文 ' + (index + 1);
      return '<a href="' + esc(link.url) + '" target="_blank" rel="noopener">' +
        esc(label) + '</a>';
    }).join('');
  }

  function haystackOf(entry) {
    var item = entry.item;
    var parts = [item.title, item.fact || '', item.source || '', entry.topic, entry.group];
    (item.stages || []).forEach(function (stage) {
      parts.push(stage.stage || '', stage.text || '');
    });
    (item.carried || []).forEach(function (step) { parts.push(step.title || ''); });
    return parts.join(' ').toLowerCase();
  }

  function itemHtml(entry) {
    var item = entry.item;
    var mark = markOf(item.id);
    var when = stageSummary(item);
    var head = '<div class="wk-top">' +
      (when ? '<span class="wk-when">' + esc(when) + '</span>' : '') +
      '<h4 class="wk-title">' + esc(item.title) + '</h4>' +
      '<div class="wk-mark" role="group" aria-label="这条属于哪一类">' +
        '<button type="button" data-label="law" aria-pressed="' +
          (mark !== 'tech' ? 'true' : 'false') + '">Law</button>' +
        '<button type="button" data-label="tech" aria-pressed="' +
          (mark === 'tech' ? 'true' : 'false') + '">Tech</button>' +
      '</div>' +
      '</div>';

    var body = '';
    /* 「此前」在本周时间线之前：先给出来龙，再给这一周走到哪一步。
       Wiki 那边同样是这个顺序（render_reader 先写 blockquote 再写阶段）。 */
    if (item.carried && item.carried.length) {
      body += item.carried.map(function (step) {
        return '<p class="wk-carried">此前 ' + esc(step.date) + '：' + esc(step.title) + '</p>';
      }).join('');
    }
    if (item.kind === 'event' && item.stages && item.stages.length) {
      body += '<ol class="wk-stages">' + item.stages.map(function (stage) {
        return '<li class="wk-stage"><span class="d">' + esc(stage.date) + '</span>' +
          (stage.stage ? '<span class="s">' + esc(stage.stage) + '</span>' : '') +
          esc(stage.text) + '</li>';
      }).join('') + '</ol>';
    }
    if (item.fact) { body += '<p class="wk-fact">' + esc(item.fact) + '</p>'; }

    var foot = '';
    if (item.source || (item.links && item.links.length)) {
      foot = '<p class="wk-foot">' +
        (item.source ? '<span class="wk-src">' + esc(item.source) + '</span>' : '') +
        linksHtml(item.links) + '</p>';
    }

    return '<li class="wk" data-id="' + esc(item.id) + '" data-mark="' + esc(mark) + '"' +
      ' data-haystack="' + esc(haystackOf(entry)) + '">' + head + body + foot + '</li>';
  }

  function renderTopics() {
    el.topics.innerHTML = (data.topics || []).map(function (topic) {
      var groups = (topic.groups || []).map(function (group) {
        var head = group.name
          ? '<h3 class="type-head">' + esc(group.name) +
            '<span class="num">' + group.items.length + '</span></h3>'
          : '';
        return head + '<ul class="wk-list">' +
          group.items.map(function (item) {
            return itemHtml({ topic: topic.name, group: group.name, item: item });
          }).join('') + '</ul>';
      }).join('');
      return '<section class="topic" data-topic="' + esc(topic.name) + '">' +
        '<div class="topic-head"><h2>' + esc(topic.name) + '</h2>' +
        '<span class="topic-count">' + (topic.count || 0) + ' 条</span></div>' +
        groups + '</section>';
    }).join('');
  }

  function renderFilters() {
    el.topicFilter.innerHTML = [{ name: 'all', count: data.counts.items }]
      .concat((data.topics || []).map(function (topic) {
        return { name: topic.name, count: topic.count || 0 };
      }))
      .map(function (entry) {
        var label = entry.name === 'all' ? '全部主题' : entry.name;
        return '<button type="button" data-topic="' + esc(entry.name) + '" aria-pressed="' +
          (state.topic === entry.name ? 'true' : 'false') + '">' + esc(label) +
          '<span class="num">' + entry.count + '</span></button>';
      }).join('');

    el.markFilter.innerHTML = MARK_FILTERS.map(function (entry) {
      return '<button type="button" data-mark-filter="' + entry.key + '" aria-pressed="' +
        (state.mark === entry.key ? 'true' : 'false') + '">' + esc(entry.label) + '</button>';
    }).join('');
  }

  /* ---------------- 筛选 ---------------- */

  function matches(item, haystack) {
    if (state.topic !== 'all' && item.dataset.topic !== state.topic) { return false; }
    var mark = item.dataset.mark;
    if (state.mark === 'none' && mark !== 'unset') { return false; }
    if (state.mark === 'law' && mark !== 'law') { return false; }
    if (state.mark === 'tech' && mark !== 'tech') { return false; }
    if (state.q && haystack.indexOf(state.q) === -1) { return false; }
    return true;
  }

  function applyFilters() {
    var shown = 0;
    var total = 0;
    Array.prototype.forEach.call(el.topics.querySelectorAll('.topic'), function (section) {
      var visibleInTopic = 0;
      Array.prototype.forEach.call(section.querySelectorAll('.wk'), function (item) {
        total += 1;
        item.dataset.topic = section.dataset.topic;
        var visible = matches(item, item.dataset.haystack || '');
        item.hidden = !visible;
        if (visible) { shown += 1; visibleInTopic += 1; }
      });
      /* 事件类型小标题跟着走：从本标题到下一个标题之间，一条都没剩下就一起收起 */
      Array.prototype.forEach.call(section.querySelectorAll('.type-head'), function (head) {
        var left = 0;
        var cursor = head.nextElementSibling;
        while (cursor && !cursor.classList.contains('type-head')) {
          if (cursor.classList.contains('wk-list')) {
            left += cursor.querySelectorAll('.wk:not([hidden])').length;
          }
          cursor = cursor.nextElementSibling;
        }
        head.hidden = left === 0;
      });
      section.hidden = visibleInTopic === 0;
    });

    var counts = countMarks();
    el.count.textContent = shown === total
      ? '共 ' + total + ' 条'
      : '显示 ' + shown + ' / ' + total + ' 条';
    if (counts.total) {
      el.note.hidden = false;
      el.note.innerHTML = '已标记 <strong>' + counts.total + '</strong> 条：Law ' +
        counts.law + ' · Tech ' + counts.tech +
        '。标记只存在这台设备上，标完点「复制标记」或「下载标记」交回。';
      el.resetLabels.hidden = false;
    } else {
      el.note.hidden = true;
      el.resetLabels.hidden = true;
    }
  }

  function scheduleFilter() {
    clearTimeout(timer);
    timer = setTimeout(applyFilters, DEBOUNCE_MS);
  }

  /* ---------------- 标记 ---------------- */

  function setMark(node, label) {
    var id = node.dataset.id;
    var current = markOf(id);
    if (current === label) {
      delete marks[id];               // 再点一次撤回到「没表过态」
      node.dataset.mark = 'unset';
    } else {
      marks[id] = label;
      node.dataset.mark = label;
    }
    saveMarks();
    node.querySelectorAll('.wk-mark button').forEach(function (button) {
      button.setAttribute('aria-pressed',
        String(button.dataset.label === (markOf(id) === 'tech' ? 'tech' : 'law')));
    });
    applyFilters();
    refreshStat();
  }

  function refreshStat() {
    var nodes = el.stats.querySelectorAll('dt');
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.textContent === '条已标记') {
        node.nextElementSibling.textContent = String(Object.keys(marks).length);
      }
    });
  }

  function exportPayload() {
    var labels = [];
    allItems().forEach(function (entry) {
      var label = marks[entry.item.id];
      if (!label) { return; }
      var item = entry.item;
      labels.push({
        id: item.id,
        label: label,
        title: item.title,
        topic: entry.topic,
        group: entry.group,
        kind: item.kind,
        date: item.kind === 'event' && item.stages && item.stages.length
          ? item.stages[0].date : (item.date || ''),
        source: item.source || '',
        url: item.links && item.links.length ? item.links[0].url : ''
      });
    });
    var counts = countMarks();
    return {
      schema: 'jurisatlas-weekly-labels/v1',
      week: data.week || '',
      title: data.title || '',
      page: location.href.split('#')[0],
      exported_at: new Date().toISOString(),
      counts: { items: data.counts.items, marked: counts.total, law: counts.law, tech: counts.tech },
      labels: labels
    };
  }

  function payloadText() {
    return JSON.stringify(exportPayload(), null, 1);
  }

  function copyText(text, button) {
    var original = button.textContent;
    var done = function (ok) {
      button.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { button.textContent = original; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); },
        function () { done(false); });
      return;
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
    document.body.removeChild(area);
    done(ok);
  }

  function download() {
    var counts = countMarks();
    if (!counts.total) {
      window.alert('还没有标记。点条目右侧的 Tech（或 Law）先标几条。');
      return;
    }
    var name = 'ai-weekly-' + (data.week || 'marks') + '-marks.json';
    var blob = new Blob([payloadText()], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------------- 主题 ---------------- */

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

  /* ---------------- 事件 ---------------- */

  function bind() {
    el.q.addEventListener('input', function () {
      state.q = el.q.value.trim().toLowerCase();
      scheduleFilter();
    });

    el.topicFilter.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-topic]');
      if (!button) { return; }
      state.topic = button.dataset.topic;
      el.topicFilter.querySelectorAll('button').forEach(function (node) {
        node.setAttribute('aria-pressed', String(node === button));
      });
      applyFilters();
    });

    el.markFilter.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-mark-filter]');
      if (!button) { return; }
      state.mark = button.dataset.markFilter;
      el.markFilter.querySelectorAll('button').forEach(function (node) {
        node.setAttribute('aria-pressed', String(node === button));
      });
      applyFilters();
    });

    el.topics.addEventListener('click', function (event) {
      var button = event.target.closest('.wk-mark button[data-label]');
      if (!button) { return; }
      var node = button.closest('.wk');
      setMark(node, button.dataset.label);
    });

    el.toggleOverview.addEventListener('click', function () {
      var showing = el.overview.hidden;
      el.overview.hidden = !showing;
      el.toggleOverview.setAttribute('aria-pressed', String(showing));
    });

    el.copyLabels.addEventListener('click', function () {
      var counts = countMarks();
      if (!counts.total) {
        window.alert('还没有标记。点条目右侧的 Tech（或 Law）先标几条。');
        return;
      }
      copyText(payloadText(), el.copyLabels);
    });

    el.downloadLabels.addEventListener('click', download);

    el.resetLabels.addEventListener('click', function () {
      var counts = countMarks();
      if (!window.confirm('清除这台设备上的 ' + counts.total + ' 条标记？此操作不能撤销。')) {
        return;
      }
      marks = {};
      saveMarks();
      Array.prototype.forEach.call(el.topics.querySelectorAll('.wk'), function (node) {
        node.dataset.mark = 'unset';
        node.querySelectorAll('.wk-mark button').forEach(function (button) {
          button.setAttribute('aria-pressed', String(button.dataset.label === 'law'));
        });
      });
      applyFilters();
      refreshStat();
    });

    el.theme.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'light' : 'dark';
      applyTheme(next);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== '/') { return; }
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) { return; }
      event.preventDefault();
      el.q.focus();
    });
  }

  /* ---------------- 启动 ---------------- */

  function fail(message) {
    el.count.textContent = message;
  }

  function start() {
    initTheme();
    Promise.all([
      fetch(DATA_DIR + 'weekly.json').then(function (res) {
        if (!res.ok) { throw new Error('weekly.json ' + res.status); }
        return res.json();
      }),
      fetch(DATA_DIR + 'weekly-meta.json').then(function (res) {
        return res.ok ? res.json() : null;
      }).catch(function () { return null; })
    ]).then(function (results) {
      data = results[0];
      meta = results[1];
      markKey = MARK_KEY_PREFIX + (data.week || 'latest');
      loadMarks();
      renderHead();
      renderTopics();
      renderFilters();
      applyFilters();
      bind();
      if (meta) {
        el.provenance.textContent = '数据同步自课程 Wiki' +
          (meta.source_commit ? '（源 ' + meta.source_commit + '）' : '') +
          (meta.generated_at ? '，' + meta.generated_at : '') + '。';
      }
    }).catch(function (error) {
      fail('数据加载失败：' + error.message);
    });
  }

  start();
})();
