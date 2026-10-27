# Backlink Lifecycle

按每个产品的 Submission Kit 筛选免费渠道、辅助逐站提交，并核验公开资料中的真实官网链接。面向能够读取本地文件、使用用户 Chrome 和运行 CLI 的 AI 助手；不是无人值守的批量投稿机器人。

## 环境

- Node.js 18+、Git；不需要安装 npm 运行依赖。
- 已安装并授权的 `lark-cli`，使用用户身份；飞书操作需要当前环境的 `lark-suite` skill。
- 提交／公开核验需要支持 Chrome 标签页、DOM 读取和人工交接的浏览器工具。只有 CLI 不足以完成公开核验。

先让助手读取 [backlink-submitter skill](.agents/skills/backlink-submitter/SKILL.md)。只读 review 不授权提交或写回。

## 项目接入

1. 复制 `projects/example/kit.json` 到被忽略的 `projects/<project-id>/kit.json`，填写该项目的路由。账号、文案和素材维护在在线 Submission Kit，不复制到工具源码。
2. 按 [Base 标准与接入说明](.agents/skills/backlink-submitter/references/base-setup.md) 创建空表，或对已有表做只读对比。迁移已有业务数据和执行状态必须单独审阅。
3. 新空表使用 `init` 创建本机持久状态；既有项目迁移机器时恢复原 `.local/backlink-submitter/`，不能重新初始化来绕过未知提交结果。

```sh
# example 是虚构配置，接入时换成自己的 project-id。
node scripts/backlinks.mjs example schema
node scripts/backlinks.mjs example check-schema
node scripts/backlinks.mjs example init --input-json - <<'JSON'
{"yes":true}
JSON
node scripts/backlinks.mjs example bootstrap
node scripts/backlinks.mjs example collect
```

`schema` 只输出字段 JSON；`check-schema` 只读远端字段并列出差异，不创建或修改表；`init` 只接受新空表且不写远端。所有业务处理必须明确选择项目。

## 提交与报告

提交时先检查资格、账号、费用和重复记录，按 skill 的检查点推进，只执行一次最终提交；点击后结果不明只能核验，不能重提。登录、邮箱验证和验证码保留现场交给用户。

`collect` 收集待核验记录。`verify` 会进行 HTTP 请求，只提供筛选线索：它不等于 Chrome 公开核验，也不能用其报告直接写 Base。正式写回要求同次 Chrome 观察的实际公开 URL、原始 `href`／`rel` 和人工审阅后的 notes，协议见 [audit-policy](.agents/skills/backlink-submitter/references/audit-policy.md)。

运行报告、截图、候选、原申请、notes 和管理链接都是私有业务资料。报告中的项目／官网／Base 身份用于防止跨项目写回，不应删除这些校验字段来制作可分享报告；公开示例只使用虚构数据。

## 公开发布

```sh
npm test
npm run check:public
npm run export:public -- tmp/public-release
```

`check:public` 检查当前可提交文件、暂存区和所有本地 refs 可达的历史，拒绝私有产物路径、真实文档/PR/Issue链接、邮箱、明显凭证及本机项目标识；只输出位置和问题类别，不打印命中的资料。它是检查工具，不能证明不存在所有形式的敏感信息；仍需人工审阅 PR、Issue、附件、release 和 Git 托管设置。

历史有敏感资料时，后续删除文件不能清除旧版本。不要直接把旧仓库改成公开，也不要把旧分支、tags、Git bundle、PR 或 Issue 搬入新仓库。

`export:public` 检查当前源码后，复制可提交文件到全新的 `tmp/` 或 `dist/` 子目录，并初始化一个**没有提交、历史或 remote**的 Git 仓库。不会覆盖已有目录，不会复制被忽略文件、原 `.git` 或原仓库的 PR/Issue。导出后在该目录重新运行 `npm test` 和 `npm run check:public`，人工审阅后再创建首个提交并推到新仓库。导出不是发布，也不会改变原远端或仓库可见性。

跨机器继续业务时，私下迁移完整 `.local/backlink-submitter/` 和项目路由；不能从公开发布副本恢复业务执行状态。

## 许可证

采用 [MIT License](LICENSE)。
