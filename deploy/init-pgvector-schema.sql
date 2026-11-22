-- ============================================================================
-- Agentic SDLC OS — PostgreSQL 16 + pgvector 核心表结构初始化脚本
-- 对齐《工程落地架构草案》4.1 节核心数据模型
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- 1. 任务运行主表 (workflow_runs)
CREATE TABLE IF NOT EXISTS workflow_runs (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    workflow_template_name VARCHAR(128) NOT NULL,
    workflow_snapshot_yaml JSONB NOT NULL,
    active_branch_id VARCHAR(128) NOT NULL,
    token_budget INT NOT NULL DEFAULT 120000,
    token_used INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 不可变阶段快照表 (stage_snapshots — 支撑 DAG 分叉回退)
CREATE TABLE IF NOT EXISTS stage_snapshots (
    id VARCHAR(96) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    parent_snap_id VARCHAR(96) NULL,
    branch_id VARCHAR(128) NOT NULL,
    stage_id VARCHAR(64) NOT NULL,
    role_agent VARCHAR(64) NOT NULL,
    model_used VARCHAR(128) NOT NULL,
    artifact_json JSONB NOT NULL,
    risk_score INT NOT NULL,
    state VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_snapshots_run_branch
    ON stage_snapshots(run_id, branch_id);

-- 3. Agent 间受限协商记录表 (negotiation_logs)
CREATE TABLE IF NOT EXISTS negotiation_logs (
    id VARCHAR(96) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    branch_id VARCHAR(128) NOT NULL,
    from_stage VARCHAR(64) NOT NULL,
    to_stage VARCHAR(64) NOT NULL,
    turn_index INT NOT NULL,
    message_structured JSONB NOT NULL,
    scope_diff JSONB NOT NULL,
    is_escalated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. 人类审核与自动放行决策账本表 (human_decisions — Append-Only 追责依据)
CREATE TABLE IF NOT EXISTS human_decisions (
    id VARCHAR(96) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    snap_id VARCHAR(96) NOT NULL,
    reviewer_id VARCHAR(128) NULL,
    decision_type VARCHAR(32) NOT NULL,
    comment TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. 负向经验飞轮向量表 (rejected_history_rag — pgvector 余弦相似度检索)
CREATE TABLE IF NOT EXISTS rejected_history_rag (
    id VARCHAR(96) PRIMARY KEY,
    stage_id VARCHAR(64) NOT NULL,
    desensitized_lesson TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- AUDIT-8 / USER_SYSTEM_DESIGN §2.2 — 用户认证、权限归属、团队评论与双轨关联表
-- ============================================================================

-- 6. 用户账号表 (users)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    display_name VARCHAR(128) NOT NULL,
    job_title VARCHAR(128) NOT NULL,
    department VARCHAR(128) NOT NULL DEFAULT '',
    tier VARCHAR(32) NOT NULL,
    specialist_domain VARCHAR(64) NOT NULL,
    counterpart_agent_role VARCHAR(64) NOT NULL,
    avatar_badge VARCHAR(32) NOT NULL DEFAULT '👤',
    password_hash VARCHAR(256) NOT NULL,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    failed_login_count INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. 用户负责阶段归属表 (user_owned_stages)
CREATE TABLE IF NOT EXISTS user_owned_stages (
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, stage_id)
);

-- 8. 登录会话表 (auth_sessions — 仅存 SHA-256(token) 摘要，支持滑动过期与视角切换)
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    impersonated_by VARCHAR(64) NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
    ON auth_sessions(user_id);

-- 9. 登录审计表 (auth_login_audit — 追责与防爆破分析)
CREATE TABLE IF NOT EXISTS auth_login_audit (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    success BOOLEAN NOT NULL,
    reason VARCHAR(64) NULL,
    ip VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_login_audit_username
    ON auth_login_audit(username, created_at DESC);

-- 10. 团队阶段协同评论表 (team_comments)
CREATE TABLE IF NOT EXISTS team_comments (
    id VARCHAR(96) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    stage_id VARCHAR(64) NOT NULL,
    author_user_id VARCHAR(64) NULL REFERENCES users(id),
    author_name VARCHAR(128) NOT NULL,
    author_job_title VARCHAR(128) NOT NULL,
    author_badge VARCHAR(32) NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    category VARCHAR(32) NOT NULL DEFAULT 'COMMENT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_comments_run_stage
    ON team_comments(run_id, stage_id);

-- 11. 既有业务表的用户双轨关联外键（可空 FK + 保留原展示字符串列）
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS created_by_user_id VARCHAR(64) REFERENCES users(id);
ALTER TABLE human_decisions ADD COLUMN IF NOT EXISTS reviewer_user_id VARCHAR(64) REFERENCES users(id);
