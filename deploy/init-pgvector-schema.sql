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
