/* 周报断言式 QA —— 渲染、工具栏结构、三视图（主题／主体／系列）、默认标记、
 * 人工标记与判定、反馈通道、筛选、检索、深色跟随、响应式与移动端溢出，并留取截图。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node tools/qa-weekly.js <baseUrl> <outDir>
 *
 * 依赖：playwright-core（本机 node workspace 已有），浏览器用系统 Chrome（channel: 'chrome'）。
 *
 * 预期值不写死：从 site/assets/data/weekly*.json 读当周真实条数、主体与系列，
 * 这样每周周报更新后不必改脚本。站点需先起在 <baseUrl> 上：
 *   - 用 tools/serve-weekly.py 起 → 反馈通道为「写盘」，零点击；
 *   - 用普通静态服务器起 → 反馈通道为「浏览器存储」，另给一次交回入口。
 * 两种通道的断言按页面自报的 mode 分支，不假设备份。
 *
 * 环境变量：
 *   QA_FEEDBACK_DIR  写盘模式的落盘目录（与 serve-weekly.py --feedback 一致）。
 *                    设了就顺手核对文件内容，不设则只核对页面提示。
 *
 * 返回码：0 全部断言通过；1 存在断言失败。
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2];
const OUT = process.argv[3] || 'qa-shots';
const FEEDBACK_DIR = process.env.QA_FEEDBACK_DIR || '';

if (!BASE) {
  console.error('用法：node qa-weekly.js <baseUrl> <outDir>');
  process.exit(2);
}

const DATA_DIR = path.resolve(__dirname, '..', 'site', 'assets', 'data');
const dataPath = path.join(DATA_DIR, 'weekly.json');
if (!fs.existsSync(dataPath)) {
  console.error(`找不到数据层 ${dataPath}，请先运行 tools/extract-weekly.py`);
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const EXPECT = { items: data.counts.items, topics: data.counts.topics, week: data.week };

function readJson(name) {
  const file = path.join(DATA_DIR, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/* 同主体初审与系列的数据层。缺了不致命——页面会退化，
   但对应的断言应当明确失败，而不是悄悄跳过。 */
const AUDIT = readJson('weekly-subjects.json');
const SERIES = readJson('weekly-series.json');

const SUBJ = {
  multi: AUDIT ? AUDIT.subjects.filter(s => s.count > 1).length : 0,
  items: AUDIT ? AUDIT.subjects.filter(s => s.count > 1)
    .reduce((sum, s) => sum + s.count, 0) : 0,
  dupItems: AUDIT ? AUDIT.review.duplicate_items : 0,
  flagged: AUDIT ? AUDIT.subjects.reduce((sum, s) =>
    sum + s.duplicates.reduce((n, d) => n + d.ids.length, 0), 0) : 0,
  relItems: AUDIT ? AUDIT.subjects.reduce((sum, s) => {
    const dup = new Set();
    s.duplicates.forEach(d => d.ids.forEach(id => dup.add(id)));
    const sus = new Set();
    s.suspects.forEach(d => d.ids.forEach(id => sus.add(id)));
    return sum + dup.size + Array.from(sus).filter(id => !dup.has(id)).length;
  }, 0) : 0
};
const SER = {
  count: SERIES ? SERIES.counts.series : 0,
  progression: SERIES ? SERIES.counts.progression : 0,
  event: SERIES ? SERIES.counts.event : 0,
  names: SERIES ? SERIES.series.map(s => s.name) : []
};

const results = [];
function check(name, actual, expected) {
  const pass = expected === undefined ? actual === true : actual === expected;
  results.push({ name, pass });
  console.log(`${pass ? '[通过]' : '[失败]'} ${name}：${JSON.stringify(actual)}` +
    (pass || expected === undefined ? '' : `（应为 ${JSON.stringify(expected)}）`));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); } });
  page.on('pageerror', e => { errors.push(String(e)); });

  /* 交回入口会打开新窗口（window.open）。这里把它截下来，既不去真开 GitHub，
     又能直接检查那条 issue URL 的内容。 */
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = function (url) {
      window.__opened.push(url);
      return { opener: null, closed: false };
    };
  });

  const url = BASE.replace(/\/$/, '') + '/weekly.html';
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.wk', { timeout: 15000 });
  check('条目数与数据层一致', await page.locator('.wk').count(), EXPECT.items);
  check('主题数与数据层一致', await page.locator('.topic').count(), EXPECT.topics);
  check('周次行显示当周',
    (await page.locator('#week-line').innerText()).includes(data.week_line));
  check('周次行不再重复起止日期',
    (await page.locator('#week-line').innerText()).includes(data.period.start), false);
  check('没有说明段落', await page.locator('.lede').count(), 0);
  check('统计标签用「连锁事件」',
    (await page.locator('#stats').innerText()).includes('件连锁事件'));
  check('每一条默认都是 Law', await page.locator('.wk[data-mark="law"]').count(), EXPECT.items);
  check('默认 Law 为按下态',
    await page.locator('.wk').first().locator('button[data-label="law"]')
      .getAttribute('aria-pressed'), 'true');

  /* 工具栏只剩三组：搜索框、chip、条数。标记筛选与操作按钮都不在了。 */
  check('工具栏只剩三组', await page.locator('.toolbar .wrap > *').count(), 3);
  check('没有标记筛选', await page.locator('#mark-filter').count(), 0);
  check('没有操作按钮行', await page.locator('.toolbar .actions').count(), 0);
  check('工具栏里的按钮全在 chip 内',
    await page.locator('.toolbar .wrap button').count(),
    await page.locator('#topic-filter button').count());

  /* Law / Tech 标签加粗 */
  const weights = await page.evaluate(() => Array.from(
    document.querySelectorAll('.wk-mark button'))
    .map(b => Number(getComputedStyle(b).fontWeight)));
  check('标签字重不低于 600', weights.every(w => w >= 600));
  check('标签字重在 700 档', weights.every(w => w === 700));

  /* chip 收成一行：可见 chip 的 offsetTop 应当只有一个值 */
  const chipRows = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#topic-filter button:not([hidden])'));
    return { rows: new Set(chips.map(c => c.offsetTop)).size, shown: chips.length };
  });
  check('主题 chip 只占一行', chipRows.rows, 1);
  check('放不下的主题收进「更多主题」',
    await page.locator('#topic-filter button[data-more]').isVisible());

  await page.locator('#topic-filter button[data-more]').click();
  await page.waitForTimeout(200);
  check('展开后露出全部主题',
    await page.locator('#topic-filter button[data-chip]:not([hidden])').count(),
    EXPECT.topics + 1);
  /* 从展开态选最后一个主题，再收起：选中项必须留在可见的一行里 */
  const lastChip = page.locator('#topic-filter button[data-chip]').last();
  const lastTopic = await lastChip.getAttribute('data-chip');
  await lastChip.click();
  await page.waitForTimeout(150);
  await page.locator('#topic-filter button[data-more]').click();
  await page.waitForTimeout(200);
  check('收起后选中的主题仍可见',
    await page.locator(`#topic-filter button[data-chip="${lastTopic}"]`).isVisible());
  check('收起后仍是一行', await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#topic-filter button:not([hidden])'));
    return new Set(chips.map(c => c.offsetTop)).size;
  }), 1);
  await page.locator('#topic-filter button[data-chip="all"]').click();
  await page.waitForTimeout(150);

  /* ---------- 反馈通道：页面自报走哪条 ---------- */
  const mode = await page.evaluate(() => window.FeedbackStore.status().mode);
  check('反馈通道已就绪', mode === 'disk' || mode === 'device');
  console.log(`  → 本次运行：${mode === 'disk' ? '本地写盘（零点击）' : '浏览器存储（一次交回）'}`);

  const first = page.locator('.wk').first();
  const firstId = await first.getAttribute('data-id');
  await first.locator('button[data-label="tech"]').click();
  await page.waitForTimeout(220);
  check('点击 Tech 后状态切换', await first.getAttribute('data-mark'), 'tech');
  check('Tech 按钮进入按下态',
    await first.locator('button[data-label="tech"]').getAttribute('aria-pressed'), 'true');
  check('标记提示出现', await page.locator('#mark-note').isVisible());
  check('点标签本身不跳窗',
    (await page.evaluate(() => window.__opened)).length, 0);

  if (mode === 'disk') {
    const note = await page.locator('#mark-note').innerText();
    check('写盘模式写明「即时写入」', note.includes('即时写入'));
    check('写盘模式不再要求交回', note.includes('不用交回'));
    check('写盘模式没有交回链接', await page.locator('#submit-marks').count(), 0);
    if (FEEDBACK_DIR) {
      const file = path.join(FEEDBACK_DIR, EXPECT.week + '.jsonl');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      check('改标已落到 feedback 文件', text.includes(firstId) && text.includes('"tech"'));
    }
  } else {
    check('浏览器存储模式给出交回入口', await page.locator('#submit-marks').isVisible());
    await page.locator('#submit-marks').click();
    await page.waitForTimeout(180);
    const opened = await page.evaluate(() => window.__opened);
    check('点交回打开 issue 表单', opened.length, 1);
    const issue = new URL(opened[0]);
    check('交回落在本仓库的 issue 表单',
      issue.host + issue.pathname, 'github.com/acaGPT/JurisAtlas/issues/new');
    check('issue 标题写明周次', (issue.searchParams.get('title') || '').includes(EXPECT.week));
    check('issue 带 weekly-labels 标签', issue.searchParams.get('labels'), 'weekly-labels');
    const issueBody = issue.searchParams.get('body') || '';
    check('issue 正文含该条的机读 id', issueBody.includes(firstId + ':tech'));
    check('issue 正文回链到高亮视图', issueBody.includes('?marks='));
    check('交回记录写入本地存储', await page.evaluate(key => {
      const raw = localStorage.getItem(key);
      return !!raw && JSON.parse(raw).ids.length === 1;
    }, 'jcm-weekly-submitted:' + EXPECT.week));
  }

  check('统计项「条标为 Tech」同步为 1', await page.evaluate(() => {
    const dt = Array.from(document.querySelectorAll('#stats dt'))
      .find(node => node.textContent === '条标为 Tech');
    return dt ? dt.nextElementSibling.textContent : null;
  }), '1');

  await first.screenshot({ path: path.join(OUT, 'weekly-marked.png') });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.wk');
  check('刷新后标记保留',
    await page.locator(`.wk[data-id="${firstId}"]`).getAttribute('data-mark'), 'tech');

  /* 点 Law 即撤回：没有第三种状态 */
  await page.locator(`.wk[data-id="${firstId}"]`).locator('button[data-label="law"]').click();
  await page.waitForTimeout(200);
  check('点 Law 撤回默认', await page.locator('.wk[data-mark="law"]').count(), EXPECT.items);
  check('撤回后标记提示收起', await page.locator('#mark-note').isVisible(), false);

  /* ---------- 关系判定：待复核也能一键定性 ---------- */
  check('关系判定按钮数与初审一致',
    await page.locator('.wk-rel').count(), SUBJ.relItems);
  const rel = page.locator('.wk-rel').first();
  const relTarget = await rel.getAttribute('data-target');
  check('判定按钮默认询问', await rel.locator('button[data-verdict="yes"]').count(), 1);
  await rel.locator('button[data-verdict="yes"]').click();
  await page.waitForTimeout(260);
  check('点「判为重复」即记下', (await rel.innerText()).includes('已判重复'));
  check('判定计入提示行',
    (await page.locator('#mark-note').innerText()).includes('项关系判定'));
  if (mode === 'disk' && FEEDBACK_DIR) {
    const file = path.join(FEEDBACK_DIR, EXPECT.week + '.jsonl');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    check('判定已落到 feedback 文件',
      text.includes(relTarget.split(':')[1]) && text.includes('"verdict"'));
  }
  await rel.locator('button[data-verdict="undo"]').click();
  await page.waitForTimeout(260);
  check('撤销后回到未判', await rel.locator('button[data-verdict="yes"]').count(), 1);

  await page.locator('#q').fill('Anthropic');
  await page.waitForTimeout(300);
  const hits = await page.locator('.wk:not([hidden])').count();
  check('检索有命中且少于全部', hits > 0 && hits < EXPECT.items);
  await page.locator('#q').fill('');
  await page.waitForTimeout(300);

  /* 主题名直接拼进选择器会被引号或括号噎住，改用文本匹配 */
  await page.locator('#topic-filter button', { hasText: data.topics[0].name })
    .first().click();
  check('主题筛选只留一个主题', await page.locator('.topic:not([hidden])').count(), 1);
  await page.locator('#topic-filter button[data-chip="all"]').click();

  /* 页面上没有深色按钮了，但仍要跟随站点在别处设过的偏好 */
  await page.evaluate(() => localStorage.setItem('jcm-theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.wk');
  check('跟随站点深色偏好', await page.getAttribute('html', 'data-theme'), 'dark');
  await page.screenshot({ path: path.join(OUT, 'weekly-dark.png') });
  await page.evaluate(() => localStorage.setItem('jcm-theme', 'light'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.wk');
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(OUT, 'weekly-light.png') });

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  check('按 / 聚焦搜索框', await page.evaluate(() => document.activeElement.id), 'q');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(340);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无横向溢出', overflow, 0);
  await page.screenshot({ path: path.join(OUT, 'weekly-mobile.png') });

  /* 交回视图：issue 正文里那条 ?marks= 链接，维护者点开就能逐条核对 */
  const viewer = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await viewer.goto(url + '?marks=' + encodeURIComponent(firstId + ':tech'));
  await viewer.waitForSelector('.wk[data-imported]', { state: 'visible' });
  await viewer.waitForTimeout(220);
  check('交回视图高亮对应条目',
    await viewer.locator('.wk[data-imported="1"]').count(), 1);
  check('交回视图只列被改标的条目',
    await viewer.locator('.wk:not([hidden])').count(), 1);
  check('交回视图标明只读',
    (await viewer.locator('#mark-note').innerText()).includes('交回视图'));
  check('交回视图不给交回入口', await viewer.locator('#submit-marks').count(), 0);
  check('交回视图的标签不可点',
    await viewer.locator('.wk[data-imported="1"] .wk-mark button').first().isDisabled());
  await viewer.close();

  /* ---------- 按主体看 ---------- */
  await page.setViewportSize({ width: 1280, height: 1000 });
  check('视图切换有三个按钮',
    await page.locator('#view-switch button[data-view]').count(), 3);
  check('第一个按钮叫「按主题」',
    (await page.locator('#view-switch button[data-view="topic"]').innerText()).trim(), '按主题');
  check('默认按主题',
    await page.locator('#view-switch button[data-view="topic"]').getAttribute('aria-pressed'),
    'true');

  await page.locator('#view-switch button[data-view="subject"]').click();
  await page.waitForTimeout(300);
  check('主体视图渲染主体卡', await page.locator('.subject').count(), SUBJ.multi);
  check('主体视图条目数与初审一致',
    await page.locator('.subject .wk').count(), SUBJ.items);
  check('主体卡内按主题分块',
    (await page.locator('.subject').first().locator('.type-head').count()) > 1);
  check('初审说明在主体视图顶部', await page.locator('.audit-head').count(), 1);
  check('初审统计与数据层一致',
    (await page.locator('.audit-head').innerText()).includes(`${SUBJ.dupItems} 条`));
  check('主体名出现在卡头',
    (await page.locator('.subject .topic-head h2').allInnerTexts()).includes('Anthropic'));

  /* chip 随视图换内容：主体视图给的是主体名，不是主题名 */
  const subjectChips = await page.locator('#topic-filter button[data-chip]').allInnerTexts();
  check('主体视图 chip 数为主体数加全部', subjectChips.length, SUBJ.multi + 1);
  check('主体 chip 不再是主题名',
    subjectChips.some(text => text.startsWith('Anthropic')));
  check('主体 chip 首项是「全部主体」', subjectChips[0].startsWith('全部主体'));
  check('主体 chip 也只占一行', await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#topic-filter button:not([hidden])'));
    return new Set(chips.map(c => c.offsetTop)).size;
  }), 1);
  check('主体视图收起概览',
    await page.locator('#overview').isVisible(), false);
  await page.screenshot({ path: path.join(OUT, 'weekly-subject.png'), fullPage: false });

  /* 主体 chip 直接筛出那一家：这一步之前是空着的 */
  const anthropicChip = page.locator('#topic-filter button', { hasText: 'Anthropic' }).first();
  await anthropicChip.click();
  await page.waitForTimeout(220);
  check('主体 chip 只留一个主体卡', await page.locator('.subject:not([hidden])').count(), 1);
  check('选中主体后仍可见 chip',
    await page.locator('#topic-filter button[aria-pressed="true"]').isVisible());
  await page.locator('#topic-filter button[data-chip="all"]').click();
  await page.waitForTimeout(180);

  check('疑重复徽标数与初审一致',
    await page.locator('.wk-tag[data-kind="dup"]').count(), SUBJ.flagged);
  check('主体视图仍可改标',
    await page.locator('.subject .wk-mark button[data-label="tech"]').first().isEnabled());

  /* 徽标右侧的「对照」从主题视图跳到主体视图里对应的那张卡 */
  await page.locator('#view-switch button[data-view="topic"]').click();
  await page.waitForTimeout(240);
  check('切回主题视图条目完整', await page.locator('#topics .wk').count(), EXPECT.items);
  await page.locator('.wk-tag[data-goto-subject]').first().click();
  await page.waitForTimeout(380);
  check('点对照切到主体视图',
    await page.locator('#view-switch button[data-view="subject"]').getAttribute('aria-pressed'),
    'true');
  check('点对照后落在对应主体卡', await page.locator('.subject[data-flash="1"]').count(), 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(360);
  check('主体视图移动端无横向溢出', await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await page.screenshot({ path: path.join(OUT, 'weekly-subject-mobile.png') });

  /* ---------- 按系列看 ---------- */
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('#view-switch button[data-view="series"]').click();
  await page.waitForTimeout(320);
  check('系列数与数据层一致', await page.locator('section.series').count(), SER.count);
  check('进展链数写入页面',
    (await page.locator('.audit-head').innerText()).includes(`进展链 ${SER.progression}`));
  check('本周多阶段数写入页面',
    (await page.locator('.audit-head').innerText()).includes(`多阶段事件 ${SER.event}`));
  check('系列名出现在卡头',
    (await page.locator('section.series .topic-head h2').allInnerTexts())
      .some(name => SER.names.includes(name)));
  check('系列卡给出证据与判定',
    (await page.locator('.series-evidence').first().innerText()).includes('是同一系列'));
  check('每个系列一个判定按钮',
    await page.locator('.series-evidence button[data-verdict="yes"]').count(), SER.count);
  check('节点里不再重复挂关系徽标',
    await page.locator('section.series .wk-tags').count(), 0);
  check('进展链画成时间轴',
    await page.locator('ol.wk-series .series-node').count() >= 2);
  check('系列视图收起概览', await page.locator('#overview').isVisible(), false);
  const seriesChips = await page.locator('#topic-filter button[data-chip]').allInnerTexts();
  check('系列视图 chip 数为系列数加全部', seriesChips.length, SER.count + 1);
  check('系列 chip 首项是「全部系列」', seriesChips[0].startsWith('全部系列'));
  await page.screenshot({ path: path.join(OUT, 'weekly-series.png'), fullPage: false });

  /* 系列也能一键定性，且判定回写同一份记录 */
  const seriesRel = page.locator('section.series .wk-rel').first();
  const seriesTarget = await seriesRel.getAttribute('data-target');
  await seriesRel.locator('button[data-verdict="yes"]').click();
  await page.waitForTimeout(260);
  check('系列判定可记下', (await seriesRel.innerText()).includes('已判同一系列'));
  check('系列判定写的是 series 目标', seriesTarget.startsWith('series:'));
  await seriesRel.locator('button[data-verdict="undo"]').click();
  await page.waitForTimeout(240);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(360);
  check('系列视图移动端无横向溢出', await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await page.screenshot({ path: path.join(OUT, 'weekly-series-mobile.png') });

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('#view-switch button[data-view="topic"]').click();
  await page.waitForTimeout(260);
  check('回到主题视图', await page.locator('#topics .wk').count(), EXPECT.items);

  check('控制台无错误', errors.length, 0);

  // 收尾：清空本机存储，别把测试痕迹留在这台机器上
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(k => k.indexOf('jcm-weekly-feedback:') === 0 ||
                   k.indexOf('jcm-weekly-submitted:') === 0)
      .forEach(k => localStorage.removeItem(k));
    localStorage.setItem('jcm-theme', 'light');
  });

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map(f => f.name).join('；'));
    process.exit(1);
  }
})().catch(error => {
  console.error('QA 中断：', error);
  process.exit(2);
});
