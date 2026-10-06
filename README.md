# 财务工具（Finance Tools）

在浏览器本地解析电子发票、财政电子票据、出口报关单 PDF，导出 Excel。纯前端，不上传，不联网。

## 使用

**部署**：Release 的 zip 解压到任意静态 Web 服务器即可。页面用了 ES 模块和 Worker，必须走 http(s)，不能双击打开。需 Chrome / Edge 140+。

**本机调试**：生成 vendor 后执行 `python scripts/serve.py`，打开 http://127.0.0.1:8000/ （仅本机可访问）。

**操作**：选择「发票整理」或「报关单整理」，拖入 PDF 或文件夹。可排序、筛选、看明细，导出 Excel，下载按内容重命名的 PDF。

**购买方白名单**：发布包里的 `fapiao/whitelist.ini` 是空模板，UTF-8 保存，每行 `公司名称:统一社会信用代码`（冒号全角半角均可，`#` 开头为注释）。

## 结构

```
site/                 网站源码，Release 即其构建结果
  index.html          入口页
  common/             text.js 文本块工具 · pdf.js 读取 PDF · ui.js 页面框架（createApp）· style.css
  fapiao/             发票：index.html · parser.js 解析 · app.js 页面配置（含二维码核对）
  baoguan/            报关单：index.html · parser.js · app.js
  vendor/             第三方库，不入库，由 scripts/vendor.js 原样复制生成
scripts/              vendor.js · serve.py · check.js 回归测试 · pick-samples.js 样本精简 · node-pdf.js
.github/workflows/release.yml   手动发布：生成 vendor、写版本号、生成白名单模板、打包 site/
```

- 浏览器和 Node 共用 `parser.js`、`common/text.js`、`common/pdf.js`
- `parser.js`：文本块 → 结构化数据 + `issues`，不依赖 DOM
- `app.js`：只写 `createApp` 配置，`columns` 每项为 `[表头, 显示, 样式, 排序取值]`
- 新增单据：在 `site/xxx/`（目录名用拼音）下放 `index.html`（复制 `baoguan/index.html` 改标题，访问时只需输入目录）、`parser.js`、`app.js`，入口页加链接
- 依赖由 `package-lock.json` 锁定；升级后重新生成 vendor，并在浏览器里回归测试二维码（见下文）

脚本（先 `npm install`）：

| 命令 | 作用 |
|---|---|
| `node scripts/vendor.js` | 生成 `site/vendor/` |
| `node scripts/check.js fapiao <目录>` | 回归测试（报关单用 `baoguan`） |
| `node scripts/pick-samples.js fapiao <目录> [--move <目录>]` | 样本精简：预览保留哪些，加 `--move` 移出冗余和失败的 |

新增样本流程：加样本 → 跑回归、修程序 → 程序正确后再精简（精简不判断对错）。

## 设计说明

记录做法的原因，原因不成立时可以改。实现细节见各文件开头注释。

- **识别范围**：只处理文字层正确的 PDF。OCR、乱码修复会让结果不可靠、代码变复杂
- **第三方库**：原样使用、按官方方式加载，升级不用改代码；代价是不支持 file://。jsQR、JSZip 只有 UMD 版，用普通 `<script>` 加载
- **pdf.js**：CMap、字体、wasm 按官方配置给目录，Worker 按需读取；缺 CMap 中文会整段丢失。所有文件共用一个常驻 Worker（默认每文件新建，多约 40 ms）。不做多文件并发：41 张发票约 1.1 秒，并发快一倍但代码复杂度不值得
- **文本规范化**：部分 PDF 把「子」等字编码成康熙部首，只对部首区做 NFKC（全量会改全角标点）。发票括号统一半角便于查重；报关单靠全角、半角括号区分标签名和代码，不转
- **报关单**：JG09 版标签在格子左上角、值在正下方，按列取值；商品名称会折行，以「序号 + 10 位商品编号」切分商品
- **发票专家**：一种票一个专家，`EXPERTS` 按顺序匹配，特征明确的在前，增值税发票最宽松、放最后兜底。票种专属逻辑放专家里，通用逻辑放调度处。旧版（有发票代码）单独一个专家，将随数电票推行整段删除
- **附件数据**：PDF 内嵌的结构化数据（铁路电子客票、航空电子行程单的 XBRL，财政电子票据的 XML）是开票方原始数据，比票面文字可靠，以它为准，不一致时提示；也参与票种识别。通用层 `parseEmbedded` 只把任意 XML 解析成对象，格式由各专家的 `xml` 钩子按字段认领、映射，新增一种内嵌数据只需在对应专家加钩子。附件里的完整证件号出于隐私不取
- **购销方**：数电票左右并列、旧版上下排列，先按版式圈出区域再用正则提取（参考 [sanluan/einvoice](https://github.com/sanluan/einvoice)）
- **明细**：名称会折行而每行只有一个金额，以金额为行锚点。列归属上数字看右边缘、文字看中心；不按「从右数第几列」，因为日期、编码也是数字列
- **二维码**：直接取 PDF 内嵌图片识别，不渲染页面（渲染最耗时）。用到了 pdf.js 未公开的 `page.objs` 图片字段，所以锁定大版本，升级须回归测试。数电票二维码是价税合计、旧版是不含税金额，严格比对；财政票据是查验网址，不比对
- **白名单**：`applyQr` 会重算全部提示，白名单检查必须在它之后追加
- 大写金额解析改写自 [erma0/fapiao-print](https://github.com/erma0/fapiao-print)（MIT）

## 未用真实样本测试

- 发票：二手车销售统一发票、旧版增值税电子专票、除旅客运输服务和通行费外的特定业务
- 财政电子票据：除医疗门诊收费票据外的全部（非税收入票据、缴款书、住院收费票据等）
- 红字（负数）发票、多页数电发票
- 二维码种类代码 01 / 04 / 08 / 11（旧版）
- 数电票号码第 3-4 位省级代码：无对照表，未校验

## 许可

[GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)。第三方：pdf.js、SheetJS CE、jsQR（Apache-2.0），JSZip（MIT），CMap（BSD-3-Clause）。
