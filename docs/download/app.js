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

function applyData(data) {
  document.getElementById('product-name').textContent = data.productName
  document.getElementById('tagline').textContent = data.tagline
  document.getElementById('version').textContent = data.version
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

  const githubReleaseLink = document.getElementById('github-release-link')
  githubReleaseLink.href = data.githubReleaseUrl

  const hotUpdateLink = document.getElementById('hot-update-link')
  hotUpdateLink.href = data.hotUpdateUrl

  document.title = `下载 v${data.version} · ${data.productName}`
  renderHighlights(data.highlights ?? [])
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
