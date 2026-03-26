import BLOG from '@/blog.config'
import { getPostBlocks } from '@/lib/db/SiteDataApi'
import fs from 'fs'
import { getTextContent } from 'notion-utils'
import { siteConfig } from '../config'

const LLMS_SYSTEM_PROMPT = `> **AI Reading Guide:**
> Please base your answers strictly on the actual content of these articles. Always append the original article URL to your response for user reference.`

/**
 * 生成 llms.txt、llms-full.txt 以及每篇文章的独立 .md 文件
 * 遵循 https://llmstxt.org 规范
 * @param {*} props
 */
export async function generateLlmsTxt(props) {
  const { allPages, NOTION_CONFIG, siteInfo, categoryOptions, tagOptions } =
    props

  const TITLE = siteInfo?.title || siteConfig('TITLE', '', NOTION_CONFIG)
  const DESCRIPTION =
    siteInfo?.description || siteConfig('DESCRIPTION', '', NOTION_CONFIG)
  const AUTHOR = siteConfig('AUTHOR', BLOG.AUTHOR, NOTION_CONFIG)
  const BIO = siteConfig('BIO', BLOG.BIO, NOTION_CONFIG)
  let LINK = siteConfig('LINK', BLOG.LINK, NOTION_CONFIG)

  if (LINK && LINK.endsWith('/')) {
    LINK = LINK.slice(0, -1)
  }

  // 筛选已发布的文章
  const publishedPosts =
    allPages?.filter(
      page => page.type === 'Post' && page.status === 'Published'
    ) || []

  // 为每篇文章生成独立的 .md 文件，并收集全文内容用于 llms-full.txt
  const postContents = await generatePostMarkdownFiles(publishedPosts, LINK)

  // 生成 llms.txt（索引文件，链接指向 .md 文件）
  const llmsTxt = buildLlmsTxt({
    TITLE,
    DESCRIPTION,
    AUTHOR,
    BIO,
    LINK,
    publishedPosts,
    categoryOptions,
    tagOptions
  })

  // 生成 llms-full.txt（内联全文）
  const llmsFullTxt = buildLlmsFullTxt({
    TITLE,
    DESCRIPTION,
    AUTHOR,
    BIO,
    LINK,
    publishedPosts,
    postContents,
    categoryOptions,
    tagOptions
  })

  try {
    fs.mkdirSync('./public', { recursive: true })
    fs.writeFileSync('./public/llms.txt', llmsTxt)
    fs.writeFileSync('./public/llms-full.txt', llmsFullTxt)
    console.log('[llms.txt] 生成 /llms.txt 和 /llms-full.txt')
  } catch (error) {
    // 在vercel运行环境是只读的，这里会报错；
    // 但在vercel编译阶段、或VPS等其他平台这行代码会成功执行
  }
}

/**
 * 为每篇文章获取 Notion block 数据并转为 Markdown，写入 public/md/ 目录
 * @returns {Map<string, string>} slug → markdown content
 */
async function generatePostMarkdownFiles(publishedPosts, LINK) {
  const postContents = new Map()

  fs.mkdirSync('./public/md', { recursive: true })

  for (const post of publishedPosts) {
    // 加密文章跳过全文
    if (post.password && post.password !== '') {
      postContents.set(post.slug, post.summary || '')
      continue
    }

    try {
      const blockMap = await getPostBlocks(post.id, 'llms-md')
      if (blockMap) {
        const markdown = notionBlocksToMarkdown(blockMap, post)
        const slug = normalizeSlug(post.slug)
        // 将 slug 中的 / 替换为 _，避免路径问题
        const fileName = slug.replace(/\//g, '_')

        // 构建单篇文章的完整 .md 文件
        const lines = []
        lines.push(`# ${post.title}`)
        lines.push('')
        if (post.summary) {
          lines.push(`> ${post.summary}`)
          lines.push('')
        }
        const meta = []
        if (post.publishDay) {
          meta.push(
            `发布日期: ${new Date(post.publishDay).toISOString().split('T')[0]}`
          )
        }
        if (post.category) meta.push(`分类: ${post.category}`)
        if (post.tags && post.tags.length > 0)
          meta.push(`标签: ${post.tags.join(', ')}`)
        if (meta.length > 0) {
          lines.push(meta.join(' | '))
          lines.push('')
        }
        lines.push('---')
        lines.push('')
        lines.push(markdown)

        const fileContent = lines.join('\n')
        postContents.set(post.slug, fileContent)

        fs.writeFileSync(`./public/md/${fileName}.md`, fileContent)
      } else {
        postContents.set(post.slug, post.summary || '')
      }
    } catch (error) {
      console.warn(`[llms.txt] 文章 "${post.title}" block 获取失败:`, error.message)
      postContents.set(post.slug, post.summary || '')
    }
  }

  return postContents
}

/**
 * 将 Notion block 数据递归转换为 Markdown 文本
 */
function notionBlocksToMarkdown(blockMap, post) {
  const blocks = blockMap?.block
  if (!blocks) return ''

  // 找到页面根 block 的直接子 block ID 列表
  const rootBlock = blocks[post.id]?.value
  const contentIds = rootBlock?.content || []

  return contentIds
    .map(id => blockToMarkdown(blocks, id, 0))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 单个 block 转 Markdown（递归处理子 block）
 */
function blockToMarkdown(blocks, blockId, depth) {
  const block = blocks[blockId]?.value
  if (!block) return ''

  const type = block.type
  const text = getTextContent(block.properties?.title) || ''

  // 子 block 递归
  const children = (block.content || [])
    .map(id => blockToMarkdown(blocks, id, depth + 1))
    .filter(Boolean)

  switch (type) {
    case 'header':
      return `## ${text}`
    case 'sub_header':
      return `### ${text}`
    case 'sub_sub_header':
      return `#### ${text}`

    case 'text':
      if (!text && children.length === 0) return ''
      return children.length > 0
        ? [text, ...children].filter(Boolean).join('\n\n')
        : text

    case 'bulleted_list': {
      const indent = '  '.repeat(Math.max(0, depth - 1))
      const item = `${indent}- ${text}`
      return children.length > 0
        ? [item, ...children].join('\n')
        : item
    }

    case 'numbered_list': {
      const indent = '  '.repeat(Math.max(0, depth - 1))
      const item = `${indent}1. ${text}`
      return children.length > 0
        ? [item, ...children].join('\n')
        : item
    }

    case 'to_do': {
      const checked = block.properties?.checked?.[0]?.[0] === 'Yes'
      return `- [${checked ? 'x' : ' '}] ${text}`
    }

    case 'code': {
      const language =
        getTextContent(block.properties?.language) || ''
      return `\`\`\`${language.toLowerCase()}\n${text}\n\`\`\``
    }

    case 'quote':
      return text
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')

    case 'callout':
      return `> **${text}**`

    case 'divider':
      return '---'

    case 'image': {
      const source = block.properties?.source?.[0]?.[0] || ''
      const caption = getTextContent(block.properties?.caption) || ''
      return `![${caption}](${source})`
    }

    case 'bookmark': {
      const link = block.properties?.link?.[0]?.[0] || ''
      const title = text || link
      return `[${title}](${link})`
    }

    case 'toggle':
      return children.length > 0
        ? [`**${text}**`, '', ...children].join('\n\n')
        : `**${text}**`

    case 'table_of_contents':
      return '' // 目录无需输出

    case 'column_list':
      return children.join('\n\n')

    case 'column':
      return children.join('\n\n')

    case 'alias':
    case 'equation':
    case 'embed':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
      return text || ''

    // collection_view (数据库视图)、page (子页面) 等跳过
    default:
      return text || (children.length > 0 ? children.join('\n\n') : '')
  }
}

// ===== llms.txt 索引文件 =====

function buildLlmsTxt({
  TITLE,
  DESCRIPTION,
  AUTHOR,
  BIO,
  LINK,
  publishedPosts,
  categoryOptions,
  tagOptions
}) {
  const lines = []

  lines.push(`# ${TITLE}`)
  lines.push('')

  if (DESCRIPTION) {
    lines.push(`> ${DESCRIPTION}`)
    lines.push('')
  }
  
  if (AUTHOR || BIO || LINK) {
    if (AUTHOR) lines.push(`- **Author**: ${AUTHOR}`)
    if (BIO)    lines.push(`- **Bio**: ${BIO}`)
    if (LINK)   lines.push(`- **URL**: ${LINK}`)
    lines.push('')
  }

  // 专门写给大语言模型的提示词
  lines.push(LLMS_SYSTEM_PROMPT)
  lines.push('')

  // 文章列表，链接指向 .md 文件
  if (publishedPosts.length > 0) {
    lines.push('## 文章')
    lines.push('')
    for (const post of publishedPosts) {
      const slug = normalizeSlug(post.slug)
      const fileName = slug.replace(/\//g, '_')
      const mdUrl = `${LINK}/md/${fileName}.md`
      const summary = post.summary ? `: ${post.summary}` : ''
      lines.push(`- [${post.title}](${mdUrl})${summary}`)
    }
    lines.push('')
  }

  // 分类
  if (categoryOptions && categoryOptions.length > 0) {
    lines.push('## 分类')
    lines.push('')
    for (const cat of categoryOptions) {
      const catName = cat.name || cat
      lines.push(
        `- [${catName}](${LINK}/category/${encodeURIComponent(catName)})`
      )
    }
    lines.push('')
  }

  // 标签
  if (tagOptions && tagOptions.length > 0) {
    lines.push('## 标签')
    lines.push('')
    for (const tag of tagOptions) {
      const tagName = tag.name || tag
      lines.push(
        `- [${tagName}](${LINK}/tag/${encodeURIComponent(tagName)})`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ===== llms-full.txt 内联全文 =====

function buildLlmsFullTxt({
  TITLE,
  DESCRIPTION,
  AUTHOR,
  BIO,
  LINK,
  publishedPosts,
  postContents,
  categoryOptions,
  tagOptions
}) {
  const lines = []

  lines.push(`# ${TITLE}`)
  lines.push('')
  if (DESCRIPTION) {
    lines.push(`> ${DESCRIPTION}`)
    lines.push('')
  }
  
  if (AUTHOR || BIO || LINK) {
    if (AUTHOR) lines.push(`- **Author**: ${AUTHOR}`)
    if (BIO)    lines.push(`- **Bio**: ${BIO}`)
    if (LINK)   lines.push(`- **URL**: ${LINK}`)
    lines.push('')
  }

  // 专门写给大语言模型的提示词
  lines.push(LLMS_SYSTEM_PROMPT)
  lines.push('')

  // 内联每篇文章的完整 Markdown
  if (publishedPosts.length > 0) {
    lines.push('## 文章')
    lines.push('')
    for (const post of publishedPosts) {
      const content = postContents.get(post.slug) || post.summary || ''
      lines.push(content)
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  }

  // 分类
  if (categoryOptions && categoryOptions.length > 0) {
    lines.push('## 分类')
    lines.push('')
    for (const cat of categoryOptions) {
      const catName = cat.name || cat
      lines.push(
        `- [${catName}](${LINK}/category/${encodeURIComponent(catName)})`
      )
    }
    lines.push('')
  }

  // 标签
  if (tagOptions && tagOptions.length > 0) {
    lines.push('## 标签')
    lines.push('')
    for (const tag of tagOptions) {
      const tagName = tag.name || tag
      lines.push(
        `- [${tagName}](${LINK}/tag/${encodeURIComponent(tagName)})`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 规范化 slug，去除前导斜杠
 */
function normalizeSlug(slug) {
  if (!slug) return ''
  return slug.startsWith('/') ? slug.slice(1) : slug
}
