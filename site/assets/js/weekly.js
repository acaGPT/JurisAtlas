/* 《法理学》周报 —— 页面逻辑
   用途：读取周报数据层，渲染「主题 → 事件类型 → 条目」三层结构，并给每条挂
        Law / Tech 两个并列标签（默认 Law，没有第三种状态）。
   用法：由 weekly.html 以 <script> 引入（在 feedback.js 之后）；数据取自
        assets/data/weekly*.json。

   三种看法：按主题（周报原样）、按主体（把同一家公司的三十条归到一处）、
   按系列（同一件事在时间上的几步进展）。主体与系列的结论分别由
   tools/audit-subjects.py 与 tools/build-series.py 算出，页面只负责显示与收人工
   判定，不改写周报一个字，也不删任何条目。

   反馈：改标与判定都经 FeedbackStore 即时写入。本地由 tools/serve-weekly.py 提供
   页面时直接落 feedback/<周次>.jsonl（零点击）；线上 GitHub Pages 没有后端，写入
   本机浏览器，并按批给一次「交回」。工具栏只留搜索框与 chip。
*/

(function () {
  'use strict';

  var DATA_DIR = 'assets/data/';
  var THEME_KEY = 'jcm-theme';
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

  var CHIP_LABEL = {
    topic: ['全部主题', '更多主题'],
    subject: ['全部主体', '更多主体'],
    series: ['全部系列', '更多系列']
  };

  var state = { q: '', chip: 'all', view: 'topic', chipsExpanded: false };
  /* 只记被人工改过的：id -> 'tech'。没有键就是默认 Law——
     默认值即当前值，不再有「未表态」这个中间态。 */
  var marks = {};
  var submitKey = '';
  /* 已经交回过的 id 与时间。交回是「点一次链接」的动作，页面无法确认读者是否
     真按了 GitHub 的 Create，所以这里记的是「已交回」，不是「已入库」。 */
  var submitted = null;
  /* 用 ?marks= 打开时是交回视图：按链接里带的标记渲染，只读，不写本机存储。 */
  var readOnly = false;
  var data = null;
  var meta = null;
  var audit = null;
  var series = null;
  /* 主体与系列两段摘要：与主题概览同形态，由写作者给，不带统计。 */
  var digest = null;
  var timer = null;
  var layoutTimer = null;
  /* id -> {title, topic, group, date}：交回时要把 id 还原成人能读的标题 */
  var itemIndex = {};
  /* 同主体初审的索引：id -> 所属主体 / 疑重复组 / 待复核组 / 链 */
  var subjectOf = {};
  var dupOf = {};
  var suspectOf = {};
  var chainOf = {};
  /* id -> 原始条目。主体与系列数据层只带摘要字段，渲染还得回周报数据里取整条。 */
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

  /* 标记只有一个来源：反馈记录。改标即 put，页面重绘时从记录里重建——
     不再另存一份 localStorage，两个容器迟早会对不上。 */
  function syncMarks() {
    marks = {};
    if (!window.FeedbackStore) { return; }
    window.FeedbackStore.records().forEach(function (record) {
      if (record.kind === 'mark' && record.value === 'tech') { marks[record.target] = 'tech'; }
    });
  }

  function countMarks() {
    /* 只有 Tech 才算「标过」：Law 是默认值，不需要有人确认也存在。 */
    var tech = 0;
    Object.keys(marks).forEach(function (id) {
      if (marks[id] === 'tech') { tech += 1; }
    });
    return { tech: tech, total: tech };
  }

  function verdictOf(target) {
    return window.FeedbackStore ? window.FeedbackStore.get('verdict', target) : '';
  }

  function countVerdicts() {
    if (!window.FeedbackStore) { return 0; }
    return window.FeedbackStore.records().filter(function (record) {
      /* 撤销会把 value 置空，空值不算「判过」 */
      return record.kind === 'verdict' && record.value;
    }).length;
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

  /* ---------------- 交回（线上通道） ---------------- */

  function shorten(text, limit) {
    var str = String(text || '');
    return str.length > limit ? str.slice(0, limit - 1) + '…' : str;
  }

  function pageLink(ids) {
    return PAGE_URL + '?marks=' +
      encodeURIComponent(ids.map(function (id) { return id + ':tech'; }).join(','));
  }

  function seriesName(id) {
    var list = (series && series.series) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) { return list[i].name; }
    }
    return id;
  }

  function verdictLines() {
    var out = [];
    (window.FeedbackStore ? window.FeedbackStore.records() : []).forEach(function (record) {
      if (record.kind !== 'verdict' || !record.value) { return; }
      var parts = record.target.split(':');
      var kind = parts.shift();
      var body = parts.join(':');
      var label = record.value === 'yes'
        ? (kind === 'series' ? '是同一系列' : '判为重复')
        : (kind === 'series' ? '不是同一系列' : '不是重复');
      var names = kind === 'series'
        ? [seriesName(body)]
        : body.split('+').map(function (id) {
          var row = itemIndex[id];
          return row ? shorten(row.title, 30) : id;
        });
      out.push('- ' + label + '：' + names.join(' ／ '));
    });
    return out;
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
    var judged = verdictLines();
    if (judged.length) {
      lines.push('### 关系判定：' + judged.length + ' 项');
      lines.push('');
      judged.forEach(function (line) { lines.push(line); });
      lines.push('');
    }
    lines.push('在页面上查看：[高亮这 ' + ids.length + ' 条](' + pageLink(ids) + ')');
    lines.push('');
    lines.push('<details><summary>机读清单（`tools/apply-weekly-labels.py` 可直接读）</summary>');
    lines.push('');
    lines.push('```');
    ids.forEach(function (id) { lines.push(id + ':tech'); });
    (window.FeedbackStore ? window.FeedbackStore.records() : []).forEach(function (record) {
      if (record.kind !== 'verdict' || !record.value) { return; }
      lines.push(record.target + ':' + record.value);
    });
    lines.push('```');
    lines.push('</details>');
    return lines.join('\n');
  }

  function issueUrl() {
    var ids = pendingIds();
    var title = '[' + (data.week || '') + '] 人工反馈：改标 ' + ids.length + ' 条';
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
        '允许本站弹出窗口后，再点一次「交回这一批」。';
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
    var tech = countMarks().total;
    var judged = countVerdicts();
    if (!tech && !judged) {
      el.note.hidden = true;
      el.note.innerHTML = '';
      return;
    }
    el.note.hidden = false;

    if (readOnly) {
      el.note.innerHTML = '这是交回视图：只列被改标为 Tech 的 <strong>' +
        tech + '</strong> 条，蓝圈标出，逐条核对即可。';
      return;
    }

    var status = window.FeedbackStore
      ? window.FeedbackStore.status() : { mode: 'device', at: '' };
    var head = '已记录 <strong>' + tech + '</strong> 条改标' +
      (judged ? '、<strong>' + judged + '</strong> 项关系判定' : '') + '。';
    var where = status.mode === 'disk'
      ? ' 即时写入 <code>feedback/' + esc(data.week || '') + '.jsonl</code>' +
        (status.at ? '（最近 ' + esc(status.at) + '）' : '') + '，下次周更自动读入，不用交回。'
      : ' 存在这台设备的浏览器里——线上页面没有写入磁盘的能力。' +
        '要交给课程维护者，仍需点一次下面这个链接。';
    var tail = '';
    if (status.mode !== 'disk') {
      var pending = pendingIds();
      if (pending.length) {
        tail = ' <a class="submit" href="#" id="submit-marks" role="button">' +
          '交回这一批（' + pending.length + ' 条）</a>';
      } else if (submitted && submitted.ids.length) {
        tail = '（' + submitted.ids.length + ' 条已交回）';
      }
    }
    el.note.innerHTML = head + where + tail +
      (status.error ? ' <span class="warn">' + esc(status.error) + '</span>' : '');
  }

  /* ---------------- 关系判定 ---------------- */

  function targetOf(prefix, ids) {
    return prefix + ':' + ids.slice().sort().join('+');
  }

  function verdictButtons(target, yesLabel, doneLabel) {
    var value = verdictOf(target);
    if (value === 'yes') {
      return '<span class="wk-verdict done">' + esc(doneLabel) + '</span>' +
        '<button type="button" class="wk-verdict undo" data-verdict="undo">撤销</button>';
    }
    if (value === 'no') {
      return '<span class="wk-verdict done">已判不是</span>' +
        '<button type="button" class="wk-verdict undo" data-verdict="undo">撤销</button>';
    }
    return '<button type="button" class="wk-verdict" data-verdict="yes">' +
      esc(yesLabel) + '</button>' +
      '<button type="button" class="wk-verdict" data-verdict="no">不是</button>';
  }

  function relHtml(target, label, title, kind) {
    return '<span class="wk-rel" data-target="' + esc(target) + '">' +
      '<span class="wk-tag" data-kind="' + esc(kind) + '" title="' + esc(title || '') + '">' +
      esc(label) + '</span>' + verdictButtons(target, '判为重复', '已判重复') + '</span>';
  }

  /* ---------------- 同主体初审的索引 ---------------- */

  function indexAudit() {
    subjectOf = {}; dupOf = {}; suspectOf = {}; chainOf = {};
    if (!audit || !audit.subjects) { return; }
    audit.subjects.forEach(function (group) {
      (group.items || []).forEach(function (row) { subjectOf[row.id] = group; });
      (group.duplicates || []).forEach(function (cluster) {
        cluster.target = targetOf('dup', cluster.ids);
        cluster.ids.forEach(function (id) { dupOf[id] = cluster; });
      });
      (group.suspects || []).forEach(function (cluster) {
        cluster.target = targetOf('suspect', cluster.ids);
        cluster.ids.forEach(function (id) { suspectOf[id] = cluster; });
      });
      (group.chains || []).forEach(function (chain) {
        chain.ids.forEach(function (id) { chainOf[id] = chain; });
      });
    });
  }

  /* 条目上的小徽标：这是机器的初审结论，不是定论。右侧的「是 / 不是」是给人用的——
     点一下即记录，记录后不再重复问。 */
  function tagsHtml(item) {
    var out = [];
    var cluster = dupOf[item.id];
    var group = subjectOf[item.id];
    if (cluster) {
      out.push(relHtml(cluster.target, '疑重复 · 同组 ' + cluster.ids.length + ' 条',
        cluster.reason, 'dup'));
      if (group) {
        out.push('<button type="button" class="wk-tag" data-goto-subject="' +
          esc(group.key) + '" title="跳到主体视图对照同组的那几条">对照</button>');
      }
    } else if (suspectOf[item.id]) {
      out.push(relHtml(suspectOf[item.id].target, '待复核',
        suspectOf[item.id].reason, 'suspect'));
    }
    if (chainOf[item.id]) {
      out.push('<span class="wk-tag" data-kind="chain" title="' +
        esc(chainOf[item.id].reason || '') + '">' +
        esc(chainOf[item.id].type || '连锁') + '</span>');
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

    var paras = (data.overview || []).filter(function (para) {
      return para && para.trim();
    });
    el.overview.innerHTML = paras.length
      ? '<h2>本周主题摘要</h2>' + paras.map(function (para) {
        return '<p>' + esc(para) + '</p>';
      }).join('')
      : '';
    el.overview.hidden = !paras.length;

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
    /* 系列卡已经用整张卡交代了关系，节点里再挂一遍「疑重复」只是噪声 */
    var tags = entry.bare ? '' : tagsHtml(item);
    return '<li class="wk" data-id="' + esc(item.id) + '" data-mark="' + esc(mark) + '"' +
      ' data-own-topic="' + esc(entry.topic) + '"' +
      imported + ' data-haystack="' + esc(haystackOf(entry)) + '">' +
      head + tags + body + foot + '</li>';
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
      return '<section class="topic" data-chip="' + esc(topic.name) + '">' +
        '<div class="topic-head"><h2>' + esc(topic.name) + '</h2>' +
        '<span class="topic-count">' + (topic.count || 0) + ' 条</span></div>' +
        groups + '</section>';
    }).join('');
  }

  /* 主体视图：把同一主体的条目从各主题里收回来，卡内仍按制度主题分块、块内按
     日期排——那就是这家公司这一周的线索。 */

  /* 三个视图各有一段摘要，形态一致：按主题读的是这一周发生的事，按主体读的是谁
     在动，按系列读的是哪几件事走了多步。三段都由写作者给出——脚本拼出来的只能
     是「305 条落到 28 个主体」这类关于数据的话，读者要知道的不是这个。

     主体与系列两段一段一个对象：{name, text}。名字挂在段首当标签，正文直接讲
     事实，不要「同一家公司同时在几个场域出现，是这一周的主体线索」这种开场——
     那是写的人在交代自己怎么组织材料，读者不欠这一段。 */
  function digestOf(key) {
    if (!digest || !data || digest.week !== data.week) { return []; }
    var rows = digest[key];
    if (!Array.isArray(rows)) { return []; }
    return rows.map(function (row) {
      if (typeof row === 'string') { return { name: '', text: row }; }
      return { name: (row && row.name) || '', text: (row && row.text) || '' };
    }).filter(function (row) { return row.text.trim(); });
  }

  function digestHtml(title, rows) {
    if (!rows.length) { return ''; }
    return '<section class="wk-overview wk-digest"><h2>' + esc(title) + '</h2>' +
      rows.map(function (row) {
        var head = row.name ? '<b class="wk-digest-name">' + esc(row.name) + '</b>' : '';
        return '<p>' + head + esc(row.text) + '</p>';
      }).join('') +
      '</section>';
  }

  function renderSubjects() {
    var groups = ((audit && audit.subjects) || []).filter(function (group) {
      return group.count > 1;
    }).sort(function (a, b) { return b.count - a.count; });
    if (!groups.length) {
      el.topics.innerHTML = '<p class="empty">本周没有识别出可归拢的主体，' +
        '请按主题浏览。</p>';
      return;
    }
    var head = digestHtml('本周主体摘要', digestOf('subject'));

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
      return '<section class="topic subject" data-chip="' + esc(group.key) + '">' +
        '<div class="topic-head"><h2>' + esc(group.name) + '</h2>' +
        '<span class="topic-count">' + group.count + ' 条 · 跨 ' +
        group.topics.length + ' 个主题</span></div>' +
        body + '</section>';
    }).join('');
  }

  /* 系列视图：一条系列一张卡，卡内是时间轴。多阶段事件直接摊开它自己的阶段；
     跨条目的进展链按节点排，同一件事的多条报道并成一个节点并注明条数。 */
  function renderSeries() {
    var list = (series && series.series) || [];
    if (!list.length) {
      el.topics.innerHTML = '<p class="empty">本周没有可串成系列的条目，' +
        '请按主题或主体浏览。</p>';
      return;
    }
    var head = digestHtml('本周系列摘要', digestOf('series'));

    el.topics.innerHTML = head + list.map(function (entry) {
      var target = 'series:' + entry.id;
      var body = '';
      if (entry.kind === 'event') {
        var item = rawItems[entry.ids[0]];
        if (item) {
          body = '<ul class="wk-list">' +
            itemHtml({ topic: '', group: '', item: item, bare: true }) + '</ul>';
        }
      } else {
        body = '<ol class="wk-series">' + (entry.nodes || []).map(function (node) {
          var item = rawItems[node.ids[0]];
          if (!item) { return ''; }
          var extra = node.count > 1
            ? '<p class="series-extra">另有 ' + (node.count - 1) +
              ' 条报道讲的是同一件事</p>'
            : '';
          return '<li class="series-node"><ul class="wk-list">' +
            itemHtml({ topic: '', group: '', item: item, bare: true }) + '</ul>' +
            extra + '</li>';
        }).join('') + '</ol>';
      }
      return '<section class="topic series" data-chip="' + esc(entry.id) + '">' +
        '<div class="topic-head"><h2>' + esc(entry.name) + '</h2>' +
        '<span class="topic-count">' +
        (entry.kind === 'event' ? '本周 ' : '跨主题 ') +
        (entry.nodes || []).length + ' 步</span></div>' +
        '<p class="series-evidence">' +
        (entry.evidence ? esc(entry.evidence) + ' ' : '') +
        '<span class="wk-rel" data-target="' + esc(target) + '">' +
        verdictButtons(target, '是同一系列', '已判同一系列') + '</span></p>' +
        body + '</section>';
    }).join('');
  }

  function renderView() {
    document.body.dataset.view = state.view;
    if (state.view === 'subject' && audit) {
      renderSubjects();
    } else if (state.view === 'series' && series) {
      renderSeries();
    } else {
      renderTopics();
    }
    Array.prototype.forEach.call(
      el.viewSwitch.querySelectorAll('button[data-view]'), function (button) {
        button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
      });
    try { localStorage.setItem(VIEW_KEY, state.view); } catch (error) { /* 隐私模式 */ }
    renderChips();
    applyFilters();
  }

  /* ---------------- chip：随视图换内容 ---------------- */

  function chipEntries() {
    var all = { key: 'all', label: CHIP_LABEL[state.view][0], count: 0 };
    if (state.view === 'subject' && audit) {
      var groups = (audit.subjects || []).filter(function (group) { return group.count > 1; });
      all.count = groups.length;          /* 与系列视图一致：chip 上的数字是卡片数 */

      return [all].concat(groups.map(function (group) {
        return { key: group.key, label: group.name, count: group.count };
      }));
    }
    if (state.view === 'series' && series) {
      all.count = (series.counts || {}).series || 0;
      return [all].concat((series.series || []).map(function (entry) {
        return { key: entry.id, label: entry.name, count: entry.ids.length };
      }));
    }
    all.count = data.counts.items;
    return [all].concat((data.topics || []).map(function (topic) {
      return { key: topic.name, label: topic.name, count: topic.count || 0 };
    }));
  }

  function renderChips() {
    state.chipsExpanded = false;
    el.topicFilter.setAttribute('aria-label', '按' + CHIP_LABEL[state.view][0].slice(2) + '筛选');
    el.topicFilter.innerHTML = chipEntries().map(function (entry) {
      return '<button type="button" data-chip="' + esc(entry.key) + '" aria-pressed="' +
        (state.chip === entry.key ? 'true' : 'false') + '">' + esc(entry.label) +
        '<span class="num">' + entry.count + '</span></button>';
    }).join('') +
      '<button type="button" class="more" data-more="1" aria-expanded="false" hidden>' +
        CHIP_LABEL[state.view][1] + '</button>';
    layoutChips();
  }

  /* chip 收成一行。主题有 14 个、主体有 14 个，铺开要占三行，把工具栏顶得很高；
     这里按容器实际宽度逐个量，放不下的收进「更多… N」，点一下再展开。
     选中的那一项永远留在可见的一行里——否则筛选生效了却看不到自己在筛什么。 */
  function layoutChips() {
    var buttons = Array.prototype.slice.call(
      el.topicFilter.querySelectorAll('button[data-chip]'));
    var more = el.topicFilter.querySelector('button[data-more]');
    if (!buttons.length || !more) { return; }

    buttons.forEach(function (button) { button.hidden = false; });
    more.hidden = false;

    if (state.chipsExpanded) {
      more.textContent = '收起';
      more.setAttribute('aria-expanded', 'true');
      return;
    }

    var avail = el.topicFilter.clientWidth;
    var reserve = more.getBoundingClientRect().width + CHIP_GAP;
    var fitted = [];
    var used = 0;

    function fit(index, force) {
      if (fitted.indexOf(index) !== -1) { return true; }
      var need = used + (fitted.length ? CHIP_GAP : 0) +
        buttons[index].getBoundingClientRect().width;
      /* 第一个与选中项可以挤进去；其余要留出「更多」的位置 */
      if (!force && fitted.length && need + reserve > avail) { return false; }
      used = need;
      fitted.push(index);
      return true;
    }

    fit(0, true);

    var selected = 0;
    buttons.forEach(function (button, index) {
      if (button.dataset.chip === state.chip) { selected = index; }
    });
    fit(selected, true);

    for (var i = 1; i < buttons.length; i += 1) { fit(i, false); }

    buttons.forEach(function (button, index) {
      button.hidden = fitted.indexOf(index) === -1;
    });
    var hiddenCount = buttons.length - fitted.length;
    more.hidden = hiddenCount === 0;
    more.textContent = CHIP_LABEL[state.view][1] + ' ' + hiddenCount;
    more.setAttribute('aria-expanded', 'false');
  }

  /* ---------------- 筛选 ---------------- */

  function matches(item, haystack) {
    /* 交回视图只列被改标的条目：核对三五条不该先滚过两百多条。主题标题仍在，
       所以看得出每条属于哪个制度主题。 */
    if (readOnly && !item.hasAttribute('data-imported')) { return false; }
    if (state.chip !== 'all' && item.dataset.chip !== state.chip) { return false; }
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
        /* 条目一律跟随所在卡片的 chip：主体卡里一条来自哪个主题已由分块小标题
           交代，再按主题筛会把这个主体的线索切碎。 */
        item.dataset.chip = section.dataset.chip;
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

    if (readOnly) {
      el.count.textContent = '只看这 ' + shown + ' 条';
    } else if (state.view === 'series') {
      /* 系列视图里「条」有两个意思：轴上的节点和节点里的信息。分开数，别混着说 */
      var cards = el.topics.querySelectorAll('section.series:not([hidden])').length;
      el.count.textContent = cards + ' 条系列 · 涉及 ' + shown + ' 条信息';
    } else {
      el.count.textContent = shown === total
        ? '共 ' + total + ' 条' : '显示 ' + shown + ' / ' + total + ' 条';
    }

    renderNote();
  }

  function scheduleFilter() {
    clearTimeout(timer);
    timer = setTimeout(applyFilters, DEBOUNCE_MS);
  }

  /* ---------------- 标记与判定 ---------------- */

  function setMark(node, label) {
    if (readOnly) { return; }        /* 交回视图只看不改 */
    var id = node.dataset.id;
    /* 两态：Tech 是人工改判，Law 是默认值。点 Law 即撤回，不存第三种状态。 */
    if (label === 'tech') { marks[id] = 'tech'; } else { delete marks[id]; }
    node.dataset.mark = markOf(id);
    if (window.FeedbackStore) {
      window.FeedbackStore.put('mark', id, markOf(id)).then(renderNote);
    }
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

  function setVerdict(target, value) {
    if (readOnly || !window.FeedbackStore) { return; }
    if (value === 'undo') {
      window.FeedbackStore.put('verdict', target, '').then(renderNote);
    } else {
      window.FeedbackStore.put('verdict', target, value).then(renderNote);
    }
  }

  function refreshStat() {
    Array.prototype.forEach.call(el.stats.querySelectorAll('dt'), function (node) {
      if (node.textContent === '条标为 Tech') {
        node.nextElementSibling.textContent = String(countMarks().total);
      }
    });
  }

  /* 判定按钮的文案随记录变，最省事的做法是就地重绘那一组。 */
  function repaintVerdicts(target) {
    var isSeries = target.indexOf('series:') === 0;
    Array.prototype.forEach.call(
      el.topics.querySelectorAll('.wk-rel[data-target="' + target + '"]'),
      function (group) {
        if (isSeries) {
          group.innerHTML = verdictButtons(target, '是同一系列', '已判同一系列');
          return;
        }
        var tag = group.querySelector('.wk-tag');
        if (!tag) { return; }
        group.innerHTML = '<span class="wk-tag" data-kind="' + esc(tag.dataset.kind) +
          '" title="' + esc(tag.title) + '">' + esc(tag.textContent) + '</span>' +
          verdictButtons(target, '判为重复', '已判重复');
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
        state.chipsExpanded = !state.chipsExpanded;
        layoutChips();
        return;
      }
      var button = event.target.closest('button[data-chip]');
      if (!button) { return; }
      state.chip = button.dataset.chip;
      el.topicFilter.querySelectorAll('button[data-chip]').forEach(function (node) {
        node.setAttribute('aria-pressed', String(node === button));
      });
      layoutChips();           /* 选中的那一项要留在可见的一行里 */
      applyFilters();
    });

    el.topics.addEventListener('click', function (event) {
      var verdict = event.target.closest('button[data-verdict]');
      if (verdict) {
        var holder = verdict.closest('.wk-rel');
        if (holder) {
          event.preventDefault();
          setVerdict(holder.dataset.target, verdict.dataset.verdict);
          repaintVerdicts(holder.dataset.target);
        }
        return;
      }
      /* 「对照」跳到主体视图：徽标本身已经是静态文字，不再抢标签的点击 */
      var badge = event.target.closest('[data-goto-subject]');
      if (badge) {
        var key = badge.dataset.gotoSubject;
        if (key && state.view !== 'subject') {
          state.view = 'subject';
          state.chip = key;
          renderView();
        }
        var target = el.topics.querySelector('[data-chip="' + key + '"]');
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
      state.chip = 'all';
      renderView();
      /* 三套内容毫无重合，留在原地只会让人以为页面没换 */
      window.scrollTo({ top: 0, behavior: 'auto' });
    });

    /* 「交回」只出现在线上（本机浏览器存储）那一档，见 renderNote */
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
      layoutTimer = setTimeout(layoutChips, 120);
    });
  }

  /* ---------------- 启动 ---------------- */

  function fail(message) {
    el.count.textContent = message;
  }

  function fetchJson(name) {
    return fetch(DATA_DIR + name).then(function (res) {
      return res.ok ? res.json() : null;
    }).catch(function () { return null; });
  }

  function start() {
    initTheme();
    Promise.all([
      fetch(DATA_DIR + 'weekly.json').then(function (res) {
        if (!res.ok) { throw new Error('weekly.json ' + res.status); }
        return res.json();
      }),
      fetchJson('weekly-meta.json'),
      fetchJson('weekly-subjects.json'),
      fetchJson('weekly-series.json'),
      /* 两段人写的摘要。可能还没写，也可能还是上一周的——按周次核对，对不上就不显示，
         宁可没有引言，也不拿数字凑一段。 */
      fetchJson('weekly-digest.json')
    ]).then(function (results) {
      data = results[0];
      meta = results[1];
      audit = results[2];
      series = results[3];
      digest = results[4];
      submitKey = SUBMIT_KEY_PREFIX + (data.week || 'latest');
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
      var pending = window.FeedbackStore
        ? window.FeedbackStore.init(data.week || 'latest') : Promise.resolve();

      return pending.then(function () {
        /* 磁盘上的记录覆盖页面：刷新后看到的必须是真正记下来的那一份。
           交回视图例外——它按链接里的清单渲染，不能被本机记录搅进来。 */
        if (!readOnly) { syncMarks(); }
        /* 交回视图固定按主题：核对改标的那几条时，位置要跟 issue 里列的顺序一致 */
        var stored = null;
        try { stored = localStorage.getItem(VIEW_KEY); } catch (error) { stored = null; }
        if (!readOnly && stored && (stored === 'subject' ? audit : series)) {
          state.view = stored;
        }
        renderHead();
        renderView();
        bind();
        if (meta) {
          el.provenance.textContent = '数据同步自课程 Wiki' +
            (meta.source_commit ? '（源 ' + meta.source_commit + '）' : '') +
            (meta.generated_at ? '，' + meta.generated_at : '') + '。';
        }
      });
    }).catch(function (error) {
      fail('数据加载失败：' + error.message);
    });
  }

  start();
})();
