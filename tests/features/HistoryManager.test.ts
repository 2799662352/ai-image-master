// tests/features/HistoryManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HistoryManager, createHistoryManager, HistoryItem } from '../../src/renderer/src/features/history'

describe('HistoryManager', () => {
  let historyManager: HistoryManager

  beforeEach(() => {
    localStorage.clear()
    historyManager = createHistoryManager({
      maxLocalHistory: 10,
      maxCloudHistory: 20,
      storageKey: 'test_history'
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe('add', () => {
    it('应该添加历史记录', async () => {
      await historyManager.init()
      
      const item = await historyManager.add({
        prompt: 'Test prompt',
        model: 'test-model',
        urls: ['http://example.com/image.png']
      })
      
      expect(item.id).toBeDefined()
      expect(item.prompt).toBe('Test prompt')
      expect(historyManager.count()).toBe(1)
    })

    it('应该将新记录添加到开头', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: 'First' })
      await historyManager.add({ prompt: 'Second' })
      
      const all = historyManager.getAll()
      expect(all[0].prompt).toBe('Second')
      expect(all[1].prompt).toBe('First')
    })

    it('应该添加元数据', async () => {
      await historyManager.init()
      
      const item = await historyManager.add({ prompt: 'Test' })
      
      expect(item.metadata).toBeDefined()
      expect(item.metadata?.savedAt).toBeDefined()
    })
  })

  describe('delete', () => {
    it('应该删除指定记录', async () => {
      await historyManager.init()
      
      const item = await historyManager.add({ prompt: 'To delete' })
      const result = await historyManager.delete(item.id)
      
      expect(result).toBe(true)
      expect(historyManager.count()).toBe(0)
    })

    it('应该返回 false 如果记录不存在', async () => {
      await historyManager.init()
      
      const result = await historyManager.delete('nonexistent')
      
      expect(result).toBe(false)
    })
  })

  describe('clear', () => {
    it('应该清空所有记录', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: '1' })
      await historyManager.add({ prompt: '2' })
      await historyManager.add({ prompt: '3' })
      
      const clearedCount = await historyManager.clear()
      
      expect(clearedCount).toBe(3)
      expect(historyManager.count()).toBe(0)
    })

    it('应该保留指定数量的记录', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: '1' })
      await historyManager.add({ prompt: '2' })
      await historyManager.add({ prompt: '3' })
      
      const clearedCount = await historyManager.clear(2)
      
      expect(clearedCount).toBe(1)
      expect(historyManager.count()).toBe(2)
    })
  })

  describe('getAll', () => {
    it('应该返回所有记录', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: '1' })
      await historyManager.add({ prompt: '2' })
      
      const all = historyManager.getAll()
      
      expect(all.length).toBe(2)
    })

    it('应该返回副本而非原数组', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: '1' })
      
      const all = historyManager.getAll()
      all.push({ id: 999, prompt: 'fake' } as HistoryItem)
      
      expect(historyManager.count()).toBe(1)
    })
  })

  describe('getById', () => {
    it('应该返回指定 ID 的记录', async () => {
      await historyManager.init()
      
      const added = await historyManager.add({ prompt: 'Find me' })
      const found = historyManager.getById(added.id)
      
      expect(found?.prompt).toBe('Find me')
    })

    it('应该返回 undefined 如果不存在', async () => {
      await historyManager.init()
      
      const found = historyManager.getById('nonexistent')
      
      expect(found).toBeUndefined()
    })
  })

  describe('search', () => {
    it('应该按 prompt 搜索', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: 'A beautiful cat' })
      await historyManager.add({ prompt: 'A cute dog' })
      await historyManager.add({ prompt: 'A cat playing' })
      
      const results = historyManager.search('cat')
      
      expect(results.length).toBe(2)
    })

    it('应该不区分大小写', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: 'CAT' })
      
      const results = historyManager.search('cat')
      
      expect(results.length).toBe(1)
    })
  })

  describe('update', () => {
    it('应该更新记录', async () => {
      await historyManager.init()
      
      const item = await historyManager.add({ prompt: 'Original' })
      const result = await historyManager.update(item.id, { prompt: 'Updated' })
      
      expect(result).toBe(true)
      expect(historyManager.getById(item.id)?.prompt).toBe('Updated')
    })
  })

  describe('onChange', () => {
    it('应该在变更时触发回调', async () => {
      await historyManager.init()
      
      const callback = vi.fn()
      historyManager.onChange(callback)
      
      await historyManager.add({ prompt: 'Test' })
      
      expect(callback).toHaveBeenCalledWith(expect.any(Array), 'add')
    })

    it('应该返回取消订阅函数', async () => {
      await historyManager.init()
      
      const callback = vi.fn()
      const unsubscribe = historyManager.onChange(callback)
      
      unsubscribe()
      await historyManager.add({ prompt: 'Test' })
      
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('export / import', () => {
    it('应该导出历史记录为 JSON', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: 'Export me' })
      
      const exported = historyManager.export()
      const parsed = JSON.parse(exported)
      
      expect(parsed.length).toBe(1)
      expect(parsed[0].prompt).toBe('Export me')
    })

    it('应该导入历史记录', async () => {
      await historyManager.init()
      
      const data = JSON.stringify([
        { id: 1, prompt: 'Imported 1' },
        { id: 2, prompt: 'Imported 2' }
      ])
      
      const count = await historyManager.import(data)
      
      expect(count).toBe(2)
      expect(historyManager.count()).toBe(2)
    })

    it('应该合并导入（不重复）', async () => {
      await historyManager.init()
      
      const item = await historyManager.add({ prompt: 'Existing' })
      
      const data = JSON.stringify([
        { id: item.id, prompt: 'Duplicate' },
        { id: 999, prompt: 'New' }
      ])
      
      const count = await historyManager.import(data, true)
      
      expect(count).toBe(1) // 只添加了新的
      expect(historyManager.count()).toBe(2)
    })
  })

  describe('getStorageInfo', () => {
    it('应该返回存储信息', async () => {
      await historyManager.init()
      
      await historyManager.add({ prompt: 'Test' })
      
      const info = historyManager.getStorageInfo()
      
      expect(info.count).toBe(1)
      expect(info.maxHistory).toBe(10)
      expect(info.storageMode).toBe('local')
    })
  })
})
