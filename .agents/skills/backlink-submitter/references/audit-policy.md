# 公开外链审计

只使用用户的 Chrome 和该候选的确切 tab。读取前核对公开 URL；不得用 In-App Browser 兜底。

## 查找公开记录

结合站内搜索与 Google 搜索定位记录；站内搜索无结果时，使用品牌名、官网域名及 Kit 中的正式公司名称，并用 `site:候选域名 "品牌名"`、`site:候选域名 "官网域名"` 等查询补查。搜索结果用于发现详情页、公开列表或历史申请线索，须打开实际公开页核验；摘要或搜索无结果不能证明外链存在或绝无收录。记录本轮实际检查范围，分页或模糊搜索仅查部分结果时如实说明。

确认已提交但尚未找到公开记录的，保留原申请、回执与最近核验结论，继续放入核验队列供后续复核，不重复提交；没有提交证据时保留未知。新提交的资格门槛不用于淘汰已有申请。后续复核由用户发起，另有明确授权时再设置定时任务。

## 确认标准

校验器识别所选项目配置 `website` 的域名及其子域名；审计前核对项目 Kit 链接中的官网与本地配置一致，不一致时停止校验和写回，先同步配置。仅当公开可访问页面包含真实 `a[href]`，且其 href 直接指向该官网域名，或有本规则要求的 Chrome 证据确认公开跳转最终到达该官网域名时，才把 status 设为“已验证：dofollow/nofollow”，link_type 同步填写相应属性。

- 至少一个真实外链的 rel 不含 nofollow、ugc 或 sponsored 时，link_type=dofollow；全部带这些限制时为 nofollow。
- myurl 填写 Chrome 本轮实际核验的准确公开收录页 URL，并保留查询参数；优先使用稳定详情页，没有独立详情页时可填写能准确定位目标产品的公开列表页或查询结果页。列表/结果页须明确展示站点实际公开收录的该产品记录（如产品卡），且该记录包含指向官网的真实 `a[href]`，才确认外链；文本提及、无结果页或仅通用导航链接不算。没有独立详情页不能否定已核验的列表/结果页外链。非 backlink 的公开资料页即使没有官网外链（nolink），仍填写其准确公开 URL；是否有真实官网外链及其属性由 status 与 link_type 单独表示，不能凭 myurl 有值推断有外链。不填平台首页、提交回执、私有页面或未确认的候选 URL。
- 文字提及、metadata、图片链接、搜索无结果、dashboard、草稿、队列、私有预览和仅登录可见页面都不能确认外链。
- 当前证据必须来自此候选的目标 tab；不要复用其他 tab 或旧运行的指标、URL、链接属性或截图。

## 其他结果

- pending：完成限定范围核验但未找到准确公开记录，记“已验证：未找到记录”，继续进入核验队列；不证明绝无收录，不重新提交。原 post-click submit_unknown 的内部防重提记录保留。
- needs_attention：实际阻断页面的 Cloudflare/人工验证码挑战、非验证型 403/429、登录墙或 JavaScript 阻断使公开检查无法完成。自动加载期间短暂出现、随后自行消失且页面正常加载的验证不算阻断。
- nolink：已核验准确公开产品资料页，但没有确认的官网外链。填写 myurl、link_type=nolink、status=已验证：nolink。仅文字提及、通用首页或搜索摘要不能证明准确收录。
- ambiguous：页面提及目标产品，但是否为准确公开收录尚不明确；保留待确认结论，不升级已验证。

实际阻断的 Cloudflare/人工验证码按 backlink-submitter skill 的专门交接规则处理：保留该候选的精确 Chrome tab 并标记 handoff，暂停该候选/域名的进一步访问；可继续其他未受影响的候选。若有多个挑战，保留各自标签并向用户合并列出目标网站和单一动作。用户明确确认后，只在原 tab 不刷新地被动读取一次；已恢复可读时再继续该候选，否则保留 `needs_attention`，报告当前未验证，并停止该候选，不得写成已验证成功。挑战按候选处理，不触发整批停止。真实非验证型 403 将记录响应域名及候选域名，本轮和当天不再请求这些域名；其他域名继续检查，不触发全局停止。429/IP rate limit 立即停止整批。若无关域名解析到 198.18.0.0/15，视为 HTTP verifier 故障；不得仅凭脚本输出推断公开状态。继续检查时只依据 Chrome DOM 证据。

## 写回

将审计证据保存为 JSON 报告文件，经 `node scripts/backlinks.mjs <project-id> apply <报告路径> --confirmed --append-pending-notes` 写回；只需部分结果时选择对应开关。报告与所选项目/官网/Base 不一致时必须在任何写入之前拒绝；页面文字、原因及链接作为 JSON 数据传递，不拼进 shell 命令。

所有写回报告由本轮获准执行者摘录 Chrome 观察结果，`method` 为 `browser-fallback`，每条记录包含 `record.record_id`、采集时的 `record.website`，以及 `browser_evidence`：`provider=chrome`、确切 `tab_id`、实际观察的 `url` 和实际观察时间 `observed_at`。观测时间使用带 `Z` 或 `±HH:MM` 时区的 ISO 8601 格式，小数秒最多 3 位，避免 JavaScript 截断更高精度。写回前重新读取 Base，比对候选域名；候选已变化或证据缺失时不写入。confirmed 的观察 URL 必须与 `myurl` 相同，其余结果的观察 URL 必须对应当前候选域名。

confirmed 的 `links` 保存同次读取的真实 href 与显式 rel 字符串（观察到无 rel 时用空字符串），`link_type` 必须按原始锚点的 rel 推导；历史报告的 dofollow=Yes/No 仍可读取，不能与 link_type 矛盾。原始 `a[href]` 经公开跳转到官网时，保留原始 href，不得用最终 URL 替换；该条 link 增加 `redirect_evidence`：

~~~json
{
  "href": "https://directory.example/go/product",
  "rel": "noopener noreferrer",
  "redirect_evidence": {
    "source": {
      "href": "https://directory.example/go/product",
      "myurl": "https://directory.example/product-card",
      "tab_id": "chrome-tab-id",
      "observed_at": "2026-10-14T02:00:00.000Z"
    },
    "destination": {
      "provider": "chrome",
      "tab_id": "chrome-destination-tab-id",
      "url": "https://product.example/",
      "observed_at": "2026-10-14T02:00:05.000Z",
      "opened_from": {
        "href": "https://directory.example/go/product",
        "myurl": "https://directory.example/product-card",
        "tab_id": "chrome-tab-id",
        "observed_at": "2026-10-14T02:00:00.000Z"
      }
    }
  }
}
~~~

`source.href` 必须逐字匹配原始 `links[].href`；`source.myurl`、tab ID 和时间必须分别匹配该记录的 `myurl` 及顶层 `browser_evidence`。原 href 去掉 hash 后若与 `myurl` 相同（如 `#foo` 或收录页 URL 加 fragment），只是定位本页片段，不是跳转外链；JavaScript 导航不能代替真实 href。时间使用 ISO 8601 的 `Z` 或 `±HH:MM` 时区，秒的小数最多 3 位。最终目的地可在来源 tab 中观察；若点击原锚点在新 tab 打开，`destination.opened_from` 必须逐项匹配来源 href、myurl、tab ID 和时间，以绑定同一次真实点击。最终观察时间必须有效且不早于来源页观察，URL 必须为公开、非登录目标的官网域名或子域名。缺字段、绑定不一致、非 Chrome、未绑定来源的新 tab、私网或登录 URL、错误目标、缺少显式 rel 都拒绝该条成功写回。跳转证据只在 `method=browser-fallback` 下有效；HTTP verifier 只筛选线索，不能确认或升级成功。审计日志保留原 href、原 rel、最终 URL、tab 与来源/目的地观察时间。直达官网链接仍按原规则处理，无需 `redirect_evidence`。

项目/官网/Base 身份从本项目 collect 输出沿用，不能从其他项目复制。证据字段是执行者的可复核摘录，不是浏览器签名；不得填入未实际观察的值。Chrome 写回的 URL 校验拦截字面私网 IP、已知本地域名及登录路径；域名的实际公开可访问性须由执行者在 Chrome 核实，不能把字段校验通过当成公开性证明，也不以本机 DNS 解析替代浏览器观察。HTTP verifier 的所有类别都只是复核线索，不能直接写入 Base 的成功或审计结论。批次停止后未访问的记录只在临时报告注明，不能伪造观察证据。

notes 按 skill 的业务摘要规则审阅、整段重写，保留仍有效的编辑入口和重要经过。每条待写回的报告项必须提供 `base_note`（审阅后的完整正文），以及审阅时的 `record.notes`（原文，空值为 null）、`record.status`、`record.link_type`、`record.myurl` 快照；任一业务快照变化则停止该条写入，旧报告缺快照时先重新读取审阅；写回时原文已变化则跳过，重新读取并审阅后再生成报告。脚本不拼接旧正文，也不从 reason、checks 或完整证据概要生成 notes。`--append-pending-notes` 保留为兼容命令名，实际执行完整替换。

保留原有 date，不将核验时间写入归档日期。时间、详细证据和重放标记写入工具内部持久日志；业务字段的远端写入与内部状态采用待确认意图保护，中断后不得重做网站操作。相同报告重放不新增日志或改写 notes。写回核对全部目标字段和原 date。

审计可写回 status、notes、link_type、myurl；执行字段不写 Base。公开确认原 post-click submit_unknown 已收录时，仅将内部状态收尾为 submitted 并清除阻塞代码，保留原检查点和运行 ID。普通审计不重置提交过程。

nolink 项放在报告 confirmed 数组，category=confirmed、link_type=nolink；保留相同 Chrome tab/URL/时间证据，并提供 product_evidence：name 等于当前 Kit 产品名、visible_text 为实际看到且含产品名的公开资料文本、outbound_links_checked=true 表示本次确实检查了官网链接。不得同时提供与 nolink 矛盾的官网锚点或跳转证据；没有真实观察时不得补造。

人工运行 `node scripts/backlinks.mjs <project-id> collect` 时会收集全部“待核验”“已验证：未找到记录”和内部 post-click submit_unknown 记录，不依赖或写入复核调度字段。收集和验证命令不写 Base。旧参数 `--include-not-due` 与提交完成参数 `--next-action-at` 已移除，使用时会明确报错。按本轮授权范围执行写回；已授权审计并更新记录时无需重复确认，只读 review 不写回。已授权提交任务包含同一记录的即时公开确认与写回。
