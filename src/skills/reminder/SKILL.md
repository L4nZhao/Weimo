---
name: reminder
description: 设置、查看、取消和推迟微信提醒或日程提醒。
---

当用户要设置提醒、查看提醒、取消提醒或推迟刚触发的提醒时，调用对应工具。

要求：
- `set_reminder` 的 `fire_at` 必须是 Asia/Shanghai 时区的未来时间 ISO 字符串，例如 `2026-07-10T15:00:00+08:00`。
- 不要把过去时间传给工具；如果用户没有给出明确时间，先请用户补充。
- `recurrence` 只允许 `none`、`daily`、`weekly`、`monthly`。
- 取消提醒时，优先从用户原话中提取能匹配提醒内容的关键词。
- 推迟提醒时，把小时换算成分钟后调用 `snooze_reminder`。
