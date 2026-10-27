# 外链项目入口

- 外链任务先读 [.agents/skills/backlink-submitter/SKILL.md](.agents/skills/backlink-submitter/SKILL.md)，通用流程与规则只在该 skill 维护。
- Git 中只维护通用 skill、执行脚本、测试及虚构示例；不提交真实项目配置、私有文档链接、账号、素材或业务记录。
- `projects/<id>/kit.json` 是被 Git 忽略的本机接入配置，只维护 Submission Kit 链接及必要路由；产品文案、账号和素材由具体项目的 Submission Kit 管理。`projects/example/kit.json` 仅作虚构示例和测试，不填真实资料。
- 适合提交的目录、候选清单和提交记录由各具体项目维护，本项目不维护共享目录库。
- 临时产物放 `tmp/`。仅在用户明确要求或批准时创建新文档。
