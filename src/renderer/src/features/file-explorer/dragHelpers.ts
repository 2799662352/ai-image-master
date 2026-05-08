const FILE_TYPE = 'application/x-catimation-file-path'
const QUOTE_TYPE = 'application/x-catimation-quote'

export function serializeFileDrag(dt: DataTransfer, path: string): void {
  dt.setData(FILE_TYPE, path)
  dt.setData('text/plain', path)
}

export function parseFileDrop(dt: DataTransfer): string | null {
  return dt.getData(FILE_TYPE) || null
}

export function serializeQuoteDrag(dt: DataTransfer, quote: string): void {
  dt.setData(QUOTE_TYPE, quote)
}

export function parseQuoteDrop(dt: DataTransfer): string | null {
  return dt.getData(QUOTE_TYPE) || null
}
