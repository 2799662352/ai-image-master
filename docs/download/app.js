const SITE_COPY = {
  summary:
    '面向创作者的 Windows 桌面工作站：从 AI 出图、视频分镜到 Agent 协作，一套工具完成视觉生产流程。',
  pagePurpose:
    '这是 CATIMATION 的官方下载页。它不负责在 GitHub 上托管 460MB 安装包，而是展示最新版本信息，并安全跳转到腾讯云 COS 直链。适合首次安装、换机重装，或需要核对 SHA-256 的用户。',
  product:
    'CATIMATION-Cyberpunk Master 是 Electron 桌面应用，内置图片生成、视频创作、分镜导演、Agent 对话与 MCP 工具链。安装后可在本地离线使用核心界面，联网时调用模型与热更新服务。',
  updates:
    '已安装用户会在应用内自动收到更新提示；此页面面向新用户首次下载。版本清单由 COS 热更新频道维护，GitHub Release 作为维护者审计与备用下载面。',
  features: [
    {
      id: 'image',
      title: 'AI 图片生成',
      description: '多模型出图、批量对比、历史管理与模板工作流，适合概念设计和高频迭代。',
    },
    {
      id: 'video',
      title: '视频与分镜',
      description: '从参考图到分镜表，再到 Seedance 视频提示词，一条龙完成视觉叙事。',
    },
    {
      id: 'agent',
      title: 'Agent 工作台',
      description: '内置 Codex Agent、Skills 与 MCP 工具，让复杂创作任务可对话式编排。',
    },
    {
      id: 'director',
      title: '导演台',
      description: '三维导演台与 Canvas 画布协同，适合镜头语言、构图和场景预演。',
    },
    {
      id: 'update',
      title: '自动热更新',
      description: '安装后无需反复打开此页面；稳定版会通过 electron-updater 自动推送。',
    },
    {
      id: 'verify',
      title: '可验证发布',
      description: '每个版本附带 SHA-256、Release 说明与 immutable 制品清单，便于核对完整性。',
    },
  ],
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function signingLabel(signing) {
  if (signing?.status === 'signed') {
    return signing.subject ? `已签名 · ${signing.subject}` : '已签名'
  }
  return '未签名'
}

function renderHighlights(items) {
  const list = document.getElementById('highlights')
  list.replaceChildren()
  for (const item of items) {
    const li = document.createElement('li')
    li.textContent = item
    list.appendChild(li)
  }
  if (items.length === 0) {
    const li = document.createElement('li')
    li.textContent = '请查看 GitHub Release 获取完整更新说明。'
    list.appendChild(li)
  }
}

function renderFeatures(features) {
  const grid = document.getElementById('feature-grid')
  grid.replaceChildren()
  for (const feature of features) {
    const article = document.createElement('article')
    article.className = 'feature-card'
    article.innerHTML = `
      <div class="feature-icon">${feature.id.slice(0, 2).toUpperCase()}</div>
      <h3>${feature.title}</h3>
      <p>${feature.description}</p>
    `
    grid.appendChild(article)
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', 'true')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
}

function applyData(data) {
  const site = { ...SITE_COPY, ...(data.site ?? {}) }

  document.getElementById('product-name').textContent = data.productName
  document.getElementById('tagline').textContent = data.tagline
  document.getElementById('about-summary').textContent = site.summary
  document.getElementById('about-page-purpose').textContent = site.pagePurpose
  document.getElementById('about-product').textContent = site.product
  document.getElementById('about-updates').textContent = site.updates

  document.getElementById('version').textContent = data.version
  document.getElementById('version-inline').textContent = data.version
  document.getElementById('channel-badge').textContent = data.channel
  document.getElementById('platform-label').textContent = data.platform.label
  document.getElementById('size-label').textContent = data.platform.sizeLabel
  document.getElementById('signing-label').textContent = signingLabel(data.signing)
  document.getElementById('published-at').textContent = formatDate(data.publishedAt)
  document.getElementById('installer-name').textContent = data.platform.installerName
  document.getElementById('sha256').textContent = data.platform.sha256

  const downloadButton = document.getElementById('download-button')
  downloadButton.href = data.platform.downloadUrl
  downloadButton.setAttribute('download', data.platform.installerName)

  const heroDownloadButton = document.getElementById('hero-download-button')
  heroDownloadButton.href = data.platform.downloadUrl
  heroDownloadButton.setAttribute('download', data.platform.installerName)

  const heroReleaseButton = document.getElementById('hero-release-button')
  heroReleaseButton.href = data.githubReleaseUrl

  const githubReleaseLink = document.getElementById('github-release-link')
  githubReleaseLink.href = data.githubReleaseUrl

  const hotUpdateLink = document.getElementById('hot-update-link')
  hotUpdateLink.href = data.hotUpdateUrl

  const githubNavLink = document.getElementById('github-nav-link')
  githubNavLink.href = data.githubReleaseUrl

  const repoLink = document.getElementById('repo-link')
  repoLink.href = `https://github.com/${data.repository}`

  document.title = `下载 v${data.version} · ${data.productName}`
  renderHighlights(data.highlights ?? [])
  renderFeatures(site.features)

  const copyButton = document.getElementById('copy-sha256')
  copyButton.addEventListener('click', async () => {
    await copyText(data.platform.sha256)
    copyButton.textContent = '已复制'
    window.setTimeout(() => {
      copyButton.textContent = '复制'
    }, 1600)
  })
}

async function loadPageData() {
  const response = await fetch(`data.json?ts=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to load download metadata (${response.status})`)
  }
  return response.json()
}

loadPageData()
  .then(applyData)
  .catch((error) => {
    document.getElementById('tagline').textContent =
      '下载元数据加载失败，请稍后重试或前往 GitHub Release。'
    console.error(error)
  })
