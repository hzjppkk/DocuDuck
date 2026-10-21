/* 查询页：列出服务器上已提交的报关单、发票（只读，查询白名单内），下载归档、删除归档；报关单可导出核对缺哪些单据的 Excel。视图沿用单据核验页（fapiao/views.js） */
import * as U from "../common/ui.js";
import { customsView, invoiceView, key, hay } from "../fapiao/views.js";

U.createApp({
  query: true,
  title: "查询",
  sub: "服务器上已提交的报关单、发票（以服务器清单为准，只读）；下载归档要输入密码，下载完成后才能删除服务器上的归档文件。",
  search: "搜索 合同号 / 海关编号 / 发票号码 / 销售方…",
  key,
  hay,
  views: [customsView, invoiceView].map((v) => ({ ...v, fileColumn: () => false })), // 没有本地文件
});
