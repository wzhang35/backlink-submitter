---
name: backlink-submitter
description: Qualify, submit and publicly audit backlink candidates for a selected product using its Submission Kit and Base records. Use in this backlinks project for authorized candidate processing or audits.
---

# 通用外链流程

仅用于用户已授权的提交或审计。只读 review 不提交，也不写 Base。

## 维护边界

- 本 skill 属于当前 backlinks 项目，维护通用的筛选、提交、人工交接和公开审计流程；不安装为全局 skill。所有产品的外链提交、公开审计及相应业务写回统一在本项目发起和执行，产品项目不再主动执行，也不维护独立执行器。
- Git 仓库只维护通用规则、脚本、测试和虚构示例；真实项目的文案、账号、素材、候选、提交记录及私有文档链接由各项目管理。
- `projects/<id>/kit.json` 是被 Git 忽略的本机项目接入入口，只保留 Submission Kit 链接和必要路由配置（含飞书 profile、默认提交人）。Kit 内容由各项目在所选平台维护，不在本地复制。唯一公开示例 `projects/example/kit.json` 使用虚构地址和资源 ID，不填真实项目资料。
- 适合提交的目录、候选清单和提交记录由各具体项目维护；本项目不汇总目录库，也不跨项目复用提交状态。
- 当前执行脚本支持飞书 Base 接入，目标表由所选项目的本机配置提供。其他记录系统按项目实际接入能力适配，不要求迁移候选目录或预先增加新的存储实现。
- 新项目接入或对齐 Base 时先读 [base-setup.md](references/base-setup.md)：`schema` 输出标准字段，`check-schema` 只读对比；`init` 仅初始化新空表的本机状态。已有提交历史必须恢复或审阅迁移原执行状态，不能重新初始化。

## 项目选择与 Submission Kit

先明确目标项目，在工作区创建或读取本机 `projects/<id>/kit.json`；可复制虚构示例后填写自己的接入路由，文件保持被 Git 忽略，不提交到远端。所有命令从工作区根目录经 `node scripts/backlinks.mjs <id> <command>` 执行；必须显式选项目，禁止默认产品。运行依赖为 Node.js 和已授权的 lark-cli；飞书操作使用 lark-suite 对应能力。Submission Kit 用链接维护：飞书链接用 lark-suite，其他链接用对应连接器或网页读取能力，不能强制转存飞书或从旧本地副本填表。

配置只放官网、Kit 链接、可选的产品资产根目录与当前记录系统的路由，不复制可变文案。`baseToken` 是 Base 的资源标识，登录凭证由已授权的 lark-cli 管理，不写入本仓库。使用现有飞书 Base 脚本时，各项目分别指向自己的表；导出、审计报告必须带 `project_id`、`website` 和 `base` 身份（wikiUrl/base_id_hash/tableId/viewId），不能跨项目写回。旧无身份报告需先核对来源再补齐身份，不能猜测或自动接纳。临时证据放工作区 `tmp/`；Kit 指定本地素材时，从项目配置 sourceProjectRoot 解析路径，未配置时不猜路径。共享 writer lock、circuit 和按项目隔离的执行记录持久保存在被 Git 忽略的 `.local/backlink-submitter/`；不能当临时文件清理，不并行使用产品旧仓库执行器。切换机器须迁移同一份运行状态；状态丢失或损坏时停止执行，不得按“未提交”重建。

候选从目标项目维护的清单或用户指定的 URL 读取，入口由该项目 Submission Kit 提供。处理时按当前公开路径重新筛选，在该项目的记录系统查重，再按授权 intake；不能继承其他产品的适用性结论或提交状态。

## Submission Kit 与 Base 字段

- 提交前读 [qualification-policy.md](references/qualification-policy.md)；审计前读 [audit-policy.md](references/audit-policy.md)。
- 填写公开字段前，读取项目配置 `submissionKitUrl` 指向的当前 Submission Kit；飞书使用用户身份，其他平台使用获准的读取能力。Kit 是本次产品资料、账号/联系人、提交文案、素材与本地路径/线上 URL 映射、Base 入口的唯一来源；按当前候选选取对应内容，不在本 skill 复制这些具体值。价格等易变信息还要在当前网站核实。Kit 无法读取或缺必要资料时说明阻塞，不从其他项目补填。
- 仅填写 Kit 和当前一手证据支持的内容。邮箱不能证明任职、公司归属、法律实体或职位；无依据时不补客户、营收、融资、奖项、发布日期、促销或功能、可用性、效果承诺。用于展示当前界面的截图须为当前截图，旧截图不能证明当前状态。
- 按 Kit 的本地路径/线上 URL 映射定位上传文件，核对文件存在、与当前线上版本一致，并符合用途和目标站点要求；根据项目实际静态目录确认映射并复用现有文件，不假设所有素材都在同一目录。维护时保持本地与线上副本同步。必要素材缺失时说明；可选上传失败不是阻塞。
- 根据候选类型使用 Kit 指定的账号身份、handle 和联系人。若验证链接或验证码发到 Kit 邮箱，按“人工交接”处理；不要把填写邮箱当成完成验证。

Base 表格/视图入口以 Kit 当前配置为准。运行开始时核对 Kit 入口与当前脚本配置；若不一致，停止 Base 读写并报告。Kit 链接不会动态切换脚本使用的 Base。

Base 字段职责：

- 各项目统一使用 16 个业务字段：name、URL、category、status、Submitter、date、月份、Last modified、submit_url、myurl、link_type、DR、Traffic (k)、cost、ROI、notes。status 使用中文业务枚举；link_type 为 dofollow/nofollow/nolink，尚未核实留空。核验完成时同步维护 status 与 link_type；核验成功含 nolink，统计实际外链时单独排除 nolink。
- 执行检查点、运行 ID、阻塞代码和详细日志由公共工具内部保存，不在业务表新增 automation 字段。工具 get 可同时查看业务结果和内部恢复信息。业务状态、notes 必须让人和 AI 都能理解当前结论与必要待办，不能只在内部日志记录重要业务信息。
- notes 是供人和 AI 快速接手、理解当前状态及重要经过的业务摘要。更新前先读原文与新证据，再整段重写；保留仍影响判断或后续操作的信息，去掉重复、过期内容和过程流水。详细运行证据写工具内部日志。
- date 保留原有归档日期，提交、忽略和审计均不改写；仅用户明确要求更新 date 时才修改。实际处理时间放在 notes 的核验说明或工具内部运行记录 中。审核由用户人工发起，不设置自动复核时间。
- 外部收集的新候选统一进入“待提交”，date 留空；提交前仍须评估资格、免费路径、费用与历史提交情况，不另设“待评估”状态。导入不算业务处理；若已有真实处理或阻断证据，以历史记录为准，不重置状态或 date。
- 运行状态不替代业务结论；不得单靠内部执行成功推断公开收录。Submitter 使用项目配置的默认值，历史归属按用户要求维护。

提交模式不得写 已验证状态、`myurl` 或 `link_type`；这些公开确认字段只由审计模式写入。

notes 写作：

- 先说明当前结果，按实际需要补充重要经过、关键依据、费用周期、期限、限制和具体待办。不限制句数或长度，也不要求每条都写“下一步”；复杂情况保留必要细节，避免贴入脚本生成的完整证据概要或反复写通用提醒。
- 保留平台返回的完整编辑／管理链接、回执或原申请入口、提交编号和排队／发布日期；更新后仍有效的入口不得遗漏。私有编辑链接保存在对应项目的记录中，不当作公开收录页，也不放入 Git。
- `finish`、`reopen` 必须用 `base-note` 提供审阅后的完整替换正文，并用 `notes-before` 传入审阅时的原备注全文（为空传空字符串）；原文变化则停止，不覆盖人工更新；reopen 还须提供审阅时的 status-before 和 website-before，状态或候选变化同样停止；`evidence` 写详细证据，不能直接用来生成 notes。终态 `finish` 重放只补元数据，不改 notes；备注更正需另行审阅写回。审计报告的对应字段及旧备注快照见 audit-policy。

以下为参考现有备注中排队、投票门槛和原申请跟踪等情形改写的虚构示例，复杂度按实际信息决定：

> 免费提交，排队审核中。编辑：https://directory.example/edit/sample
>
> 免费发布排期为 2027-04-15；当前为 noindex 预告页。上线后需达到 12 分才能保留，达到 25 分才获 follow 链接，未达门槛会撤回且不能重新进入免费队列。$45 一次性加速方案未购买。编辑：https://launch.example/edit/sample
>
> 原 PR 仍待维护者批准安全检查。提交人称已提供测试凭证，接收情况未确认；两个目录按同一次申请跟踪，继续处理原 PR：https://code.example/pull/123

## Submit mode

候选逐条串行处理，遵守用户给定的上限。每筛选一个候选都计入上限，无论结果是 submitted、ignored 还是 blocked。达到上限后汇报结果和剩余数量，然后暂停。

本轮提交同时保留的 active Chrome 候选标签页最多 5 个，用户指定更小上限时从其要求；此上限与整批处理数量分开计算。正在评估、填写及等待人工登录、邮箱验证、Cloudflare/验证码的页面均占用名额，不能因已写 blocked、切到后台或折叠标签组就释放；同一候选额外打开的登录或表单标签页也计数。达到上限后不再领取新候选或打开新页，先等待已有候选取得明确处置结论并完成写回核对。收尾时关闭本轮创建且已有结论、无需保留现场的站点标签页后再补充新页；保留仍需人工接手的原页，不关闭用户原有标签页。上限不代表允许并行写 Base 或绕过既有整批停止规则。

每个候选开始前检查 circuit 和 Base 记录。不要 claim 已终态或正在运行的记录。用户提供直达 URL 时，先按归一化域名查重；仅对新候选 intake 并 claim。短链或追踪链接只被动打开一次以确认目标域名；原始 URL 写入 notes，intake 只使用最终目标。新的第一方证据推翻受阻或终止结论时，先走 reopen 流程。bootstrap 仅验证统一业务结构及已有持久运行状态；不再创建自动化字段，也不初始化丢失的运行状态。Base 认证失败时，在浏览器操作前停止。

状态命令的自由文本一律通过 --input-json <path|-> 提供。JSON 键名是现有参数名去掉开头的 --；值为字符串、布尔值或有限数值。可用单引号 heredoc 从 stdin 传入。不要把自由文本放进 shell 参数，也不要把 JSON.stringify 当作 shell 转义。

~~~sh
node scripts/backlinks.mjs <project-id> finish --input-json - <<'JSON'
{"record-id":"<record_id>","run-id":"<run_id>","result":"ignore","blocker-type":"paid","evidence":"Only paid plans are offered; no selection or payment was made.","notes-before":"原备注全文","base-note":"仅提供付费提交；已忽略，未付款。"}
JSON
~~~

每个候选都在用户的 Chrome 中打开，包括用户未指定浏览器时。操作要绑定到该候选的确切 Chrome tab；每次跳转后先确认 tab ID、标题和 URL，再读取或操作。Google OAuth 只使用当前 Kit 指定的账号：检查账号选择器，仅选择该账号，并在同一个目标表单 tab 上复核账号后再填写。账号不可用时停止并交接。OAuth 仅允许身份/邮箱权限；Calendar、Drive、Contacts、offline access 等更广权限须用户明确批准。不要查看或手动输入密码。仅在获准的 Google OAuth 路径允许浏览器自动填充；若页面要求输入密码、恢复账号或确认邮箱，按“人工交接”处理。不要使用 Codex In-App Browser 或其他浏览器兜底。

先检查公开提交流程并按判定表分类，再填写。submit_url 记录真实表单/编辑入口，不记录登录页。

提交默认保留已有 DR/Traffic，不重新采集、补充或修改，也不以指标读取作为提交前置条件。仅在用户明确要求时采集或更新：读取目标 Chrome tab 工具栏的稳定读数，Traffic 换算为千次，实测 0 是有效值。未检查或读取失败均保留原值；dr-unavailable、traffic-unavailable 不清空字段。清空已有指标须用户明确授权。获授权的指标更新只在 form_ready 写入，并带 metrics-checked-in-chrome；不更新指标时省略这些参数。

工具内部 checkpoint 必须按 claimed → public_precheck_done → form_ready → form_filled → pre_submit_verified → submit_click_started → submit_result_recorded 顺序推进。提交前核对 Kit 支持的产品声明、规范 HTTPS URL、联系人、分类、上传内容、勾选项、已保存的公开 href 和最终 slug。需要时点击字段内 Save/Update 并读回确认；页面级 Continue 可能不会保存嵌套编辑。官网 URL 与具体资料以 Kit 为准；通用目录使用不带 UTM 参数的规范首页。

既有运行若缺失或含无效 checkpoint，先 get 排查，不允许直接推进阶段。新流程的 claimed 由 claim 建立，不用 checkpoint 命令补造已完成的步骤。

submit_click_started 表示首次不可逆的发布/接受操作。紧邻操作前记录该 checkpoint，然后只执行一次。结果不明确时不要双击、按 Enter、刷新重试或在另一个 tab 提交。

每次运行都要 finish。submitted 必须有提交后 checkpoint 和明确成功证据。点击后的结果不明时，表内记“受阻：人工处理”并在 notes 说明已点击、结果未知、不可重提；工具内部记 manual_review/submit_unknown；禁止 resume 或再次提交。后续只能审计公开状态。finish 后提交流程关闭，不再添加 checkpoint、修改网站或补录指标。

进程若在点击后、finish 前中断，先 get 原记录；即使 state 仍为 running，也不得 resume。只用同一 run ID 和已有点击证据 finish 为 manual_review/submit_unknown，完成元数据收尾后公开审计，不重做网站操作。

内部状态已持久化、Base 写入结果未确认时，工具保留 pending intent 并阻止继续执行。先 get 排查；只有当前业务字段与待确认补丁及原 date 全部一致时，reconcile 才会只读核对 Base 并提交内部状态。不能确认时保持阻塞，不重做网站操作或自动覆盖人工备注。

保留 circuit 规则：一次真实的非验证型 403 会记录网站域名并阻止本轮及当天后续访问该网站；其他网站继续处理。403 不打开全局 circuit。429/IP rate limit 停止整批并打开 circuit。Cloudflare/人工验证码挑战按下方专门规则交接，按候选暂停，不计入 403 circuit。领取候选及每个提交前 checkpoint 都重新检查全局 circuit 和该域名的 403 事件；点击后的 submit_result_recorded 与 finish 仍可用于元数据收尾。旧 `repeated_security_blocks` 仅在没有 429/IP 熔断事件时归一化为关闭，同时保留事件及域名/记录 ID。不要修改 user agent、cookies、proxy、DNS、IP 或浏览器身份来绕过拦截。

Base 写入遇到 writer lock 时，脚本内部等待 30 秒并重试获取锁一次。返回“两次仍被锁”即停止并报告冲突；不要在外层再次重启命令、删除 lock、重开流程或再次执行浏览器提交。若 submit_result_recorded 后的 finish 被锁，后续任务只可 inspect get，并用同一 run ID 和持久证据重试 finish。

## Audit mode

浏览器公开审计只用用户的 Chrome。每次读取都绑定确切目标 tab，检查 DOM 前确认公开页 URL。候选收集/HTTP verifier 脚本只作筛选；脚本结果按 [audit-policy.md](references/audit-policy.md) 核实，不能代替 Chrome DOM 证据。Chrome 有问题时不要切换到 In-App Browser；记录具体阻塞。

按 [audit-policy.md](references/audit-policy.md) 的标准确认并写回。收集和验证待审计记录不会写 Base：

~~~sh
node scripts/backlinks.mjs <project-id> collect
node scripts/backlinks.mjs <project-id> verify <本项目collect返回的JSON路径>
~~~

人工运行收集器时会包含所有符合审核资格的“待核验”“已验证：未找到记录”，以及内部点击结果不明的 post-click `manual_review/submit_unknown` 记录；不按日期筛选。旧参数 `--include-not-due` 会明确报错。写回授权和历史留痕统一遵循 audit-policy，不在本入口重复维护。

运行报告含项目路由、原 notes 和管理链接，均为私有产物，不提交到工具仓库或放入公开PR/Issue。HTTP报告的匹配结果仅为线索，Markdown及统计不应称为已验证收录；正式写回仍要求Chrome证据与项目身份。

## 人工交接

仅用于资格判定表指定交接的阻塞：

1. 停止该候选的浏览器操作。不要点击、刷新、离开页面、另开重复流程或切换浏览器。
2. 记录 Chrome tab ID、标题和 URL，然后调用当前浏览器 API 的 tab.markHandoff()，保留原页面。
3. 告知用户需要完成的单一动作并持久化对应 blocked 状态。登录、注册、邮箱验证等既有人工交接仍停止当前批次并等待用户明确确认；Cloudflare/人工验证码按下方规则处理。
4. 用户确认后，resume 同一条提交前流程，并在不刷新的情况下读取交接页一次。若页面无法恢复，不要推断成功或另开重复流程。点击后的未知结果不得 resume，只能审计公开状态。

### Cloudflare / 人工验证码

仅当挑战实际阻断页面或当前路径并要求人为操作时触发交接。自动加载期间短暂出现、随后自行消失且页面正常加载的验证不算阻断，继续常规检查。

- 保留该候选的精确 Chrome tab，记录 tab ID、标题和 URL，并调用 `tab.markHandoff()`。告知用户目标网站和一个动作：在这个 tab 中完成当前可见的 Cloudflare/验证码挑战。Agent 不得自行点击挑战、解题或绕过拦截。
- 只暂停该候选；active 候选标签页未达上限时可继续处理其他未受影响的候选。多条挑战保留各自的 handoff tab，并合并列出目标网站和对应动作；不要要求用户关闭其他标签。Cloudflare/验证码挑战的次数不触发安全熔断，但等待人工的页面仍占用名额，达到 5 个或用户指定的更小上限时暂停新增候选。
- 用户明确确认后，只在原 tab 被动读取一次，不刷新、不另开页面。若页面已正常可读，按当前证据继续该候选；若仍被阻断或原 tab 不可用，将候选保留为未完成/`needs_attention`（提交模式保留对应 blocked 状态）并停止该候选，不再尝试该挑战。
- 本规则只处理提交点击前的验证阻断。`submit_click_started` 后结果未知时仍不得 resume 或重提，只能审计公开状态。

## 完成与验收

- 处理结果按 qualification-policy 或 audit-policy 落表；notes 保留简洁、可读的当前结论及必要业务信息，工具内部日志保留过程证据。写入补丁省略 date，并核对原值未变；既有脚本会自动改日期时须先适配，不能覆盖原归档日期。
- 每次业务写入后核对补丁内全部字段。脚本最多读回三次；仍不一致时用 `node scripts/backlinks.mjs <project-id> get --record-id ...` 只读核对并报告，不能据此重新写入或重做浏览器提交。
- 汇报已处理数量、逐条结果及简短证据、已验证公开 URL、Base 记录 ID、未完成事项和 circuit 状态。明确区分站点结果与 Base 写回是否已确认。
