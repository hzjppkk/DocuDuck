# 单据整理（DocuDuck）

把发票、财政电子票据、报关单证 PDF 拖进浏览器：自动识别、核对，导出 Excel，按内容重命名打包。文件只在你的浏览器里识别。

## 使用

需 Chrome 或 Edge 140 以上，只识别带文字层的 PDF（扫描件不行）。

### 1. 在线使用

打开 https://hzjppkk.github.io/DocuDuck/ ，把 PDF 或文件夹拖进页面即可。

### 2. 本地部署

需要把整理好的文件提交到局域网服务器归档时用。

1. 从 [Releases](https://github.com/hzjppkk/DocuDuck/releases) 下载 zip 并解压，电脑上要装有 Python 3
2. 运行 `python scripts/serve.py`，可用地址会列出，可服务器部署。
3. 按需编辑 `scripts/config.ini`，改后重启：

| 配置 | 作用 |
|---|---|
| `[存档]` `switch = 1` | 开启提交和查询（默认 0：和在线版一样，纯本地） |
| `[查询白名单]` | 能进查询页的 IP 或网段，每行一个（本机写 127.0.0.1） |
| `[下载]` `密码 = …` | 查询页下载归档的密码，为空不能下载 |
| `[发票购买方白名单]` | 每行 `公司名称:统一社会信用代码`，不在名单内的发票标为需核对 |
| `[OCR]` | 扫描的提运单用 OCR 识别，填接口和密钥 |

提交的文件存在 `submitted/`，迁移时连同其中的 `.清单密钥` 一起备份。

## 功能

- **报关单**：同一报关单的退税联、预填单、放行通知书、委托书、提运单、货代发票合为一行，互相核对，按「合同号/申报日期/单据类型_海关编号.pdf」归档；发货清单（.xlsx）可在详情里手动上传，不识别、不算缺文件
- **发票**：核对二维码、金额、税号、购买方白名单，按「开票年月/开票日期_销售方_金额_号码.pdf」命名
- **查询**（本地部署）：查看服务器上已提交的报关单、发票，输入密码下载归档

## 结构

```
site/                     网站源码，Release 即其构建结果
  index.html              入口页：单据核验；查询（只对查询白名单显示）
  common/
    ui.js                 页面框架 createApp：拖入、识别、视图标签页、筛选、表格、详情、导出 Excel / PDF
    archive.js            存档（与 serve.py 交互）：已提交、提交、归属、OCR；查询页的列出、下载、删除
    pdf.js                打开 PDF、提取带坐标的文字、内嵌附件、切页、取二维码图片（浏览器与 Node 共用）
    text.js               文本块规整与工具：prepare、squash、日期、数字、规范命名（浏览器与 Node 共用）
    pool.js               并发识别（THREADS）
    dom.js                页面小工具：转义、金额、提示、进度
    style.css             样式
  fapiao/                 单据核验
    parser.js             专家列表（排定顺序）、逐页识别一次、按单据拆分
    invoice.js            发票专家，及发票的解析、核对（金额、税号、二维码、附件数据、白名单）、命名
    customs.js            报关单证专家，及按报关单归集（mergeDocs）、提交与清单字段
    views.js              视图：报关单、发票、无法识别（列、详情、筛选、Excel、提交目录）
    app.js                页面配置：白名单、二维码解码、视图
  chaxun/                 查询页（只读）：index.html · app.js（沿用 fapiao/views.js）
  baoguan/index.html      只留跳转到 fapiao/（旧网址）
  vendor/                 第三方库，不入库，由 scripts/vendor.js 生成
scripts/
  serve.py                本地 / 局域网服务：静态文件、提交、清单、查询、下载、OCR
  ocr_tencent.py          OCR 接口（腾讯云）
  config.ini              配置（不入库）
  check.js                回归测试与样本精简
  samples.js              样本精简规则
  node-pdf.js             Node 读取 PDF、取二维码（check.js 用）
  vendor.js               从 node_modules 生成 site/vendor/
.github/workflows/release.yml   手动发布：生成 vendor、写版本号、生成 config.ini 模板、打包
.github/workflows/pages.yml     推送到 main 时把 site/ 发布到 GitHub Pages
```

- 浏览器和 Node 共用 `fapiao/` 的解析（invoice.js、customs.js、parser.js）、`common/text.js`、`common/pdf.js`；解析不依赖 DOM
- 新增单据：专家写进 invoice.js 或 customs.js，parser.js 的专家列表按顺序加入；要单独列出的加一个视图（views.js）
- 依赖由 `package-lock.json` 锁定；升级后重新生成 vendor，并跑回归测试

脚本（先 `npm install`）：

| 命令 | 作用 |
|---|---|
| `node scripts/vendor.js` | 生成 `site/vendor/` |
| `node scripts/check.js invoice <目录>` | 回归测试（报关资料用 `customs`，含子文件夹），发票末尾预览样本精简 |
| `node scripts/check.js invoice <目录> --move <目录>` | 同上，并执行精简：移出冗余和失败的样本，保留的改为规范命名 |

新增样本流程：加样本 → 跑回归、修程序 → 程序正确后加 `--move` 精简（精简不判断对错）。报关资料按整套保留，不精简。

## 设计说明

记录做法的原因，原因不成立时可以改。实现细节见各文件注释。

- **识别范围**：只处理文字层正确的 PDF，扫描件、乱码不兜底，也不为个别文件定向适配
- **专家**：一种票 / 一种版式一个专家（`EXPERTS`），按顺序匹配，特征明确的在前、最宽松的放最后；新增版式只加专家。旧版发票专家将随数电票推行整段删除
- **第三方库**：原样使用、按官方方式加载，升级不用改代码；代价是不支持 file://
- **并发与缓存**：同时识别 2 个文件（`common/pool.js` 的 `THREADS`，再多不再变快；页面地址加 `?threads=1` 即逐个处理），各用一个常驻的 pdf.js Worker；识别规则在主线程，结果按原顺序收进列表。CMap、标准字体页面只下载一次（pdf.js 默认每个 PDF 重新下载，经网络批量识别时会卡住）
- **附件数据**：PDF 内嵌的结构化数据（铁路、航空客票的 XBRL，财政电子票据的 XML）比票面可靠，以它为准、不一致时提示；附件里的完整证件号不取
- **二维码**：直接取 PDF 内嵌图片识别，不渲染页面。用到了 pdf.js 未公开的 `page.objs`，所以锁定大版本，升级须回归测试
- **存档**：每个目录一份 `清单.jsonl`，查询、判断是否已提交只读它；只存非敏感字段和校验值，海关编号、提运单号、集装箱号原文只在服务器上比对，不发给页面
- **报关资料**：提运单格式各异，不取字段，只用于关联。归档按合同号、申报日期分文件夹（各单据都有且不变），文件名带海关编号区分同一天的多份
- 参考：购销方区域提取参考 [sanluan/einvoice](https://github.com/sanluan/einvoice)；大写金额解析改写自 [erma0/fapiao-print](https://github.com/erma0/fapiao-print)（MIT）

## 未用真实样本测试

- 发票：二手车销售统一发票、旧版增值税电子专票、除旅客运输服务和通行费外的特定业务、多页数电发票（含每页小计核对）、旧版发票的销货清单
- 财政电子票据：除医疗门诊收费票据、中央非税收入统一票据外的全部
- 二维码种类代码 01 / 04 / 08 / 11（旧版）；数电票号码第 3-4 位省级代码未校验（无对照表）

## 许可

[GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)。第三方：pdf.js、SheetJS CE、jsQR（Apache-2.0），JSZip（MIT），CMap（BSD-3-Clause）。
