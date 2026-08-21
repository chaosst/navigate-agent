---
name: greet_user
description: "用中文向用户打招呼。"
schema:
  type: object
  properties:
    name:
      type: string
      description: "用户的名字"
  required:
    - name
action:
  type: template
  template: |
    你好，{{ name }}！欢迎使用 Navigate Agent。今天有什么可以帮你的？
---

用友好的中文问候用户，适合在对话开始时使用。

也可以用作测试 skill 系统是否正常加载的示例文件。
