/* 周报断言式 QA —— 渲染、工具栏结构、默认标记、人工标记与持久化、筛选、检索、
 * 深色跟随、响应式与移动端溢出，并留取截图。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node tools/qa-weekly.js <baseUrl> <outDir>
 *
 * 依赖：playwright-core（本机 node workspace 已有），浏览器用系统 Chrome（channel: 'chrome'）。
 *
 * 预期值不写死：从 site/assets/data/weekly.json 读当周真实条数与主题数，
 * 这样每周周报更新后不必改脚本。站点需先用静态服务器起在 <baseUrl> 上。
 *
 * 返回码：0 全部断言通过；1 存在断言失败。
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2];
const OUT = process.argv[3] || 'qa-shots';

if (!BASE) {
  console.error('用法：node qa-weekly.js <baseUrl> <outDir>');
  process.exit(2);
}

const dataPath = path.resolve(__dirname, '..', 'site', 'assets', 'data', 'weekly.json');
if (!fs.existsSync(dataPath)) {
  console.error(`找不到数据层 ${dataPath}，请先运行 tools/extract-weekly.py`);
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const EXPECT = {
  items: data.counts.items,
  topics: data.counts.topics,
  week: data.week
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

  await page.goto(BASE.replace(/\/$/, '') + '/weekly.html', { waitUntil: 'networkidle' });
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

  /* 工具栏只剩三组：搜索框、主题 chip、条数。标记筛选与操作按钮都不在了。 */
  check('工具栏只剩三组', await page.locator('.toolbar .wrap > *').count(), 3);
  check('没有标记筛选', await page.locator('#mark-filter').count(), 0);
  check('没有操作按钮行', await page.locator('.toolbar .actions').count(), 0);
  check('工具栏里的按钮全在主题 chip 内',
    await page.locator('.toolbar .wrap button').count(),
    await page.locator('#topic-filter button').count());

  /* Law / Tech 标签加粗 */
  const weights = await page.evaluate(() => Array.from(
    document.querySelectorAll('.wk-mark button'))
    .map(b => Number(getComputedStyle(b).fontWeight)));
  check('标签字重不低于 600', weights.every(w => w >= 600));
  check('标签字重在 700 档', weights.every(w => w === 700));

  /* 主题 chip 收成一行：可见 chip 的 offsetTop 应当只有一个值 */
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
    await page.locator('#topic-filter button[data-topic]:not([hidden])').count(),
    EXPECT.topics + 1);
  /* 从展开态选最后一个主题，再收起：选中项必须留在可见的一行里 */
  const lastChip = page.locator('#topic-filter button[data-topic]').last();
  const lastTopic = await lastChip.getAttribute('data-topic');
  await lastChip.click();
  await page.waitForTimeout(150);
  await page.locator('#topic-filter button[data-more]').click();
  await page.waitForTimeout(200);
  check('收起后选中的主题仍可见',
    await page.locator(`#topic-filter button[data-topic="${lastTopic}"]`).isVisible());
  check('收起后仍是一行', await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#topic-filter button:not([hidden])'));
    return new Set(chips.map(c => c.offsetTop)).size;
  }), 1);
  await page.locator('#topic-filter button[data-topic="all"]').click();
  await page.waitForTimeout(150);

  const first = page.locator('.wk').first();
  const firstId = await first.getAttribute('data-id');
  await first.locator('button[data-label="tech"]').click();
  check('点击 Tech 后状态切换', await first.getAttribute('data-mark'), 'tech');
  check('Tech 按钮进入按下态',
    await first.locator('button[data-label="tech"]').getAttribute('aria-pressed'), 'true');
  check('标记提示出现', await page.locator('#mark-note').isVisible());
  check('统计项「条标为 Tech」同步为 1', await page.evaluate(() => {
    const dt = Array.from(document.querySelectorAll('#stats dt'))
      .find(node => node.textContent === '条标为 Tech');
    return dt ? dt.nextElementSibling.textContent : null;
  }), '1');
  const stored = await page.evaluate(key => localStorage.getItem(key),
    'jcm-weekly-marks:' + EXPECT.week);
  check('标记写入本地存储', typeof stored === 'string' && stored.includes('tech'));

  await first.screenshot({ path: path.join(OUT, 'weekly-marked.png') });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.wk');
  check('刷新后标记保留',
    await page.locator(`.wk[data-id="${firstId}"]`).getAttribute('data-mark'), 'tech');

  /* 点 Law 即撤回：没有第三种状态 */
  await page.locator(`.wk[data-id="${firstId}"]`).locator('button[data-label="law"]').click();
  await page.waitForTimeout(150);
  check('点 Law 撤回默认', await page.locator('.wk[data-mark="law"]').count(), EXPECT.items);
  check('撤回后标记提示收起', await page.locator('#mark-note').isVisible(), false);
  check('撤回后本地存储清空',
    await page.evaluate(key => localStorage.getItem(key) || '{}',
      'jcm-weekly-marks:' + EXPECT.week), '{}');

  await page.locator('#q').fill('Anthropic');
  await page.waitForTimeout(260);
  const hits = await page.locator('.wk:not([hidden])').count();
  check('检索有命中且少于全部', hits > 0 && hits < EXPECT.items);
  await page.locator('#q').fill('');
  await page.waitForTimeout(260);

  /* 主题名直接拼进选择器会被引号或括号噎住，改用文本匹配 */
  await page.locator('#topic-filter button', { hasText: data.topics[0].name })
    .first().click();
  check('主题筛选只留一个主题', await page.locator('.topic:not([hidden])').count(), 1);
  await page.locator('#topic-filter button[data-topic="all"]').click();

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
  await page.waitForTimeout(320);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无横向溢出', overflow, 0);
  await page.screenshot({ path: path.join(OUT, 'weekly-mobile.png') });

  check('控制台无错误', errors.length, 0);

  // 收尾：清空标记，别把测试痕迹留在这台机器上
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(k => k.indexOf('jcm-weekly-marks:') === 0)
      .forEach(k => localStorage.removeItem(k));
    localStorage.setItem('jcm-theme', 'light');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.wk');
  check('清理后全部回到 Law',
    await page.locator('.wk[data-mark="law"]').count(), EXPECT.items);

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
