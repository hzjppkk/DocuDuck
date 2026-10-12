# 财务工具（Finance Tools）

在浏览器里解析发票、财政电子票据、出口报关资料 PDF，导出 Excel，按内容重命名打包。PDF 在本机浏览器中识别；报关资料可提交到局域网服务器归档。

## 使用

**运行**：`python scripts/serve.py`（开发时先生成 vendor），打开 http://127.0.0.1:8080/ 。默认供局域网访问、只服务 `site/`；`--local` 只供本机，`--store` 指定提交存放目录（默认 `submitted/`）；作为后台服务运行时不打开浏览器。需 Chrome / Edge 140+；页面用了 ES 模块和 Worker，不能双击 html 打开。Release 的 zip 含 `site/` 和 `scripts/`（serve.py、OCR、`config.ini` 空模板）。

**发票整理**：拖入 PDF 或文件夹，看明细、核对（二维码、金额勾稽、税号校验位、购买方白名单），导出 Excel，打包按内容重命名的 PDF（一个 PDF 含多张发票的按票切开）。

**报关资料**：
- 同一报关单的各单据合为一行，按合同号分组；合订的 PDF 按页拆开
- 提运单、数电发票：全文（数电发票只看备注栏）中出现某报关单的海关编号或提运单号（8 位以上）即归入，其次按集装箱号
- 归档名「合同号/申报日期/单据类型_海关编号.pdf」；没有合同号的记为「无合同号」，识别异常的（超过 32 位或有乱码）记为「合同号异常」并提示
- 能规范命名的都打包、提交（需核对的照常）；缺的单据可在详情里直接上传（不识别，归档名末尾加 `_手动`）
- 提交时服务器上的同名文件修改时间更晚，或时间、大小都相同的跳过，否则覆盖

**服务器（serve.py）**：
- 提交的文件存在 `--store` 下；每个工具目录有一份 `清单.jsonl`，查询、判断是否已提交都只读它。页面拿到的只有非敏感字段（合同号、申报日期、单据类型、部分隐去的海关编号、大小、时间、提交者 IP）和校验值；海关编号、提运单号、集装箱号原文只供服务器比对，不发给页面
- 是否已提交按「报关单 + 单据类型」查清单，不论文件名；识别不了的文件按大小 + 修改时间认，库中已有的不再列出
- 查询白名单内的人可「查询已提交」（追加服务器上的报关单，本地单据可并入）和「下载归档」（要密码；下载完可删除服务器上的归档文件，清单保留）
- 疑似提运单的「OCR」调用 `scripts/ocr_<provider>.py`，换接口只换这个文件

**配置** `scripts/config.ini`（不入库，含密钥，改后重启 serve.py）：`[发票购买方白名单]` 每行 `公司名称:统一社会信用代码`；`[查询白名单]` 每行一个 IP 或网段（本机也要写 127.0.0.1）；`[下载]` `密码 = …`，为空不能下载；`[OCR]` 接口和密钥。存放目录下的 `.清单密钥`（首次运行生成）换版本、迁移时要连同提交的文件一起保留。

## 结构

```
site/                 网站源码，Release 即其构建结果
  index.html          入口页
  common/             text.js 文本块工具 · pdf.js 读取 PDF、切页、取二维码图片 · ui.js 页面框架（createApp、withPdf）
                      server.js 与 serve.py 交互 · pool.js 并发 · dom.js 页面小工具 · style.css
  fapiao/             发票：index.html · parser.js 解析 · app.js 页面配置
  baoguan/            报关资料：index.html · parser.js · app.js
  vendor/             第三方库，不入库，由 scripts/vendor.js 原样复制生成
scripts/              serve.py · ocr_tencent.py · vendor.js · check.js 回归测试与样本精简 · samples.js 精简规则 · node-pdf.js
.github/workflows/release.yml   手动发布：生成 vendor、写版本号、生成 config.ini 模板、打包
```

- 浏览器和 Node 共用 `parser.js`、`common/text.js`、`common/pdf.js`；`parser.js` 不依赖 DOM
- 新增单据：在 `site/xxx/`（目录名用拼音）下放 `index.html`（复制 `baoguan/index.html` 改标题）、`parser.js`、`app.js`（只写 `createApp` 配置），入口页加链接
- 依赖由 `package-lock.json` 锁定；升级后重新生成 vendor，并跑回归测试

脚本（先 `npm install`）：

| 命令 | 作用 |
|---|---|
| `node scripts/vendor.js` | 生成 `site/vendor/` |
| `node scripts/check.js fapiao <目录>` | 回归测试（报关资料用 `baoguan`，含子文件夹），发票末尾预览样本精简 |
| `node scripts/check.js fapiao <目录> --move <目录>` | 同上，并执行精简：移出冗余和失败的样本，保留的改为规范命名 |

新增样本流程：加样本 → 跑回归、修程序 → 程序正确后加 `--move` 精简（精简不判断对错）。报关资料按整套保留，不精简。

## 设计说明

记录做法的原因，原因不成立时可以改。实现细节见各文件注释。

- **识别范围**：只处理文字层正确的 PDF，扫描件、乱码不兜底，也不为个别文件定向适配
- **专家**：一种票 / 一种版式一个专家（`EXPERTS`），按顺序匹配，特征明确的在前、最宽松的放最后；新增版式只加专家。旧版发票专家将随数电票推行整段删除
- **第三方库**：原样使用、按官方方式加载，升级不用改代码；代价是不支持 file://
- **并发与缓存**：同时识别 2 个文件（`common/pool.js` 的 `THREADS`，再多不再变快；页面地址加 `?threads=1` 即逐个处理），各用一个常驻的 pdf.js Worker；识别规则在主线程，结果按原顺序收进列表。CMap、标准字体页面只下载一次（pdf.js 默认每个 PDF 重新下载，经网络批量识别时会卡住）
- **附件数据**：PDF 内嵌的结构化数据（铁路、航空客票的 XBRL，财政电子票据的 XML）比票面可靠，以它为准、不一致时提示；附件里的完整证件号不取
- **二维码**：直接取 PDF 内嵌图片识别，不渲染页面。用到了 pdf.js 未公开的 `page.objs`，所以锁定大版本，升级须回归测试
- **报关资料**：提运单格式各异，不取字段，只用于关联。归档按合同号、申报日期分文件夹（各单据都有且不变），文件名带海关编号区分同一天的多份
- 参考：购销方区域提取参考 [sanluan/einvoice](https://github.com/sanluan/einvoice)；大写金额解析改写自 [erma0/fapiao-print](https://github.com/erma0/fapiao-print)（MIT）

## 未用真实样本测试

- 发票：二手车销售统一发票、旧版增值税电子专票、除旅客运输服务和通行费外的特定业务、多页数电发票（含每页小计核对）、旧版发票的销货清单
- 财政电子票据：除医疗门诊收费票据、中央非税收入统一票据外的全部
- 二维码种类代码 01 / 04 / 08 / 11（旧版）；数电票号码第 3-4 位省级代码未校验（无对照表）

## 许可

[GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)。第三方：pdf.js、SheetJS CE、jsQR（Apache-2.0），JSZip（MIT），CMap（BSD-3-Clause）。
