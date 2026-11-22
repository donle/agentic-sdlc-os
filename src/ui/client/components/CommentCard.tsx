/**
 * @file CommentCard.tsx
 * @description 团队评论卡片（阶段操作台评论列表抽屉共用）。
 */

import type { TeamCommentDto } from '../types.ts';

function categoryBadge(category: string): { label: string; pillClass: string } {
  if (category === 'APPROVAL_NOTE') {
    return { label: '步骤签核', pillClass: 'pill pill-green' };
  }
  if (category === 'REVISION_REQUEST') {
    return { label: '修改建议', pillClass: 'pill pill-amber' };
  }
  return { label: '团队评论', pillClass: 'pill pill-blue' };
}

export function CommentCard({ comment }: { comment: TeamCommentDto }) {
  const badge = categoryBadge(comment.category);
  const initial = comment.authorName.trim().charAt(0) || 'U';
  return (
    <div className="comment-card">
      <div className="comment-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="avatar-circle">{initial}</span>
          <div>
            <strong style={{ fontSize: 12.5 }}>{comment.authorName}</strong>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
              {comment.authorJobTitle}
            </span>
          </div>
        </div>
        <span className={badge.pillClass}>{badge.label}</span>
      </div>
      <div
        style={{ fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.55, paddingLeft: 34 }}
      >
        {comment.content}
      </div>
    </div>
  );
}
