# Backlink Candidate Qualification

此表是提交模式唯一的候选判定依据。用 Chrome 检查当前公开路径；费用、互链、注册和验证要求以现场页面为准，不沿用候选源表的旧标签。

| 观察到的路径或条件 | 记录结果 | 后续动作 |
|---|---|---|
| 网站活跃且相关；提供免费的个人提交路径；允许真实的产品、项目或个人资料展示；不要求互链、徽章或未经证实的声明 | 继续处理 | 记录真实提交/编辑 URL，填写并仅提交一次。指标处理按 skill 的授权范围执行。 |
| 必须购买提交服务或付费试用 | ignore / paid；status=受阻：需换链/付费 | 记录现场价格及未选择、未付款、未提交。继续下一个候选。 |
| 免费路径要求在 目标产品 放互链、徽章或其他推广位置 | ignore / reciprocal；status=受阻：需换链/付费 | 记录具体要求和未修改 目标产品。继续下一个候选。 |
| 必须创建或使用站点专属账号，且没有获准的 Google OAuth 路径 | ignore / site_registration；status=受阻：人工处理 | 记录注册要求；不要让用户创建账号。继续下一个候选。 |
| 访问、产品/公司归属或提交流程要求手机号或手机验证 | ignore / phone_verify；status=受阻：人工处理 | 记录具体要求；不要索要手机号或要求用户完成验证。继续下一个候选。 |
| 没有有效公开路径、网站已失效、与产品无关、属于低质链接农场，或只允许虚假评价/低质推广 | ignore / no_path、not_relevant 或 low_quality；status 按证据区分终止：网站失效／终止：不适合提交／受阻：人工处理 | 记录具体原因。不要在论坛或社区发纯外链内容。继续下一个候选。 |
| Cloudflare / CAPTCHA 挑战实际阻断路径并需要人工操作 | blocked / 对应 blocker；status=受阻：人工处理 | 保留精确 Chrome tab 并按 skill 的专门交接规则办理；只暂停该候选，可继续其他未受影响候选。用户确认后在原 tab 不刷新地被动读取一次。Agent 不得自行解决或绕过；挑战次数不触发整批停止。自动加载期间短暂出现且自行消失、页面正常加载的验证不算阻断。 |
| 合格路径所需的登录或邮箱验证需要用户处理 | blocked / 对应 blocker；status=受阻：人工处理 | 保留原页面，按既有“人工交接”办理。停止本批并等待用户确认。 |
| 单次非验证型 403 / 访问拒绝 | blocked / forbidden_403；status=受阻：人工处理 | 记录受影响域名，本轮及当天不再访问该网站；其他网站继续处理。若页面实际显示 Cloudflare/CAPTCHA 人工挑战，按上一行处理，不计作真实 403。 |
| 429/IP rate limit | blocked / ip_rate_limit；status=受阻：人工处理 | 打开 circuit 并停止整批；circuit 关闭前不尝试其他候选。 |
| 条款、公开可见性、链接位置或业务声明确实不清楚 | 内部 manual_review / ambiguous；status=受阻：人工处理 | 记录未决点；不提交，也不推定已获授权。 |
| submit_click_started 后结果未知 | 内部 manual_review / submit_unknown；status=受阻：人工处理 | 关闭提交流程，绝不 resume 或重按提交；之后只能审计公开状态。 |

表中 ignore 的候选也计入用户指定的批次上限。候选一旦判为 ignore 或 blocked，不再收集 DR/Traffic，也不填写表单。

真实代表 Kit 指定产品且有明确官网字段的个人项目页可以符合条件。nofollow 链接可作为引荐/实体链接，不等同于 follow 链接。DR 单独不能决定是否提交。

## 通用收录标准

以下为通用流程标准；具体受众、主题和产品声明由所选项目 Kit 决定。

1. 页面应给目标受众带来真实参考价值，优先主题匹配；低相关本身不等于违规。
2. 检查站点持续运营与具体页面用途，不只看 DR、DA 或 dofollow 标签。
3. 排除链接农场、PBN、低质目录/书签、批量自动生成与仅堆链接的页面；目录形式本身不自动违规。
4. 本流程只使用免费入口，不买收录、排名或 badge，不以产品/服务换取排名链接。
5. 不做操纵性批量互换、跨站模板/页脚铺链或无差别自动化批量投稿。逐候选授权的流程辅助与批量制造链接须区分。
6. 自然使用品牌名、裸 URL 或准确描述，不要求商业关键词锚文本或批量变体。
7. 上线后核对真实 href、位置与 rel；不把提交回执当公开链接。
8. 如实记录 nofollow、ugc、sponsored，不承诺排名权重。
9. 分开记录已提交、已公开、真实引荐访问和搜索表现，不以其中一项证明另一项。
10. 只按可验证结果复核、留痕，不保证收录、排名或流量。

Google 的 [链接垃圾政策](https://developers.google.com/search/docs/essentials/spam-policies)、[外链属性说明](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links) 与 [可抓取链接说明](https://developers.google.com/search/docs/crawling-indexing/links-crawlable) 是外部政策依据；实际执行需要时读取最新正文。上述免费、账号和渠道选择属于本流程偏好，不能推断为 Google 的违规判据。

ignore/blocked/manual_review 和 blocker 代码是工具内部结果。内容尚未准备的渠道用“受阻：暂缓（需内容/运营）”；付费/互链用“受阻：需换链/付费”；明确失效或不适合才终止。临时故障、按钮不可用、未找到入口或不明历史跳过不能直接判为网站失效。finish 可用 business-status 显式指定有证据的 ignore 业务结果，其余结果不允许借此写已验证状态。
