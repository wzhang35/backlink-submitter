# 维护与发布

## 本地检查

```sh
npm test
npm run check:public
```

通用规则在 [skill](../.agents/skills/backlink-submitter/SKILL.md) 维护，Base 定义以 [base-schema.mjs](../.agents/skills/backlink-submitter/scripts/base-schema.mjs) 为唯一来源。修改后检查关联说明和示例是否仍准确，不手工维护重复的字段 JSON。

## 保护项目资料

真实项目路由、账号、素材、候选、Base 导出、截图和报告不进入工具 Git、公开 PR 或 Issue。运行报告包含项目／官网／Base 身份、原 notes 和管理链接，按私有业务资料处理；不要为了分享而删掉防跨项目写回的身份字段。演示只使用虚构项目。

`check:public` 检查可提交文件、暂存区，以及本地 refs 可达的提交历史和 tag 消息，识别私有产物路径、真实文档/PR/Issue链接、邮箱、明显凭证和本机项目标识。输出只含位置和问题类别，不打印命中资料。检查通过不能证明不存在所有敏感信息，发布前仍需审阅实际文件与 Git 托管内容。

## 正常更新

已清理的公开仓库沿用其正常提交历史。仅提交审阅过的通用文件；提交、推送、创建 PR 和修改可见性分别遵守用户授权，不因运行检查自动执行。

## 需要无历史副本时

历史曾包含私有资料时，后续删文件不会清除旧版本。审阅旧 refs、PR、Issue、附件、release 和托管设置，避免把旧资料一起公开。

```sh
npm run export:public -- tmp/public-release
```

`export:public` 检查当前源码后，将可提交文件复制到全新的 `tmp/` 或 `dist/` 子目录，初始化没有提交、历史、refs 或 remote 的 Git 仓库。它不会覆盖已有目录、复制被忽略文件或原 `.git`，也不会搬迁 PR/Issue、推送或改变远端可见性。

进入导出目录后重新运行测试和发布检查，人工审阅，再按授权创建首个提交并推送。这个工具用于需要干净副本的场景，不是日常更新公开仓库的必经步骤。

## 换机器继续业务

通过私有渠道迁移完整 `.local/backlink-submitter/` 和项目路由；产品资料继续以在线 Kit 为准。公开代码副本不含业务执行状态，不能据此恢复未知提交或重建 ledger。
