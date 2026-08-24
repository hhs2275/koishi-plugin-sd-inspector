import extract from 'png-chunks-extract'
import text from 'png-chunk-text'
import ExifReader from 'exifreader'
import pako from 'pako'

/** 轻量日志接口，由 Koishi 入口根据 debug 配置注入，解析层不直接依赖 Koishi */
export interface Logger {
  info(format: any, ...args: any[]): void
  debug(format: any, ...args: any[]): void
  error(format: any, ...args: any[]): void
}

export interface PngChunk {
  keyword: string
  text: string
}

/** 解析后的结构化结果，formatter 只负责渲染 */
export interface ParsedResult {
  prompt: string
  negativePrompt: string
  params: string
  modelInfo: string
  generationType: string
  characterPrompts: string
  rawComment: string
  isNovelAI: boolean
  huatuCommand: string
  source: string
}

export interface CharacterCaption {
  char_caption?: string
  centers?: Array<{ x: number; y: number }>
}

export interface V4Caption {
  base_caption?: string
  char_captions?: CharacterCaption[]
}

export interface V4Prompt {
  use_coords?: boolean
  use_order?: boolean
  caption?: V4Caption
}

export interface NovelAIMetadata {
  prompt?: string
  uc?: string
  request_type?: string
  steps?: number
  width?: number
  height?: number
  scale?: number
  seed?: number
  sampler?: string
  noise_schedule?: string
  sm?: boolean
  sm_dyn?: boolean
  dynamic_thresholding?: boolean
  cfg_rescale?: number
  strength?: number
  noise?: number
  skip_cfg_above_sigma?: number | string | null
  reference_strength_multiple?: number[]
  director_reference_images?: unknown[]
  director_reference_descriptions?: Array<{ caption?: { base_caption?: string } }>
  director_reference_strengths?: number[]
  director_reference_information_extracted?: number[]
  v4_prompt?: V4Prompt
  v4_negative_prompt?: { caption?: V4Caption }
}

export type AnalyzeResult =
  | { kind: 'ok'; result: ParsedResult; chunks: PngChunk[] }
  | { kind: 'no-data' }
  | { kind: 'parse-failed' }

export function isPngBuffer(buffer: Buffer): boolean {
  return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
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
export function parseStealthPng(imageBuffer: Buffer): unknown | null {
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

    // 做 filter 还原像素值
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

    // 4. 按列优先（x 外层、y 内层）提取 alpha LSB —— 与开源项目一致
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
    return JSON.parse(jsonString)
  } catch {
    return null
  }
}

// PNG Paeth 滤波预测函数
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

// NovelAI 模型映射
const novelAIModels: Record<string, { name: string; cmd: string }> = {
  '7BCCAA2C': { name: 'NAI-V3 (Stable Diffusion XL)', cmd: 'nai' },
  '1120E6A9': { name: 'NAI-V3 (Stable Diffusion XL 局部重绘)', cmd: 'nai' },
  '37C2B166': { name: 'NAI-V3-Furry (Stable Diffusion XL)', cmd: 'nai -m furry' },
  'F306816B': { name: 'NAI-V3-Furry (Stable Diffusion XL 局部重绘)', cmd: 'nai -m furry' },
  '7ABFFA2A': { name: 'NAI-V4-Curated-Preview', cmd: 'nai4c' },
  '770A9E12': { name: 'NAI-V4-Curated-Preview (局部重绘)', cmd: 'nai4c' },
  '37442FCA': { name: 'NAI-V4-Full (NovelAI Diffusion V4)', cmd: 'nai4' },
  'F6302A9D': { name: 'NAI-V4-Full (局部重绘)', cmd: 'nai4' },
  'C02D4F98': { name: 'NAI-V4.5-Curated', cmd: 'nai4-5c' },
  '5BB76870': { name: 'NAI-V4.5-Curated (局部重绘)', cmd: 'nai4-5c' },
  '4BDE2A90': { name: 'NAI-V4.5-Full (NovelAI Diffusion 4.5)', cmd: 'nai4-5' },
  '1229B44F': { name: 'NAI-V4.5-Full (局部重绘)', cmd: 'nai4-5' },
  '0ADF9AB7': { name: 'NAI-V5-Full (NovelAI Diffusion V5)', cmd: 'nai5' },
  '657484A5': { name: 'NAI-V5-Full (局部重绘)', cmd: 'nai5' },
  'DB276663': { name: 'NAI-V5-Curated (NovelAI Diffusion V5)', cmd: 'nai5c' },
}

// 识别 NovelAI 模型
export function identifyNovelAIModel(source?: string): { name: string; cmd: string } | null {
  if (!source) return null

  for (const [hash, modelObj] of Object.entries(novelAIModels)) {
    if (source.includes(hash)) {
      return modelObj
    }
  }
  return null
}

// 识别生成类型
export function identifyGenerationType(jsonData: NovelAIMetadata): string {
  const requestType = jsonData.request_type || ''
  const hasVibeTransfer = jsonData.reference_strength_multiple?.length > 0
  const hasPreciseRef = jsonData.director_reference_images?.length > 0

  const types: string[] = []
  if (requestType === 'NativeInfillingRequest') types.push('局部重绘 (Inpainting)')
  else if (requestType === 'Img2ImgRequest') types.push('图生图 (Img2Img)')
  else types.push('文生图 (Text2Img)')

  if (hasPreciseRef) types.push('精准参考 (Precise Ref)')
  if (hasVibeTransfer) types.push('氛围转移 (Vibe Transfer)')

  return types.join(' + ')
}

// 生成 hhs-huatu 绘图指令
export function generateHhsHuatuCommand(
  jsonData: NovelAIMetadata,
  source: string,
  prompt: string,
  characterPrompts: string,
  negativePrompt: string,
): string {
  let cmdBase = 'nai'
  if (source) {
    const modelObj = identifyNovelAIModel(source)
    if (modelObj) {
      cmdBase = modelObj.cmd
    }
  }

  const opts: string[] = []
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
  if (jsonData.sm === true) opts.push('-S')
  if (jsonData.sm_dyn === true) opts.push('-d')
  if (jsonData.dynamic_thresholding === true) opts.push('-D')
  if (jsonData.cfg_rescale !== undefined) opts.push(`-R ${jsonData.cfg_rescale}`)
  if (jsonData.strength !== undefined) opts.push(`-N ${jsonData.strength}`)
  if (jsonData.noise !== undefined) opts.push(`-n ${jsonData.noise}`)
  if (jsonData.skip_cfg_above_sigma !== undefined && jsonData.skip_cfg_above_sigma !== null && jsonData.skip_cfg_above_sigma !== 'null') {
    opts.push(`-v ${jsonData.skip_cfg_above_sigma}`)
  }

  const requestType = jsonData.request_type || ''
  if (requestType === 'NativeInfillingRequest') {
    opts.push('-M')
  }

  if (jsonData.director_reference_images && jsonData.director_reference_images.length > 0) {
    opts.push('-P')
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

      const strength = jsonData.director_reference_strengths?.[i] ?? 1
      const fidelity = jsonData.director_reference_information_extracted?.[i] ?? 1

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
// 命中 5×5 网格点时输出 A1-E5（V4/V4.5 及 V5 兼容写法）；
// 其余连续坐标输出 x,y（NAI 5 自由定位，与 hhs-huatu 一致）
export function coordsToPosition(x: number, y: number): string {
  const xMap: Record<number, string> = {
    0.1: 'A', 0.3: 'B', 0.5: 'C', 0.7: 'D', 0.9: 'E',
  }
  const yMap: Record<number, string> = {
    0.1: '1', 0.3: '2', 0.5: '3', 0.7: '4', 0.9: '5',
  }

  const matchGrid = (value: number, map: Record<number, string>): string | null => {
    for (const key of Object.keys(map).map(Number)) {
      if (Math.abs(value - key) < 1e-4) return map[key]
    }
    return null
  }

  const xPos = matchGrid(x, xMap)
  const yPos = matchGrid(y, yMap)
  if (xPos && yPos) return `${xPos}${yPos}`

  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
  return `${clamp(x)},${clamp(y)}`
}

// 解析 V4 角色提示词
export function parseV4CharacterPrompts(jsonData: NovelAIMetadata, useCoords: boolean = true): string | null {
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
export function parsePngInfo(imageBuffer: Buffer, log?: Logger): PngChunk[] | null {
  try {
    const chunks = extract(imageBuffer)
    const textChunks: PngChunk[] = []

    if (log) log.info(`PNG chunks 总数: ${chunks.length}`)

    // 统计 chunk 类型
    if (log) {
      const chunkTypes = chunks.map(c => c.name)
      log.info(`Chunk 类型: ${[...new Set(chunkTypes)].join(', ')}`)
    }

    // 查找包含 SD 参数的文本块
    for (const chunk of chunks) {
      if (chunk.name === 'tEXt') {
        try {
          const textData = text.decode(chunk.data)
          if (log) log.info(`找到 tEXt chunk, keyword: ${textData.keyword}`)
          textChunks.push(textData)
        } catch (err) {
          if (log) log.debug('tEXt chunk 解析失败:', err)
        }
      } else if (chunk.name === 'iTXt') {
        // iTXt 可能包含 NULL 字符，需要特殊处理
        try {
          const data = chunk.data.filter((x: number) => x !== 0x00)
          const header = new TextDecoder().decode(data.slice(0, 11))

          if (log) log.info(`找到 iTXt chunk, header: ${header}`)

          if (header === 'Description') {
            const txt = new TextDecoder().decode(data.slice(11))
            textChunks.push({
              keyword: 'Description',
              text: txt,
            })
            if (log) log.info(`Description 内容长度: ${txt.length}`)
          } else {
            // 尝试完整解析
            const txt = new TextDecoder().decode(data)
            textChunks.push({
              keyword: 'Comment',
              text: txt,
            })
            if (log) log.info(`Comment 内容长度: ${txt.length}`)
          }
        } catch (err) {
          if (log) log.info('iTXt chunk 解析失败:', err.message)
        }
      }
    }

    if (log) log.info(`解析到 ${textChunks.length} 个文本 chunks`)

    return textChunks.length > 0 ? textChunks : null
  } catch (error) {
    log?.error('解析图片失败:', error)
    return null
  }
}

// 解析 WebUI 格式的参数
export function parseWebUiFormat(text: string) {
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

// 从 EXIF 数据中提取 SD 相关文本字段，作为 chunks 使用
export function extractChunksFromExif(exifData: any, exifDataFlat: any, log?: Logger): PngChunk[] {
  const chunks: PngChunk[] = []

  // 优先尝试扁平模式（更直接）
  const possibleSources = [
    exifDataFlat,
    exifData?.pngFile,
    exifData?.pngText,
    exifData?.png,
    exifData,
  ]

  // SD 相关的关键字
  const sdKeywords = ['Description', 'Software', 'Source', 'Comment', 'Generation_time', 'Title', 'parameters', 'prompt']

  for (const pngSource of possibleSources) {
    if (!pngSource || typeof pngSource !== 'object') continue

    for (const key of Object.keys(pngSource)) {
      if (!sdKeywords.includes(key)) continue

      const field = pngSource[key]
      if (log) log.info(`检查 SD 字段: ${key}, 类型: ${typeof field}`)

      // 尝试多种数据结构
      let description: unknown = null
      if (field && typeof field === 'object' && field.description) {
        description = field.description
      } else if (field && typeof field === 'object' && field.value) {
        description = field.value
      } else if (typeof field === 'string') {
        description = field
      }

      if (description) {
        chunks.push({ keyword: key, text: description as string })
        if (log) {
          const preview = typeof description === 'string' ? description.substring(0, 100) : String(description).substring(0, 100)
          log.info(`✅ 从 EXIF 提取: ${key}, 长度: ${String(description).length}, 预览: ${preview}`)
        }
      }
    }

    if (chunks.length > 0) {
      if (log) log.info(`EXIF 提取完成，总计 ${chunks.length} 个 SD 字段`)
      break
    }
  }

  return chunks
}

// 从 chunks 中解析出结构化的图片信息
export function parseChunks(chunks: PngChunk[], exifData?: any, log?: Logger): ParsedResult {
  let prompt = ''
  let negativePrompt = ''
  let params = ''
  let modelInfo = ''
  let generationType = ''
  let characterPrompts = ''
  let rawComment = ''
  let isNovelAI = false
  let huatuCommand = ''
  let source = ''

  // 从 EXIF 读取基本信息
  if (exifData) {
    if (log) log.info('EXIF 可用字段:', Object.keys(exifData).join(', '))

    // PNG 文本信息存储在 pngText 字段下
    const pngText = exifData.pngText || exifData.png || {}

    if (log && pngText && Object.keys(pngText).length > 0) {
      log.info('pngText 字段:', Object.keys(pngText).join(', '))
    }

    source = pngText.Source?.description ||
      pngText.Source?.value ||
      exifData.Source?.description ||
      exifData.Source?.value ||
      ''

    if (log) log.info('读取到 Source:', source || '(空)')

    if (source) {
      const model = identifyNovelAIModel(source)
      if (model) {
        modelInfo = model.name
        if (log) log.info('✅ 识别到 NovelAI 模型:', model.name)
      } else if (log) {
        log.info('❌ NovelAI 模型哈希未识别:', source)
      }
    } else if (log) {
      log.info('无 Source 字段，无法判断 NovelAI 模型')
    }
  } else if (log) {
    log.info('EXIF 数据为空')
  }

  // 如果 EXIF 没有提取到 Source，尝试从 tEXt/iTXt chunk 中提取
  if (!source) {
    for (const chunk of chunks) {
      if (chunk.keyword === 'Source' && chunk.text) {
        source = chunk.text
        const model = identifyNovelAIModel(source)
        if (model) {
          modelInfo = model.name
          if (log) log.info('✅ 从 Chunk 识别到 NovelAI 模型:', model.name)
        }
        break
      }
    }
  }

  // 遍历所有 chunks
  for (const chunk of chunks) {
    const keyword = chunk.keyword || ''
    const chunkText = chunk.text || ''

    // 优先检查是否是 SD WebUI 格式（通过文本内容特征判断）
    // WebUI 格式特征：包含 "Negative prompt:" 或同时包含换行和 "Steps:"
    if (chunkText.includes('Negative prompt:') || (chunkText.includes('\n') && chunkText.includes('Steps: '))) {
      const parsed = parseWebUiFormat(chunkText)
      prompt = parsed.prompt
      negativePrompt = parsed.negativePrompt
      params = parsed.params
      break
    }

    // 检查是否是 NovelAI JSON 格式
    if (keyword === 'Comment') {
      rawComment = chunkText
    }
    if (keyword === 'Description' || keyword === 'Comment') {
      try {
        const jsonData = JSON.parse(chunkText) as NovelAIMetadata

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
      prompt = chunkText
    } else if (keyword === 'negative prompt' || keyword === '负面提示词') {
      negativePrompt = chunkText
    }
  }

  return { prompt, negativePrompt, params, modelInfo, generationType, characterPrompts, rawComment, isNovelAI, huatuCommand, source }
}

// 完整解析一张 PNG：EXIF + chunks + stealth 兜底，输出结构化结果
export async function analyzeImage(imageBuffer: Buffer, log?: Logger): Promise<AnalyzeResult> {
  // 读取 EXIF 数据（尝试两种模式）
  let exifData: any = null
  let exifDataFlat: any = null
  try {
    // 先尝试 expanded 模式
    exifData = await ExifReader.load(imageBuffer, { expanded: true })
    if (log) log.info('成功读取 EXIF (expanded)，字段数:', exifData ? Object.keys(exifData).length : 0)

    // 再读取扁平模式（更容易访问 PNG 文本块）
    exifDataFlat = await ExifReader.load(imageBuffer, { expanded: false })
    if (log) log.info('成功读取 EXIF (flat)，字段数:', exifDataFlat ? Object.keys(exifDataFlat).length : 0)

    // 检查扁平模式中的字段
    if (log && exifDataFlat) {
      const flatKeys = Object.keys(exifDataFlat)
      const sdRelatedKeys = flatKeys.filter(k =>
        k === 'Description' || k === 'Comment' || k === 'Software' ||
        k === 'Source' || k === 'Generation_time' || k.includes('prompt'),
      )
      if (sdRelatedKeys.length > 0) {
        log.info('在扁平模式中发现 SD 相关字段:', sdRelatedKeys.join(', '))
      }
    }
  } catch (err) {
    if (log) log.info('读取 EXIF 失败:', err.message)
  }

  // 解析元数据
  let chunks = parsePngInfo(imageBuffer, log)

  // 如果普通 chunks 解析为空，尝试 stealth PNG 隐写解析
  if (!chunks || chunks.length === 0) {
    if (log) log.info('🔍 尝试 Stealth PNG 隐写解析...')
    const stealthData = parseStealthPng(imageBuffer)
    if (stealthData) {
      if (log) log.info('✅ Stealth PNG 解析成功')
      // 将 stealth 数据转换为 chunks 格式
      const data = stealthData as Record<string, unknown>
      chunks = Object.keys(data).map(key => ({
        keyword: key === 'uc' ? 'Comment' : key,
        text: typeof data[key] === 'string' ? data[key] as string : JSON.stringify(data[key]),
      }))
      // 同时把完整 JSON 作为 Comment chunk（供 NovelAI 格式解析）
      chunks.unshift({
        keyword: 'Comment',
        text: JSON.stringify(data),
      })
    } else if (log) {
      log.info('❌ Stealth PNG 解析未找到数据')
    }
  }

  // 如果 PNG chunks 中没有找到，尝试从 EXIF 中提取
  if ((!chunks || chunks.length === 0) && (exifData || exifDataFlat)) {
    if (log) log.info('🔄 PNG chunks 中未找到数据，尝试从 EXIF 提取')
    if (!chunks) {
      chunks = []
    }
    chunks.push(...extractChunksFromExif(exifData, exifDataFlat, log))
  }

  if (!chunks || chunks.length === 0) {
    return { kind: 'no-data' }
  }

  // 调试：输出 EXIF 顶层结构概览
  if (log && exifData) {
    log.info(`exifData 顶层字段: ${Object.keys(exifData).join(', ')}`)
    log.info(`exifData.pngText 存在: ${!!exifData.pngText}`)
    log.info(`exifData.png 存在: ${!!exifData.png}`)
    log.info(`exifData.pngFile 存在: ${!!exifData.pngFile}`)
    if (exifData.pngText) log.info(`pngText 字段: ${Object.keys(exifData.pngText).join(', ')}`)
    if (exifData.png) log.info(`png 字段: ${Object.keys(exifData.png).join(', ')}`)
    if (exifData.pngFile) log.info(`pngFile 字段: ${Object.keys(exifData.pngFile).join(', ')}`)
  }

  try {
    const result = parseChunks(chunks, exifData, log)
    return { kind: 'ok', result, chunks }
  } catch (error) {
    if (log) log.error('格式化失败:', error)
    return { kind: 'parse-failed' }
  }
}
