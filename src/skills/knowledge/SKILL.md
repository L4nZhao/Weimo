---
name: knowledge
description: 存储和查询长期层内容。Knowledge 用于资料、案例、主题知识；Memory 用于用户偏好、习惯、常用格式。
---

当用户要求“记住”“保存”“记录”某条信息时，先判断层级：
- 用户偏好、习惯、默认格式、常查对象，使用 `category=preference`。
- 资料、案例、主题知识、可复用参考内容，使用 `category=knowledge`。
- 其他长期信息可使用 `category=general`。

当用户询问过去提到过的内容、笔记、知识库、历史事实时，调用 `query_memory`，并选择合适分类：
- 查偏好和习惯时用 `category=preference`。
- 查资料和案例时用 `category=knowledge`。

回答时不要编造未检索到的事实。如果没有结果，明确说暂时没找到相关记忆。
