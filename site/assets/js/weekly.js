/* 《法理学》周报 —— 页面逻辑
   用途：读取周报数据层，渲染「主题 → 事件类型 → 条目」三层结构，并给每条挂
        Law / Tech 两个并列标签（默认 Law，没有第三种状态），标记存在浏览器本地。
   用法：由 weekly.html 以 <script> 引入；数据取自 assets/data/weekly*.json。

   工具栏只留搜索框与主题 chip：标记筛选、导出、深浅色切换都不在页面上了。
   标记仍按周存在本机（jcm-weekly-marks:<周次>），刷新不丢，但不出这台设备。
*/

(function () {
  'use strict';

  var DATA_DIR = 'assets/data/';
  var THEME_KEY = 'jcm-theme';
  var MARK_KEY_PREFIX = 'jcm-weekly-marks:';
  var DEBOUNCE_MS = 110;
  var CHIP_GAP = 5;

  var state = { q: '', topic: 'all', topicsExpanded: false };
  /* 只记被人工改过的：id -> 'tech'。没有键就是默认 Law——
     默认值即当前值，不再有「未表态」这个中间态。 */
  var marks = {};
  var markKey = '';
  var data = null;
  var meta = null;
  var timer = null;
  var layoutTimer = null;

  var el = {
    weekLine: document.getElementById('week-line'),
    stats: document.getElementById('stats'),
    overview: document.getElementById('overview'),
    topics: document.getElementById('topics'),
    q: document.getElementById('q'),
    topicFilter: document.getElementById('topic-filter'),
    count: document.getElementById('count'),
    note: document.getElementById('mark-note'),
    wikiLink: document.getElementById('wiki-link'),
    provenance: document.getElementById('provenance')
  };

  /* ---------------- 工具 ---------------- */

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function markOf(id) {
    return marks[id] === 'tech' ? 'tech' : 'law';
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

  function countMarks() {
    /* 只有 Tech 才算「标过」：Law 是默认值，不需要有人确认也存在。 */
    var tech = 0;
    Object.keys(marks).forEach(function (id) {
      if (marks[id] === 'tech') { tech += 1; }
    });
    return { tech: tech, total: tech };
  }

  /* ---------------- 渲染 ---------------- */

  function renderHead() {
    /* 周次行本身已经带了日期区间，不再另接一段起止日。 */
    el.weekLine.textContent = data.week_line || '';
    el.weekLine.className = 'week-line';

    var counts = data.counts || {};
    el.stats.innerHTML = [
      stat(counts.items, '条信息'),
      stat(counts.events, '件连锁事件'),
      stat(counts.topics, '个制度主题'),
      stat(countMarks().total, '条标为 Tech')
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
      })
      .join('') +
      '<button type="button" class="more" data-more="1" aria-expanded="false" hidden>' +
        '更多主题</button>';
  }

  /* 主题 chip 收成一行。14 个主题铺开要占三行，把工具栏顶得很高；
     这里按容器实际宽度逐个量，放不下的收进「更多主题 N」，点一下再展开。
     选中的主题永远留在可见的一行里——否则筛选生效了却看不到自己在筛什么。 */
  function layoutTopics() {
    var buttons = Array.prototype.slice.call(
      el.topicFilter.querySelectorAll('button[data-topic]'));
    var more = el.topicFilter.querySelector('button[data-more]');
    if (!buttons.length || !more) { return; }

    buttons.forEach(function (button) { button.hidden = false; });
    more.hidden = false;

    if (state.topicsExpanded) {
      more.textContent = '收起主题';
      more.setAttribute('aria-expanded', 'true');
      return;
    }

    var avail = el.topicFilter.clientWidth;
    more.textContent = '更多主题 ' + buttons.length;
    var reserve = more.getBoundingClientRect().width + CHIP_GAP;
    var fitted = [];
    var used = 0;

    function fit(index, force) {
      if (fitted.indexOf(index) !== -1) { return true; }
      var need = used + (fitted.length ? CHIP_GAP : 0) +
        buttons[index].getBoundingClientRect().width;
      /* 第一个与选中项可以挤进去；其余要留出「更多主题」的位置 */
      if (!force && fitted.length && need + reserve > avail) { return false; }
      used = need;
      fitted.push(index);
      return true;
    }

    fit(0, true);

    var selected = 0;
    buttons.forEach(function (button, index) {
      if (button.dataset.topic === state.topic) { selected = index; }
    });
    fit(selected, true);

    for (var i = 1; i < buttons.length; i += 1) { fit(i, false); }

    buttons.forEach(function (button, index) {
      button.hidden = fitted.indexOf(index) === -1;
    });
    var hiddenCount = buttons.length - fitted.length;
    more.hidden = hiddenCount === 0;
    more.textContent = '更多主题 ' + hiddenCount;
    more.setAttribute('aria-expanded', 'false');
  }

  /* ---------------- 筛选 ---------------- */

  function matches(item, haystack) {
    if (state.topic !== 'all' && item.dataset.topic !== state.topic) { return false; }
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

    el.count.textContent = shown === total
      ? '共 ' + total + ' 条'
      : '显示 ' + shown + ' / ' + total + ' 条';

    var counts = countMarks();
    el.note.hidden = !counts.total;
    if (counts.total) {
      el.note.innerHTML = '已把 <strong>' + counts.total + '</strong> 条改标为 Tech。' +
        '标记只存在这台设备的浏览器里，刷新仍在，不会上传。';
    }
  }

  function scheduleFilter() {
    clearTimeout(timer);
    timer = setTimeout(applyFilters, DEBOUNCE_MS);
  }

  /* ---------------- 标记 ---------------- */

  function setMark(node, label) {
    var id = node.dataset.id;
    /* 两态：Tech 是人工改判，Law 是默认值。点 Law 即撤回，不存第三种状态。 */
    if (label === 'tech') { marks[id] = 'tech'; } else { delete marks[id]; }
    node.dataset.mark = markOf(id);
    saveMarks();
    syncButtons(node);
    applyFilters();
    refreshStat();
  }

  function syncButtons(node) {
    var mark = markOf(node.dataset.id);
    Array.prototype.forEach.call(node.querySelectorAll('.wk-mark button'), function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.label === mark));
    });
  }

  function refreshStat() {
    Array.prototype.forEach.call(el.stats.querySelectorAll('dt'), function (node) {
      if (node.textContent === '条标为 Tech') {
        node.nextElementSibling.textContent = String(countMarks().total);
      }
    });
  }

  /* ---------------- 主题 ---------------- */

  /* 页面上没有切换按钮了，但仍跟随站点在别处设过的偏好（课程地图／文献库的
     深色按钮写的是同一个键），没设过就跟系统走。 */
  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (error) { stored = null; }
    if (stored !== 'light' && stored !== 'dark') {
      stored = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', stored);
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    el.q.addEventListener('input', function () {
      state.q = el.q.value.trim().toLowerCase();
      scheduleFilter();
    });

    el.topicFilter.addEventListener('click', function (event) {
      var more = event.target.closest('button[data-more]');
      if (more) {
        state.topicsExpanded = !state.topicsExpanded;
        layoutTopics();
        return;
      }
      var button = event.target.closest('button[data-topic]');
      if (!button) { return; }
      state.topic = button.dataset.topic;
      el.topicFilter.querySelectorAll('button[data-topic]').forEach(function (node) {
        node.setAttribute('aria-pressed', String(node === button));
      });
      layoutTopics();          /* 选中的主题要留在可见的一行里 */
      applyFilters();
    });

    el.topics.addEventListener('click', function (event) {
      var button = event.target.closest('.wk-mark button[data-label]');
      if (!button) { return; }
      var node = button.closest('.wk');
      setMark(node, button.dataset.label);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== '/') { return; }
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) { return; }
      event.preventDefault();
      el.q.focus();
    });

    /* 窗口一改宽度，能塞进一行 chip 的数量就变了 */
    window.addEventListener('resize', function () {
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(layoutTopics, 120);
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
      layoutTopics();
      window.addEventListener('load', layoutTopics);
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
