# Quarto AI 论文工作台

这是一个本地网页工具，用 Quarto `.qmd` 管理论文写作、资料整理、AI 协作修改、数据分析和可视化草稿。

前端默认端口固定为 `5183`，后端默认端口固定为 `8011`。

## Shell 启动

当前仓库支持直接使用本机 shell 启动，不依赖 Docker。

首次准备环境：

```bash
cp .env.example .env
./setup.sh
```

启动：

```bash
./start.sh
```

默认会尝试使用：

```text
http://127.0.0.1:5183   frontend
http://127.0.0.1:8011   backend
```

如果端口已被占用，`start.sh` 会自动寻找下一个可用端口，并在终端输出实际地址。

停止：

```bash
./stop.sh
```

也可以分别启动：

```bash
./start-backend.sh
./start-frontend.sh
```

说明：

- Python 虚拟环境、缓存和日志会写入 `.runtime/`
- 前端依赖安装在 `frontend/node_modules/`
- shell 模式下若需要导出 `.docx`，本机需要能直接调用 `quarto`
- 如果你之前开过 Docker，占用 `8011` 或 `5183` 时，shell 会自动换端口；如需恢复默认端口，先执行 `docker compose down`

## Docker 启动

也可以使用 Docker 开发环境：

```bash
docker compose up --build
```

打开：

```text
http://127.0.0.1:5183
```

停止：

```bash
docker compose down
```

说明：

- 前端容器运行 Vite dev server，支持热更新。
- 后端容器运行 FastAPI + Uvicorn，支持 `--reload`。
- 宿主机代码目录会挂载到容器内，代码修改后不需要重新 build。
- 只有依赖变化时，才建议重新执行 `docker compose up --build`。

### 端口

默认映射：

```text
5183 -> frontend
8011 -> backend
```

如需修改宿主机端口，可以在 `.env` 中设置：

```bash
FRONTEND_PORT=5183
BACKEND_PORT=8011
```

## 项目数据目录

论文项目默认保存在仓库内：

```text
.runtime/projects/
```

例如测试项目：

```text
.runtime/projects/higher-education/
```

本地模式下也可以在界面里直接选择一个 Workspace 文件夹。应用会把这个文件夹直接作为当前工作区载入，并自动补齐标准目录结构；该路径会写入本地状态，下一次启动继续使用。

每个项目会包含：

```text
paper.qmd / notes.qmd 等文稿
data/                  原始数据
sources/               文献与资料文本
figures/               生成的图表
outputs/               brief / mindmap / 导出文件
memory/                AI 协作记录
templates/             模板文件
```

后端也支持通过环境变量覆盖项目根目录：

```bash
THESIS_PROJECTS_ROOT=/your/path
```

## 环境变量

至少需要在 `.env` 里提供 OpenAI Key：

```bash
OPENAI_API_KEY=sk-...
```

如果要启用 DeepSeek，也可以加入：

```bash
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

仓库提供了一个示例文件：

```bash
cp .env.example .env
```

## 目前功能

- 多 manuscript（一个项目内多个 `.qmd`）
- AI 修订建议与局部接受
- 项目 memory 记录
- qmd 预览
- Analysis 工作区
- 文献资料分析
- 数据分析与图表生成
- Mermaid 思维导图
- PPT / poster brief 生成
- OpenAI / DeepSeek 提供方与模型切换
- 自定义 instruction / scholar persona

## Quarto 说明

编辑、AI 协作、资料分析、数据分析不依赖 Quarto。

导出 `.docx` 需要 `quarto` 命令，已内置在后端 Docker 镜像中，无需单独安装。
