# 聚酯链驾驶舱 · Polyester Desk

个人用能化产业链看板。原油 → 石脑油 → PX → PTA → MEG → 瓶片 / 短纤 → 长丝 → 服装，
一条链走完，K 线、加工费、现货、全球股债汇商品、数据血统、情报流都在一屏里。

纯静态：**没有后端、没有构建步骤、没有 npm**。一个 `index.html`，推上 GitHub Pages 就能在任何地方打开。

---

## 0. 配色

色值取自 **Imperial College London 官方视觉规范**：

| 用途 | 色值 | 说明 |
|---|---|---|
| 底 | `#0e1116` | 近黑 |
| 强调（文字/线） | `#0091d4` Pool Blue | 对底色 5.4:1，达到 WCAG AA |
| 次级（描边/悬停） | `#006eaf` Process Blue | |
| 填充（选中态） | `#003e74` Imperial Blue | 配白字 8.2:1 |
| 深填充 | `#002147` Navy | |
| 区分节点 | `#009cbc` Seaglass | 产业链末端的「服装」 |
| MA20 | `#9d9d9d` Cool Grey | 与蓝拉开距离，不撞色 |

> 为什么不用 Imperial Blue 当正文色：它在近黑底上只有 1.8:1 对比度，会看不清。
> 所以拆成三层——深蓝做填充，亮一档的 Pool Blue 做文字和线条。

涨红跌绿（中国习惯），全站统一。改主题只需要改 `assets/app.css` 顶部那组变量。

---

## 1. 目录结构

```
polyester-desk/
├── index.html                    页面骨架（唯一的 HTML 文件）
├── .nojekyll                     阻止 Jekyll 处理，避免下划线目录被吃掉
├── .gitignore                    排除 .env 和真实的 ai_digest.json
├── .env.example                  密钥放哪，照着抄
├── README.md                     你正在看的这份
├── assets/
│   ├── app.css                   设计系统 v3「哑光黑曜石」，含响应式栅格
│   ├── config.js                 品种、新闻频道词典、11 组全球市场、日历规则 —— 改配置只改这里
│   ├── data.js                   数据层：多源适配器 + 三级缓存 + 四级降级 + hasSeries 判定
│   ├── charts.js                 K 线（Lightweight Charts）+ 迷你走势
│   ├── news.js                   情报流：分频道、高亮、自动滚动、轮询去重
│   ├── app.js                    编排：切换联动、热力图、血统、新鲜度、日历、AI、终端
│   └── vendor/
│       └── lightweight-charts.standalone.production.js   v4.1.3，Apache-2.0，本地自带
├── data/
│   ├── desk.json                 由 tools/export_desk_json.py 生成
│   ├── ai_digest.json            由 GitHub Actions 里的 tools/ai_digest.py 生成（不入库）
│   └── ai_digest.example.json    产物长什么样（样子示例，不是真数据）
├── .github/workflows/
│   └── ai-digest.yml             每日 4 次：拉数据 → 生成复盘 + 情报分析 → 提交回仓库
└── tools/
    ├── export_desk_json.py       读 polyester.db + FX 工作簿 → desk.json（只读，不改原库）
    ├── ai_digest.py              DeepSeek 复盘 + 情报分析，见第 6 节
    ├── cloudflare_worker.js      可选的按需解读代理
    ├── publish.sh                一键：更新数据 → 提交 → 推送
    ├── e2e_check.mjs             88 项无头浏览器交互自检（0 FAIL 才退出码 0）
    └── overflow_scan.mjs         10 档宽度全扫「跑出框」+ 截图
```

**为什么图表库放本地**：`cdn.jsdelivr.net` 在国内时通时不通，一旦拉不到，整个 K 线区就是空白。
160 KB 的文件放在自己仓库里，比省这点体积划算得多。同理，页面不依赖任何 npm 包。

---

## 2. 本地先跑起来

### 2.1 生成数据文件

```bash
cd polyester-desk
python3 tools/export_desk_json.py
```

正常输出：

```
[ok] 已写出 .../polyester-desk/data/desk.json
     数据截止 2026-09-21 | 序列 19 条 | 血统 ok=8 partial=2 single=9
     价差 7 组 | 冲突组 6 | 汇率 3 组 ['USDCNY', 'USDKRW', 'USDJPY'] | 体积 36.2 KB
```

脚本是**只读**的：用 `mode=ro` 打开 `polyester.db`，不写回、不生成中间文件。
读汇率工作簿需要 `openpyxl`（没装会自动跳过汇率，不影响其它数据）：

```bash
~/.workbuddy/binaries/python/envs/default/bin/pip install openpyxl
```

换机器用参数覆盖默认路径：

```bash
python3 tools/export_desk_json.py \
  --db ~/Desktop/data_run/data/polyester.db \
  --fx ~/Desktop/Database/2026/"FX rate"/FX_rate_Source.xlsx
```

### 2.2 起本地预览

**不要直接双击 `index.html`**。`file://` 协议下浏览器会拦掉 `data/desk.json` 的读取，
页面会显示「读不到 desk.json」。

```bash
cd polyester-desk
python3 -m http.server 8791
# 打开 http://127.0.0.1:8791/
```

或者用一键脚本（会顺手重建数据）：

```bash
./tools/publish.sh
```

---

## 3. 数据从哪来 —— 全部实测过

| 内容 | 来源 | 浏览器直连 | 说明 |
|---|---|---|---|
| CN 期货日线 / 60 分钟线 | 新浪 `stock2.finance.sina.com.cn` JSONP | ✅ | TA0 4803 根日线；PX0/PF0/PR0/EG0/SC0 全通 |
| **国内能化 / 黑色 / 纺织主力** | 同上（新浪日线） | ✅ | MA0 EB0 V0 L0 PP0 SA0 FG0 UR0 FU0 BU0 / RB0 I0 CU0 AL0 / CF0 CY0 —— 与上方 K 线**同一源同一口径**，点开就有 120 日 K 线 |
| A 股 / 港股指数 + 60 日趋势 | 腾讯 `qt.gtimg.cn` + `web.ifzq.gtimg.cn` | ✅ `ACAO: *` | 上证/沪深300/中证500/创业板/中证1000/上证50/科创50/深证成指 + 恒生/恒生科技/国企 |
| 美债 2Y/3M/5Y/10Y/30Y、日债 10Y、德债 10Y、美元指数、美股、VIX、金铜银铝、天然气 | **CNBC** `quote.cnbc.com` | ✅ `ACAO: *` | **一个请求拿一批**，25 个代码分 3 批并发 |
| 全球股指：日经225 / 韩国KOSPI / 德国DAX / 英国富时100 / 法国CAC40 / 中国台湾加权 | 同上（CNBC） | ✅ | 源只给快照、不给历史序列 → 渲染成**不可点的快照条**，不是空面板 |
| 现货 / 加工费 / 现金流 / 仓单 / 开工率 | 你自己的 `polyester.db` | ✅ 静态 JSON | 免费 API 拿不到，这是本站的核心差异 |
| **聚酯链现货日序列**（POY / FDY / DTY / 切片 / PTA / MEG / PX / 石脑油） | 同上，`desk.json` 的 `series` | ✅ 静态 JSON | 库里本来就有 12–16 个点的日序列，之前只用了当天的数；现在整条序列放出来，**零新增网络请求** |
| 汇率 USDCNY / USDJPY / USDKRW | 你自己的 `FX_rate_Source.xlsx` | ✅ 静态 JSON | 按表头声明的方向读取 |
| 7×24 情报 | 东方财富 `np-listapi` | ✅ `ACAO: *` | 45 秒轮询 + 去重 |
| 日历：FOMC | 美联储官网 | — | 2026 剩余：10/27-28、12/8-9 |
| 日历：EIA 周报 | EIA 官网 | — | 周三 10:30 ET，含官方假日顺延表 |

### 3.1 已验证但踩到的坑

- **`hq.sinajs.cn` 会 403**。网上绝大多数教程推荐它（`hq.sinajs.cn/list=hf_CL,DINIW`），
  但它带 `Referer: https://xxx.github.io/` 会返回 **403 Forbidden**，**不能用在 GitHub Pages 上**。
  替代方案：期货用 `stock2.finance.sina.com.cn` 的 JSONP，宏观用 CNBC + 腾讯。
- **腾讯行情有「简版 / 全版」两套字段位**。`s_sh000001`（简版）的 `f[4]` 是涨跌额，
  `sh000001`（全版）的 `f[4]` 是昨收。混用会静默算错涨跌。本站只用全版，字段位：
  `f[3]=最新 f[4]=昨收 f[5]=今开 f[31]=涨跌额 f[32]=涨跌幅% f[33]=最高 f[34]=最低`。
  交叉校验：上证 3952.13 − 昨收 3949.91 = 涨跌额 2.22 ✓
- **腾讯的 `usXXX` 前缀是美股个股**，不是商品。`usCL` 是高露洁不是原油，`usDX` 是德尼克斯投资
  不是美元指数。指数只有 `usDJI/usIXIC/usINX` 是真的。
- **新浪的 CME 外汇期货已停更**。`DX`（美元指数期货）/`EC`/`JY` 的数据停在 2019-11-29，别用。
- **Lightweight Charts 的分钟线 `time` 必须是 UNIX 秒**。传 `'YYYY-MM-DD HH:MM:SS'` 字符串
  不会在 `setData` 报错，而是在下一帧抛 `Value is null`，极难定位。
  已按本地时区转时间戳，并配套本地化格式化器（否则标签整体偏 8 小时）。
- **东财 `push2` / `push2his` 会限流**，连续请求返回空（`http=000`）。本站不依赖它，
  宏观全部走 CNBC + 腾讯，两者都实测稳定。
- **口径要统一**：CNBC 的布伦特报 100.22，你自己的库是 96.24，跟新浪 OIL 的 96.24 一致。
  所以布伦特/WTI 用你的库，CNBC 的单独列成「布伦特(CNBC)」做对照，不混在一行里。
- **本轮新验过、可用的代码**（全部实测返回 200 且有值）：CNBC `US3M` `US5Y` `JP10Y` `DE10Y`
  `.N225` `.KS11` `.GDAXI` `.FTSE` `.FCHI` `.TWII` `@AL.1` `@NG.1`；
  腾讯 `sh000852` `sh000016` `sh000688` `sz399001`；新浪 `MA0`（甲醇主力）。
- **本轮验过、不可用的**：东财 `push2` 报价接口返回 `rc:102, data:null`；
  新浪期货列表 API 返回 `Service not found`。两者都没进代码。

### 3.2 「能不能点」是数据源属性，不是样式选择

一个瓦片能不能点开看 K 线，取决于**数据源给不给历史序列**，不取决于它重不重要。
所以这个判断在取数时就固化成 `hasSeries`：

| `hasSeries` | 渲染成什么 | 行为 |
|---|---|---|
| `true` | `<button class="mtile">` | 可点，展开成日线 / 折线大图 |
| `false` | `<span class="msnap">` | **不是按钮、没有 tabindex、点了没反应**，前面带一个「快照」前缀 |

为什么不用「点了弹一句『该项无历史数据』」：那等于把一个死按钮摆在人面前反复解释它为什么死。
用非交互元素直接表达「这里只有个数」，是唯一不需要解释的做法。
`#w=xxx` 书签和 `hashchange` 路径也加了同一道守卫，所以书签也点不出空面板。

---

## 4. 页面怎么用

| 想做的事 | 怎么做 |
|---|---|
| 换品种 | 点 K 线上方品种按钮，或点产业链节点，或底部热力格子 |
| 换周期 | 日线 / 60分 / 周线（周线是本地按 ISO 周聚合，不多打请求） |
| 把某一张图放大 | **点「全球市场」里任意瓦片**：这一项展开成日线 K 线大图，同组和其他组同时缩成小格。再点一次 / 点「收起」/ Esc 退出 |
| 找某个品种在哪一组 | 11 个分组：A股 / 港股 / 全球股指 / 美股与情绪 / 利率与美元 / 聚酯链现货 / 能化期货 / 纺织原料 / 黑色与有色 / 商品与产业链上游 / 交易所仓单。点分组标题折叠展开，折叠态是一行摘要 |
| 看到带「快照」前缀的条目 | 那是**故意不可点**的：源只给当日一个数，没有序列可画（见 3.2） |
| 把放大视图存成书签 | `#w=sh000905`（中证500）、`#w=.DJI`（道琼斯）、`#w=TA`（PTA 仓单） |
| 图表坐标系不对了 | **双击图表复位缩放**（鼠标）＝双击触摸（手机）。手机端已禁用价格轴拖拽，不会再误触 |
| 看某个加工费怎么算的 | 鼠标移到价差卡上，卡片下方显示计算公式 |
| 看某个数字来自哪 | 每个瓦片的 `title` 里有来源和取数时间；宏观条上 `L`=实时 / `D`=日终 |
| 看今天的情报主线 | 右上「情报分析」卡：第一行是一句判断，下面是几条带标签的证据，最后一行写清这次分析花了多少 token |
| 只看某类情报 | 点情报流频道按钮；数字是命中条数，为 0 说明这段时间真没相关新闻 |
| 情报流不滚了 | 鼠标移上去暂停，移开继续；滚轮手动滚过后停 4 秒再接管 |
| 存常用视图为书签 | 地址栏加锚点：`#PX`、`#PX/W`、`#SC/60`、`#term` |
| 打开终端模式 | 按 `/`（或 Cmd+K）。`help` 看全部指令，`Esc` 关闭 |
| 强制重取 | 右上角「刷新」，会清本地缓存重新拉全部 |

**终端指令**：`help` · `chart PX W` · `TA` `SC` `EG` · `D` `60` `W` ·
`w 中证500` / `w off` · `news fed` · `macro` · `heat` · `prov` · `desk` · `ai` · `refresh` · `clear`

### 4.0 全球市场点开之后看到的是什么

| 数据源给到什么 | 画什么 | 例子 |
|---|---|---|
| 日线开高低收（腾讯 / 新浪 / 本地库带 OHLC） | 蜡烛图 + MA5 / MA10 + 成交量 + 区间统计 | 上证 / 中证500 / 恒生 / 标普 / 纳斯达克 / 道琼斯 / 甲醇 / 螺纹钢 / 棉花 |
| 只有收盘价（本地库 / 汇率库 / 东财仓单） | 折线 + 面积（不假装有开高低） | SC原油 / 布伦特 / WTI / 石脑油 / POY / FDY / 切片 / USDCNY / PTA 仓单 |
| 只有当日快照 | **不可点的快照条**，只给数值和来源 | 美债 2/3M/5/10/30Y、2s10s、美元指数、VIX、日经 / 韩国 / DAX / 富时 / CAC / 中国台湾加权、CME 铝、NYMEX 天然气 |

三种情况在页面上是分开说的，不会用一张假曲线把「没数据」糊过去。
VIX 故意不给历史：腾讯的 VIX 历史是一串常数，画出来是一条假平线。

### 4.1 数据是实时的吗 —— 分层看，别混成一句「实时」

| 层 | 频率 | 真实延迟 |
|---|---|---|
| 期货 K 线（日线） | 收盘后更新 | **不是实时**，当天收盘价，约 15:00 后稳定 |
| 期货 K 线（60 分钟） | 盘中更新 | 准实时，通常延迟几分钟 |
| 指数 / 债汇 / 美股 / 商品 | 45 秒缓存 + 60 秒轮询 | 准实时。A 股 15:00 后为收盘值，美股盘中约 15 分钟延迟 |
| 现货 / 加工费 / 仓单 / 开工率 | 日频 | **日终值**，标 `D` 并显示截止日期 |
| 情报流 | 45 秒轮询 | 东财 7×24，通常 1–5 分钟内 |

底部「数据新鲜度」那一行把每层单独列出来，就是为了不让你把日终值当实时值用。
页面不会在任何地方声称自己是 tick 级行情——它不是，也不该假装是。

---

## 5. 部署到 GitHub Pages

> ⚠️ **先说清楚隐私这件事，因为它跟直觉相反。**
>
> | 你的账号 / 仓库 | 结果 |
> |---|---|
> | GitHub 免费账号 | **仓库必须是 Public** 才允许开 Pages |
> | Pro + 私有仓库 | 可以开，但**站点本身仍然是公网可达的** |
> | 只有 GitHub 企业版 Cloud | 才能把站点设成私有 |
>
> GitHub Pages 给你的是「**没有公开宣传**」，不是「**私有**」。
> 页面已加 `noindex,nofollow`，但任何拿到 URL 的人都能打开，`data/desk.json` 也能被直接下载。
> 里面都是公开市场行情（价格、价差、仓单），风险可接受；
> 但**别往里放你的持仓、成本、交易记录**。要真门禁见第 7 节。

### 最简路径：纯网页拖拽（不用终端、不用 token、不用 git）

网站真正需要的只有 **9 个文件、316 KB**，`tools/`、`README.md`、所有点开头的隐藏文件
**都不用上传**。已实测：只传这 9 个，页面 39 项功能全部正常。

```
index.html
assets/app.css
assets/app.js
assets/charts.js
assets/config.js
assets/data.js
assets/news.js
assets/vendor/lightweight-charts.standalone.production.js
data/desk.json
```

1. https://github.com/new → 名字起个不好猜的（如 `desk-7f3a`）→ 选 **Public** → 不勾 README → Create
2. 仓库页面点 **uploading an existing file**
3. 在 Finder 打开这些文件所在目录，按 **Cmd+A** 全选，拖进上传区
   —— **拖"里面的东西"，别拖父文件夹本身**，否则会多套一层目录导致 404
4. **Commit changes**
5. Settings → Pages → Source: `Deploy from a branch` → `main` + `/ (root)` → Save
6. 等 1–10 分钟，访问 `https://<用户名>.github.io/<仓库名>/`

**为什么可以省掉 `.nojekyll`**：GitHub Pages 用 Jekyll 处理时会吃掉 `{{ }}` 和 `{% %}`。
源码里本来有一处 JSDoc 注释 `@returns {{groups:Array, ...}}`，已改成 `{...}` 写法，
现在全站扫描零匹配，所以 Jekyll 就算处理也改不坏任何东西。

> 这个 9 文件的子集是**验证过能独立运行**的：把它单独拷到一个空目录起 HTTP 服务，
> 跑完整自检，39 项全过、console 干净。不是"应该能跑"，是跑过了。

### 用脚本（想省掉第 2 步的手动拖拽）

**方式 A：在 Finder 里双击**（不用开终端）

```
polyester-desk/
├── 体检.command      ← 先双击这个：只检查，不改任何东西
└── 部署.command      ← 体检通过后再双击这个
```

窗口会留在原地等你按回车，方便你看结果。如果 macOS 提示「无法打开，因为来自身份不明的开发者」，
**右键点它 → 打开 → 再点「打开」**，之后就不会再问了。

**方式 B：在终端里跑**

```bash
cd polyester-desk
./tools/deploy_github.sh --check     # 先体检，不改任何东西
./tools/deploy_github.sh             # 然后正式跑
```

两种方式跑的是同一个脚本。它会问你 4 项（GitHub 用户名、仓库名、提交显示名、邮箱），
然后自动完成：体检 → 配凭据助手 → 建仓 → 提交 → 挂远端 → 推送，并打印你要手动点的两个链接。

`--check` 做三件事：查 git 版本是否够新、查能不能连上 github.com、
**扫描密钥字面量**（发现就中断，不让你把 token 推上去）。

### 密钥扫描是怎么做的

**不按扩展名挑文件，扫「所有会被提交的文件」。** 第一版只扫 `*.js / *.html / *.json`，
而钥匙真正容易被误粘进去的地方恰恰是 `.env`、`*.py`、`*.sh`、`*.command` —— 一个都没覆盖，
等于守卫建在了没人的门口。现在改成：

- 在 git 仓库里 → 用 `git ls-files --cached --others --exclude-standard` 取清单，
  也就是「真正会提交的集合」，并且自动尊重 `.gitignore`
- 还没建仓（`--check` 阶段）→ 扫工作区全部，只告警
- **提交前会再查一次**，那一次是权威的，命中就中止，什么都不提交

覆盖三类最常见的钥匙形态：模型 API key（`sk-…`）、GitHub PAT（`ghp_…` / `gho_…`）、
AWS Access Key（`AKIA…`）。二进制文件按 MIME 识别跳过，不会把图片当文本扫出假阳性。

`.env` 是唯一豁免的文件——它本来就该放钥匙，而且已被 `.gitignore` 忽略，不会进仓库。
但**别的文件里出现真钥匙一律拦死**，包括 `.env.example` 这种模板：模板里只留
`sk-REPLACE-WITH-YOUR-OWN-KEY` 这样的占位符。

已知会被脚本处理的四个环境坑（都是实际踩到的）：

- **凭据助手不在标准路径**。macOS 有时 `/usr/bin/git-credential-osxkeychain` 缺失，
  只有早期独立安装的 git 里留着一个。脚本逐个探测可用路径，找到就用钥匙串
  （token 只输一次），找不到就明确告诉你每次都要重输。
- **git 身份没配过**。脚本只写仓库级 `user.name` / `user.email`，**不动你的全局配置**。
- **全局配置写不进去**（HOME 异常、`.gitconfig` 只读）。凭据助手是便利项不是必需品，
  写失败会降级到本仓库配置，不阻断部署。
- **中文文件名被转义**。默认 `core.quotepath=true` 会让 `体检.command` 在 `git status` 里
  显示成 `\344\275\223\346\243\200.command`，看起来像乱码。脚本会关掉这个转义。

### 手动路径（不想用脚本的话）

### 步骤 1：建仓库

1. https://github.com/new
2. Repository name 填一个**不好猜**的名字，例如 `desk-7f3a`（别用 `my-dashboard`）
3. 选 **Public**（免费账号必须）
4. **不要**勾 Add a README / .gitignore / license —— 本地已有，勾了反而要处理冲突
5. Create repository

### 步骤 2：推上去

```bash
cd polyester-desk

git init
git branch -M main

# 你的机器上全局 git 身份是空的，不设这两行 commit 会直接失败：
#   *** Please tell me who you are.
git config user.name  "你的名字"
git config user.email "你的邮箱"

git add -A
git commit -m "init: 聚酯链驾驶舱"

git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

> 上面两行只写进这个仓库，不会改你的全局配置。想全局设置就把 `git config` 换成 `git config --global`。

第一次推送要认证。GitHub **不接受账号密码**，需要 Personal Access Token：

1. https://github.com/settings/tokens → **Tokens (classic)** → Generate new token (classic)
2. Note 随便写，Expiration 90 days，勾 **`repo`**
   > 如果仓库里有 `.github/workflows/`（本项目用云端定时任务时会用到），
   > 还要额外勾上 **`workflow`**，否则推送会被拒：
   > `refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`
   > 已经生成过的 token 可以点进去「编辑权限」补勾，**token 值不会变**，不用重新粘贴。
3. 生成后**立刻复制**那串 `ghp_...`（离开页面就看不到了）
4. 推送时 Username 填用户名，**Password 位置粘贴这个 token**

> 更省事：装 GitHub CLI（`brew install gh`）→ `gh auth login` 走浏览器授权，之后不用管 token。

**报 `remote origin already exists`**：
```bash
git remote set-url origin https://github.com/<用户名>/<仓库名>.git
```
**报 `failed to push some refs`**：远端已有提交，`git pull --rebase origin main` 后再推。

### 步骤 3：打开 Pages

1. 仓库 → 右上 **Settings**
2. 左侧 **Code and automation** → **Pages**
3. **Source** 选 `Deploy from a branch`
4. **Branch** 选 `main` + `/ (root)` → **Save**

### 步骤 4：等构建，然后访问

```
https://<用户名>.github.io/<仓库名>/
```

**构建要 1–10 分钟**，不是即时的。刚 Save 完立刻打开大概率 404，等一会儿再刷。
之后每次推送通常 1 分钟内生效。

### 步骤 5：验证真的上线了

用**无痕窗口**打开（没有登录态和缓存）。再顺手做四件事：

- K 线出来了 → 新浪源在公网可用
- 右上情报流有条目 → 东财源可用
- 「全球市场」里 A 股/港股/美股/美债都有数 → 腾讯和 CNBC 可用
- 手机浏览器也开一次，确认移动端没散

### 步骤 6：以后更新

```bash
./tools/publish.sh --push
```

重跑数据导出 → `git add -A` → 提交 → 推送。等一分钟刷新页面。

---

## 6. AI 复盘 + 情报分析：怎么用最少的 token

痛点不是「缺 AI」，是「每天几十条新闻，我懒得一条条读，
但又不想被一个胡说八道的模型带偏」。所以设计原则是**把 token 花在判断上，不花在搬运上**。

### 6.0 一次调用，三份产物 —— 这是省钱的全部秘密

```
GitHub Actions（每天 4 次，北京时间 09/12/15/18）
        │
        ├─ 抓新闻 → 关键词分级筛选（0 token）
        ├─ 调 DeepSeek 一次（固定 system prompt → 前缀缓存命中）
        │
        └─► data/ai_digest.json
                ├── digest / drivers   逐品种复盘
                ├── headlines          今日要点（回答「今天发生了什么」）
                └── macro_brief        情报分析（回答「这些事合起来说明什么」）
                        │
                        ▼
              浏览器只做一件事：读这个文件
```

**浏览器端 0 次 API 调用、0 个密钥、0 元成本。** 页面刷一百次也是 0 token。
token 只花在「一天四次的判断」上，不花在「每 45 秒一次的搬运」上。

这和「点按钮实时问」是两条路，不要混：
- **默认路（本仓库已启用）**：静态产物，只读，永远能用，永远免费。
- **可选路（6.4）**：需要自己架一个持钥匙的代理，才有实时问答。

`macro_brief` 是刻意和 `headlines` 分开的两个字段：
`headlines` 负责**罗列**，`macro_brief` 负责**下判断**。后者只有一句话结论（`read`）
加几条带标签的证据（`points`）。system prompt 里写死了一条：
证据不足时 `read` 就写「今日无明确主线」，**不要硬凑一句正确的废话**——
一个每天都在说「市场情绪谨慎，需关注政策变化」的分析卡，等于没有分析卡。

### 6.1 六个省 token 的设计

| 手段 | 效果 |
|---|---|
| **先用关键词筛，再喂模型** | 逐条新闻调 LLM 是最贵的错法。60 条里通常只有 8–10 条与能化相关，筛选这一步 0 token |
| **关键词分级权重** | 核心品种词权重 3、能化宏观词 2、泛词/季节词 0.5，过阈才进上下文。不分级的话「消费」「订单」会把茅台、苹果的新闻一起捞进来——那比不筛更糟 |
| **输入哈希缓存** | 整段上下文算 sha256 存进产物。**只有截面数据和新闻标题都没变时才复用**，那时一次 API 都不打。注意：白天标题一直在变，所以一天四次基本都是真实调用，别指望它把四次变成一次 |
| **异动闸门** | `--anomaly 2` 让它只在真有品种涨跌超过 2% 时才调用 |
| **固定 system prompt** | DeepSeek 有磁盘前缀缓存，固定前缀按 cache-hit 计费，约为未命中的 **1/50**。**这才是四次调用里真正省下来的部分**（约 600 token 的 system 段） |
| **空闲时段跑** | DeepSeek 2026-08-17 起峰谷定价，高峰（北京时间 9–12、14–18）是空闲时段的**两倍**。<br>`--off-peak-only` 让它只在空闲时段执行 |

### 6.2 实测数字

`--dry-run` 不发请求，只把 prompt 和 token 估算打出来：

```
▸ 北京时间 2026-09-23 00:09（空闲时段）
▸ 词典来源 assets/config.js（142 词）· 抓到 60 条 → 过阈 9 条（强相关 5 / 泛词 4）→ 送入 8 条
  入选条目命中词：对二甲苯+PTA+乙二醇 | 国债+收益率+债券 | ...
--- system 约 235 token · 输出上限 400 token ---
--- 单次估算：输入约 865 token，粗算成本 $0.000121 ---
```

页面右上「情报分析」卡的最后一行，写的是**真实账单数字**，不是估算：

```
deepseek-flash · 输入 1295 + 输出 407 tokens ≈ $0.00030
```

这个数直接来自 API 返回的 `usage`，不做任何换算美化。
脚本不硬编码费率（DeepSeek 2026 年调过价且改成了峰谷定价），
费率表在 `tools/ai_digest.py` 顶部，要改就改那里。

**一天四次，每次几百 token → 一个月约 3 分钱。**

成本别自我安慰：输入哈希覆盖的是「截面数据 + 新闻标题」整体，
白天标题一直在变，所以**四次都是真实调用**，不是三次命中缓存。
省下来的只有 system 前缀那一段（DeepSeek 磁盘前缀缓存，按 1/50 计费）。
四次换来的是「下午看到的不是早上的判断」——这个值。

### 6.3 怎么用

**第一步：把密钥放好（这一步最关键）**

```bash
cd polyester-desk
cp .env.example .env
# 编辑 .env，填入你的 key
```

`.env` 已经在 `.gitignore` 里，不会被提交。

> 🔴 **绝对不要把密钥写进 `assets/` 里的任何文件。**
> 前端跑在公开的 GitHub Pages 上，浏览器能拿到的密钥等于全网公开——
> 你的额度会在几个小时内被扫走。这是硬约束，不是建议。

**第二步：先看要花多少**

```bash
python3 tools/ai_digest.py --dry-run
```

把要发送的上下文原样打出来。**看一遍，不对就改关键词，不要直接跑。**

**第三步：真跑**

```bash
python3 tools/ai_digest.py                      # 正常跑一次
python3 tools/ai_digest.py --anomaly 2          # 只在有品种涨跌超 2% 时才调
python3 tools/ai_digest.py --off-peak-only      # 只在空闲时段调
python3 tools/ai_digest.py --news-limit 6       # 严格省钱模式
python3 tools/ai_digest.py --max-out 1000       # 输出上限（默认 1000，含情报分析）
python3 tools/ai_digest.py --force              # 数据没变也重跑
```

产物写到 `data/ai_digest.json`，页面会自动读。没有这个文件时整个区块隐藏，不会报错。
想先看效果：把 `data/ai_digest.example.json` 复制成 `data/ai_digest.json`。

**每天自动跑（GitHub Actions，已配好）**

`.github/workflows/ai-digest.yml` 每天北京时间 **09:00 / 12:00 / 15:00 / 18:00** 各跑一次，
把产物提交回仓库，Pages 自动重建。只需要在仓库里配一个 secret：

```
Settings → Secrets and variables → Actions → New repository secret
名称：DEEPSEEK_API_KEY      值：你的 key
```

为什么可以放心跑四次：**输入哈希缓存**。行情和新闻没变时，脚本连请求都不发，
直接复用上次结论并打一行「命中缓存」。所以四次的实际计费通常只发生在一两次。

**本地接在你现有采集后面**（不想用 Actions 的话）：

```bash
# ~/Desktop/data_run/run.command 末尾追加
DASH="$HOME/WorkBuddy/2026-09-22-23-13-50/polyester-desk"
if [ -d "$DASH" ]; then
  (cd "$DASH" && python3 tools/ai_digest.py --anomaly 1.5 && ./tools/publish.sh --push) \
    || echo "驾驶舱更新失败，不影响采集"
fi
```

### 6.4 想在页面上点按钮实时问？那需要一个代理

前端在公开页面上，密钥不能进浏览器。第二种用法（点按钮 → 实时解读）必须有个持钥匙的服务端。
`tools/cloudflare_worker.js` 就是干这个的，Cloudflare 免费额度足够：

```bash
npm i -g wrangler && wrangler login
wrangler secret put DEEPSEEK_API_KEY     # 填你的 key
wrangler secret put SHARED_TOKEN         # 自定义一串随机字符串
# 改文件里的 ALLOW_ORIGIN 为你的 Pages 域名
wrangler deploy
```

Worker 里做了三件防护：`Origin` 白名单、共享口令校验、输入长度上限 4000 字符
（防止有人拿它当免费通用 API）。

---

## 7. 如果你以后想要真正的私有

GitHub Pages 给不了。三条路，按省事程度排：

1. **Cloudflare Pages + Cloudflare Access** —— 免费额度支持 50 个用户，走邮箱验证码登录。
   同一个仓库连到 Cloudflare Pages，在 Zero Trust 里加一条 Access 策略。
2. **GitHub 企业版 Cloud** —— 官方支持私有 Pages，但贵，个人用不值。
3. **前端密码框** —— 别用。GitHub 官方文档明确写了这不构成访问控制：
   校验逻辑和资源都在访客手里，只能挡不想点开的人。

---

## 8. 日历的准确性是怎么保证的

三个层次，不混着说：

1. **官方确切日期**（FOMC、EIA）—— 硬编码在 `config.js`，标注了核对日期 **2026-09-22**，
   页面上也显示这个日期，让你知道这份表是什么时候核的。
   - FOMC 2026 全年 8 次，含 2027 年 8 次，来源 `federalreserve.gov/monetarypolicy/fomccalendars.htm`
   - EIA 周三 10:30 ET，含官方发布的假日顺延表（例如 2026-10-14 顺延到 10-15）
   - 时区用真正的美国夏令时规则换算（3 月第 2 个周日 – 11 月第 1 个周日），不是写死 +12 小时
2. **规则推算**（PMI、社零、非农、CPI、进出口）—— 页面上标「约」，并附官方日程链接。
   这类事件没有稳定的公开日历接口，所以**不假装它是确切日期**。
3. **过期守卫** —— 如果硬编码的日期表里已经没有未来项，页面顶部会弹红框
   「日历数据需要更新」，而不是静默显示错误日期。**这是这一块唯一会真正出错的场景，
   所以让它可见。**

进度条用「上一场 → 下一场」的真实区间（FOMC 用前一次会议日期），不是拍脑袋的 30 天窗口。

---

## 9. 自检

```bash
cd polyester-desk
python3 -m http.server 8791 --bind 127.0.0.1 &
node tools/e2e_check.mjs http://127.0.0.1:8791/       # 88 项交互断言
node tools/overflow_scan.mjs http://127.0.0.1:8791/   # 10 档宽度全扫跑出框 + 截图
```

用无头 Chrome 真跑 **88 项**：链条节点、热力格子、K 线取数、价差与迷你走势、血统行、
日历倒计时与进度条、情报流条目与高亮、全球市场 11 个分组与 49 张瓦片、
**快照条不可点（必须是 `SPAN`、没有 `tabindex`、点了不弹面板）**、
2s10s 利差、跑马灯、数据新鲜度、AI 区块与产物状态一致、AI 复盘正文与 token 行、
**配色断言（强调色必须是 `#0091d4`，全站不得残留旧主题色）**、
点链条联动、终端指令、频道过滤、60 分钟线时间轴、自检按钮真的绑上了，
最后打印所有 console 的 error / warning，并给出 `N PASS / N WARN / N FAIL` 汇总。

**有 FAIL 就退出码 1**，所以它能直接接 CI，而不是只能靠人眼看。
不装任何依赖：Node 22 自带 `WebSocket` + Chrome 自带调试协议。
它能抓到 `setData` 之后**下一帧**才抛的异步异常——`--dump-dom` 抓不到那类问题。

> ⚠ 两个脚本里的 Chrome 启动参数都带 `--no-proxy-server`，**不要删**。
> 这台机器设了 `HTTPS_PROXY=http://127.0.0.1:51990`，Chrome 会把它当系统代理，
> 连 `http://127.0.0.1:8791/` 都走代理 → 页面变成 `chrome-error://chromewebdata/`
> → 所有断言读到「`.card` 数量为 0」。现象长得像「本地服务没起来」，实际是代理吃掉了 loopback。

> ⚠ 起服务要写 `--bind 127.0.0.1`，且必须让它**留在前台或真正的后台任务里**。
> 用 `python3 -m http.server 8791 &` 塞进一次性 shell 命令里，命令一结束服务就没了，
> 后面 Chrome 拿到的是连接被拒。

---

## 10. 免责

所有数据来自公开渠道和你自己的采集管线，可能存在源间口径差异、主力合约换月跳空、
低频序列（库存、开工率）滞后等问题。页面底部的「数据血统」和「数据新鲜度」两行
就是把这些问题标出来用的：

- 血统：绿点=多源一致，蓝点=多源分歧，灰点=单源，红点=源间不一致
- 新鲜度：每一层单独说了算，日终值标 `D` 并显示截止日期

`data/ai_digest.json` 里的文字由大模型生成，**只依据喂给它的数据**，但它仍可能读错。
把它当草稿，不当结论。

**这只是个人研究工具，不构成任何交易建议。**
