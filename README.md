# JurisAtlas

《法理学》课程地图、文献库与每周动态 —— 把课程大纲从一篇长文还原为可检索、可筛选的索引页。

- **站点地址**：<https://acagpt.github.io/JurisAtlas/>
- **数据来源**：<https://github.com/acaGPT/Jurisprudence.wiki>
- **当前版本**：v0.4.2

## 这个站点做什么

课程大纲是一份九百余行、九单元四十六章的长文档。它适合通读，不适合查找：
想知道「第四单元有哪几章」「哪几章已经有了课前概览」「哪一章讨论哈特与富勒之争」，
都只能在长文里翻。

本站把大纲解析为结构化数据，提供三页：

**课程地图（`index.html`）**

1. **单元分组浏览**——九个单元各自成区，章卡并列，可一屏看尽一个单元；
2. **跨字段检索**——在章号、中英题名、中英梗概五个字段上做即时过滤；
3. **撰写进度可视**——每章标注课前概览是「已有」还是「待撰写」，并可据此筛选。

**文献库（`references.html`）**

1. **逐条检索**——在作者、题名、年份、渠道上做即时过滤，中英文皆可；
2. **按获取方式筛选**——粗分「全文直读 / 需定位或订阅」，细分至
   Open Library、doi.org、SEP、HeinOnline 等具体渠道（仅 1 条的长尾渠道默认折叠）；
3. **三种排序**——按课程结构（默认）、按作者、按年份；
4. **跨章共引标记**——同一著作在多章出现时标注「N 章共引」并列出所在章，
   拼阅读清单时可据此去重；
5. **单条引注复制**——每条可一键复制 APA 或 MLA 引注，纯客户端生成；
6. **导出书目**——一键导出全部条目的 BibTeX 或 RIS（固定全量，不随筛选变化）。

**本周 AI+法律动态（`weekly.html`）**

1. **三层结构浏览**——制度主题 → 事件类型 → 条目，可先按主题收窄再读；主题筛选
   收在一行里，放不下的点「更多主题」展开；
2. **事件而非消息**——同一件事的多条报道收在一张卡片里按日期排开，跨周的接上「此前」进展；
3. **逐条出处**——每条注明日期、来源与原文链接，判断依据可以直接点开核对；
4. **人工标记**——每条可标 Law 或 Tech（默认 Law），标为 Tech 的是「这条更像技术动态」
   这一判断，留在这台设备上供自己复核；

## 内容边界

本站**不复制正文**。章节梗概、文献条目、课前概览链接均取自大纲原文，
阅读入口一律指向课程 Wiki。正文与文献的增删改，只在 Wiki 一处发生；
本站的数据层由脚本从 Wiki 重新生成，不手工维护第二份内容。

周报页同理：`weekly.json` 是 Wiki 上周报页的读回结果，站内不做二次编辑。
页面上唯一由读者产生的东西是 Law / Tech 标记，它只存在浏览器本地、不写回 Wiki。

`index.html` 页脚与 `LICENSE` 载明本站的版权条款。

## 目录结构

```
.
├── .github/workflows/
│   └── sync-wiki.yml          # 每日轮询 Wiki，落后则抽取并直推 gh-pages
├── tools/
│   ├── extract-syllabus.py    # 从 Wiki 大纲抽取课程地图数据层
│   ├── extract-references.py  # 从 Wiki 大纲抽取文献库数据层
│   ├── extract-weekly.py      # 从 Wiki 周报页抽取「本周 AI+法律动态」数据层
│   ├── apply-weekly-labels.py # 把人工 Law/Tech 标记整理为反馈表（页面已无导出，备用通道）
│   ├── check-sync.py          # 三级比对：Wiki → 数据层 → 线上 Pages
│   ├── bump-version.py        # 递增 README 版本号，供自动发版取号
│   ├── qa-references.js       # 文献库断言式 QA（playwright + Chrome）
│   └── qa-weekly.js           # 周报断言式 QA（渲染、工具栏、标记、持久化、深色跟随）
├── site/                      # 站点源（发布到 gh-pages 分支）
│   ├── index.html              # 课程地图
│   ├── references.html         # 文献库
│   ├── weekly.html             # 本周 AI+法律动态（每条可标 Law / Tech）
│   ├── 404.html                # 容错页（自包含，根路径运行时推导）
│   ├── .nojekyll
│   └── assets/
│       ├── css/site.css
│       ├── js/app.js
│       ├── js/references.js
│       ├── js/weekly.js
│       ├── data/syllabus.json          # 生成物（纯数据，字节稳定）
│       ├── data/meta.json              # 生成物（含生成时间与源 commit）
│       ├── data/references.json        # 生成物（纯数据，字节稳定）
│       ├── data/references-meta.json   # 生成物（含生成时间与源 commit）
│       ├── data/weekly.json            # 生成物（纯数据，字节稳定）
│       ├── data/weekly-meta.json       # 生成物（含生成时间与源 commit）
│       └── favicon.svg
└── README.md
```

## 重建数据层

数据层由 Wiki 克隆生成。先取得大纲，再分别抽取两页所需数据：

```bash
git clone https://github.com/acaGPT/Jurisprudence.wiki.git

python3 tools/extract-syllabus.py \
  --wiki Jurisprudence.wiki \
  --out site/assets/data \
  --auto

python3 tools/extract-references.py \
  --wiki Jurisprudence.wiki \
  --out site/assets/data \
  --auto

python3 tools/extract-weekly.py \
  --wiki Jurisprudence.wiki \
  --out site/assets/data \
  --auto
```

课程地图输出 `syllabus.json`（单元、章节、文献计数、课前概览链接）与 `meta.json`；
文献库输出 `references.json`（逐条作者、年份、题名、获取渠道）与
`references-meta.json`；周报输出 `weekly.json`（主题 → 事件类型 → 条目三层）与
`weekly-meta.json`。`*-meta.json` 含生成时间与源 commit；三个数据文件为纯数据、
不含时间戳，字节比较稳定，CI 的发版判定正建立于此。控制的输出样例：

```
单元 9 · 章节 46 · 经典文献 235 · 延伸阅读 128 · 已有课前概览 15
文献 363 · 经典 235 · 延伸 128 · 全文直读 294 · 需定位或订阅 69 · 解析失败 0
周次 2026-W43 · 主题 14 · 事件类型 39 · 条目 278 · 事件卡 8
```

`meta.json` 里的 `source_commit` 是数据层的溯源凭据——抽取时写入的 Wiki commit，
也是同步机制判定「站点是否落后」的基准。

## 同步机制

Wiki 大纲更新后，站点数据层由 GitHub Actions 自动跟上，无需人工介入。

```
Course-Syllabus.md  ──抽取器──▶ syllabus.json / meta.json             ─┐
Course-Syllabus.md  ──抽取器──▶ references.json / references-meta.json ─┼─推送──▶ gh-pages ──▶ Pages
Weekly-AI+Law-Brief ──抽取器──▶ weekly.json / weekly-meta.json         ─┘
```

工作流 `.github/workflows/sync-wiki.yml` 每日北京时间 07:17 运行一次，也可手动触发。
每一步都可独立失败而不影响其余步骤：

| 步骤 | 行为 | 失败时 |
|---|---|---|
| 判定 | 比对 Wiki `master` 的 HEAD 与 `gh-pages` 上 `meta.json` 的 `source_commit` | 取不到基准即判定为「无法判定」，本轮不动任何东西 |
| 抽取 | 重跑三个抽取器，产物写临时目录 | 抽取异常退出，`gh-pages` 不被触碰；周报页单独缺失只告警不中断 |
| 推送 | 只替换 `assets/data/` 六个 JSON，站点其余文件沿用分支现状 | 抽取结果与现状一致时不产生空提交 |
| 部署 | 推送后由 Pages 自行部署，工作流不再单独轮询 `/pages` 的 `status` | 该字段反映的是上一次**已完成**构建，会把本次失败读成 `building` |
| 回流 | 同一份数据层提交回 `main`；版本号有变化时一并提交 README | `main` 侧无差异则跳过；两者合并为一次提交，避免第二次推送非快进 |
| 发版 | 仅在 `syllabus.json` / `references.json` / `weekly.json` **确有字节级变化**时递增版本号并建 Release | 无实质变化时只更新溯源信息，不占版本号 |
| 复核 | 以**本轮刚推送的产物**为基准比对线上 Pages，轮询至 30 分钟上限 | 仍不一致才报错；期间若查到 Pages 最近构建 `errored` 立即失败 |

判定与发版的分流是刻意设计：源 commit 变化可能来自首页或其他非大纲页面的改动，
此时站点内容其实没变，不应白耗一个版本号。分流依据是三个纯数据 JSON 的字节差异，
而非 commit 本身。

**数据层必须回流 `main`。** 若只推 `gh-pages`，`main` 上的 `site/assets/data` 会永远
停在上一轮，本地 `check-sync.py` 的「数据层」这一级就恒判落后、失去判定意义。

**复核不能拿 `main` 的数据层当基准。** 同步发生前它还是上一轮内容，比对必然判
「不同步」——v0.2.1–v0.2.4 期间连续四次运行在同步其实成功的情况下被标红，正是此因。
复核须用 `--meta` 指向本轮刚推送的产物。

**复核窗口取 30 分钟。** Pages 从推送到线上可访问通常要十几分钟，v0.3.0 之前的 3 分钟
窗口会在同步其实成功的情况下提前判失败。为不空等，每轮重试都会打印 Pages 最近一次
构建状态，一旦读到 `errored` 立即失败——构建失败不会随时间好转。

手动复查当前是否同步：

```bash
python3 tools/check-sync.py          # 三级比对，含线上 Pages
python3 tools/check-sync.py --offline # 只比本地，跳过联网
```

```
源 Wiki    ：029e825（本地克隆 Jurisprudence.wiki）
数据层     ：029e825｜数据层 已对齐（029e825）
线上 Pages ：029e825｜线上 Pages 已对齐（029e825）
结论       ：同步
```

退出码：`0` 对齐、`1` 落后、`2` 无法判定——可直接用于其他脚本或本地钩子。

## 周报页与人工标记

`weekly.html` 是课程 Wiki 上周报页（`Weekly-AI+Law-Brief`）的镜像。周报由
`pre-class-overview-writing` 技能生成，格式固定为「主题 → 事件类型 → 条目」三层；
`tools/extract-weekly.py` 只把它读回来，不改写一个字，所以站点上与 Wiki 上看到的
是同一条信息、同一个日期、同一处出处。同一件事的多条报道是一张卡片（按日期排开，
跨周的事件把此前的进展收在「此前 …」一行），只发生一次的消息就是一行。

**人工标记是这一页的核心，不是装饰。** 每条信息右侧有 Law 与 Tech 两个并列标签，
默认落在 Law 上。只有两种状态，没有「未表态」这个中间态：

| 状态 | 怎么进入 | 含义 |
|---|---|---|
| Law（默认） | 什么都不用点；改过之后点一下 Law 即退回 | 按法律动态看待 |
| Tech | 点一下 Tech | 人工否定：这条更像技术动态，不该占法律新闻的位置 |

Law 是默认值，所以只用强调色标出、不填底——278 条全挂底色等于没有标记；Tech 是
人工作出的判断，填实并给卡片挂一条琥珀竖条，翻到底也认得出自己改过哪些。
标记存在浏览器本地存储（键 `jcm-weekly-marks:<周次>`，逐周独立），
**不上传、不需要登录、不跨设备**。

工具栏只留搜索框与主题 chip：标记筛选、导出、深浅色切换都不在页面上了，深色跟随
课程地图／文献库上设过的偏好（同一个 `jcm-theme` 键），没设过就跟系统走。

页面当前不导出标记。格式与合并脚本都还在，需要成批收集时可直接取浏览器里的
`localStorage['jcm-weekly-marks:<周次>']`（`{id: "tech"}` 的例外清单），按
`jurisatlas-weekly-labels/v1` 包一层交给 `tools/apply-weekly-labels.py`：

```bash
python3 tools/apply-weekly-labels.py --in a.json b.json c.json
# → weekly-reports/human-labels-2026-W43.jsonl
```

输出每行一个条目，带 `label`、`votes` 与 `agree`。**标为 `tech` 的条目就是
`classify_domain` 的候选假阳性**——它们本来被判定为法律新闻，人读下来认为不是，
下一轮校准应当逐条复核。payload 用 `default_label: "law"` 声明默认值，文件里只列
改判项：默认 Law 是基线，不是判断。同一 id 被多人标过就计票；若要记「我认为是
Law」的异见，需手工补一行 `label: "law"`——票数打平按待复核记 `agree: false`。
不同周的导出不能合并（脚本会拒绝）——跨周的同 id 不相干。

标记只收人不收机器：这一页不自动改分类，也不回写 Wiki。反馈表交回课程维护者，
由人决定下一轮要不要调整判据——与 `relation-gold.jsonl` 那套金标维护是同一个口径。

## 发布

站点为纯静态页，无构建步骤、无第三方依赖。**数据层不由这条链路发布**——它由上面的
同步工作流维护；手工发布用于站点代码（HTML / CSS / JS）的改动。

```bash
python3 ~/.workbuddy/skills/gh-pages-maker/scripts/new_pages_site.py \
  --name JurisAtlas \
  --source site \
  --description "《法理学》课程地图、文献库与每周 AI+法律动态：四十六章与全部阅读文献的可检索索引" \
  --org acaGPT --copyright iLINGBIN --branch gh-pages --auto
```

该脚本会重建 `gh-pages` 分支根目录并重新装配 `LICENSE`、站点 `README` 与 `404.html`。
仓库已有同名分支，需加 `--skip-repo` 复用；清空 `.build` 目录若被安全删除保护拦住，
改用 `git worktree add .build/wt origin/gh-pages` 装配后再推。

本地预览：

```bash
python3 -m http.server 8899 --directory site
```

## 分支

| 分支 | 内容 |
|---|---|
| `main` | 站点源、抽取与检查脚本、同步工作流、说明文档 |
| `gh-pages` | 发布产物（站点源 + `LICENSE` + 站点 `README`），Pages 由此分支根目录发布 |

两分支内容并不相同：`gh-pages` 不含 `tools/` 与本文件，站点 `README` 也与本文件不同。
因此改站点代码、手动发版走 `gh-pages`，改脚本与文档走 `main`；同步工作流只往
`gh-pages` 替换 `assets/data/` 六个 JSON，不触碰站点其余文件。

## 已知事项

- 大纲中的章节标题带章号前缀，抽取时已剥离，章号由卡片徽章单独呈现。
- 大纲中的章节按「中文题名 + 英文题名」两行成对书写，抽取器据此配对合并。
  两章题名若紧邻（PVI.1.a 与 PVI.1.b），块终点须越过本章两行再取下一个异章
  标题，否则会把文献与课前概览小节整段丢给下一章——改动大纲结构后建议重跑
  抽取器，核对各章 `refs_count` 与 `preclass_list` 是否归位。
- `PVI.1.b. Global Debates on Legal Formalism vs Legal Realism` 此前只挂在大纲
  PVI.1.a 的课前概览小节里、且未进 Wiki 首页，已于 v0.1.1 在 Wiki 侧补登本章的
  中英题名、把概览链接归位，并补齐首页导航。
- **延伸阅读统计修正（v0.2.0）**：此前「延伸阅读 132」混入了 4 条课程政策条目
  （学术诚信、出勤、迟交、引注——它们位于大纲末尾的 `## 7. 课程政策` 下，被算进
  最后一章的延伸阅读），修正后为 **128**。抽取器的块边界现以顶层 `## ` 标题为界。
- 文献条目的作者、年份、题名由正则从大纲原文解析，支持英文「作者 (年份)」、
  年份区间（如 1739–40）与中文「作者（年份）《书名》」三种形态；解析不了的条目
  照录原文并标注，当前 363 条全部解析成功。
- 跨章共引只归并**作者非空**的条目（8 组、17 条）：延伸阅读多为百科页面，缺作者
  字段，按题名强行归并会把同名不同页的条目误判为重复，故不参与。
- 单条引注的 APA / MLA 由前端按作者、年份、题名、链接拼装，不联网查元数据。
  原文本身缺出版信息（出版地、出版社、页码不在大纲里），因此引注只到能给出的粒度；
  要完整引注仍以原书为准。
- 延伸阅读中的作者头像在 Wiki 里走相对路径，抽取时已改写为
  `raw.githubusercontent.com/wiki/...` 绝对地址，否则站点上全部 404。
- 同步工作流只在 `master` 分支上取大纲。Wiki 的 `Course-Syllabus.md` 改动若先落在
  特性分支，要等合并进 `master` 才会被站点取到；本地想提前验证，可把该分支克隆下来
  用 `--wiki` 指向它。
- `meta.json` 每次抽取都会写入新的 `generated_at`，即使内容未变。因此判定「是否需要
  同步」以 `source_commit` 为准，判定「是否值得发版」以 `syllabus.json` 与
  `references.json` 的字节差异为准，两者不要混用。
- 自动发版路径（递增版本号 + `gh release create`）已由 CI 真实跑通：v0.2.1–v0.2.4 均为
  同步工作流自行递增并创建，无需人工介入。
- 章数随大纲变动，不手工维护：Wiki 在 v0.2.x 期间由 47 章调整为 **46 章**，已有课前
  概览增至 13。站点上的数字一律由抽取器生成。
- CI 在 UTC 环境运行，`meta.json` 的 `generated_at` 时区写作 `+0000`，与本地生成的
  `+0800` 不同。这是环境差异而非错误，比对请以 `source_commit` 为准。
- 周报页只有一份、每周被覆盖：`weekly.json` 里只有**当周**的条目，历史周次留在课程仓
  的 `weekly-reports/`。因此 `weekly.html` 永远显示最新一周，不提供周次切换——同一周内
  重跑周报会刷新数据层（条数可能因信源增删而变），`content_changed` 也随之触发。
- 抽取器认页名 `Weekly-AI+Law-Brief`。Wiki 侧若改名或删页，工作流会打印告警并跳过周报，
  其余数据照常同步——此时站点上的周报会停在上一轮，而不是变成空白页。
- 条目的 `id` 由「主题 + 事件类型 + 标题」哈希而来。周报重跑若改了标题（例如把「OpenAI
  融资」改成「OpenAI 估值」），该条的 id 会变，读者此前对旧条目的标记就对不上新条目；
  这是有意的取舍——宁可丢一条标记，也不让两条不同消息共用一个 id。

## 版权

Copyright (c) 2026 iLINGBIN. 保留所有权利（All Rights Reserved）。

本站及其所索引的课程内容，未获书面许可，不得以复制、改写、汇编、翻译、上传网络、
制作衍生讲义、商业性使用等方式利用。课堂内为教学目的之讲授、投影、复印，
属许可范围内之使用；公开出版、网络公开发布、商业培训或二次改编须先行取得书面同意。
详见 [LICENSE](LICENSE)。
