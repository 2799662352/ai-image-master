import type { FileNode } from './types'

/**
 * 文件树的不可变改写。
 *
 * 这些函数只有一个非显然的要求:**没被改到的子树必须保持同一个对象引用**。
 *
 * 为什么重要 —— 树是递归渲染的,行组件靠引用相等来跳过重渲染。原先的写法是
 * `if (n.children) return { ...n, children: recurse(...) }`:这个分支**无条件**执行,
 * 于是每个有子节点的目录都会拿到一个新对象,哪怕目标根本不在它里面。展开一个文件夹
 * 就把整棵树上所有展开的目录全弄脏了。
 *
 * 这个坑很隐蔽,因为在行组件没有 memo 的时候它完全没有症状(反正都要重渲染)。
 * 一旦加上 memo,它会让 memo 静默失效 —— 看起来做了优化,实际一点没省。所以两件事
 * 必须一起做。
 */

/** 递归结果与输入引用相同 = 这棵子树没被碰过,原样返回父节点。 */
function mapChildren(
  node: FileNode,
  recurse: (children: FileNode[]) => FileNode[],
): FileNode {
  if (!node.children) return node
  const nextChildren = recurse(node.children)
  return nextChildren === node.children ? node : { ...node, children: nextChildren }
}

/** 逐项比较:全部同引用就把原数组还回去,让上层也能跳过。 */
function sameOrNew(original: FileNode[], mapped: FileNode[]): FileNode[] {
  if (mapped.length !== original.length) return mapped
  return mapped.every((n, i) => n === original[i]) ? original : mapped
}

/**
 * 把 `targetPath` 处的节点交给 `updater` 改写,其余子树保持引用不变。
 */
export function updateNodeInTree(
  tree: FileNode[],
  targetPath: string,
  updater: (n: FileNode) => FileNode,
): FileNode[] {
  const mapped = tree.map((n) => {
    if (n.path === targetPath) return updater(n)
    return mapChildren(n, (children) => updateNodeInTree(children, targetPath, updater))
  })
  return sameOrNew(tree, mapped)
}

/** 删掉 `targetPath`,其余子树保持引用不变。 */
export function removeFromTree(tree: FileNode[], targetPath: string): FileNode[] {
  const kept = tree.filter((n) => n.path !== targetPath)
  const mapped = kept.map((n) => mapChildren(n, (children) => removeFromTree(children, targetPath)))
  // 长度变了说明就是在这一层删掉的,直接返回新数组。
  if (kept.length !== tree.length) return mapped
  return sameOrNew(tree, mapped)
}

/** 改名/移动 `oldPath`,其余子树保持引用不变。 */
export function renameInTree(
  tree: FileNode[],
  oldPath: string,
  newPath: string,
  newName: string,
): FileNode[] {
  const mapped = tree.map((n) => {
    if (n.path === oldPath) return { ...n, path: newPath, name: newName }
    return mapChildren(n, (children) => renameInTree(children, oldPath, newPath, newName))
  })
  return sameOrNew(tree, mapped)
}
