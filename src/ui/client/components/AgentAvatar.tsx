/**
 * @file AgentAvatar.tsx
 * @description 拟人化 Agent 岗位插图头像组件：支持角色插图渲染、多尺寸、动态情绪光环与气泡状态徽章。
 */

import { useState, type CSSProperties } from 'react';
import { personaFor, type AgentMood } from '../lib/agentPersona.ts';

export type AgentAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const MOOD_BADGE: Record<AgentMood, { emoji: string; label: string }> = {
  idle: { emoji: '☕', label: '待命中' },
  thinking: { emoji: '💭', label: '思考推演' },
  working: { emoji: '⚡', label: '作业中' },
  cache: { emoji: '✨', label: '缓存复用' },
  talking: { emoji: '💬', label: '交流协商' },
  retrying: { emoji: '🔄', label: '自愈重修' },
  waiting: { emoji: '🙋', label: '待您拍板' },
  celebrating: { emoji: '🎉', label: '已放行' },
  alert: { emoji: '↩️', label: '需重做' },
  archived: { emoji: '🕘', label: '已归档' },
};

export function AgentAvatar({
  roleOrStage,
  size = 'md',
  mood = 'idle',
  showMoodBadge = false,
  showSpeakingWaves = false,
  className = '',
  title,
}: {
  roleOrStage?: string | null;
  size?: AgentAvatarSize;
  mood?: AgentMood;
  showMoodBadge?: boolean;
  showSpeakingWaves?: boolean;
  className?: string;
  title?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const persona = personaFor(roleOrStage);
  const badge = MOOD_BADGE[mood];

  const style = {
    '--agent-accent': persona.accentColor,
    '--agent-soft': persona.softBg,
  } as CSSProperties;

  return (
    <span
      className={`agent-avatar agent-avatar--${size} agent-mood--${mood} ${className}`.trim()}
      style={style}
      title={title ?? `${persona.personName} · ${persona.roleTitle}`}
      aria-label={`${persona.personName} (${persona.codename})`}
    >
      <span className="agent-avatar-ring" aria-hidden="true" />
      <span className="agent-avatar-frame">
        {!imgFailed ? (
          <img
            src={persona.avatarSrc}
            alt={`${persona.personName} · ${persona.codename}`}
            className="agent-avatar-img"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="agent-avatar-fallback" aria-hidden="true">
            {persona.propEmoji}
          </span>
        )}
      </span>
      {showSpeakingWaves ? (
        <span className="agent-speaking-waves" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      {showMoodBadge ? (
        <span className="agent-avatar-mood-badge" title={badge.label} aria-label={badge.label}>
          {badge.emoji}
        </span>
      ) : null}
    </span>
  );
}
