import { Context, Schema, h } from 'koishi'
import extract from 'png-chunks-extract'
import text from 'png-chunk-text'
import ExifReader from 'exifreader'
import pako from 'pako'

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
适配[hhs-huatu](https://github.com/hhs2275/koishi-plugin-hhs-huatu)插件角色提示词表达格式。
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

// === Stealth PNG 隐写解析 ===

class DataReader {
  data: number[]
  index: number

  constructor(data: number[]) {
    this.data = data
    this.index = 0
  }

  readBit(): number {
    return this.data[this.index++]
  }

  readByte(): number {
    let byte = 0
    for (let i = 0; i < 8; i++) {
      byte |= this.readBit() << (7 - i)
    }
    return byte
  }

  readNBytes(n: number): number[] {
    const bytes: number[] = []
    for (let i = 0; i < n; i++) {
      bytes.push(this.readByte())
    }
    return bytes
  }

  readInt32(): number {
    const bytes = this.readNBytes(4)
    return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  }
}

// 从 PNG buffer 解析 stealth 隐写数据（NovelAI 风格）
// 原理：元数据被编码到每个像素的 alpha 通道最低位 (LSB) 中
async function parseStealthPng(imageBuffer: Buffer): Promise<any | null> {
  try {
    const chunks = extract(imageBuffer)

    // 1. 解析 IHDR 获取图片尺寸和颜色类型
    const ihdrChunk = chunks.find(c => c.name === 'IHDR')
    if (!ihdrChunk) return null

    const ihdrData = ihdrChunk.data
    const width = (ihdrData[0] << 24 | ihdrData[1] << 16 | ihdrData[2] << 8 | ihdrData[3]) >>> 0
    const height = (ihdrData[4] << 24 | ihdrData[5] << 16 | ihdrData[6] << 8 | ihdrData[7]) >>> 0
    const bitDepth = ihdrData[8]
    const colorType = ihdrData[9]

    // stealth PNG 需要 alpha 通道：colorType 4 (灰度+alpha) 或 6 (RGBA)
    if (colorType !== 4 && colorType !== 6) return null

    // 2. 合并并解压所有 IDAT chunks
    const idatChunks = chunks.filter(c => c.name === 'IDAT')
    if (idatChunks.length === 0) return null

    const totalLength = idatChunks.reduce((sum, c) => sum + c.data.length, 0)
    const compressedData = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of idatChunks) {
      compressedData.set(chunk.data, offset)
      offset += chunk.data.length
    }

    const rawData = pako.inflate(compressedData)

    // 3. 从解压后的 scanline 数据中提取 alpha 通道 LSB
    // PNG scanline 格式：每行以 1 字节 filter type 开头，后跟像素数据
    const bytesPerPixel = colorType === 6 ? 4 : 2 // RGBA=4, GA=2
    const channels = colorType === 6 ? 4 : 2
    const alphaOffset = channels - 1 // alpha 是最后一个通道
    const bytesPerRow = 1 + width * bytesPerPixel * (bitDepth / 8)

    // 只支持 8-bit 深度（最常见）
    if (bitDepth !== 8) return null

    // 反 filter 还原像素值
    const pixels = new Uint8Array(width * height * channels)
    const prevRow = new Uint8Array(width * channels)
    prevRow.fill(0)

    for (let y = 0; y < height; y++) {
      const rowStart = y * bytesPerRow
      const filterType = rawData[rowStart]
      const rowData = rawData.slice(rowStart + 1, rowStart + bytesPerRow)

      const currentRow = new Uint8Array(width * channels)
      for (let i = 0; i < width * channels; i++) {
        const raw = rowData[i]
        const a = i >= channels ? currentRow[i - channels] : 0
        const b = prevRow[i]
        const c = i >= channels ? prevRow[i - channels] : 0

        switch (filterType) {
          case 0: currentRow[i] = raw; break
          case 1: currentRow[i] = (raw + a) & 0xFF; break
          case 2: currentRow[i] = (raw + b) & 0xFF; break
          case 3: currentRow[i] = (raw + Math.floor((a + b) / 2)) & 0xFF; break
          case 4: currentRow[i] = (raw + paethPredictor(a, b, c)) & 0xFF; break
          default: currentRow[i] = raw; break
        }
      }

      pixels.set(currentRow, y * width * channels)
      prevRow.set(currentRow)
    }

    // 4. 按列优先（x 外层、y 内层）提取 alpha LSB — 与开源项目一致
    const lowestData: number[] = []
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const idx = (y * width + x) * channels + alphaOffset
        lowestData.push(pixels[idx] & 1)
      }
    }

    // 5. 检查魔法字符串
    const magic = 'stealth_pngcomp'
    const reader = new DataReader(lowestData)
    const readMagic = reader.readNBytes(magic.length)
    const magicString = String.fromCharCode(...readMagic)

    if (magic !== magicString) return null

    // 6. 读取数据长度并解压
    const dataLength = reader.readInt32()
    const gzipData = reader.readNBytes(dataLength / 8)
    const data = pako.ungzip(new Uint8Array(gzipData))
    const jsonString = new TextDecoder().decode(new Uint8Array(data))
    const json = JSON.parse(jsonString)
    return json
  } catch {
    return null
  }
}

// PNG Paeth 滤镜预测函数
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function apply(ctx: Context, config: Config) {
  const { commandName = 'sdinfo', autoReply = false, useForward = true, debug = false } = config

  // 等待图片的用户会话状态
  const waitingForImage = new Map<string, { userId: string, channelId: string, timestamp: number }>()

  // NovelAI 模型映射
  const novelAIModels: Record<string, {name: string, cmd: string}> = {
    '7BCCAA2C': {name: 'NAI-V3 (Stable Diffusion XL)', cmd: 'nai'},
    '1120E6A9': {name: 'NAI-V3 (Stable Diffusion XL 局部重绘)', cmd: 'nai'},
    '37C2B166': {name: 'NAI-V3-Furry (Stable Diffusion XL)', cmd: 'nai -m furry'},
    'F306816B': {name: 'NAI-V3-Furry (Stable Diffusion XL 局部重绘)', cmd: 'nai -m furry'},
    '7ABFFA2A': {name: 'NAI-V4-Curated-Preview', cmd: 'nai4c'},
    '770A9E12': {name: 'NAI-V4-Curated-Preview (局部重绘)', cmd: 'nai4c'},
    '37442FCA': {name: 'NAI-V4-Full (NovelAI Diffusion V4)', cmd: 'nai4'},
    'F6302A9D': {name: 'NAI-V4-Full (局部重绘)', cmd: 'nai4'},
    'C02D4F98': {name: 'NAI-V4.5-Curated', cmd: 'nai4-5c'},
    '5BB76870': {name: 'NAI-V4.5-Curated (局部重绘)', cmd: 'nai4-5c'},
    '4BDE2A90': {name: 'NAI-V4.5-Full (NovelAI Diffusion 4.5)', cmd: 'nai4-5'},
    '1229B44F': {name: 'NAI-V4.5-Full (局部重绘)', cmd: 'nai4-5'},
  }

  // 识别 NovelAI 模型
  function identifyNovelAIModel(source?: string): {name: string, cmd: string} | null {
    if (!source) return null

    for (const [hash, modelObj] of Object.entries(novelAIModels)) {
      if (source.includes(hash)) {
        return modelObj
      }
    }
    return null
  }

  // 识别生成类型
  function identifyGenerationType(jsonData: any): string {
    const requestType = jsonData.request_type || ''
    const hasVibeTransfer = jsonData.reference_strength_multiple?.length > 0
    const hasPreciseRef = jsonData.director_reference_images?.length > 0

    const types = []
    if (requestType === 'NativeInfillingRequest') types.push('局部重绘 (Inpainting)')
    else if (requestType === 'Img2ImgRequest') types.push('图生图 (Img2Img)')
    else types.push('文生图 (Text2Img)')

    if (hasPreciseRef) types.push('精准参考 (Precise Ref)')
    if (hasVibeTransfer) types.push('氛围转移 (Vibe Transfer)')

    return types.join(' + ')
  }

  // 生成 hhs-huatu 绘图指令
  function generateHhsHuatuCommand(jsonData: any, source: string, prompt: string, characterPrompts: string, negativePrompt: string): string {
    let cmdBase = 'nai'
    if (source) {
      const modelObj = identifyNovelAIModel(source)
      if (modelObj) {
        cmdBase = modelObj.cmd
      }
    }

    let opts: string[] = []
    if (jsonData.steps) opts.push(`-t ${jsonData.steps}`)
    
    if (jsonData.width && jsonData.height) {
      let res = 'square'
      if (jsonData.width < jsonData.height) res = 'portrait'
      else if (jsonData.width > jsonData.height) res = 'landscape'
      opts.push(`-r ${res}`)
    }

    if (jsonData.scale !== undefined) opts.push(`-c ${jsonData.scale}`)
    if (jsonData.seed !== undefined) opts.push(`-x ${jsonData.seed}`)
    if (jsonData.sampler) {
      let s = jsonData.sampler
      if (s === 'k_euler_ancestral') s = 'k_euler_a'
      opts.push(`-s ${s}`)
    }
    if (jsonData.noise_schedule) opts.push(`-C ${jsonData.noise_schedule}`)
    if (jsonData.sm === true) opts.push(`-S`)
    if (jsonData.sm_dyn === true) opts.push(`-d`)
    if (jsonData.dynamic_thresholding === true) opts.push(`-D`)
    if (jsonData.cfg_rescale !== undefined) opts.push(`-R ${jsonData.cfg_rescale}`)
    if (jsonData.strength !== undefined) opts.push(`-N ${jsonData.strength}`)
    if (jsonData.noise !== undefined) opts.push(`-n ${jsonData.noise}`)
    if (jsonData.skip_cfg_above_sigma !== undefined && jsonData.skip_cfg_above_sigma !== null && jsonData.skip_cfg_above_sigma !== 'null') opts.push(`-v ${jsonData.skip_cfg_above_sigma}`)

    const requestType = jsonData.request_type || ''
    if (requestType === 'NativeInfillingRequest') {
      opts.push(`-M`)
    }

    if (jsonData.director_reference_images && jsonData.director_reference_images.length > 0) {
      opts.push(`-P`)
      const preciseRefs: string[] = []
      for (let i = 0; i < jsonData.director_reference_images.length; i++) {
        let modeStr = ''
        if (jsonData.director_reference_descriptions && jsonData.director_reference_descriptions[i] && jsonData.director_reference_descriptions[i].caption) {
           modeStr = jsonData.director_reference_descriptions[i].caption.base_caption || ''
        }
        let mode = 'cs'
        if (modeStr.includes('character&style') || modeStr.includes('character and style')) mode = 'cs'
        else if (modeStr.includes('character')) mode = 'c'
        else if (modeStr.includes('style')) mode = 's'
        
        let strength = jsonData.director_reference_strengths?.[i] ?? 1
        let fidelity = jsonData.director_reference_information_extracted?.[i] ?? 1
        
        preciseRefs.push(`${mode},${strength},${fidelity}`)
      }
      if (preciseRefs.length > 0) {
        opts.push(`-p "${preciseRefs.join(';')}"`)
      }
    }

    let commandStr = `${cmdBase} -O ${opts.join(' ')}\n\n"${prompt || ''}"`
    if (characterPrompts) {
      commandStr += `\n\n-K "${characterPrompts}"`
    }
    if (negativePrompt) {
      commandStr += `\n\n-u "${negativePrompt}"`
    }

    return commandStr
  }

  // 坐标转换为位置标识
  function coordsToPosition(x: number, y: number): string {
    // X 轴映射：0.1=A, 0.3=B, 0.5=C, 0.7=D, 0.9=E
    const xMap: Record<string, string> = {
      '0.1': 'A', '0.3': 'B', '0.5': 'C', '0.7': 'D', '0.9': 'E'
    }
    // Y 轴映射：0.1=1, 0.3=2, 0.5=3, 0.7=4, 0.9=5
    const yMap: Record<string, string> = {
      '0.1': '1', '0.3': '2', '0.5': '3', '0.7': '4', '0.9': '5'
    }

    const xKey = x.toFixed(1)
    const yKey = y.toFixed(1)
    const xPos = xMap[xKey] || `x${x}`
    const yPos = yMap[yKey] || `y${y}`

    return `${xPos}${yPos}`
  }

  // 解析 V4 角色提示词
  function parseV4CharacterPrompts(jsonData: any, useCoords: boolean = true): string | null {
    const v4Prompt = jsonData.v4_prompt
    const v4NegPrompt = jsonData.v4_negative_prompt

    if (!v4Prompt?.caption?.char_captions || v4Prompt.caption.char_captions.length === 0) {
      return null
    }

    const characters: string[] = []

    for (let i = 0; i < v4Prompt.caption.char_captions.length; i++) {
      const charData = v4Prompt.caption.char_captions[i]
      const charCaption = charData.char_caption || ''

      if (!charCaption) continue

      // 获取位置（仅在 useCoords 为 true 时）
      let position = ''
      if (useCoords && charData.centers && charData.centers.length > 0) {
        const center = charData.centers[0]
        position = coordsToPosition(center.x, center.y)
      }

      // 获取对应的负面提示词
      let negCaption = ''
      if (v4NegPrompt?.caption?.char_captions?.[i]?.char_caption) {
        negCaption = v4NegPrompt.caption.char_captions[i].char_caption
      }

      // 组合格式
      let charStr = charCaption
      if (position) {
        charStr += `@${position}`
      }
      if (negCaption) {
        charStr += ` --uc:${negCaption}`
      }

      characters.push(charStr)
    }

    return characters.length > 0 ? characters.join('; ') : null
  }

  // 解析 PNG 图片的元数据
  async function parsePngInfo(imageBuffer: Buffer): Promise<any> {
    try {
      const chunks = extract(imageBuffer)
      const textChunks: any[] = []

      if (debug) ctx.logger('sd-inspector').info(`PNG chunks 总数: ${chunks.length}`)

      // 统计 chunk 类型
      if (debug) {
        const chunkTypes = chunks.map(c => c.name)
        ctx.logger('sd-inspector').info(`Chunk 类型: ${[...new Set(chunkTypes)].join(', ')}`)
      }

      // 查找包含 SD 参数的文本块
      for (const chunk of chunks) {
        if (chunk.name === 'tEXt') {
          try {
            const textData = text.decode(chunk.data)
            if (debug) ctx.logger('sd-inspector').info(`找到 tEXt chunk, keyword: ${textData.keyword}`)
            textChunks.push(textData)
          } catch (err) {
            if (debug) ctx.logger('sd-inspector').debug('tEXt chunk 解析失败:', err)
          }
        } else if (chunk.name === 'iTXt') {
          // iTXt 可能包含 NULL 字符，需要特殊处理
          try {
            const data = chunk.data.filter((x: number) => x !== 0x00)
            const header = new TextDecoder().decode(data.slice(0, 11))

            if (debug) ctx.logger('sd-inspector').info(`找到 iTXt chunk, header: ${header}`)

            if (header === 'Description') {
              const txt = new TextDecoder().decode(data.slice(11))
              textChunks.push({
                keyword: 'Description',
                text: txt,
              })
              if (debug) ctx.logger('sd-inspector').info(`Description 内容长度: ${txt.length}`)
            } else {
              // 尝试完整解析
              const txt = new TextDecoder().decode(data)
              textChunks.push({
                keyword: 'Comment',
                text: txt,
              })
              if (debug) ctx.logger('sd-inspector').info(`Comment 内容长度: ${txt.length}`)
            }
          } catch (err) {
            if (debug) ctx.logger('sd-inspector').info('iTXt chunk 解析失败:', err.message)
          }
        }
      }

      if (debug) ctx.logger('sd-inspector').info(`解析到 ${textChunks.length} 个文本 chunks`)

      return textChunks.length > 0 ? textChunks : null
    } catch (error) {
      ctx.logger('sd-inspector').error('解析图片失败:', error)
      return null
    }
  }

  // 解析 WebUI 格式的参数
  function parseWebUiFormat(text: string) {
    // 移除可能存在的 "parameters" 前缀
    let cleanText = text
    if (text.trim().toLowerCase().startsWith('parameters')) {
      cleanText = text.replace(/^parameters/i, '').trim()
    }

    const [prompts, otherParas] = cleanText.split('Steps: ')
    const promptSplit = prompts.split('Negative prompt: ')
    const negativePrompt = promptSplit.length > 1 ? promptSplit[1].trim() : ''

    return {
      prompt: promptSplit[0].trim(),
      negativePrompt,
      params: otherParas ? 'Steps: ' + otherParas.trim() : '',
    }
  }

  // 格式化输出结果为消息数组
  function formatSDInfoAsMessages(chunks: any[], exifData?: any): string[] {
    const messages: string[] = []

    try {
      let prompt = ''
      let negativePrompt = ''
      let params = ''
      let modelInfo = ''
      let generationType = ''
      let software = ''
      let characterPrompts = ''
      let rawComment = ''
      let isNovelAI = false
      let huatuCommand = ''
      let source = ''

      // 从 EXIF 读取基本信息
      if (exifData) {
        // 调试日志 - 显示所有可用的 EXIF 字段
        if (debug) {
          const exifKeys = Object.keys(exifData)
          ctx.logger('sd-inspector').info('EXIF 可用字段:', exifKeys.join(', '))
        }

        // PNG 文本信息存储在 pngText 字段下
        const pngText = exifData.pngText || exifData.png || {}

        if (debug && pngText && Object.keys(pngText).length > 0) {
          ctx.logger('sd-inspector').info('pngText 字段:', Object.keys(pngText).join(', '))
        }

        // 尝试多种路径访问 EXIF 数据
        software = pngText.Software?.description ||
          pngText.Software?.value ||
          exifData.Software?.description ||
          exifData.Software?.value ||
          ''

        source = pngText.Source?.description ||
          pngText.Source?.value ||
          exifData.Source?.description ||
          exifData.Source?.value ||
          ''

        if (debug) {
          ctx.logger('sd-inspector').info('读取到 Software:', software || '(空)')
          ctx.logger('sd-inspector').info('读取到 Source:', source || '(空)')
        }

        if (source) {
          const model = identifyNovelAIModel(source)
          if (model) {
            modelInfo = model.name
            if (debug) ctx.logger('sd-inspector').info('✅ 识别到 NovelAI 模型:', model.name)
          } else {
            if (debug) ctx.logger('sd-inspector').info('❌ NovelAI 模型哈希未识别:', source)
          }
        } else {
          if (debug) ctx.logger('sd-inspector').info('无 Source 字段，无法判断 NovelAI 模型')
        }
      } else {
        if (debug) ctx.logger('sd-inspector').info('EXIF 数据为空')
      }
      // 如果 EXIF 没有提取到 Source，尝试从 tEXt/iTXt chunk 中提取
      if (!source) {
        for (const chunk of chunks) {
          if (chunk.keyword === 'Source' && chunk.text) {
            source = chunk.text
            const model = identifyNovelAIModel(source)
            if (model) {
              modelInfo = model.name
              if (debug) ctx.logger('sd-inspector').info('✅ 从 Chunk 识别到 NovelAI 模型:', model.name)
            }
            break
          }
        }
      }

      // 遍历所有 chunks
      for (const chunk of chunks) {
        const keyword = chunk.keyword || ''
        const text = chunk.text || ''

        // 优先检查是否是 SD WebUI 格式（通过文本内容特征判断）
        // WebUI 格式特征：包含 "Negative prompt:" 或同时包含换行和 "Steps:"
        if (text.includes('Negative prompt:') || (text.includes('\n') && text.includes('Steps: '))) {
          const parsed = parseWebUiFormat(text)
          prompt = parsed.prompt
          negativePrompt = parsed.negativePrompt
          params = parsed.params
          break
        }

        // 检查是否是 NovelAI JSON 格式
        if (keyword === 'Comment') {
          rawComment = text
        }
        if (keyword === 'Description' || keyword === 'Comment') {
          try {
            const jsonData = JSON.parse(text)

            // NovelAI 格式
            if (jsonData.prompt || jsonData.uc || jsonData.v4_prompt) {
              isNovelAI = true
              // 检查是否为 V4+ 角色提示词格式
              const useCoords = jsonData.v4_prompt?.use_coords || false
              const v4CharPrompts = parseV4CharacterPrompts(jsonData, useCoords)

              if (v4CharPrompts) {
                // V4+ 格式：使用基础提示词，角色提示词单独保存
                const baseCaption = jsonData.v4_prompt?.caption?.base_caption || jsonData.prompt || ''
                const baseNegCaption = jsonData.v4_negative_prompt?.caption?.base_caption || jsonData.uc || ''

                prompt = baseCaption
                characterPrompts = v4CharPrompts
                negativePrompt = baseNegCaption
              } else {
                // 传统格式
                prompt = jsonData.prompt || ''
                negativePrompt = jsonData.uc || ''
              }

              // 识别生成类型
              generationType = identifyGenerationType(jsonData)
              
              // 生成推测指令
              huatuCommand = generateHhsHuatuCommand(jsonData, source, prompt, characterPrompts, negativePrompt)

              // 提取主要参数
              const paramsList: string[] = []
              if (jsonData.steps) paramsList.push(`Steps: ${jsonData.steps}`)
              if (jsonData.sampler) paramsList.push(`Sampler: ${jsonData.sampler}`)
              if (jsonData.scale !== undefined) paramsList.push(`CFG scale: ${jsonData.scale}`)
              if (jsonData.seed) paramsList.push(`Seed: ${jsonData.seed}`)
              if (jsonData.width && jsonData.height) paramsList.push(`Size: ${jsonData.width}x${jsonData.height}`)
              if (jsonData.noise_schedule) paramsList.push(`Noise schedule: ${jsonData.noise_schedule}`)

              // V4 特性标记
              if (jsonData.v4_prompt) {
                const useCoordsDisplay = jsonData.v4_prompt.use_coords ? '✓' : '✗'
                const useOrder = jsonData.v4_prompt.use_order ? '✓' : '✗'
                paramsList.push(`V4特性: 坐标${useCoordsDisplay} 顺序${useOrder}`)
              }

              // 氛围转移信息
              if (jsonData.reference_strength_multiple?.length > 0) {
                const strength = jsonData.reference_strength_multiple[0]
                paramsList.push(`Vibe Transfer strength: ${strength}`)
              }

              params = paramsList.join(', ')
              break
            }
          } catch {
            // 不是 JSON，继续尝试其他格式
          }
        }

        // 其他格式
        if (keyword === 'prompt' || keyword === '提示词') {
          prompt = text
        } else if (keyword === 'negative prompt' || keyword === '负面提示词') {
          negativePrompt = text
        }
      }

      // 构建消息数组
      messages.push('📷 SD 图片参数信息')

      if (modelInfo) messages.push(`🤖 模型：${modelInfo}`)
      if (generationType) messages.push(`📝 类型：${generationType}`)
      if (prompt) messages.push(`🎨 正向提示词：\n${prompt}`)
      if (characterPrompts) messages.push(`👥 角色提示词：\n"${characterPrompts}"`)
      if (negativePrompt) messages.push(`🚫 负向提示词：\n${negativePrompt}`)
      if (params) messages.push(`⚙️ 生成参数：\n${params}`)
      if (isNovelAI && huatuCommand) messages.push(`💻 hhs-huatu 推测指令：\n${huatuCommand}`)
      if (isNovelAI && rawComment) messages.push(`📋 Comment 原始数据：\n${rawComment}`)

      // 如果没有成功解析任何内容
      if (!prompt && !negativePrompt && !params) {
        messages.push('❌ 未能识别标准格式')
        for (const chunk of chunks) {
          if (chunk.text) {
            messages.push(`${chunk.keyword}: ${chunk.text.substring(0, 200)}...`)
          }
        }
      }

      return messages
    } catch (error) {
      ctx.logger('sd-inspector').error('格式化失败:', error)
      return ['📷 SD 图片参数信息', '❌ 解析失败']
    }
  }

  // 格式化输出结果（兼容旧版单条消息）
  function formatSDInfo(chunks: any[], exifData?: any): string {
    try {
      let result = 'SD 图片参数信息：\n\n'
      let prompt = ''
      let negativePrompt = ''
      let params = ''
      let modelInfo = ''
      let generationType = ''
      let software = ''
      let characterPrompts = ''
      let rawComment = ''
      let isNovelAI = false
      let huatuCommand = ''
      let source = ''

      // 从 EXIF 读取基本信息
      if (exifData) {
        // 调试日志 - 显示所有可用的 EXIF 字段
        if (debug) {
          const exifKeys = Object.keys(exifData)
          ctx.logger('sd-inspector').info('EXIF 可用字段:', exifKeys.join(', '))
        }

        // PNG 文本信息存储在 pngText 字段下
        const pngText = exifData.pngText || exifData.png || {}

        if (debug && pngText && Object.keys(pngText).length > 0) {
          ctx.logger('sd-inspector').info('pngText 字段:', Object.keys(pngText).join(', '))
        }

        // 尝试多种路径访问 EXIF 数据
        software = pngText.Software?.description ||
          pngText.Software?.value ||
          exifData.Software?.description ||
          exifData.Software?.value ||
          ''

        source = pngText.Source?.description ||
          pngText.Source?.value ||
          exifData.Source?.description ||
          exifData.Source?.value ||
          ''

        if (debug) {
          ctx.logger('sd-inspector').info('读取到 Software:', software || '(空)')
          ctx.logger('sd-inspector').info('读取到 Source:', source || '(空)')
        }

        if (source) {
          const model = identifyNovelAIModel(source)
          if (model) {
            modelInfo = model.name
            if (debug) ctx.logger('sd-inspector').info('✅ 识别到 NovelAI 模型:', model.name)
          } else {
            if (debug) ctx.logger('sd-inspector').info('❌ NovelAI 模型哈希未识别:', source)
          }
        } else {
          if (debug) ctx.logger('sd-inspector').info('无 Source 字段，无法判断 NovelAI 模型')
        }
      } else {
        if (debug) ctx.logger('sd-inspector').info('EXIF 数据为空')
      }
      // 如果 EXIF 没有提取到 Source，尝试从 tEXt/iTXt chunk 中提取
      if (!source) {
        for (const chunk of chunks) {
          if (chunk.keyword === 'Source' && chunk.text) {
            source = chunk.text
            const model = identifyNovelAIModel(source)
            if (model) {
              modelInfo = model.name
              if (debug) ctx.logger('sd-inspector').info('✅ 从 Chunk 识别到 NovelAI 模型:', model.name)
            }
            break
          }
        }
      }

      // 遍历所有 chunks
      for (const chunk of chunks) {
        const keyword = chunk.keyword || ''
        const text = chunk.text || ''

        // 优先检查是否是 SD WebUI 格式（通过文本内容特征判断）
        // WebUI 格式特征：包含 "Negative prompt:" 或同时包含换行和 "Steps:"
        if (text.includes('Negative prompt:') || (text.includes('\n') && text.includes('Steps: '))) {
          const parsed = parseWebUiFormat(text)
          prompt = parsed.prompt
          negativePrompt = parsed.negativePrompt
          params = parsed.params
          break
        }

        // 检查是否是 NovelAI JSON 格式
        if (keyword === 'Comment') {
          rawComment = text
        }
        if (keyword === 'Description' || keyword === 'Comment') {
          try {
            const jsonData = JSON.parse(text)

            // NovelAI 格式
            if (jsonData.prompt || jsonData.uc || jsonData.v4_prompt) {
              isNovelAI = true
              // 检查是否为 V4+ 角色提示词格式
              const useCoords = jsonData.v4_prompt?.use_coords || false
              const v4CharPrompts = parseV4CharacterPrompts(jsonData, useCoords)

              if (v4CharPrompts) {
                // V4+ 格式：使用基础提示词，角色提示词单独保存
                const baseCaption = jsonData.v4_prompt?.caption?.base_caption || jsonData.prompt || ''
                const baseNegCaption = jsonData.v4_negative_prompt?.caption?.base_caption || jsonData.uc || ''

                prompt = baseCaption
                characterPrompts = v4CharPrompts
                negativePrompt = baseNegCaption
              } else {
                // 传统格式
                prompt = jsonData.prompt || ''
                negativePrompt = jsonData.uc || ''
              }

              // 识别生成类型
              generationType = identifyGenerationType(jsonData)

              // 生成推测指令
              huatuCommand = generateHhsHuatuCommand(jsonData, source, prompt, characterPrompts, negativePrompt)

              // 提取主要参数
              const paramsList: string[] = []
              if (jsonData.steps) paramsList.push(`Steps: ${jsonData.steps}`)
              if (jsonData.sampler) paramsList.push(`Sampler: ${jsonData.sampler}`)
              if (jsonData.scale !== undefined) paramsList.push(`CFG scale: ${jsonData.scale}`)
              if (jsonData.seed) paramsList.push(`Seed: ${jsonData.seed}`)
              if (jsonData.width && jsonData.height) paramsList.push(`Size: ${jsonData.width}x${jsonData.height}`)
              if (jsonData.noise_schedule) paramsList.push(`Noise schedule: ${jsonData.noise_schedule}`)

              // V4 特性标记
              if (jsonData.v4_prompt) {
                const useCoordsDisplay = jsonData.v4_prompt.use_coords ? '✓' : '✗'
                const useOrder = jsonData.v4_prompt.use_order ? '✓' : '✗'
                paramsList.push(`V4特性: 坐标${useCoordsDisplay} 顺序${useOrder}`)
              }

              // 氛围转移信息
              if (jsonData.reference_strength_multiple?.length > 0) {
                const strength = jsonData.reference_strength_multiple[0]
                paramsList.push(`Vibe Transfer strength: ${strength}`)
              }

              params = paramsList.join(', ')
              break
            }
          } catch {
            // 不是 JSON，继续尝试其他格式
          }
        }

        // 其他格式
        if (keyword === 'prompt' || keyword === '提示词') {
          prompt = text
        } else if (keyword === 'negative prompt' || keyword === '负面提示词') {
          negativePrompt = text
        }
      }

      // 构建输出
      if (modelInfo) result += ` 模型：${modelInfo}\n\n`
      if (generationType) result += ` 类型：${generationType}\n\n`
      if (prompt) result += ` 正向提示词：\n${prompt}\n\n`
      if (characterPrompts) result += `👥 角色提示词：\n"${characterPrompts}"\n\n`
      if (negativePrompt) result += `负向提示词：\n${negativePrompt}\n\n`
      if (params) result += ` 生成参数：\n${params}\n`
      if (isNovelAI && huatuCommand) result += `\n💻 hhs-huatu 推测指令：\n${huatuCommand}\n`
      if (isNovelAI && rawComment) result += `\n📋 Comment 原始数据：\n${rawComment}\n`

      // 如果没有成功解析任何内容，返回原始信息
      if (!prompt && !negativePrompt && !params) {
        result += '未能识别标准格式，原始数据：\n'
        for (const chunk of chunks) {
          result += `${chunk.keyword}: ${chunk.text.substring(0, 200)}...\n\n`
        }
      }

      return result.trim()
    } catch (error) {
      ctx.logger('sd-inspector').error('格式化失败:', error)
      return 'SD 图片参数信息：\n\n解析失败'
    }
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
          timestamp: Date.now()
        })

        // 1分钟后自动清除等待状态并发送提示
        setTimeout(async () => {
          if (waitingForImage.has(sessionKey)) {
            waitingForImage.delete(sessionKey)
            await session.send('⏱️ 等待图片超时，已取消解析请求')
          }
        }, 1 * 60 * 1000)

        return '✅ 请在60s内发送要解析的图片'
      }

      // 解析第一张图片
      const imgUrl = images[0].attrs.src || images[0].attrs.url
      if (!imgUrl) {
        return '❌ 无法获取图片 URL'
      }

      try {
        // 下载图片
        const buffer = await downloadImage(ctx, imgUrl)

        // 检查是否为 PNG 格式
        if (!buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
          return '❌ 该图片不是 PNG 格式，无法读取 SD 参数'
        }

        // 读取 EXIF 数据（尝试两种模式）
        let exifData = null
        let exifDataFlat = null
        try {
          // 先尝试 expanded 模式
          exifData = await ExifReader.load(buffer, { expanded: true })
          if (debug) ctx.logger('sd-inspector').info('成功读取 EXIF (expanded)，字段数:', exifData ? Object.keys(exifData).length : 0)

          // 再读取扁平模式（更容易访问 PNG 文本块）
          exifDataFlat = await ExifReader.load(buffer, { expanded: false })
          if (debug) ctx.logger('sd-inspector').info('成功读取 EXIF (flat)，字段数:', exifDataFlat ? Object.keys(exifDataFlat).length : 0)

          // 检查扁平模式中的字段
          if (debug && exifDataFlat) {
            const flatKeys = Object.keys(exifDataFlat)
            const sdRelatedKeys = flatKeys.filter(k =>
              k === 'Description' || k === 'Comment' || k === 'Software' ||
              k === 'Source' || k === 'Generation_time' || k.includes('prompt')
            )
            if (sdRelatedKeys.length > 0) {
              ctx.logger('sd-inspector').info('在扁平模式中发现 SD 相关字段:', sdRelatedKeys.join(', '))
            }
          }
        } catch (err) {
          if (debug) ctx.logger('sd-inspector').info('读取 EXIF 失败:', err.message)
        }

        // 解析元数据
        let chunks = await parsePngInfo(buffer)

        // 如果普通 chunks 解析为空，尝试 stealth PNG 隐写解析
        if (!chunks || chunks.length === 0) {
          if (debug) ctx.logger('sd-inspector').info('🔍 尝试 Stealth PNG 隐写解析...')
          const stealthData = await parseStealthPng(buffer)
          if (stealthData) {
            if (debug) ctx.logger('sd-inspector').info('✅ Stealth PNG 解析成功')
            // 将 stealth 数据转换为 chunks 格式
            chunks = Object.keys(stealthData).map(key => ({
              keyword: key === 'uc' ? 'Comment' : key,
              text: typeof stealthData[key] === 'string' ? stealthData[key] : JSON.stringify(stealthData[key]),
            }))
            // 同时把完整 JSON 作为 Comment chunk（供 NovelAI 格式解析）
            chunks.unshift({
              keyword: 'Comment',
              text: JSON.stringify(stealthData),
            })
          } else {
            if (debug) ctx.logger('sd-inspector').info('❌ Stealth PNG 解析未找到数据')
          }
        }

        if (debug) {
          ctx.logger('sd-inspector').info(`chunks 状态: ${chunks ? chunks.length : 'null'}`)
          ctx.logger('sd-inspector').info(`exifData 存在: ${!!exifData}`)
          if (exifData) {
            ctx.logger('sd-inspector').info(`exifData 顶层字段: ${Object.keys(exifData).join(', ')}`)
            ctx.logger('sd-inspector').info(`exifData.pngText 存在: ${!!exifData.pngText}`)
            ctx.logger('sd-inspector').info(`exifData.png 存在: ${!!exifData.png}`)
            ctx.logger('sd-inspector').info(`exifData.pngFile 存在: ${!!exifData.pngFile}`)

            // 检查各种可能的位置
            if (exifData.pngText) {
              ctx.logger('sd-inspector').info(`pngText 字段: ${Object.keys(exifData.pngText).join(', ')}`)
            }
            if (exifData.png) {
              ctx.logger('sd-inspector').info(`png 字段: ${Object.keys(exifData.png).join(', ')}`)
            }
            if (exifData.pngFile) {
              ctx.logger('sd-inspector').info(`pngFile 字段: ${Object.keys(exifData.pngFile).join(', ')}`)
            }

            // 调试：输出所有顶层字段的内容预览
            ctx.logger('sd-inspector').info('=== 开始详细调试 ===')
            for (const topKey of Object.keys(exifData)) {
              const topValue = exifData[topKey]
              if (topValue && typeof topValue === 'object' && !Array.isArray(topValue)) {
                ctx.logger('sd-inspector').info(`🔍 检查 exifData.${topKey} 的所有字段:`)
                for (const subKey of Object.keys(topValue)) {
                  const subValue = topValue[subKey]
                  if (subValue && typeof subValue === 'object' && (subValue.description || subValue.value)) {
                    const content = subValue.description || subValue.value
                    const preview = typeof content === 'string' ? content.substring(0, 50) : JSON.stringify(content).substring(0, 50)
                    ctx.logger('sd-inspector').info(`  - ${subKey}: ${preview}...`)
                  }
                }
              }
            }
            ctx.logger('sd-inspector').info('=== 详细调试结束 ===')
          }
        }

        // 如果 PNG chunks 中没有找到，尝试从 EXIF 中提取
        if ((!chunks || chunks.length === 0) && (exifData || exifDataFlat)) {
          if (debug) ctx.logger('sd-inspector').info('🔄 PNG chunks 中未找到数据，尝试从 EXIF 提取')

          // 初始化 chunks 为空数组（如果是 null）
          if (!chunks) {
            chunks = []
          }

          // 优先尝试扁平模式（更直接）
          const possibleSources = [
            exifDataFlat,
            exifData?.pngFile,
            exifData?.pngText,
            exifData?.png,
            exifData
          ]

          for (const pngSource of possibleSources) {
            if (!pngSource || typeof pngSource !== 'object') continue

            // SD 相关的关键字
            const sdKeywords = ['Description', 'Software', 'Source', 'Comment', 'Generation_time', 'Title', 'parameters', 'prompt']

            // 提取 EXIF 中的文本字段
            for (const key of Object.keys(pngSource)) {
              // 只提取 SD 相关字段
              if (!sdKeywords.includes(key)) {
                continue
              }

              const field = pngSource[key]
              if (debug) ctx.logger('sd-inspector').info(`检查 SD 字段: ${key}, 类型: ${typeof field}`)

              // 尝试多种数据结构
              let description = null
              if (field && typeof field === 'object' && field.description) {
                description = field.description
              } else if (field && typeof field === 'object' && field.value) {
                description = field.value
              } else if (typeof field === 'string') {
                description = field
              }

              if (description) {
                chunks.push({
                  keyword: key,
                  text: description
                })
                if (debug) {
                  const preview = typeof description === 'string' ? description.substring(0, 100) : String(description).substring(0, 100)
                  ctx.logger('sd-inspector').info(`✅ 从 EXIF 提取: ${key}, 长度: ${String(description).length}, 预览: ${preview}`)
                }
              }
            }

            if (chunks.length > 0) {
              if (debug) ctx.logger('sd-inspector').info(`EXIF 提取完成，总计 ${chunks.length} 个 SD 字段`)
              break
            }
          }

          if (debug && (!chunks || chunks.length === 0)) {
            ctx.logger('sd-inspector').info(`❌ 未找到 SD 字段`)
          }
        }

        if (!chunks || chunks.length === 0) {
          return '❌ 该图片不包含 Stable Diffusion 生成参数\n提示：只有 PNG 格式且包含元数据的图片才能解析'
        }

        // 根据配置选择发送方式
        if (useForward) {
          const messages = formatSDInfoAsMessages(chunks, exifData)
          // 构建转发消息节点
          const forwardNodes = messages.map(msg => h('message', {}, msg))
          return h('message', { forward: true }, forwardNodes)
        } else {
          return formatSDInfo(chunks, exifData)
        }
      } catch (error) {
        ctx.logger('sd-inspector').error('处理图片失败:', error)
        return `❌ 处理图片时出错：${error.message}`
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

    try {
      const buffer = await downloadImage(ctx, imgUrl)

      // 检查是否为 PNG 格式
      if (!buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
        if (isWaitingForImage) {
          await session.send('❌ 该图片不是 PNG 格式，无法读取 SD 参数')
        }
        return
      }

      // 读取 EXIF 数据
      let exifData = null
      let exifDataFlat = null
      try {
        exifData = await ExifReader.load(buffer, { expanded: true })
        exifDataFlat = await ExifReader.load(buffer, { expanded: false })
        if (debug) ctx.logger('sd-inspector').info('自动模式-成功读取 EXIF')
      } catch (err) {
        if (debug) ctx.logger('sd-inspector').info('自动模式-读取 EXIF 失败:', err.message)
      }

      let chunks = await parsePngInfo(buffer)

      // 如果普通 chunks 解析为空，尝试 stealth PNG 隐写解析
      if (!chunks || chunks.length === 0) {
        if (debug) ctx.logger('sd-inspector').info('自动模式-尝试 Stealth PNG 隐写解析...')
        const stealthData = await parseStealthPng(buffer)
        if (stealthData) {
          if (debug) ctx.logger('sd-inspector').info('自动模式-Stealth PNG 解析成功')
          chunks = Object.keys(stealthData).map(key => ({
            keyword: key === 'uc' ? 'Comment' : key,
            text: typeof stealthData[key] === 'string' ? stealthData[key] : JSON.stringify(stealthData[key]),
          }))
          chunks.unshift({
            keyword: 'Comment',
            text: JSON.stringify(stealthData),
          })
        }
      }

      // 如果 PNG chunks 中没有找到，尝试从 EXIF 中提取
      if ((!chunks || chunks.length === 0) && (exifData || exifDataFlat)) {
        if (debug) ctx.logger('sd-inspector').info('自动模式-PNG chunks 中未找到数据，尝试从 EXIF 提取')

        // 初始化 chunks 为空数组
        if (!chunks) {
          chunks = []
        }

        // 优先尝试扁平模式
        const possibleSources = [
          exifDataFlat,
          exifData?.pngFile,
          exifData?.pngText,
          exifData?.png,
          exifData
        ]

        for (const pngSource of possibleSources) {
          if (!pngSource || typeof pngSource !== 'object') continue

          const sdKeywords = ['Description', 'Software', 'Source', 'Comment', 'Generation_time', 'Title', 'parameters', 'prompt']

          for (const key of Object.keys(pngSource)) {
            if (!sdKeywords.includes(key)) continue

            const field = pngSource[key]
            let description = null

            if (field && typeof field === 'object' && field.description) {
              description = field.description
            } else if (field && typeof field === 'object' && field.value) {
              description = field.value
            } else if (typeof field === 'string') {
              description = field
            }

            if (description) {
              chunks.push({
                keyword: key,
                text: description
              })
            }
          }

          if (chunks.length > 0) break
        }
      }

      if (chunks && chunks.length > 0) {
        if (useForward) {
          const messages = formatSDInfoAsMessages(chunks, exifData)
          // 构建转发消息节点
          const forwardNodes = messages.map(msg => h('message', {}, msg))
          await session.send(h('message', { forward: true }, forwardNodes))
        } else {
          await session.send(formatSDInfo(chunks, exifData))
        }
      } else if (isWaitingForImage) {
        await session.send('❌ 该图片不包含 Stable Diffusion 生成参数\n提示：只有 PNG 格式且包含元数据的图片才能解析')
      }
    } catch (error) {
      ctx.logger('sd-inspector').debug('处理图片失败:', error)
    }
  })
}
