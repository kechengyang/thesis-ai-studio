# Quarto AI 论文工作台

这是一个本地网页工具，用 Quarto `.qmd` 写论文，用 OpenAI API 生成“先预览、再确认”的修改建议，最后导出 Word `.docx`。

## 第一次启动

在 `tool/` 文件夹中运行：

```bash
./setup.sh
```

然后一键启动：

```bash
./start.sh
```

打开前端提示的本地地址，通常是 `http://127.0.0.1:5173`。

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
2. 在正文中编辑 `paper.qmd`。
3. 导入 PDF、Word、CSV 或 Excel 资料。
4. 选中一段正文，点击“生成建议”。
5. 检查建议后点击“接受”，正文才会被替换。
6. 点击“导出 Word”生成 `.docx`。

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
