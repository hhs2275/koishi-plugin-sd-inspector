# koishi-plugin-sd-inspector

从 Stable Diffusion 生成的图片中读取 pnginfo 来获取生成的参数。

基于 [stable-diffusion-inspector](https://github.com/Akegarasu/stable-diffusion-inspector) 的功能实现。

## 功能特性

-  解析 PNG 图片中的 Stable Diffusion 生成参数
-  自动提取正向提示词、负向提示词和生成参数
-  **识别 NovelAI 模型**（NAI-V3, NAI-V4, NAI-V4.5, NAI-V5 等）
-  **识别生成类型**（文生图、图生图、氛围转移）
-  **NovelAI V4+ 角色提示词支持**（Character Prompts，坐标位置显示）
-  支持多种调用方式（命令触发或自动回复）
-  支持 NovelAI、SD WebUI 等主流工具生成的图片

## 安装

```bash
# 在 Koishi 项目根目录下执行
yarn add koishi-plugin-sd-inspector
```

## 使用方法

### 命令模式（默认）

发送图片并使用 `sdinfo` 命令：

```
sdinfo [图片]
```

或者引用包含图片的消息后发送 `sdinfo`

### 自动回复模式

在插件配置中开启 `autoReply` 选项后，机器人会自动解析所有 PNG 格式的 SD 图片。

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| commandName | string | `sdinfo` | 命令名称 |
| autoReply | boolean | `false` | 是否自动回复所有图片（不需要命令触发） |
| useForward | boolean | `true` | 使用转发消息发送结果（避免刷屏和超字数限制） |

## 示例配置

在 `koishi.yml` 中添加：

```yaml
plugins:
  sd-inspector:
    commandName: sdinfo
    autoReply: false
    useForward: true  # 推荐开启，避免刷屏
```

**关于转发消息：**
- 开启 `useForward` 后，结果将以转发消息（合并转发）形式发送
- 每项信息（模型、类型、提示词等）分别作为一条消息
- 避免单条消息过长超过 QQ 字数限制（约 3000 字）
- 避免多条消息刷屏
- 如需传统单条消息模式，设置 `useForward: false`

## 支持的图片格式

- ✅ PNG 格式且包含元数据的图片
- ❌ JPG/JPEG 格式（不支持）
- ❌ 压缩或转换后丢失元数据的图片

## 输出示例

### NovelAI 格式（文生图）

```
 SD 图片参数信息：

 模型：NAI-V3 (Stable Diffusion XL)

 类型：文生图 (Text2Img)

 正向提示词：
1girl, best quality, amazing quality, very aesthetic, absurdres

 负向提示词：
nsfw, lowres, {bad}, error, fewer, extra, missing, worst quality

 生成参数：
Steps: 23, Sampler: k_euler_ancestral, CFG scale: 5.0, Seed: 4044195310, Size: 832x1216, Noise schedule: karras
```

### NovelAI V4+ 格式（角色提示词）

```
SD 图片参数信息：

 模型：NAI-V4.5-Full (NovelAI Diffusion 4.5)

 类型：文生图 (Text2Img)

 正向提示词：
school, best quality, amazing quality, very aesthetic, absurdres
【角色提示词】"1girl, smile@B3 --uc:frown; 1boy, tall@D3 --uc:short"

负向提示词：
nsfw, lowres, {bad}, error, fewer, extra, missing, worst quality

 生成参数：
Steps: 23, Sampler: k_euler_ancestral, CFG scale: 5.0, Seed: 2691682226, Size: 832x1216, Noise schedule: karras, V4特性: 坐标✓ 顺序✓
```

**角色提示词说明：**
- `@B3` 表示角色位于 B3 位置（左偏中间，5×5 网格，V4/V4.5 及兼容写法）
- `@0.25,0.7` 表示 NAI 5 自由坐标（值域 0~1，对应官方网页版拖拽定位）
- `--uc:frown` 表示该角色的负面提示词
- 坐标系统：网格为 X轴(A-E) × Y轴(1-5)；非网格点还原为 `x,y`
- 详见 [V4_CHARACTER_PROMPTS.md](V4_CHARACTER_PROMPTS.md)

### SD WebUI 格式

```
 SD 图片参数信息：

 正向提示词：
masterpiece, best quality, 1girl, long hair, smile

 负向提示词：
lowres, bad anatomy, bad hands, text, error

 生成参数：
Steps: 28, Sampler: Euler a, CFG scale: 7, Seed: 1234567890, Size: 512x768
```

## 技术实现

插件使用以下 npm 包来解析 PNG 元数据：
- `png-chunks-extract` - 提取 PNG chunks
- `png-chunk-text` - 解析文本 chunks

## 许可证

MIT License

## 相关链接

- [stable-diffusion-inspector](https://github.com/Akegarasu/stable-diffusion-inspector) - 原始 Web 版本
- [在线版本](https://spell.novelai.dev/) - Web 在线解析工具