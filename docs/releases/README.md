# 发行说明

正式发布前，在此目录新增 `v<version>.md`，例如 `v4.3.96.md`。

文件必须随版本变更一起合入 `main`，内容非空，且不得包含 `TODO`、`TBD`、`FIXME`、
`<version>` 或 `[待补充]` 等占位符。`Release` 工作流会从已解析的 release SHA
读取该文件，并作为 GitHub Release 正文的基础内容。
