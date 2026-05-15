export type ParsedUnifiedDiff =
  | { ok: true; beforeContent: string; afterContent: string }
  | { ok: false; reason: string }

const FILE_HEADER_PREFIXES = ['diff --git', 'index ', '--- ', '+++ ']
const FILE_METADATA_PREFIXES = [
  'old mode ',
  'new mode ',
  'new file mode ',
  'deleted file mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
]
const NO_NEWLINE_MARKER = '\\ No newline at end of file'

function isFileHeader(line: string): boolean {
  return FILE_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))
}

function isFileMetadata(line: string): boolean {
  return FILE_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix))
}

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  if (diff.trim().length === 0) {
    return { ok: false, reason: 'empty diff' }
  }

  const beforeLines: string[] = []
  const afterLines: string[] = []
  let foundDiffLine = false
  let inHunk = false
  const lines = diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (const line of lines) {
    if (line === NO_NEWLINE_MARKER) {
      continue
    }

    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }

    if (!inHunk && (isFileHeader(line) || isFileMetadata(line))) {
      continue
    }

    foundDiffLine = true

    if (line.startsWith('-')) {
      beforeLines.push(line.slice(1))
      continue
    }

    if (line.startsWith('+')) {
      afterLines.push(line.slice(1))
      continue
    }

    if (line.startsWith(' ')) {
      const contextLine = line.slice(1)
      beforeLines.push(contextLine)
      afterLines.push(contextLine)
      continue
    }

    beforeLines.push(line)
    afterLines.push(line)
  }

  if (!foundDiffLine) {
    return { ok: false, reason: 'no diff lines found' }
  }

  return {
    ok: true,
    beforeContent: beforeLines.join('\n'),
    afterContent: afterLines.join('\n'),
  }
}
