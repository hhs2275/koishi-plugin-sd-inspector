import { PngChunk, ParsedResult } from './parser'

/** 格式化输出结果为消息数组（转发消息模式） */
export function formatSDInfoAsMessages(result: ParsedResult, chunks: PngChunk[]): string[] {
  const messages: string[] = []
  try {
    messages.push('📷 SD 图片参数信息')

    const { prompt, negativePrompt, params, modelInfo, generationType, characterPrompts, rawComment, isNovelAI, huatuCommand } = result

    if (modelInfo) messages.push(`🤖 模型：${modelInfo}`)
    if (generationType) messages.push(`📝 类型：${generationType}`)
    if (prompt) messages.push(`🎨 正向提示词：\n${prompt}`)
    if (characterPrompts) messages.push(`👥 角色提示词：\n'${characterPrompts}'`)
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
  } catch {
    // 兜底：与原实现一致，渲染异常时返回占位消息
    return ['📷 SD 图片参数信息', '❌ 解析失败']
  }
}

/** 格式化输出结果（兼容旧版单条消息） */
export function formatSDInfo(result: ParsedResult, chunks: PngChunk[]): string {
  try {
    let output = 'SD 图片参数信息：\n\n'

    const { prompt, negativePrompt, params, modelInfo, generationType, characterPrompts, rawComment, isNovelAI, huatuCommand } = result

    if (modelInfo) output += ` 模型：${modelInfo}\n\n`
    if (generationType) output += ` 类型：${generationType}\n\n`
    if (prompt) output += ` 正向提示词：\n${prompt}\n\n`
    if (characterPrompts) output += `👥 角色提示词：\n'${characterPrompts}'\n\n`
    if (negativePrompt) output += `负向提示词：\n${negativePrompt}\n\n`
    if (params) output += ` 生成参数：\n${params}\n`
    if (isNovelAI && huatuCommand) output += `\n💻 hhs-huatu 推测指令：\n${huatuCommand}\n`
    if (isNovelAI && rawComment) output += `\n📋 Comment 原始数据：\n${rawComment}\n`

    // 如果没有成功解析任何内容，返回原始信息
    if (!prompt && !negativePrompt && !params) {
      output += '未能识别标准格式，原始数据：\n'
      for (const chunk of chunks) {
        output += `${chunk.keyword}: ${chunk.text.substring(0, 200)}...\n\n`
      }
    }

    return output.trim()
  } catch {
    // 兜底：与原实现一致，渲染异常时返回占位消息
    return 'SD 图片参数信息：\n\n解析失败'
  }
}
