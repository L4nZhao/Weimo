---
name: document-generation
description: 生成通用 Word 文档并通过微信直接发送。用户要求写文章、材料、方案、说明、报告、总结，并要求以 Word/.docx 文件返回时使用。
---

当用户要求生成非项目汇报类 Word 文档时，调用 `generate_word_document`。

适用示例：
- 写一篇关于当前 AI 发展前景的文章，以 Word 形式返回。
- 帮我生成一份活动方案 Word。
- 写一个说明文档并发给我。

要求：
- 必须生成 `.docx` 文件并触发微信直接发送，不要只口头说“已生成”。
- `title` 使用文档标题，不要使用“测试报告”等旧标题。
- `prompt` 保留用户原始需求。
- `content` 填入完整正文，纯文本即可，不要使用 Markdown 代码块。
- 如果用户要求的是项目工作汇报、日报、周报，优先使用 project-report Skill。
