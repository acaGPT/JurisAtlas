/* 《法理学》周报 —— 页面逻辑
   用途：读取周报数据层，渲染「主题 → 事件类型 → 条目」三层结构，并给每条挂
        Law / Tech 两个并列标签（默认 Law，没有第三种状态）。
   用法：由 weekly.html 以 <script> 引入；数据取自 assets/data/weekly*.json。

   两种看法：按制度主题（原样，周报的组织方式）、按主体（把同一家公司的三十条
   归到一处）。主体那一路同时带出同主体初审的结论——哪几条疑是同一件事、哪几条
   构成一条链——结论由 tools/audit-subjects.py 算出，页面只负责显示，不改写周报
   一个字，也不删任何条目。

   工具栏只留搜索框与主题 chip：标记筛选、导出面板、深浅色切换都不在页面上了。
   标记按周存在本机（jcm-weekly-marks:<周次>），刷新不丢；改动后不再需要「导出」——
   正文上方那行提示里直接给「交回」，点了就打开一条正文已填好的 GitHub issue，
   由维护者在该仓库的 issues 里收。交回过的不再重复列入下一次交回。
*/

(function () {
  'use strict';

  var DATA_DIR = 'assets/data/';
  var THEME_KEY = 'jcm-theme';
  var MARK_KEY_PREFIX = 'jcm-weekly-marks:';
  var SUBMIT_KEY_PREFIX = 'jcm-weekly-submitted:';
  var VIEW_KEY = 'jcm-weekly-view';
  var DEBOUNCE_MS = 110;
  var CHIP_GAP = 5;

  /* 交回通道：本仓库的 issues。public 仓库不需要任何 token——
     页面只负责把内容预填进 issue 表单，读者按 GitHub 的 Create 才真正入库。 */
  var ISSUE_REPO = 'acaGPT/JurisAtlas';
  var ISSUE_LABEL = 'weekly-labels';
  var PAGE_URL = 'https://acagpt.github.io/JurisAtlas/weekly.html';
  /* URL 超过这个长度就退回「只列 id」的紧凑正文（浏览器与 GitHub 都在 8K 上下截断） */
  var MAX_ISSUE_URL = 6000;
  /* 点标签那一刻是否弹出交回页。默认关——不是因为怕多一次点击，而是因为
     自动打开时 issue 里只有当时那一条：读者接着标第 2、3 条也进不去，结果变成
     「一条一个 issue」。所以改成累积：改标先入队，正文上方给一个「交回」，
     点一次就把这一批全部送出去。要单条即送，把这里改成 true。 */
  var AUTO_OPEN = false;

  var state = { q: '', topic: 'all', view: 'topic', topicsExpanded: false };
  /* 只记被人工改过的：id -> 'tech'。没有键就是默认 Law——
     默认值即当前值，不再有「未表态」这个中间态。 */
  var marks = {};
  var markKey = '';
  var submitKey = '';
  /* 已经交回过的 id 与时间。交回是「点一次链接」的动作，页面无法确认读者是否
     真按了 GitHub 的 Create，所以这里记的是「已交回」，不是「已入库」。 */
  var submitted = null;
  /* 用 ?marks= 打开时是交回视图：按链接里带的标记渲染，只读，不写本机存储。 */
  var readOnly = false;
  /* 本次会话是否已经自动弹过交回页 */
  var autoOpened = false;
  var data = null;
  var meta = null;
  var audit = null;
  var timer = null;
  var layoutTimer = null;
  /* id -> {title, topic, group, date}：交回时要把 id 还原成人能读的标题 */
  var itemIndex = {};
  /* 同主体初审的索引：id -> 所属主体 / 疑重复组 / 待复核组 / 链 */
  var subjectOf = {};
  var dupOf = {};
  var suspectOf = {};
  var chainOf = {};
  /* id -> 原始条目。主体数据层只带摘要字段，渲染还得回周报数据里取整条。 */
  var rawItems = {};

  var el = {
    weekLine: document.getElementById('week-line'),
    stats: document.getElementById('stats'),
    overview: document.getElementById('overview'),
    topics: document.getElementById('topics'),
    q: document.getElementById('q'),
    topicFilter: document.getElementById('topic-filter'),
    count: document.getElementById('count'),
    note: document.getElementById('mark-note'),
    viewSwitch: document.getElementById('view-switch'),
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

  function loadSubmitted() {
    var raw = null;
    try { raw = localStorage.getItem(submitKey); } catch (error) { raw = null; }
    try { submitted = raw ? JSON.parse(raw) : null; } catch (error) { submitted = null; }
    if (!submitted || !Array.isArray(submitted.ids)) { submitted = null; }
  }

  /* 还没交回的 id。交回过的留在 submitted 里，后面又改标的会重新进来。 */
  function pendingIds() {
    var done = {};
    if (submitted) {
      submitted.ids.forEach(function (id) { done[id] = 1; });
    }
    return Object.keys(marks).filter(function (id) { return !done[id]; }).sort();
  }

  /* ?marks=id1:tech,id2:tech —— issue 正文里的那条链接用的就是这个形状，
     维护者点开即看到被改标的条目，不必自己对着 id 反查。 */
  function importMarks() {
    var hit = /[?&]marks=([^&]+)/.exec(location.search);
    if (!hit) { return null; }
    var parsed = {};
    var raw = '';
    try { raw = decodeURIComponent(hit[1]); } catch (error) { return null; }
    raw.split(',').forEach(function (pair) {
      var bits = pair.split(':');
      if (bits.length === 2 && bits[1] === 'tech' && bits[0]) {
        parsed[bits[0]] = 'tech';
      }
    });
    return Object.keys(parsed).length ? parsed : null;
  }

  /* ---------------- 交回 ---------------- */

  function shorten(text, limit) {
    var str = String(text || '');
    return str.length > limit ? str.slice(0, limit - 1) + '…' : str;
  }

  function pageLink(ids) {
    return PAGE_URL + '?marks=' +
      encodeURIComponent(ids.map(function (id) { return id + ':tech'; }).join(','));
  }

  function issueBody(ids, withTitles) {
    var lines = [];
    lines.push('### 人工改标：' + ids.length + ' 条（' + (data.week || '') + '）');
    lines.push('');
    lines.push('来自 [本周 AI+法律动态](' + PAGE_URL + ') 页面。这些条目被人逐条点成 **Tech**，');
    lines.push('意思是「更像技术动态，不该占法律新闻的位置」。请移到技术卷或剔除。');
    lines.push('');
    if (withTitles) {
      ids.forEach(function (id) {
        var row = itemIndex[id];
        if (!row) { return; }
        lines.push('- ' + (row.date ? row.date + ' · ' : '') + shorten(row.title, 46));
      });
      lines.push('');
    }
    lines.push('在页面上查看：[高亮这 ' + ids.length + ' 条](' + pageLink(ids) + ')');
    lines.push('');
    lines.push('<details><summary>机读清单（`tools/apply-weekly-labels.py` 可直接读）</summary>');
    lines.push('');
    lines.push('```');
    ids.forEach(function (id) { lines.push(id + ':tech'); });
    lines.push('```');
    lines.push('</details>');
    return lines.join('\n');
  }

  function issueUrl() {
    var ids = pendingIds();
    var title = '[' + (data.week || '') + '] 人工改标 ' + ids.length + ' 条（Law → Tech）';
    function build(withTitles) {
      return 'https://github.com/' + ISSUE_REPO + '/issues/new' +
        '?labels=' + encodeURIComponent(ISSUE_LABEL) +
        '&title=' + encodeURIComponent(title) +
        '&body=' + encodeURIComponent(issueBody(ids, withTitles));
    }
    var full = build(true);
    /* 中文标题经 URL 编码后一个字占九个字节，条数一多就顶到上限：退回只列 id */
    return full.length <= MAX_ISSUE_URL ? full : build(false);
  }

  function openIssue() {
    var ids = pendingIds();
    if (!ids.length) { return; }
    var win = window.open(issueUrl(), '_blank');
    if (!win) {
      el.note.innerHTML = '交回页被浏览器拦下了（弹窗设置）。' +
        '允许本站弹出窗口后，再点一次「交回给课程维护者」。';
      return;
    }
    win.opener = null;
    submitted = {
      ids: (submitted ? submitted.ids : []).concat(ids),
      at: new Date().toISOString()
    };
    try { localStorage.setItem(submitKey, JSON.stringify(submitted)); } catch (error) { /* 隐私模式 */ }
    renderNote();
  }

  function renderNote() {
    var total = countMarks().total;
    if (!total) {
      el.note.hidden = true;
      el.note.innerHTML = '';
      return;
    }
    el.note.hidden = false;

    if (readOnly) {
      el.note.innerHTML = '这是交回视图：只列被改标为 Tech 的 <strong>' +
        total + '</strong> 条，蓝圈标出，逐条核对即可。';
      return;
    }

    var pending = pendingIds();
    var head = '已把 <strong>' + total + '</strong> 条改标为 Tech。';
    if (pending.length) {
      var tail = submitted && submitted.ids.length
        ? '（另 ' + submitted.ids.length + ' 条已交回）' : '';
      el.note.innerHTML = head +
        ' <a class="submit" href="#" id="submit-marks" role="button">交回给课程维护者</a>' +
        tail;
    } else {
      /* 页面只能确认「交回页已打开」，是否真按了 Create 无法知道，别把话说满。 */
      el.note.innerHTML = head + ' 已在 GitHub 打开交回页——在那边按 Create 才算入库。';
    }
  }

  /* ---------------- 同主体初审的索引 ---------------- */

  function indexAudit() {
    subjectOf = {}; dupOf = {}; suspectOf = {}; chainOf = {};
    if (!audit || !audit.subjects) { return; }
    audit.subjects.forEach(function (group) {
      (group.items || []).forEach(function (row) { subjectOf[row.id] = group; });
      (group.duplicates || []).forEach(function (cluster) {
        cluster.ids.forEach(function (id) { dupOf[id] = cluster; });
      });
      (group.suspects || []).forEach(function (cluster) {
        cluster.ids.forEach(function (id) { suspectOf[id] = cluster; });
      });
      (group.chains || []).forEach(function (chain) {
        chain.ids.forEach(function (id) { chainOf[id] = chain; });
      });
    });
  }

  /* 条目上的小徽标：这是机器的初审结论，不是定论，所以措辞用「疑」「待复核」，
     并且点一下能跳到主体视图里同组的那几条去对照。 */
  function tagsHtml(item) {
    var out = [];
    var cluster = dupOf[item.id];
    var group = subjectOf[item.id];
    if (cluster) {
      out.push('<button type="button" class="wk-tag" data-kind="dup" data-goto-subject="' +
        esc(group ? group.key : '') + '" title="' + esc(cluster.reason || '') +
        '">疑重复 · 同组 ' + cluster.ids.length + ' 条</button>');
    }
    if (suspectOf[item.id] && !cluster) {
      out.push('<span class="wk-tag" data-kind="suspect" title="' +
        esc(suspectOf[item.id].reason || '') + '">待复核</span>');
    }
    if (chainOf[item.id]) {
      out.push('<span class="wk-tag" data-kind="chain" title="' + esc(chainOf[item.id].reason || '') +
        '">' + esc(chainOf[item.id].type || '连锁') + '</span>');
    }
    return out.length ? '<div class="wk-tags">' + out.join('') + '</div>' : '';
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
    var group = subjectOf[item.id];
    if (group) { parts.push(group.name || ''); }
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
    /* 交回时要把 id 还原成标题，顺手记一份索引 */
    itemIndex[item.id] = {
      title: item.title, topic: entry.topic, group: entry.group, date: when
    };
    var head = '<div class="wk-top">' +
      (when ? '<span class="wk-when">' + esc(when) + '</span>' : '') +
      '<h4 class="wk-title">' + esc(item.title) + '</h4>' +
      '<div class="wk-mark" role="group" aria-label="这条属于哪一类">' +
        '<button type="button" data-label="law" aria-pressed="' +
          (mark !== 'tech' ? 'true' : 'false') + '"' + (readOnly ? ' disabled' : '') +
          '>Law</button>' +
        '<button type="button" data-label="tech" aria-pressed="' +
          (mark === 'tech' ? 'true' : 'false') + '"' + (readOnly ? ' disabled' : '') +
          '>Tech</button>' +
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

    var imported = readOnly && mark === 'tech' ? ' data-imported="1"' : '';
    return '<li class="wk" data-id="' + esc(item.id) + '" data-mark="' + esc(mark) + '"' +
      ' data-own-topic="' + esc(entry.topic) + '"' +
      imported + ' data-haystack="' + esc(haystackOf(entry)) + '">' +
      head + tagsHtml(item) + body + foot + '</li>';
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

  /* 主体视图：把同一主体的条目从各主题里收回来，卡内仍按制度主题分块、块内按
     日期排——那就是这家公司这一周的线索。同主体初审的结论挂在卡头。 */
  function subjectNote(group) {
    var bits = [];
    if (group.duplicates && group.duplicates.length) {
      bits.push('疑重复 ' + group.duplicates.length + ' 组');
    }
    if (group.suspects && group.suspects.length) {
      bits.push('待复核 ' + group.suspects.length + ' 簇');
    }
    if (group.chains && group.chains.length) {
      bits.push('连锁 ' + group.chains.length + ' 条');
    }
    return bits.length ? '机器初审：' + bits.join(' · ') : '';
  }

  function renderSubjects() {
    var groups = ((audit && audit.subjects) || []).filter(function (group) {
      return group.count > 1;
    });
    if (!groups.length) {
      el.topics.innerHTML = '<p class="empty">本周没有识别出可归拢的主体，' +
        '请按制度主题浏览。</p>';
      return;
    }
    var review = (audit && audit.review) || {};
    var head = '<div class="audit-head">' +
      '<h2>同主体初审</h2>' +
      '<p>' + esc(review.items_checked || 0) + ' 条里认出 ' + esc(review.subjects || 0) +
      ' 个主体（2 条以上 ' + esc(review.subjects_multi || 0) + ' 个）· 疑重复 ' +
      esc(review.duplicate_groups || 0) + ' 组（' + esc(review.duplicate_items || 0) +
      ' 条）· 待复核 ' + esc(review.suspects || 0) + ' 簇 · 跨主题连锁 ' +
      esc(review.chains || 0) + ' 条。这是机器按标题、摘要与制度动作序列算的初审，' +
      '不是定论；条目上的徽标可点，点了会停在本主体里对照同组的那几条。</p></div>';

    el.topics.innerHTML = head + groups.map(function (group) {
      var order = [];
      var byTopic = {};
      (group.items || []).forEach(function (row) {
        if (!byTopic[row.topic]) { byTopic[row.topic] = []; order.push(row.topic); }
        byTopic[row.topic].push(row);
      });
      var body = order.map(function (topic) {
        var rows = byTopic[topic];
        return '<h3 class="type-head">' + esc(topic) +
          '<span class="num">' + rows.length + '</span></h3>' +
          '<ul class="wk-list">' + rows.map(function (row) {
            var item = rawItems[row.id];
            return item ? itemHtml({ topic: row.topic, group: row.group, item: item }) : '';
          }).join('') + '</ul>';
      }).join('');
      var note = subjectNote(group);
      return '<section class="topic subject" data-subject="' + esc(group.key) +
        '" data-topic="' + esc(group.name) + '">' +
        '<div class="topic-head"><h2>' + esc(group.name) + '</h2>' +
        '<span class="topic-count">' + group.count + ' 条 · 跨 ' +
        group.topics.length + ' 个主题</span></div>' +
        (note ? '<p class="subject-note">' + esc(note) + '</p>' : '') +
        body + '</section>';
    }).join('');
  }

  function renderView() {
    document.body.dataset.view = state.view;
    if (state.view === 'subject' && audit) {
      renderSubjects();
    } else {
      renderTopics();
    }
    Array.prototype.forEach.call(
      el.viewSwitch.querySelectorAll('button[data-view]'), function (button) {
        button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
      });
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (error) { /* 隐私模式 */ }
    applyFilters();
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
    /* 交回视图只列被改标的条目：核对三五条不该先滚过两百多条。主题标题仍在，
       所以看得出每条属于哪个制度主题。 */
    if (readOnly && !item.hasAttribute('data-imported')) { return false; }
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
        /* 主体卡里的条目来自不同制度主题，各自带着自己的主题走；主题卡里则由
           所在的 section 决定。 */
        item.dataset.topic = item.dataset.ownTopic || section.dataset.topic;
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

    el.count.textContent = readOnly
      ? '只看这 ' + shown + ' 条'
      : (shown === total
        ? '共 ' + total + ' 条'
        : '显示 ' + shown + ' / ' + total + ' 条');

    renderNote();
  }

  function scheduleFilter() {
    clearTimeout(timer);
    timer = setTimeout(applyFilters, DEBOUNCE_MS);
  }

  /* ---------------- 标记 ---------------- */

  function setMark(node, label) {
    if (readOnly) { return; }        /* 交回视图只看不改 */
    var id = node.dataset.id;
    /* 两态：Tech 是人工改判，Law 是默认值。点 Law 即撤回，不存第三种状态。 */
    if (label === 'tech') { marks[id] = 'tech'; } else { delete marks[id]; }
    node.dataset.mark = markOf(id);
    saveMarks();
    syncButtons(node);
    applyFilters();
    refreshStat();
    /* 标记即入队；AUTO_OPEN 打开时才在点标签这一刻直接开交回页 */
    if (label === 'tech' && AUTO_OPEN && !autoOpened && pendingIds().length) {
      autoOpened = true;
      openIssue();
    }
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
      /* 徽标先处理：它也是 button，别被下面的标签判断抢走 */
      var badge = event.target.closest('[data-goto-subject]');
      if (badge) {
        var key = badge.dataset.gotoSubject;
        if (key && state.view !== 'subject') {
          state.view = 'subject';
          renderView();
        }
        var target = el.topics.querySelector('[data-subject="' + key + '"]');
        if (target) {
          target.scrollIntoView({ block: 'start' });
          target.setAttribute('data-flash', '1');
          setTimeout(function () { target.removeAttribute('data-flash'); }, 1600);
        }
        return;
      }
      var button = event.target.closest('.wk-mark button[data-label]');
      if (!button) { return; }
      var node = button.closest('.wk');
      setMark(node, button.dataset.label);
    });

    el.viewSwitch.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-view]');
      if (!button || button.dataset.view === state.view) { return; }
      state.view = button.dataset.view;
      renderView();
      /* 两套内容毫无重合，留在原地只会让人以为页面没换 */
      window.scrollTo({ top: 0, behavior: 'auto' });
    });

    /* 「交回」是提示行里的一个链接，不用按钮：交回是标记动作的收尾，不是另一套面板 */
    el.note.addEventListener('click', function (event) {
      var link = event.target.closest('#submit-marks');
      if (!link) { return; }
      event.preventDefault();
      openIssue();
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
      }).catch(function () { return null; }),
      fetch(DATA_DIR + 'weekly-subjects.json').then(function (res) {
        return res.ok ? res.json() : null;
      }).catch(function () { return null; })
    ]).then(function (results) {
      data = results[0];
      meta = results[1];
      audit = results[2];
      markKey = MARK_KEY_PREFIX + (data.week || 'latest');
      submitKey = SUBMIT_KEY_PREFIX + (data.week || 'latest');
      loadMarks();
      loadSubmitted();
      /* ?marks= 优先于本机记录：链接里带的是「这一批交回的条目」，
         用它渲染成只读视图，避免维护者本机的旧标记搅进来。 */
      var imported = importMarks();
      if (imported) {
        marks = imported;
        readOnly = true;
      }
      (data.topics || []).forEach(function (topic) {
        (topic.groups || []).forEach(function (group) {
          (group.items || []).forEach(function (item) { rawItems[item.id] = item; });
        });
      });
      indexAudit();
      /* 交回视图固定按主题：核对改标的那几条时，位置要跟 issue 里列的顺序一致 */
      var stored = null;
      try { stored = localStorage.getItem(VIEW_KEY); } catch (error) { stored = null; }
      if (!readOnly && stored === 'subject' && audit) { state.view = 'subject'; }
      renderHead();
      renderFilters();
      layoutTopics();
      window.addEventListener('load', layoutTopics);
      renderView();
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
