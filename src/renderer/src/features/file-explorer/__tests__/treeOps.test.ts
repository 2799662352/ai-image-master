import { describe, expect, it } from 'vitest'
import type { FileNode } from '../types'
import { removeFromTree, renameInTree, updateNodeInTree } from '../treeOps'

/**
 * 这些测试盯的不是「改对了没有」,而是**没改到的子树有没有保持同一个引用**。
 *
 * 树是递归渲染的,行组件靠引用相等跳过重渲染。原先的写法对每个有子节点的目录都
 * 无条件新建对象,于是展开一个文件夹会把整棵树上所有展开的目录弄脏。这个坑在行
 * 组件没 memo 时毫无症状(反正都要重渲染),但一旦加了 memo,它会让 memo 静默失效。
 */

function dir(path: string, children: FileNode[]): FileNode {
  return { path, name: path.split('/').pop()!, kind: 'dir', source: 'workspace', children }
}
function file(path: string): FileNode {
  return { path, name: path.split('/').pop()!, kind: 'file', source: 'workspace' }
}

/** a/{a1,a2}, b/{b1}, c —— 改 a 里的东西时 b 和 c 必须原样不动。 */
function tree(): FileNode[] {
  return [
    dir('/a', [file('/a/a1'), file('/a/a2')]),
    dir('/b', [file('/b/b1')]),
    file('/c'),
  ]
}

describe('updateNodeInTree', () => {
  it('改中的节点更新，未命中的兄弟子树保持同一引用', () => {
    const before = tree()
    const after = updateNodeInTree(before, '/a/a1', (n) => ({ ...n, name: 'renamed' }))

    expect(after[0].children![0].name).toBe('renamed')
    // 兄弟目录 /b 整棵没被碰 —— 这是 memo 能生效的前提。
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
    // 命中路径上的祖先必须是新对象，否则改动传不上去。
    expect(after[0]).not.toBe(before[0])
    // 同一目录下没被改的兄弟节点也保持引用。
    expect(after[0].children![1]).toBe(before[0].children![1])
  })

  it('目标不存在时整棵树原样返回（连根数组都不换）', () => {
    const before = tree()
    expect(updateNodeInTree(before, '/nope', (n) => n)).toBe(before)
  })
})

describe('removeFromTree', () => {
  it('删除后其余子树保持引用', () => {
    const before = tree()
    const after = removeFromTree(before, '/a/a1')

    expect(after[0].children!.map((n) => n.path)).toEqual(['/a/a2'])
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  it('目标不存在时整棵树原样返回', () => {
    const before = tree()
    expect(removeFromTree(before, '/nope')).toBe(before)
  })
})

describe('renameInTree', () => {
  it('改名后其余子树保持引用', () => {
    const before = tree()
    const after = renameInTree(before, '/b/b1', '/b/b2', 'b2')

    expect(after[1].children![0]).toMatchObject({ path: '/b/b2', name: 'b2' })
    // 改的是 /b 里的东西，/a 不该被弄脏。
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
  })

  it('目标不存在时整棵树原样返回', () => {
    const before = tree()
    expect(renameInTree(before, '/nope', '/x', 'x')).toBe(before)
  })
})
