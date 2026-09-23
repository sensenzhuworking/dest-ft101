/* ==========================================================================
   config.js — 品种、新闻频道、全球市场面板、日历规则
   所有硬编码的外部地址、代码映射、字段位都在这个文件里。改数据源只改这里。
   ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
   1. K 线品种（CN 期货，走新浪 JSONP）
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   0. 构建标记
   每次改动源码都要 +1。页脚会显示它，用来确认「线上跑的到底是哪一版」——
   上传 / 部署之后如果页脚还是旧号，说明浏览器缓存没清或传错了路径。
   -------------------------------------------------------------------------- */
const BUILD = '2026-09-24.01';

/* 自检要探测的本地文件。
   作用：把「我传了但没生效」变成一个页面自己能回答的问题 ——
   任何一个 404 都会被点名，而不是留下一个空白面板让人猜。 */
const SELF_CHECK_FILES = [
  'index.html',
  'assets/app.css',
  'assets/app.js',
  'assets/charts.js',
  'assets/config.js',
  'assets/data.js',
  'assets/news.js',
  'assets/vendor/lightweight-charts.standalone.production.js',
  'data/desk.json'
];

/* 需要确认已经加载的 JS 模块（用 typeof 判断，因为顶层 const 不挂在 window 上） */
const SELF_CHECK_MODULES = [
  { label: '配置',    file: 'assets/config.js',   has: () => typeof BUILD !== 'undefined' },
  { label: '数据层',  file: 'assets/data.js',     has: () => typeof Desk !== 'undefined' },
  { label: 'K 线',    file: 'assets/charts.js',   has: () => typeof Charts !== 'undefined' },
  { label: '情报流',  file: 'assets/news.js',     has: () => typeof News !== 'undefined' },
  { label: '图表库',  file: 'assets/vendor/lightweight-charts.standalone.production.js',
                                                  has: () => typeof LightweightCharts !== 'undefined' }
];

const KLINE_ORDER = ['SC', 'PX', 'PTA', 'MEG', 'PF', 'PR'];

const PERIODS = [
  { id: '1',  label: '1分',  type: 1,  tail: 400 },   // 新浪 type=1，仅覆盖最近约 3 个交易日
  { id: '60', label: '60分', type: 60, tail: 220 },
  { id: 'D',  label: '日线', type: 101, tail: 180 },
  { id: 'W',  label: '周线', type: 'weekly', tail: 180 }   // 由日线本地聚合，少打一次请求
];

/* --------------------------------------------------------------------------
   0b. 可以在浏览器里【复现】你管道的那部分
   东财数据中心的期货仓单接口，CORS 放行，且实测与你的 CirculatingInventory
   逐日完全一致：

     TA/PX/PF  5 吨/张   PR  15 吨/张   （来自你 _SCHEMA.md 的交割单位表）
     2026-09-16  TA 13435 张 × 5 ÷ 10000 = 6.7175 万吨
     你 Excel Inventory 同日 = 6.7175 万吨            ← 完全吻合

   所以仓单不需要等你的数据。但【现货】不行，见 config 下面的注释。
   -------------------------------------------------------------------------- */
const WAREHOUSE = [
  { id: 'TA', label: 'PTA',    tons: 5  },
  { id: 'PX', label: 'PX',     tons: 5  },
  { id: 'PF', label: '短纤',   tons: 5  },
  { id: 'PR', label: '瓶片',   tons: 15 }
];

/* --------------------------------------------------------------------------
   2. 全球市场面板
   每个瓦片声明一个 src，data.js 里按 src 分发。全部实测过浏览器可直连：

     tx       腾讯 qt.gtimg.cn —— A股/港股指数（CORS *）
     txk      腾讯 web.ifzq.gtimg.cn 日线 —— 迷你趋势 + 聚焦大图（60 天只要 6 KB）
     cnbc     CNBC quote —— 一次请求拿全部：美债 2Y/5Y/10Y/30Y/3M、日德10年、
              美元指数、美国三大指数、VIX、金/银/铜/铝/天然气、日韩德英法台股指
     desk     你自己的 desk.json（现货/期货日终，口径与你数据库一致）
     deskFx   你自己的 FX_rate_Source.xlsx
     em_stock 东财数据中心 —— 交易所仓单
     sina     新浪期货 JSONP —— 国内商品期货主力（与上方 K 线同一个源、同一个接口）
     spread   本地派生（2s10s）

   注：布伦特/WTI 故意用 desk 而不是 CNBC —— CNBC 的布伦特报 100.22，
   你自己的库是 96.24，跟新浪 OIL 的 96.24 一致。同一屏里口径必须统一。

   是否「点得开」不在这里写死：data.js 取数时会算出 hasSeries 挂到每一项上。
   没有历史序列的项（VIX、2s10s、CNBC 的全球股指）由 app.js 渲染成不可点的快照条 ——
   点开一片空白比不给点更糟。
   -------------------------------------------------------------------------- */
const WORLD_GROUPS = [
  {
    id: 'a', label: 'A 股', note: '腾讯 · 含 60 日趋势',
    items: [
      { id: 'sh000001', label: '上证指数', src: 'tx', kline: 'sh000001', digits: 2 },
      { id: 'sh000300', label: '沪深300',  src: 'tx', kline: 'sh000300', digits: 2 },
      { id: 'sh000905', label: '中证500',  src: 'tx', kline: 'sh000905', digits: 2 },
      { id: 'sh000852', label: '中证1000', src: 'tx', kline: 'sh000852', digits: 2 },
      { id: 'sh000016', label: '上证50',   src: 'tx', kline: 'sh000016', digits: 2 },
      { id: 'sh000688', label: '科创50',   src: 'tx', kline: 'sh000688', digits: 2 },
      { id: 'sz399001', label: '深证成指', src: 'tx', kline: 'sz399001', digits: 2 },
      { id: 'sz399006', label: '创业板指', src: 'tx', kline: 'sz399006', digits: 2 }
    ]
  },
  {
    id: 'hk', label: '港股', note: '腾讯 · 含 60 日趋势',
    items: [
      { id: 'hkHSI',     label: '恒生指数', src: 'tx', kline: 'hkHSI',     digits: 2 },
      { id: 'hkHSTECH',  label: '恒生科技', src: 'tx', kline: 'hkHSTECH',  digits: 2 },
      { id: 'hkHSCEI',   label: '国企指数', src: 'tx', kline: 'hkHSCEI',   digits: 2 }
    ]
  },
  {
    id: 'gl', label: '全球股指', note: 'CNBC 快照 · 源不提供历史序列，故只读不可点',
    items: [
      { id: '.N225',  label: '日经225',    src: 'cnbc', digits: 2 },
      { id: '.KS11',  label: '韩国KOSPI',  src: 'cnbc', digits: 2 },
      { id: '.GDAXI', label: '德国DAX',    src: 'cnbc', digits: 2 },
      { id: '.FTSE',  label: '英国富时100', src: 'cnbc', digits: 2 },
      { id: '.FCHI',  label: '法国CAC40',  src: 'cnbc', digits: 2 },
      { id: '.TWII',  label: '中国台湾加权', src: 'cnbc', digits: 2 }
    ]
  },
  {
    id: 'us', label: '美股与情绪', note: 'CNBC 快照 + 腾讯日线',
    items: [
      { id: '.SPX',  label: '标普500',  src: 'cnbc', digits: 2, kline: 'us.INX' },
      { id: '.IXIC', label: '纳斯达克', src: 'cnbc', digits: 2, kline: 'us.IXIC' },
      { id: '.DJI',  label: '道琼斯',   src: 'cnbc', digits: 2, kline: 'us.DJI' },
      // VIX 不给 kline：腾讯的 VIX 历史是一串常数，画出来是假线
      { id: '.VIX',  label: 'VIX 恐慌', src: 'cnbc', digits: 2 }
    ]
  },
  {
    id: 'rates', label: '利率与美元', note: 'CNBC + 你的汇率库',
    items: [
      { id: 'US10Y', label: '美债10年', src: 'cnbc', digits: 3, suffix: '%' },
      { id: 'US5Y',  label: '美债5年',  src: 'cnbc', digits: 3, suffix: '%' },
      { id: 'US2Y',  label: '美债2年',  src: 'cnbc', digits: 3, suffix: '%' },
      { id: 'US30Y', label: '美债30年', src: 'cnbc', digits: 3, suffix: '%' },
      { id: 'US3M',  label: '美债3月',  src: 'cnbc', digits: 3, suffix: '%' },
      { id: '2s10s', label: '2s10s 利差', src: 'spread', from: ['US10Y', 'US2Y'],
        digits: 3, suffix: 'pp', note: '10Y − 2Y，负值即倒挂' },
      { id: 'JP10Y', label: '日本10年', src: 'cnbc', digits: 3, suffix: '%' },
      { id: 'DE10Y', label: '德国10年', src: 'cnbc', digits: 3, suffix: '%' },
      { id: '.DXY',  label: '美元指数', src: 'cnbc', digits: 3 },
      { id: 'USDCNY', label: 'USDCNY', src: 'deskFx', digits: 4 },
      { id: 'USDJPY', label: 'USDJPY', src: 'deskFx', digits: 2 },
      { id: 'USDKRW', label: 'USDKRW', src: 'deskFx', digits: 2 }
    ]
  },
  {
    id: 'pet', label: '聚酯链现货（你的库）',
    note: '本地数据库 · 日频 · 口径与加工费完全一致 · 点开有 30 日走势',
    items: [
      { id: 'POY_SPOT',  label: 'POY 长丝',  src: 'desk', desk: ['POY', 'spot'],  digits: 0, unit: '¥' },
      { id: 'FDY_SPOT',  label: 'FDY 长丝',  src: 'desk', desk: ['FDY', 'spot'],  digits: 0, unit: '¥' },
      { id: 'DTY_SPOT',  label: 'DTY 长丝',  src: 'desk', desk: ['DTY', 'spot'],  digits: 0, unit: '¥' },
      { id: 'CHIP_SPOT', label: '聚酯切片',  src: 'desk', desk: ['CHIP', 'spot'], digits: 0, unit: '¥' },
      { id: 'PTA_SPOT',  label: 'PTA 现货',  src: 'desk', desk: ['PTA', 'spot'],  digits: 0, unit: '¥' },
      { id: 'MEG_SPOT',  label: 'MEG 现货',  src: 'desk', desk: ['MEG', 'spot'],  digits: 0, unit: '¥' },
      { id: 'PX_SPOT',   label: 'PX 现货',   src: 'desk', desk: ['PX', 'spot'],   digits: 0, unit: '¥' },
      { id: 'SC_SPOT',   label: 'SC 原油现货', src: 'desk', desk: ['SC', 'spot'], digits: 1, unit: '¥' }
    ]
  },
  {
    id: 'chem', label: '能化期货（国内主力）',
    note: '新浪日线 · 与上方 K 线同一源 · 值为日终结算前的最后价 · 点开看 120 日 K 线',
    items: [
      { id: 'MA0', label: '甲醇 MA',   src: 'sina', digits: 0, unit: '¥' },
      { id: 'EB0', label: '苯乙烯 EB', src: 'sina', digits: 0, unit: '¥' },
      { id: 'V0',  label: 'PVC V',     src: 'sina', digits: 0, unit: '¥' },
      { id: 'L0',  label: '塑料 L',    src: 'sina', digits: 0, unit: '¥' },
      { id: 'PP0', label: '聚丙烯 PP', src: 'sina', digits: 0, unit: '¥' },
      { id: 'SA0', label: '纯碱 SA',   src: 'sina', digits: 0, unit: '¥' },
      { id: 'FG0', label: '玻璃 FG',   src: 'sina', digits: 0, unit: '¥' },
      { id: 'UR0', label: '尿素 UR',   src: 'sina', digits: 0, unit: '¥' },
      { id: 'FU0', label: '燃料油 FU', src: 'sina', digits: 0, unit: '¥' },
      { id: 'BU0', label: '沥青 BU',   src: 'sina', digits: 0, unit: '¥' }
    ]
  },
  {
    id: 'tex', label: '纺织原料', note: '新浪日线 · 棉花是聚酯的直接替代品，看它才知道替代压力',
    items: [
      { id: 'CF0', label: '棉花 CF', src: 'sina', digits: 0, unit: '¥' },
      { id: 'CY0', label: '棉纱 CY', src: 'sina', digits: 0, unit: '¥' }
    ]
  },
  {
    id: 'metal', label: '黑色与有色', note: '新浪日线 · 成本与需求的宏观温度计',
    items: [
      { id: 'RB0', label: '螺纹钢 RB', src: 'sina', digits: 0, unit: '¥' },
      { id: 'I0',  label: '铁矿石 I',  src: 'sina', digits: 1, unit: '¥' },
      { id: 'CU0', label: '沪铜 CU',   src: 'sina', digits: 0, unit: '¥' },
      { id: 'AL0', label: '沪铝 AL',   src: 'sina', digits: 0, unit: '¥' }
    ]
  },
  {
    id: 'comm', label: '商品与产业链上游', note: '你的数据库优先，口径与加工费一致',
    items: [
      { id: 'SC',      label: 'SC原油',  src: 'desk', desk: ['SC', 'futures'],      digits: 1, unit: '¥' },
      { id: 'BRENT',   label: '布伦特',  src: 'desk', desk: ['BRENT', 'spot'],      digits: 2, unit: '$' },
      { id: 'WTI',     label: 'WTI',    src: 'desk', desk: ['WTI', 'spot'],        digits: 2, unit: '$' },
      { id: 'NAPHTHA', label: '石脑油',  src: 'desk', desk: ['NAPHTHA', 'spot'],   digits: 0, unit: '¥' },
      { id: '@GC.1',   label: 'COMEX黄金', src: 'cnbc', digits: 1, unit: '$' },
      { id: '@SI.1',   label: 'COMEX银',  src: 'cnbc', digits: 3, unit: '$' },
      { id: '@HG.1',   label: 'COMEX铜',  src: 'cnbc', digits: 3, unit: '$' },
      { id: '@AL.1',   label: 'CME铝',    src: 'cnbc', digits: 1, unit: '$' },
      { id: '@NG.1',   label: 'NYMEX天然气', src: 'cnbc', digits: 3, unit: '$' },
      { id: '@BZ.1',   label: '布伦特(CNBC)', src: 'cnbc', digits: 2, unit: '$',
        note: '与你的库口径不同，留作对照' }
    ]
  },
  {
    id: 'wh', label: '交易所仓单（在线复现）',
    note: '东财数据中心 · 日频 · 看增减（张）不看百分比 · 注销期归零属正常，点开有 90 天曲线',
    items: [
      { id: 'TA', label: 'PTA 仓单',  src: 'em_stock', tons: 5,  digits: 4, suffix: '万吨' },
      { id: 'PX', label: 'PX 仓单',   src: 'em_stock', tons: 5,  digits: 4, suffix: '万吨' },
      { id: 'PF', label: '短纤 仓单', src: 'em_stock', tons: 5,  digits: 4, suffix: '万吨' },
      { id: 'PR', label: '瓶片 仓单', src: 'em_stock', tons: 15, digits: 4, suffix: '万吨' }
    ]
  }
];

/* 顶栏跑马灯挑哪几项（顺序即显示顺序）。
   甲醇放在这里是有意的：它是聚酯链之外、但最能提前反映能化成本与 MTO 利润的一条线。 */
const MARQUEE_PICK = ['.DXY', 'US10Y', 'USDCNY', 'sh000001', '.SPX', '.VIX', 'hkHSI', 'MA0', 'OIL_DESK'];

/* 腾讯迷你趋势取几根日线 */
const SPARK_DAYS = 60;

/* 聚焦大图（点瓦片放大）取几根日线 */
const FOCUS_DAYS = 120;

/* --------------------------------------------------------------------------
   0c. AI 情报分析 —— 两种模式，默认走「静态」这条
   ──────────────────────────────────────────────────────────────────────────
   【静态，默认】tools/ai_digest.py 在 GitHub Actions 上跑，把当天宏观情报压成
   一段粗分析写进 data/ai_digest.json 的 macro_brief。前端只是读文件：
   页面零 API 调用、零密钥暴露、一次浏览不花一分钱。这是最省 token 的路子 ——
   token 只花在「一天一次的判断」上，不花在「每次刷新的搬运」上。
   【实时，可选】想点按钮就现问，需要有个持钥匙的服务端，见 AI_PROXY。
   配了 AI_PROXY.url 就会在静态版之上再补一次实时压缩；没配就只用静态版。
   -------------------------------------------------------------------------- */
const AI_PROXY = { url: null, token: null };

/* 全球市场分组默认是否折叠。false = 全部分组展开 —— 硬数据不要藏在折叠行里；
   想收哪个组，用户自己点组标题收，选择记在 localStorage 里，下次打开还是他排的样子。 */
const WORLD_COLLAPSED_DEFAULT = false;
const WORLD_EXPAND_HINT = ['a', 'us'];

/* 情报分析（静态产物）渲染规则 */
const MACRO_BRIEF = {
  maxPoints: 5,          // 最多渲染几条要点（产物里多的截掉）
  showTokens: true       // 是否显示这一段的 token 成本 —— 让它一眼可见「花了多少」
};

/* 实时压缩（仅 AI_PROXY 已配置时生效）：压缩多少条、覆盖哪些频道、触发阈值。
   maxNews 只喂【标题】，不带正文摘要 —— 所以可以比原来多带一些，
   让速览真的覆盖一整天的动静，而 token 反而更省。 */
const MACRO_OVERVIEW = {
  maxPoints: 5,                 // 最多输出几条要点
  maxNews: 24,                  // 每次最多喂多少条标题进上下文
  channels: ['macro', 'bonds', 'fed', 'chain'],  // 只从这些频道取
  cooldownMs: 12 * 60e3,        // 两次调用之间的最小间隔（省 token）
  maxDaily: 30                  // 单日最多调用次数（省 token 天顶）
};

/* --------------------------------------------------------------------------
   3. 情报流频道
   顺序即显示顺序，也就是「谁抢到用户眼睛」的顺序。
   宏观排第二是有意的：它是这一屏里唯一能解释「为什么今天整条链一起动」的东西，
   而产业链频道回答的是「哪一环在动」。先因后果。
   -------------------------------------------------------------------------- */
const NEWS_CHANNELS = [
  { id: 'all', label: '全部', kw: [] },
  {
    id: 'macro', label: '宏观',
    kw: ['国常会', '国务院', '发改委', '财政部', '政治局', '中央经济工作会议', '政策', '刺激',
         '稳增长', '专项债', '特别国债', '赤字率', '财政政策', '货币政策', '央行', '降准', '降息',
         '加息', 'MLF', 'LPR', '逆回购', '资金面', '银行间', '社融', 'M2', '信贷', '人民币',
         '汇率', '美元指数', '通胀', '通缩', 'GDP', '增速', '关税', '出口', '进口', '外贸',
         '就业', '非农', '美国CPI', 'CPI', 'PPI', 'PMI', '社零', '社会消费品零售', '消费',
         '零售', '内需', '促消费', '以旧换新', '补贴', '房地产', '制造业', '工业增加值',
         '固定资产投资', '美联储', 'FOMC', '鲍威尔', '美债', '国债', '收益率', '债市',
         '欧元区', '欧洲央行', '日本央行', 'ECB', 'BOJ', '地缘', '制裁', 'OPEC', '减产',
         '库存', 'EIA']
  },
  {
    id: 'chain', label: '产业链',
    kw: ['原油', '石脑油', '汽油', '柴油', '航煤', '芳烃', '对二甲苯', 'PX', 'PTA', '精对苯二甲酸',
         '乙二醇', 'MEG', '聚酯', '瓶片', 'PET', '短纤', '涤纶', '长丝', 'POY', 'FDY', 'DTY',
         '切片', '加工差', '加工费', '现金流', '检修', '装置', '开工', '负荷', '仓单', '库存',
         '郑商所', '大商所', '上期所', '上期能源', '化纤', '纺织原料', '再生', '炼厂', 'OPEC',
         '甲醇', '苯乙烯', 'PVC', '纯碱', '玻璃', '尿素', '燃料油', '沥青']
  },
  {
    id: 'apparel', label: '服装',
    kw: ['服装', '成衣', '鞋服', '品牌服饰', '快时尚', '秋冬', '春夏', '棉花', '棉纱', '优衣库',
         '耐克', 'Nike', '阿迪达斯', 'Adidas', 'Zara', 'H&M', 'Shein', 'SHEIN', '跨境电商',
         '亚马逊', '羽绒服', '运动鞋服', '纺服']
  },
  {
    id: 'bonds', label: '国债',
    kw: ['国债', '收益率', '债市', '债券', '央行', '货币政策', '降准', 'MLF', '逆回购', '资金面',
         '银行间', 'LPR', '财政', '特别国债', '国开债', '10年期', '十年期', '中标', '美联储']
  },
  {
    id: 'fed', label: '美联储',
    kw: ['美联储', 'Fed', 'FOMC', '鲍威尔', 'Powell', '加息', '降息', '升息', '利率决议',
         '点阵图', '缩表', '议息', '联邦基金利率', '美国CPI', '美国通胀', '美国就业', '非农就业']
  },
  {
    id: 'equity', label: '股市',
    kw: ['A股', '沪指', '上证指数', '深证成指', '创业板', '恒生指数', '港股', '纳斯达克', '标普500',
         '道琼斯', '美股', '股市', '北向资金', '融资余额', 'IPO', '退市', '涨停', '跌停', '回购']
  }
];

/* 无论选中哪个频道，都值得高亮的市场词（数字与方向类）。
   频道关键词在选中某频道时会叠加进来，见 news.js 的 ranges()。 */
const NEWWORDS = [
  '涨停', '跌停', '大涨', '大跌', '暴涨', '暴跌', '创历史新高', '创新低',
  '超预期', '不及预期', '加息', '降息', '降准', '升破', '跌破', '失守',
  '涨超', '跌超', '涨幅', '跌幅', '净流入', '净流出', '停产', '复产'
];

/* --------------------------------------------------------------------------
   4. 日历
   exact = 官方公布的确切日期；rule = 固定规则推算（页面标"约"并给官方链接）
   FOMC 日期来源：federalreserve.gov/monetarypolicy/fomccalendars.htm（核对于 2026-09-22）
   EIA  日期来源：eia.gov/petroleum/supply/weekly/schedule.cfm（2026 年假日顺延表）
   ⚠ 这两张表是硬编码的，见 §5 的过期守卫。
   -------------------------------------------------------------------------- */
const CAL_VERIFIED_AT = '2026-09-22';

/* 时间口径标注（tz）：
   美国事件官方按美东时间（ET）公布，中国事件按北京时间（CST）。
   页面两个都显示 —— 只写一个「本机时间」，换台设备看同一行会变成另一个数字，
   对着一张官方日历对不上号。 */
const CAL_TZ = { ET: '美东', CST: '北京' };
const CAL_ZONE = { ET: 'America/New_York', CST: 'Asia/Shanghai' };

/** 把时间戳按指定 IANA 时区渲染成「M/D HH:MM」，不受设备时区影响 */
function fmtInZone (ts, tzKey) {
  const zone = CAL_ZONE[tzKey] || CAL_ZONE.ET;
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone, month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(ts));
    const g = k => (parts.find(x => x.type === k) || {}).value || '';
    return g('month') + '/' + g('day') + ' ' + g('hour') + ':' + g('minute');
  } catch (e) { return ''; }
}

/** 设备当前时区名，用来给「本机」那一段一个明确的标签 */
function localZoneName () {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区'; }
  catch (e) { return '本机时区'; }
}

const FOMC_DATES = [                       // 第二天为决议日，14:00 ET 发布声明
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-16',
  '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'
];

const EIA_HOLIDAY_SHIFT = {                // 键=常规周三，值=官方实际发布日
  '2026-01-21': '2026-01-22', '2026-02-18': '2026-02-19', '2026-05-27': '2026-05-28',
  '2026-09-09': '2026-09-10', '2026-10-14': '2026-10-15', '2026-11-11': '2026-11-12',
  '2027-01-20': '2027-01-21', '2027-02-17': '2027-02-18', '2027-05-26': '2027-05-27',
  '2027-09-08': '2027-09-09', '2027-10-13': '2027-10-14', '2027-11-10': '2027-11-11'
};

const CALENDAR = [
  {
    id: 'fomc', label: 'FOMC 利率决议', kind: 'exact', periodDays: 44, tz: 'ET',
    src: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    note: '第二天 14:00 ET 发声明，14:30 ET 开发布会',
    next: () => nextAtDates(FOMC_DATES, 14, 0),
    prev: () => prevAtDates(FOMC_DATES, 14, 0)
  },
  {
    id: 'eia', label: 'EIA 原油库存周报', kind: 'exact', periodDays: 7, tz: 'ET',
    src: 'https://www.eia.gov/petroleum/supply/weekly/schedule.cfm',
    note: '周三 10:30 ET，官方假日顺延表已含',
    next: () => nextEia()
  },
  {
    id: 'nonfarm', label: '美国非农就业', kind: 'rule', periodDays: 30, tz: 'ET',
    src: 'https://www.bls.gov/schedule/news_release/empsit.htm',
    note: '每月第一个周五 08:30 ET',
    next: () => nextNthWeekdayEt(5, 1, 8, 30)
  },
  {
    id: 'cpi', label: '美国 CPI', kind: 'rule', periodDays: 30, tz: 'ET',
    src: 'https://www.bls.gov/schedule/news_release/cpi.htm',
    note: '约每月中旬 08:30 ET',
    next: () => nextMonthDayEt(12, 8, 30)
  },
  {
    id: 'pmi', label: '中国官方制造业PMI', kind: 'rule', periodDays: 30, tz: 'CST',
    src: 'https://www.stats.gov.cn/sj/zxfb/',
    note: '约月末最后一日 09:30 北京',
    next: () => nextMonthEnd(9, 30)
  },
  {
    id: 'retail', label: '中国社零 / 工业增加值', kind: 'rule', periodDays: 30, tz: 'CST',
    src: 'https://www.stats.gov.cn/sj/zxfb/',
    note: '约每月 15 日 10:00 北京',
    next: () => nextMonthDay(15, 10, 0)
  },
  {
    id: 'trade', label: '中国进出口（海关总署）', kind: 'rule', periodDays: 30, tz: 'CST',
    src: 'http://www.customs.gov.cn/',
    note: '约每月 7–14 日',
    next: () => nextMonthDay(10, 10, 0)
  }
];

/* --------------------------------------------------------------------------
   5. 时间与日历工具
   -------------------------------------------------------------------------- */

/** 美国是否处于夏令时（3月第2个周日 – 11月第1个周日，注意差值的边界是 UTC 时刻） */
function usDst (d) {
  const y = d.getUTCFullYear();
  const march = new Date(Date.UTC(y, 2, 1));
  const nov = new Date(Date.UTC(y, 10, 1));
  const mar2sun = 1 + ((7 - march.getUTCDay()) % 7) + 7;
  const nov1sun = 1 + ((7 - nov.getUTCDay()) % 7);
  const t = d.getTime();
  return t >= Date.UTC(y, 2, mar2sun, 7) && t < Date.UTC(y, 10, nov1sun, 6);
}

/** 给定 ET 的 (日,时,分)，返回 UTC 时间戳 */
function etToUtc (day, hh, mm) {
  const off = usDst(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12))) ? 4 : 5;
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh + off, mm);
}

function nextAtDates (list, hourEt, minEt) {
  const now = Date.now();
  for (const s of list) {
    const [y, m, d] = s.split('-').map(Number);
    const t = etToUtc(new Date(Date.UTC(y, m - 1, d)), hourEt, minEt);
    if (t > now) return t;
  }
  return null;
}

function prevAtDates (list, hourEt, minEt) {
  const now = Date.now();
  let best = null;
  for (const s of list) {
    const [y, m, d] = s.split('-').map(Number);
    const t = etToUtc(new Date(Date.UTC(y, m - 1, d)), hourEt, minEt);
    if (t <= now && (best === null || t > best)) best = t;
  }
  return best;
}

/** 下一个 EIA 发布时刻：周三 10:30 ET，含官方假日顺延表 */
function nextEia () {
  const now = new Date();
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    if (d.getUTCDay() !== 3) continue;
    const key = d.toISOString().slice(0, 10);
    const target = EIA_HOLIDAY_SHIFT[key] || key;
    const [y, m, dd] = target.split('-').map(Number);
    const t = etToUtc(new Date(Date.UTC(y, m - 1, dd)), 10, 30);
    if (t > Date.now()) return t;
  }
  return null;
}

function nextNthWeekdayEt (weekday, nth, hh, mm) {
  for (let m = 0; m < 4; m++) {
    const base = new Date();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + m);
    const y = base.getUTCFullYear(), mo = base.getUTCMonth();
    const firstWd = new Date(Date.UTC(y, mo, 1)).getUTCDay();
    const day = 1 + ((7 - firstWd + weekday) % 7) + (nth - 1) * 7;
    const t = etToUtc(new Date(Date.UTC(y, mo, day)), hh, mm);
    if (t > Date.now()) return t;
  }
  return null;
}

function nextMonthDayEt (day, hh, mm) {
  for (let m = 0; m < 4; m++) {
    const now = new Date();
    const y = now.getUTCFullYear(), mo = now.getUTCMonth() + m;
    const t = etToUtc(new Date(Date.UTC(y, mo, day)), hh, mm);
    if (t > Date.now()) return t;
  }
  return null;
}

function nextMonthDay (day, hh, mm) {
  const now = new Date();
  for (let m = 0; m < 4; m++) {
    const cand = new Date(now.getFullYear(), now.getMonth() + m, day, hh, mm, 0, 0);
    if (cand.getTime() > now.getTime()) return cand.getTime();
  }
  return null;
}

function nextMonthEnd (hh, mm) {
  const now = new Date();
  for (let m = 0; m < 4; m++) {
    const last = new Date(now.getFullYear(), now.getMonth() + m + 1, 0, hh, mm, 0, 0);
    if (last.getTime() > now.getTime()) return last.getTime();
  }
  return null;
}

/** 剩余毫秒 → 「3天 06时」 */
function fmtLeft (ms) {
  if (ms == null) return '—';
  if (ms < 0) return '已过';
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  const mi = Math.floor((ms % 36e5) / 6e4);
  if (d > 0) return d + '天 ' + String(h).padStart(2, '0') + '时';
  if (h > 0) return h + '时 ' + String(mi).padStart(2, '0') + '分';
  return mi + '分';
}

/** 距今多久 → 「2分钟前」 */
function fmtAgo (ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return Math.round(s) + '秒前';
  if (s < 3600) return Math.round(s / 60) + '分钟前';
  if (s < 86400) return Math.round(s / 3600) + '小时前';
  return Math.round(s / 86400) + '天前';
}
