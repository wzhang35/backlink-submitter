# Base 标准与项目接入

机器可读标准唯一来源为 [base-schema.mjs](../scripts/base-schema.mjs)，`schema`、`check-schema` 和 `bootstrap` 复用同一定义。生成的字段 JSON 可用于 `lark-cli base +table-create --fields`；不在文档手工维护第二套 JSON。

## 字段标准

| 字段 | 类型 | 业务含义／约束 |
|---|---|---|
| name | text/plain，主字段 | 候选站点名，不是产品名 |
| URL | text/url | 候选查重地址；共享平台保留区分目标的路径 |
| category | select，单选 | 渠道分类，标准选项由 schema 输出 |
| status | select，单选 | 默认待提交；业务枚举由 schema 输出，不再设待评估 |
| Submitter | select，多选 | 各项目维护经办人，必须包含配置的 defaultSubmitter |
| date | datetime | 原归档日期；无默认日期，新导入留空，不随执行改写 |
| 月份 | formula | date 为空时为空，否则 YYYY-MM |
| Last modified | updated_at | 系统修改时间，不是核验完成时间 |
| submit_url | text/url | 真实表单／管理／原申请入口，不填登录页 |
| myurl | text/url | 经过公开核验的准确资料页；不是回执或猜测地址 |
| link_type | select，单选 | dofollow / nofollow / nolink；尚未核实留空 |
| DR | number/plain | 0–100，未知为空，0有效；默认不更新 |
| Traffic (k) | number/plain | 估算月总访问量，单位千次；未知为空 |
| cost | number/currency USD | 费用；0免费，未知为空，周期与付款事实写 notes |
| ROI | formula | 指标与费用形成的粗筛分，不是实际回报；公式由 schema 输出 |
| notes | text/plain | 完整审阅后的业务摘要，保留有效管理／回执链接及重要限制 |

表内不添加执行锁、run ID、checkpoint 或自动化日志。标准比较检查16字段名称与类型、select 单多选及枚举、默认值、公式、URL样式和费用币种；说明文字、颜色及显示精度可调整。额外字段及配置差异只报告，不自动删除或迁移。Submitter 可保留其他经办人选项。

## 新表

准备在线 Submission Kit，包含产品官网、公开文案、账号和联系人、素材路径/URL映射及 Base 入口。建立本机项目路由，指定 profile/defaultSubmitter。凭证由 lark-cli 管理，不能写进 kit.json。

```sh
mkdir -p tmp
node scripts/backlinks.mjs example schema > tmp/base-fields.json
# 以下参数全部为占位符；先按本机 lark-suite skill 授权，并检查 --dry-run。
lark-cli base +table-create --base-token '<base-token>' --name Backlinks \
  --fields @tmp/base-fields.json --as user --profile '<profile>' --dry-run
```

这里的 `example schema` 只生成标准字段，不访问远端。建表前，将生成文件中 Submitter 的 `example-owner` 选项替换为该项目已确认的经办人；不要将示例路由用于云端操作。拿到新表的实际 ID 后，再建立真实项目配置。

创建表是独立的远端写入，须获用户授权；确认后使用同一参数去掉 `--dry-run`。记录返回的 tableId/viewId，将其和在线 Kit 的 Base 入口、本机配置逐一核对，再运行：

```sh
# 以下 example 均须换成已建立真实配置的 project-id。
node scripts/backlinks.mjs example check-schema
node scripts/backlinks.mjs example init --input-json - <<'JSON'
{"yes":true}
JSON
node scripts/backlinks.mjs example bootstrap
```

`init` 需要显式确认、结构合规、整张表为空且该项目持久目录从未创建，只建立本机执行状态。即使只剩空目录或备份文件，也停止并要求审阅恢复。首个项目同时建立共享 circuit；已有 workspace 丢失或损坏共享 circuit 时停止，不能清零恢复。已存在的全局限流或网站阻断不因新项目初始化被取消。

## 已有表／已有提交历史

先运行 `check-schema`；它不要求 runtime，也不写 Base。逐项审阅差异后再制定迁移方案，不能用新表默认状态覆盖旧提交、回执或已验证结果。

已有记录的表不允许 `init`。迁移旧执行器或换机器时，恢复匹配当前项目／官网／Base 的原始执行 ledger 和共享 circuit；不得以新建空状态解释“以前没提交过”。状态缺失、损坏、点击结果未知及待确认写入都需要人工审阅恢复。`bootstrap` 只核对字段和持久状态，不修复或重建它们。

首次使用本工具但已有非空 Base 时，当前没有自动接管命令；先做只读检查并审阅迁移方案。新建空表应在导入候选之前完成 `init`，不能通过清空历史记录来满足初始化条件。

## 报告与公开仓库

运行报告、Base 导出和 `.local/` 是私有业务产物，跟随项目维护，不放入工具 Git、示例、PR或Issue。报告保留项目／官网／Base身份和业务快照用于防误写；它不是用于公开展示的匿名报告。需要对外演示时使用 `projects/example/kit.json` 和虚构记录重新生成。
