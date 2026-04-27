# Quarto AI 论文工作台

这是一个本地网页工具，用 Quarto `.qmd` 写英文论文，用 OpenAI API 生成“先预览、再确认”的修改建议，最后导出 Word `.docx`。

论文项目默认保存在：

```text
/Users/anqizhang/work/thesis
```

每篇论文会是这个目录下的一个子文件夹，例如：

```text
/Users/anqizhang/work/thesis/thesis-draft
```

## 第一次启动

在 `tool/` 文件夹中运行：

```bash
./setup.sh
```

然后一键启动：

```bash
./start.sh
```

启动脚本会先关闭之前由这个工具启动的相关服务，再启动新的后端和前端。如果端口仍被系统残留进程占用，它会自动换到下一个可用端口，并在终端打印最新地址。

打开前端提示的本地地址。默认是 `http://127.0.0.1:5183`，如果该端口已被旧服务占用，脚本会自动换到下一个端口。

停止服务：

```bash
./stop.sh
```

## 隔离环境

这个项目会把运行环境放在项目自己的 `.runtime/` 文件夹中：

```text
.runtime/python      Python 虚拟环境
.runtime/pip-cache   Python 下载缓存
.runtime/npm-cache   npm 下载缓存
.runtime/logs        一键启动时的日志
```

这些文件不会进入 Git。你可以删除 `.runtime/` 后重新运行 `./setup.sh`，得到一套干净环境。

如果你想分别启动后端和前端：

```bash
./start-backend.sh
```

另开一个终端：

```bash
./start-frontend.sh
```

## 使用方式

1. 点击“设置”，填写 OpenAI API Key。
2. 在“论文项目”区域新建或打开一个论文项目。
3. 在正文中编辑英文 `paper.qmd`。
4. 导入 PDF、Word、CSV 或 Excel 资料。
5. 选中一段正文，点击“生成建议”。
6. 检查建议后点击“接受”，正文才会被替换。
7. 点击“导出 Word”生成 `.docx`。

## Quarto 是什么

Quarto 是本地排版和导出工具。这个应用可以在没有 Quarto 的情况下编辑论文、管理资料、使用 AI；但导出 Word/PDF 需要安装 Quarto，并且系统命令行能找到 `quarto`。

## 项目 Memory

每个论文项目都有自己的 `memory/` 文件夹：

```text
memory/conversations.jsonl   AI 请求、回复和相关资料来源
memory/changes.jsonl         接受或拒绝的修改记录
memory/summary.md            给人和 AI 看的项目记忆摘要
```

当你生成 AI 建议时，系统会把该项目最近的 memory 一起作为上下文发给 OpenAI API，方便 AI 记住之前讨论过什么、哪些修改被接受或拒绝。

## Word 模板

如果你有期刊或学校的 Word 模板，把它放到：

```text
workspace/templates/reference.docx
```

导出时会尽量沿用其中的 Word 样式。

## 注意

- 这个工具会把你选中的正文和检索到的本地资料片段发送给 OpenAI API。
- AI 不会自动覆盖正文，必须由你确认后才会应用修改。
- 导出 Word 需要本机安装 Quarto。
