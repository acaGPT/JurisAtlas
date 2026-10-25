/* 周报断言式 QA —— 渲染、默认标记、人工标记与持久化、筛选、检索、导出、主题、
 * 响应式与移动端溢出，并留取截图。
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
  check('默认全部未表态', await page.locator('.wk[data-mark="unset"]').count(), EXPECT.items);
  check('默认 Law 为按下态',
    await page.locator('.wk').first().locator('button[data-label="law"]')
      .getAttribute('aria-pressed'), 'true');

  const first = page.locator('.wk').first();
  const firstId = await first.getAttribute('data-id');
  await first.locator('button[data-label="tech"]').click();
  check('点击 Tech 后状态切换', await first.getAttribute('data-mark'), 'tech');
  check('Tech 按钮进入按下态',
    await first.locator('button[data-label="tech"]').getAttribute('aria-pressed'), 'true');
  check('标记提示出现', await page.locator('#mark-note').isVisible());
  const stored = await page.evaluate(key => localStorage.getItem(key),
    'jcm-weekly-marks:' + EXPECT.week);
  check('标记写入本地存储', typeof stored === 'string' && stored.includes('tech'));

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.wk');
  check('刷新后标记保留',
    await page.locator(`.wk[data-id="${firstId}"]`).getAttribute('data-mark'), 'tech');

  await page.locator('#mark-filter button[data-mark-filter="tech"]').click();
  check('只看 Tech 只剩已标记条目',
    await page.locator('.wk:not([hidden])').count(), 1);
  await page.locator('#mark-filter button[data-mark-filter="all"]').click();

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

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-labels').click();
  const download = await downloadPromise;
  const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  check('导出文件名带周次', download.suggestedFilename().includes(EXPECT.week));
  check('导出 schema', payload.schema, 'jurisatlas-weekly-labels/v1');
  check('导出只含已标记条目', payload.labels.length, 1);
  check('导出计数与标记一致',
    payload.counts.marked === 1 && payload.counts.tech === 1);
  check('导出条目可回指（含 id 与 topic）',
    Boolean(payload.labels[0] && payload.labels[0].id && payload.labels[0].topic));

  await page.locator('#theme').click();
  check('切换深色', await page.getAttribute('html', 'data-theme'), 'dark');
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(OUT, 'weekly-dark.png') });
  await page.locator('#theme').click();
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
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#reset-labels').click();
  await page.waitForTimeout(220);
  check('清除后回到未表态', await page.locator('.wk[data-mark="unset"]').count(), EXPECT.items);

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
