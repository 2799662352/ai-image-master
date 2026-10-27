// 升级首启:老页面已归入「默认项目」的一次性提示。只对 legacy 剧显示;
// 用户点「知道了」或改名后 legacy 被清,提示随之消失。

import type { VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

export interface MigrationNoticeProps {
  project: VideoWorkbenchProject
  segmentCount: number
  onRename: () => void
}

export function MigrationNotice({ project, segmentCount, onRename }: MigrationNoticeProps) {
  const dismiss = useVideoWorkbenchStore((s) => s.dismissLegacyNotice)
  const addProject = useVideoWorkbenchStore((s) => s.addProject)
  if (!project.legacy) return null
  return (
    <div role="status" className="vw-notice">
      <span className="vw-notice-icon" aria-hidden="true">i</span>
      <div className="vw-notice-text">
        这是升级前的 {segmentCount} 个页面,已原样放进「{project.name}」这部剧里,没有改动任何内容。
        你可以给这部剧改个名,或者把分段拖到左侧剧栏新建一部剧并移入。
      </div>
      <div className="vw-notice-actions">
        <button type="button" className="vw-ghost" onClick={onRename}>重命名这部剧</button>
        <button type="button" className="vw-ghost" onClick={() => addProject()}>新建剧</button>
        <button type="button" className="vw-ghost" aria-label="知道了" onClick={() => dismiss(project.id)}>知道了</button>
      </div>
    </div>
  )
}
