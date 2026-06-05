import React from 'react'

import { AgentWorkspaceNav } from '../features/agent-workspace/AgentWorkspaceNav'
import { DoctorSection } from '../features/agent-workspace/DoctorSection'
import { LogsSection } from '../features/agent-workspace/LogsSection'
import { McpSection } from '../features/agent-workspace/McpSection'
import { OverviewSection } from '../features/agent-workspace/OverviewSection'
import { PermissionsSection } from '../features/agent-workspace/PermissionsSection'
import { SkillsSection } from '../features/agent-workspace/SkillsSection'
import { ThreadsSection } from '../features/agent-workspace/ThreadsSection'
import { useAgentWorkspaceStore } from '../features/agent-workspace/useAgentWorkspaceStore'
import { useAgentChatStore } from '../features/agent-chat/store'

export default function AgentWorkspacePage(): React.JSX.Element {
  const section = useAgentWorkspaceStore((state) => state.section)

  return (
    <div className="flex h-full w-full bg-slate-950 font-mono text-slate-100">
      <AgentWorkspaceNav />
      <main className="flex-1 overflow-y-auto p-6">
        {section === 'overview' && (
          <div data-testid="section-overview">
            <OverviewSection />
          </div>
        )}
        {section === 'permissions' && (
          <div data-testid="section-permissions">
            <PermissionsSection />
          </div>
        )}
        {section === 'mcp' && (
          <div data-testid="section-mcp">
            <McpSection />
          </div>
        )}
        {section === 'skills' && (
          <div data-testid="section-skills">
            <SkillsSection insertIntoChat={insertIntoChat} />
          </div>
        )}
        {section === 'threads' && (
          <div data-testid="section-threads">
            <ThreadsSection />
          </div>
        )}
        {section === 'doctor' && (
          <div data-testid="section-doctor">
            <DoctorSection />
          </div>
        )}
        {section === 'logs' && (
          <div data-testid="section-logs">
            <LogsSection />
          </div>
        )}
      </main>
    </div>
  )
}

function insertIntoChat(text: string): void {
  const { input, setInput } = useAgentChatStore.getState()
  const nextInput = input.trimEnd()
  setInput(nextInput ? `${nextInput} ${text}` : text)
}
