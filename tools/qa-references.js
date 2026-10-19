/* 文献库断言式 QA —— 渲染、筛选、检索、排序、导出、主题、响应式，并留取截图。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node tools/qa-references.js <baseUrl> <outDir>
 *
 * 依赖：playwright-core（本机 node workspace 已有），浏览器用系统 Chrome（channel: 'chrome'）。
 * 预期值对应 extract-references.py 当前产出（363 条：经典 235 / 延伸 128）。
 *
 * 返回码：0 全部断言通过；1 存在断言失败。
 */

const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = process.argv[2];
const OUT = process.argv[3] || 'qa-shots';

if (!BASE) {
  console.error('用法：node qa-references.js <baseUrl> <outDir>');
  process.exit(2);
}

const EXPECT = { total: 363, classic: 235, further: 128, fulltext: 294, locator: 69 };

const results = [];
function check(name, actual, expected) {
  const pass = expected === undefined ? actual === true : actual === expected;
  results.push({ name, pass });
  console.log(`${pass ? '[通过]' : '[失败]'} ${name}：${JSON.stringify(actual)}` +
    (pass || expected === undefined ? '' : `（应为 ${JSON.stringify(expected)}）`));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(BASE + '/references.html', { waitUntil: 'networkidle' });

  /* 1. 渲染与统计 */
  const rendered = await page.locator('.ref-item').count();
  check('文献条目渲染数', rendered, EXPECT.total);

  const statPairs = await page.locator('#stats div').allTextContents();
  const statMap = Object.fromEntries(statPairs.map((t) => {
    const m = t.replace(/\s+/g, ' ').trim().match(/^(\D+?)\s*([\d]+)$/);
    return m ? [m[1].trim(), Number(m[2])] : [t, null];
  }));
  check('统计·总数', statMap['文献总数'], EXPECT.total);
  check('统计·经典文献', statMap['经典文献'], EXPECT.classic);
  check('统计·延伸阅读', statMap['延伸阅读'], EXPECT.further);
  check('统计·全文直读', statMap['全文直读'], EXPECT.fulltext);
  check('统计·需定位或订阅', statMap['需定位或订阅'], EXPECT.locator);

  await page.screenshot({ path: OUT + '/refs-initial.png', fullPage: false });

  /* 2. 类型筛选 */
  await page.click('#kind-filter button[data-kind="classic"]');
  check('筛选·经典文献命中', await page.locator('.ref-item').count(), EXPECT.classic);
  await page.click('#kind-filter button[data-kind="further"]');
  check('筛选·延伸阅读命中', await page.locator('.ref-item').count(), EXPECT.further);
  await page.click('#kind-filter button[data-kind="all"]');

  /* 3. 获取方式筛选 */
  await page.click('#access-filter button[data-access="fulltext"]');
  check('筛选·全文直读命中', await page.locator('.ref-item').count(), EXPECT.fulltext);
  await page.click('#access-filter button[data-access="locator"]');
  check('筛选·需定位或订阅命中', await page.locator('.ref-item').count(), EXPECT.locator);
  await page.click('#access-filter button[data-access="all"]');

  /* 4. 渠道筛选 */
  await page.click('#channel-filter button[data-channel="Open Library"]');
  check('筛选·Open Library 命中', await page.locator('.ref-item').count(), 137);
  await page.click('#channel-filter button[data-channel="all"]');

  /* 5. 检索（中英各一） */
  await page.fill('#q', 'Hart');
  await page.waitForTimeout(300);
  const hartHits = await page.locator('.ref-item').count();
  check('检索·英文 "Hart" 命中 > 0', hartHits > 0, true);
  check('检索·计数行与渲染一致',
    (await page.locator('#count').textContent()).includes(String(hartHits)), true);

  await page.fill('#q', '刘星');
  await page.waitForTimeout(300);
  check('检索·中文 "刘星" 命中', await page.locator('.ref-item').count(), 1);
  await page.fill('#q', '');
  await page.waitForTimeout(300);

  /* 6. 排序 */
  await page.selectOption('#sort', 'author');
  const authorGroups = await page.locator('.ref-group .unit-head h2').allTextContents();
  check('排序·作者分组首组为字母', /^[A-Z]/.test(authorGroups[0] || ''), true);
  await page.selectOption('#sort', 'year');
  check('排序·年份渲染', (await page.locator('.ref-item').count()), EXPECT.total);
  await page.selectOption('#sort', 'course');
  check('排序·回到课程结构', (await page.locator('.ref-group').count()) > 40, true);

  await page.screenshot({ path: OUT + '/refs-filtered.png', fullPage: false });

  /* 7. 导出（固定全部，不受筛选影响） */
  await page.click('#kind-filter button[data-kind="classic"]');
  const [bibDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-bibtex'),
  ]);
  const bibPath = OUT + '/export.bib';
  await bibDownload.saveAs(bibPath);
  const bib = fs.readFileSync(bibPath, 'utf8');
  const bibEntries = (bib.match(/^@\w+\{/gm) || []).length;
  check('导出·BibTeX 条目数固定为全部', bibEntries, EXPECT.total);
  check('导出·BibTeX 含 @book 与 @article',
    bib.includes('@book{') && bib.includes('@article{'), true);

  const [risDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#export-ris'),
  ]);
  const risPath = OUT + '/export.ris';
  await risDownload.saveAs(risPath);
  const ris = fs.readFileSync(risPath, 'utf8');
  const risEntries = (ris.match(/^TY  - /gm) || []).length;
  check('导出·RIS 条目数固定为全部', risEntries, EXPECT.total);
  check('导出·RIS 含 ER 终止符', (ris.match(/^ER  - /gm) || []).length, EXPECT.total);
  await page.click('#kind-filter button[data-kind="all"]');

  /* 8. 主题切换 */
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#theme');
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('主题切换生效', before !== after, true);
  await page.click('#theme');

  /* 9. 课程地图页联动 */
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  check('课程地图·文献库入口存在', await page.locator('.head-link a[href="references.html"]').count(), 1);
  const furtherStat = await page.locator('#stats div')
    .filter({ hasText: '延伸阅读' }).textContent();
  check('课程地图·延伸阅读统计已修正为 128', furtherStat.replace(/\s+/g, '').includes('128'), true);

  /* 10. 移动端横向溢出 */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/references.html', { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无横向溢出', overflow <= 0, true);
  await page.screenshot({ path: OUT + '/refs-mobile.png', fullPage: false });

  /* 11. 长尾渠道折叠 */
  const tailToggle = page.locator('#channel-filter button[data-tail]');
  check('渠道·长尾折叠开关存在', await tailToggle.count(), 1);
  check('渠道·开关文案含待展开数量',
    (await tailToggle.textContent()).includes('24'), true);
  const chipsCollapsed = await page.locator('#channel-filter button[data-channel]').count();
  await tailToggle.click();
  const chipsExpanded = await page.locator('#channel-filter button[data-channel]').count();
  check('渠道·展开后筛选项增加', chipsExpanded > chipsCollapsed, true);
  check('渠道·展开后为全部 36 类 + 全部渠道', chipsExpanded, 37);
  await tailToggle.click();
  check('渠道·可再次收起',
    await page.locator('#channel-filter button[data-channel]').count(), chipsCollapsed);

  /* 12. 跨章共引标记 */
  const dupBadges = await page.locator('.ref-item .dup').count();
  check('共引·标记条目数为 17', dupBadges, 17);
  check('共引·徽章文案为「N 章共引」',
    /^\d+ 章共引$/.test((await page.locator('.ref-item .dup').first().textContent()).trim()), true);

  /* 13. 单条引注复制（APA / MLA） */
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const sample = await page.evaluate(async () => {
    const res = await fetch('assets/data/references.json');
    const data = await res.json();
    return data.items.find((i) => i.author && i.year != null);
  });
  const apaBtn = page.locator(`button[data-cite="apa"][data-id="${sample.id}"]`);
  await apaBtn.click();
  /* 复制反馈在剪贴板写入完成后才出现，须等一拍再断言，不能点完立刻读 */
  await page.waitForFunction((id) => {
    const button = document.querySelector(`button[data-cite="apa"][data-id="${id}"]`);
    return !!button && button.textContent.trim() !== 'APA';
  }, sample.id, { timeout: 3000 }).catch(() => {});
  check('引注·复制后按钮反馈为「已复制」',
    (await apaBtn.textContent()).trim(), '已复制');
  const apa = await page.evaluate(() => navigator.clipboard.readText());
  check('引注·APA 含作者', apa.includes(sample.author), true);
  check('引注·APA 含年份', apa.includes(String(sample.year)), true);

  await page.locator(`button[data-cite="mla"][data-id="${sample.id}"]`).click();
  const mla = await page.evaluate(() => navigator.clipboard.readText());
  check('引注·MLA 含作者', mla.includes(sample.author), true);
  check('引注·MLA 与 APA 结果不同', mla !== apa, true);

  /* 14. 控制台零错误 */
  check('控制台零错误', consoleErrors.length, 0);
  if (consoleErrors.length) console.log(consoleErrors);

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 项断言，失败 ${failed.length} 项`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
