import { Context, Schema, h } from 'koishi'
import { analyzeImage, isPngBuffer, Logger, PngChunk, ParsedResult } from './parser'
import { formatSDInfo, formatSDInfoAsMessages } from './formatter'

export const name = 'sd-inspector'

export interface Config {
  commandName?: string
  autoReply?: boolean
  useForward?: boolean
  debug?: boolean
}

export const usage = `
# 🎨 sd-inspector 插件
基于stable-diffusion-inspector项目[GitHub 仓库](https://github.com/Akegarasu/stable-diffusion-inspector)开发。
从 Stable Diffusion 生成的图片中读取 pnginfo 来获取生成的参数 / Stable Diffusion 模型类别解析。
### ✨ 核心亮点
适配[hhs-huatu](https://github.com/hhs2275/koishi-plugin-hhs-huatu)插件角色提示词表达格式，支持识别 NAI-V3 / V4 / V4.5 / V5（含 V5 Full 局部重绘）。
`

export const Config: Schema<Config> = Schema.object({
  commandName: Schema.string().default('sdinfo').description('命令名称'),
  autoReply: Schema.boolean().default(false).description('是否自动回复所有图片（不需要命令触发）'),
  useForward: Schema.boolean().default(true).description('使用转发消息发送结果（避免刷屏和超字数限制）'),
  debug: Schema.boolean().default(false).description('启用调试日志（用于排查问题）'),
})

// 下载图片函数（使用 Koishi 全局 HTTP 配置）
async function downloadImage(ctx: Context, url: string): Promise<Buffer> {
  try {
    const response = await ctx.http(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      // 不设置 proxyAgent，让 Koishi 处理代理
    } as any)
    // 某些 Koishi 版本返回的是原始数据而不是 { data }
    const data = (response && (response as any).data !== undefined) ? (response as any).data : response
    return Buffer.from(data)
  } catch (error) {
    ctx.logger('sd-inspector').error('下载图片失败:', error)
    throw error
  }
}

type ImageOutcome =
  | { kind: 'ok'; result: ParsedResult; chunks: PngChunk[] }
  | { kind: 'not-png' }
  | { kind: 'no-data' }
  | { kind: 'parse-failed' }
  | { kind: 'error'; error: unknown }

export function apply(ctx: Context, config: Config) {
  const { commandName = 'sdinfo', autoReply = false, useForward = true, debug = false } = config

  const base = ctx.logger('sd-inspector')
  // 解析层只通过该日志接口输出，debug 关闭时 info/debug 静默、error 始终输出
  const log: Logger = {
    info: (format, ...args) => { if (debug) base.info(format, ...args) },
    debug: (format, ...args) => { if (debug) base.debug(format, ...args) },
    error: (format, ...args) => base.error(format, ...args),
  }

  // 等待图片的用户会话状态
  const waitingForImage = new Map<string, { userId: string; channelId: string; timestamp: number }>()
  const pendingTimers = new Set<NodeJS.Timeout>()

  // 下载并解析图片，命令与自动回复共用同一条管线
  async function analyzeRemoteImage(imgUrl: string): Promise<ImageOutcome> {
    try {
      const buffer = await downloadImage(ctx, imgUrl)
      if (!isPngBuffer(buffer)) return { kind: 'not-png' }
      return await analyzeImage(buffer, log)
    } catch (error) {
      return { kind: 'error', error }
    }
  }

  function buildResultMessage(result: ParsedResult, chunks: PngChunk[]) {
    if (useForward) {
      const messages = formatSDInfoAsMessages(result, chunks)
      const forwardNodes = messages.map(msg => h('message', {}, msg))
      return h('message', { forward: true }, forwardNodes)
    }
    return formatSDInfo(result, chunks)
  }

  function buildParseFailedMessage() {
    if (useForward) {
      const messages = ['📷 SD 图片参数信息', '❌ 解析失败']
      return h('message', { forward: true }, messages.map(msg => h('message', {}, msg)))
    }
    return 'SD 图片参数信息：\n\n解析失败'
  }

  // 注册命令
  ctx.command(`${commandName} [image:text]`, '解析 Stable Diffusion 图片的生成参数')
    .usage('发送图片并使用此命令，或引用包含图片的消息')
    .example(`${commandName} [图片]`)
    .action(async ({ session }, imageUrl) => {
      if (!session) return '无法获取会话信息'

      // 从消息中提取图片
      const images = h.select(session.elements, 'img')

      // 如果命令参数中有图片
      if (imageUrl) {
        const imgElements = h.parse(imageUrl)
        const imgFromArg = h.select(imgElements, 'img')
        if (imgFromArg.length > 0) {
          images.push(...imgFromArg)
        }
      }

      // 检查是否有引用的消息
      if (images.length === 0 && session.quote) {
        const quotedImages = h.select(session.quote.elements, 'img')
        images.push(...quotedImages)
      }

      if (images.length === 0) {
        // 设置等待图片状态
        const sessionKey = `${session.userId}:${session.channelId}`
        waitingForImage.set(sessionKey, {
          userId: session.userId,
          channelId: session.channelId,
          timestamp: Date.now(),
        })

        // 1 分钟后自动清除等待状态并发送提示
        const timer = setTimeout(async () => {
          pendingTimers.delete(timer)
          if (waitingForImage.has(sessionKey)) {
            waitingForImage.delete(sessionKey)
            await session.send('⏱️ 等待图片超时，已取消解析请求')
          }
        }, 60 * 1000)
        pendingTimers.add(timer)

        return '✅ 请在60s内发送要解析的图片'
      }

      // 解析第一张图片
      const imgUrl = images[0].attrs.src || images[0].attrs.url
      if (!imgUrl) {
        return '❌ 无法获取图片 URL'
      }

      const outcome = await analyzeRemoteImage(imgUrl)
      switch (outcome.kind) {
        case 'ok':
          return buildResultMessage(outcome.result, outcome.chunks)
        case 'not-png':
          return '❌ 该图片不是 PNG 格式，无法读取 SD 参数'
        case 'no-data':
          return '❌ 该图片不包含 Stable Diffusion 生成参数\n提示：只有 PNG 格式且包含元数据的图片才能解析'
        case 'parse-failed':
          return buildParseFailedMessage()
        case 'error':
          base.error('处理图片失败:', outcome.error)
          return `❌ 处理图片时出错：${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
      }
    })

  // 消息监听器 - 处理自动回复和等待图片状态
  ctx.on('message', async (session) => {
    const images = h.select(session.elements, 'img')

    // 检查是否有用户在等待发送图片
    const sessionKey = `${session.userId}:${session.channelId}`
    const isWaitingForImage = waitingForImage.has(sessionKey)

    // 如果用户在等待状态但发送的不是图片，提醒并结束等待
    if (isWaitingForImage && images.length === 0) {
      waitingForImage.delete(sessionKey)
      await session.send('❌ 未检测到图片，已取消解析请求。请重新发送命令后再发送图片。')
      return
    }

    // 如果没有图片且不是等待状态，则跳过
    if (images.length === 0) {
      return
    }

    // 如果不是自动回复模式且用户不在等待状态，则跳过
    if (!autoReply && !isWaitingForImage) {
      return
    }

    // 如果用户在等待状态，清除等待状态
    if (isWaitingForImage) {
      waitingForImage.delete(sessionKey)
    }

    const imgUrl = images[0].attrs.src || images[0].attrs.url
    if (!imgUrl) return

    const outcome = await analyzeRemoteImage(imgUrl)
    switch (outcome.kind) {
      case 'ok':
        await session.send(buildResultMessage(outcome.result, outcome.chunks))
        break
      case 'not-png':
        if (isWaitingForImage) {
          await session.send('❌ 该图片不是 PNG 格式，无法读取 SD 参数')
        }
        break
      case 'no-data':
        if (isWaitingForImage) {
          await session.send('❌ 该图片不包含 Stable Diffusion 生成参数\n提示：只有 PNG 格式且包含元数据的图片才能解析')
        }
        break
      case 'parse-failed':
        // 与原实现一致：格式化异常时也发送占位消息
        await session.send(buildParseFailedMessage())
        break
      case 'error':
        log.debug('处理图片失败:', outcome.error)
        break
    }
  })

  // 插件卸载时清理等待状态和定时器
  ctx.on('dispose', () => {
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.clear()
    waitingForImage.clear()
  })
}
