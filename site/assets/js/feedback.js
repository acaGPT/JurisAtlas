/* 《法理学》周报 —— 反馈记录
   用途：把「改标 Law/Tech」「关系判定（重复 / 系列）」记下来，并尽量落到能被读到
        的地方。调用方只需 FeedbackStore.init(week) 与 FeedbackStore.put(kind, target,
        value)，其余（通道选择、失败退回、状态文案）都在这里。

   两种通道：
     本地  页面由 tools/serve-weekly.py 提供时，每次改动即时 POST 到 api/feedback，
           写入 feedback/<周次>.jsonl。零点击，下次跑周报技能时第一步读它。
     线上  GitHub Pages 没有后端。改动写入本机浏览器（localStorage），并按批提示
           一次点击交回。线上页面不能假装写进了磁盘——那会让人以为反馈已经发出了。

   记录形状（与 tools/serve-weekly.py、tools/import-feedback.py 一致）：
     {week, kind: 'mark'|'verdict', target, value, at}
*/

(function () {
  'use strict';

  var API = 'api/feedback';
  var DEVICE_PREFIX = 'jcm-weekly-feedback:';

  var state = {
    week: '',
    mode: 'device',          // 'disk' | 'device'
    records: Object.create(null),
    at: '',
    error: ''
  };

  function keyOf(kind, target) { return kind + '|' + target; }

  function loadDevice() {
    try {
      var raw = localStorage.getItem(DEVICE_PREFIX + state.week);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveDevice() {
    try {
      localStorage.setItem(DEVICE_PREFIX + state.week,
        JSON.stringify(Object.keys(state.records).map(function (key) {
          return state.records[key];
        })));
    } catch (error) {
      /* 隐私模式：当次有效，不拦路 */
    }
  }

  function adopt(records) {
    (records || []).forEach(function (record) {
      if (!record || !record.kind || !record.target) { return; }
      state.records[keyOf(record.kind, record.target)] = {
        week: record.week || state.week,
        kind: record.kind,
        target: record.target,
        value: record.value,
        at: record.at || ''
      };
    });
  }

  /* 通道不靠域名猜，靠问一句：这个地址背后有没有写入端点。
     仓库里 site/api/feedback 是一份静态占位（{"mode":"device"}），
     所以线上读到的没有 records 字段；本地用 serve-weekly.py 打开时，
     同一个地址被动态接口接管，返回的 records 是数组。 */
  function init(week) {
    state.week = week || 'latest';
    adopt(loadDevice());
    return fetch(API + '?week=' + encodeURIComponent(state.week))
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (payload) {
        if (!Array.isArray(payload.records)) {
          state.mode = 'device';
          return state.mode;
        }
        adopt(payload.records);
        state.mode = 'disk';
        return state.mode;
      })
      .catch(function () {
        state.mode = 'device';
        return state.mode;
      });
  }

  function put(kind, target, value) {
    var record = {
      week: state.week,
      kind: kind,
      target: target,
      value: value,
      at: new Date().toISOString()
    };
    state.records[keyOf(kind, target)] = record;
    state.at = record.at;
    saveDevice();
    if (state.mode !== 'disk') { return Promise.resolve(state.mode); }
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: state.week, records: [record] })
    }).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      return state.mode;
    }).catch(function () {
      state.mode = 'device';
      state.error = '本地记录服务写入失败，已退回浏览器存储';
      return state.mode;
    });
  }

  function get(kind, target) {
    var record = state.records[keyOf(kind, target)];
    return record ? record.value : '';
  }

  function count() {
    return Object.keys(state.records).length;
  }

  function time() {
    if (!state.at) { return ''; }
    var date = new Date(state.at);
    if (isNaN(date.getTime())) { return ''; }
    return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
  }

  function records() {
    return Object.keys(state.records).map(function (key) { return state.records[key]; });
  }

  window.FeedbackStore = {
    init: init,
    put: put,
    get: get,
    count: count,
    time: time,
    records: records,
    status: function () {
      return { mode: state.mode, count: count(), at: time(), error: state.error };
    }
  };
})();
