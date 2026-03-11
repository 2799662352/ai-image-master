interface AppliedSkillsBadgesProps {
  skills: string[]
}

export function AppliedSkillsBadges({ skills }: AppliedSkillsBadgesProps) {
  if (skills.length === 0) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-white/10 bg-white/5 text-[10px] text-white/30">
        no skill
      </span>
    )
  }

  return (
    <>
      {skills.map((skillId) => (
        <span
          key={skillId}
          className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-blue-400/40 bg-blue-500/10 text-[10px] text-blue-300"
          title={skillId}
        >
          {skillId}
        </span>
      ))}
    </>
  )
}
