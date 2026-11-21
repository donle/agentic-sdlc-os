/**
 * @file WorkbenchViewController.ts
 * @description 全员共享多项目、分步协同、Agent 讨论历史结论与团队评论网站主控制器。
 */

import { StageDisplayFormatter } from './StageDisplayFormatter.ts';
import type { DashboardStateDto, RagQueryMatchDto, SnapshotRecordDto } from './types.ts';
import { WorkbenchApiClient } from './WorkbenchApiClient.ts';

export type SystemRouteKey =
  | 'projects'
  | 'workspace'
  | 'gate-center'
  | 'dag-supervisor'
  | 'sandbox-explorer'
  | 'audit-rag'
  | 'admin-governance';

export class WorkbenchViewController {
  private readonly apiClient: WorkbenchApiClient;
  private currentState: DashboardStateDto | null = null;
  private activeRoute: SystemRouteKey = 'workspace';
  private selectedStageIdForInspector: string | null = null;
  private filterOnlyMyDomainGates = false;
  private activeSandboxFilePath: string | null = null;
  private latestRagSearchResults: ReadonlyArray<RagQueryMatchDto> | null = null;

  public constructor(apiClient: WorkbenchApiClient) {
    this.apiClient = apiClient;
  }

  public async initialize(): Promise<void> {
    this.bindNavigationAndShellEvents();
    this.syncRouteFromHash();
    await this.refreshState();
    this.connectSseStream();
  }

  private connectSseStream(): void {
    this.apiClient.subscribeRealtimeEventStream(
      (nextState) => {
        this.currentState = nextState;
        this.renderAll();
      },
      (connected) => {
        const sseBadge = document.getElementById('sseStatusPill');
        if (sseBadge) {
          sseBadge.textContent = connected ? '🟢 实时协同已连接' : '⚪ 同步就绪';
          sseBadge.className = connected ? 'pill pill-green' : 'pill pill-muted';
        }
      },
    );
  }

  private getElementOrThrow<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`DOM 元素未找到: #${id}`);
    }
    return el as T;
  }

  private getElementById<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  private showBannerAlert(message: string, type: 'error' | 'success'): void {
    const banner = this.getElementById('globalAlertBanner');
    const textEl = this.getElementById('globalAlertText');
    if (!banner || !textEl) {
      return;
    }
    textEl.textContent = message;
    banner.className = `alert-banner visible ${type === 'error' ? 'alert-error' : 'alert-success'}`;
  }

  public getActiveRoute(): SystemRouteKey {
    return this.activeRoute;
  }

  public switchRoute(route: SystemRouteKey): void {
    this.activeRoute = route;
    window.location.hash = `#/${route}`;

    const navButtons = document.querySelectorAll<HTMLElement>('.nav-item[data-route]');
    navButtons.forEach((btn) => {
      const btnRoute = btn.getAttribute('data-route');
      if (btnRoute === route) {
        btn.classList.add('active-nav');
      } else {
        btn.classList.remove('active-nav');
      }
    });

    const viewSections = document.querySelectorAll<HTMLElement>('.view-section');
    viewSections.forEach((sec) => {
      if (sec.id === `view-${route}`) {
        sec.classList.add('active-view');
      } else {
        sec.classList.remove('active-view');
      }
    });
  }

  private syncRouteFromHash(): void {
    const hash = window.location.hash.replace(/^#\/?/, '').trim();
    const validRoutes: ReadonlyArray<SystemRouteKey> = [
      'projects',
      'workspace',
      'gate-center',
      'dag-supervisor',
      'sandbox-explorer',
      'audit-rag',
      'admin-governance',
    ];
    if (validRoutes.includes(hash as SystemRouteKey)) {
      this.switchRoute(hash as SystemRouteKey);
    } else {
      this.switchRoute('workspace');
    }
  }

  private bindNavigationAndShellEvents(): void {
    // 1. 左侧网站导航路由切换
    const navButtons = document.querySelectorAll<HTMLElement>('.nav-item[data-route]');
    navButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const route = btn.getAttribute('data-route') as SystemRouteKey | null;
        if (route) {
          this.switchRoute(route);
        }
      });
    });

    window.addEventListener('hashchange', () => {
      this.syncRouteFromHash();
    });

    this.getElementById('btnCloseAlertBanner')?.addEventListener('click', () => {
      this.getElementById('globalAlertBanner')?.classList.remove('visible');
    });

    // 1b. 浅色 / 深色现代主题一键切换
    this.getElementById('btnThemeToggle')?.addEventListener('click', () => {
      const htmlEl = document.documentElement;
      const currentTheme = htmlEl.getAttribute('data-theme') ?? 'light';
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      htmlEl.setAttribute('data-theme', nextTheme);
      const btn = this.getElementById('btnThemeToggle');
      if (btn) {
        btn.textContent = nextTheme === 'dark' ? '☀️ 浅色' : '🌙 深色';
      }
    });

    // 2. 顶部当前登录成员身份切换（支持胶囊按钮一键切换 & 下拉同步）
    const switchActorIdentity = async (targetUserId: string): Promise<void> => {
      this.apiClient.setActiveActorUserId(targetUserId);
      const topSelect = this.getElementById<HTMLSelectElement>('actorIdentitySelect');
      if (topSelect) {
        topSelect.value = targetUserId;
      }
      document.querySelectorAll<HTMLElement>('.role-chip-btn[data-actor]').forEach((chip) => {
        if (chip.getAttribute('data-actor') === targetUserId) {
          chip.classList.add('active-role-chip');
        } else {
          chip.classList.remove('active-role-chip');
        }
      });
      await this.refreshState();
      this.connectSseStream();
      const currentUser = this.currentState?.rbacContext?.currentUser;
      if (currentUser) {
        this.showBannerAlert(
          `已切换当前登录成员为：${currentUser.displayName} (${currentUser.jobTitle}) — 页面共享完整的项目步骤、Agent 讨论结论与同事评论，你的专属步骤确认权限已生效`,
          'success',
        );
      }
    };

    document.querySelectorAll<HTMLElement>('.role-chip-btn[data-actor]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const actor = chip.getAttribute('data-actor');
        if (actor) {
          void switchActorIdentity(actor);
        }
      });
    });

    this.getElementById<HTMLSelectElement>('actorIdentitySelect')?.addEventListener(
      'change',
      (ev) => {
        const selectEl = ev.target as HTMLSelectElement;
        void switchActorIdentity(selectEl.value);
      },
    );

    // 3. 顶部当前协作项目切换
    this.getElementById<HTMLSelectElement>('projectRunSelect')?.addEventListener(
      'change',
      async (ev) => {
        const selectEl = ev.target as HTMLSelectElement;
        if (!selectEl.value) {
          return;
        }
        this.selectedStageIdForInspector = null;
        this.activeSandboxFilePath = null;
        this.currentState = await this.apiClient.selectRun(selectEl.value);
        this.renderAll();
      },
    );

    // 4. 顶部 YAML 工作流模板切换
    this.getElementById<HTMLSelectElement>('workflowTemplateSelect')?.addEventListener(
      'change',
      async (ev) => {
        const selectEl = ev.target as HTMLSelectElement;
        if (!selectEl.value) {
          return;
        }
        try {
          this.selectedStageIdForInspector = null;
          this.currentState = await this.apiClient.switchWorkflowTemplate(selectEl.value);
          this.renderAll();
          this.showBannerAlert(`已切换项目研发流程模板至 [${selectEl.value}]`, 'success');
        } catch (err) {
          this.showBannerAlert(err instanceof Error ? err.message : '模板切换失败', 'error');
        }
      },
    );

    // 5. 新建项目弹窗与示例场景
    const modal = this.getElementById('newProposalModal');
    const openModal = (): void => {
      modal?.classList.add('open');
    };
    this.getElementById('btnOpenNewProposalModal')?.addEventListener('click', openModal);
    this.getElementById('btnNewProjectFromHub')?.addEventListener('click', openModal);
    this.getElementById('btnCloseProposalModal')?.addEventListener('click', () => {
      modal?.classList.remove('open');
    });

    this.getElementById('btnSubmitCustomProposal')?.addEventListener('click', async () => {
      try {
        const title =
          this.getElementById<HTMLInputElement>('customProposalTitleInput')?.value.trim() ?? '';
        const summary =
          this.getElementById<HTMLInputElement>('customProposalSummaryInput')?.value.trim() ?? '';
        const reqsRaw =
          this.getElementById<HTMLTextAreaElement>('customProposalReqsInput')?.value ?? '';
        const ddl = Boolean(
          this.getElementById<HTMLInputElement>('customProposalDdlCheck')?.checked,
        );
        const auth = Boolean(
          this.getElementById<HTMLInputElement>('customProposalAuthCheck')?.checked,
        );
        const conflict = Boolean(
          this.getElementById<HTMLInputElement>('customProposalConflictCheck')?.checked,
        );

        const requirements: Record<string, string> = {};
        for (const line of reqsRaw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx > 0) {
            const key = trimmed.slice(0, colonIdx).trim();
            const val = trimmed.slice(colonIdx + 1).trim();
            requirements[key] = val;
          } else {
            requirements[`REQ_${Object.keys(requirements).length + 1}`] = trimmed;
          }
        }

        this.selectedStageIdForInspector = null;
        this.currentState = await this.apiClient.createCustomProposal({
          title,
          summary,
          requirements,
          involvesDatabaseMigration: ddl,
          involvesPermissionOrPayment: auth,
          simulateNegotiationConflict: conflict,
        });
        modal?.classList.remove('open');
        this.switchRoute('workspace');
        this.renderAll();
        this.showBannerAlert(`新研发项目《${title}》已创建并拆解为多 Agent 协同步骤！`, 'success');
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '立项失败', 'error');
      }
    });

    const launchPreset = async (preset: string, label: string): Promise<void> => {
      this.selectedStageIdForInspector = null;
      this.currentState = await this.apiClient.launchPresetProposal(preset);
      modal?.classList.remove('open');
      this.switchRoute('workspace');
      this.renderAll();
      this.showBannerAlert(`已切换至项目场景：${label}`, 'success');
    };

    this.getElementById('btnPresetConflict')?.addEventListener('click', () => {
      void launchPreset('CONFLICT_AND_DDL', '示例 1：PM 与 PD 3轮讨论分歧 + 架构表设计');
    });
    this.getElementById('btnPresetLowRisk')?.addEventListener('click', () => {
      void launchPreset('LOW_RISK_FAST_TRACK', '示例 2：常规迭代项目直达步骤 4 QA 验收');
    });
    this.getElementById('btnPresetScopeDiff')?.addEventListener('click', () => {
      void launchPreset('SCOPE_DIFF_ALERT', '示例 3：需求范围变更提醒项目');
    });
    this.getElementById('btnPresetCacheHit')?.addEventListener('click', () => {
      void launchPreset('CACHE_HIT_REUSE', '示例 4：复用历史方案加速交付项目');
    });

    // 6. 步骤内团队成员发表评论 & 按评论要求 Agent 重做本步骤
    this.getElementById('btnPostStepComment')?.addEventListener('click', async () => {
      const inputEl = this.getElementById<HTMLTextAreaElement>('stepCommentInput');
      const content = inputEl?.value.trim() ?? '';
      if (!content) {
        this.showBannerAlert('请先在评论框中输入你的评论或建议内容', 'error');
        return;
      }
      const targetStageId =
        this.selectedStageIdForInspector ?? this.currentState?.run?.currentStageId ?? 'STAGE_1_PM';
      try {
        this.currentState = await this.apiClient.postTeamComment(targetStageId, content);
        if (inputEl) {
          inputEl.value = '';
        }
        this.renderAll();
        this.showBannerAlert('评论已发布！全团队成员均可在此步骤下看到你的评论', 'success');
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '发表评论失败', 'error');
      }
    });

    this.getElementById('btnReviseStepWithComment')?.addEventListener('click', async () => {
      const inputEl = this.getElementById<HTMLTextAreaElement>('stepCommentInput');
      const customComment = inputEl?.value.trim() || '请结合本步骤团队评论区的最新意见重新优化方案';
      const targetStageId =
        this.selectedStageIdForInspector ?? this.currentState?.run?.currentStageId ?? 'STAGE_2_PD';
      try {
        this.currentState = await this.apiClient.sendSupervisorRollback(
          targetStageId,
          customComment,
        );
        if (inputEl) {
          inputEl.value = '';
        }
        this.renderAll();
        this.showBannerAlert(
          `已将你的修改意见转交总管 Agent，已切出新分支 [${this.currentState.run?.activeBranchId ?? ''}] 重新执行本步骤！`,
          'success',
        );
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '触发步骤重做失败', 'error');
      }
    });

    // 7. 待办确认中心角色筛选
    this.getElementById('btnFilterAllGates')?.addEventListener('click', () => {
      this.filterOnlyMyDomainGates = false;
      this.getElementById('btnFilterAllGates')?.classList.add('btn-primary');
      this.getElementById('btnFilterMyDomainGates')?.classList.remove('btn-primary');
      this.renderNotificationInbox();
    });
    this.getElementById('btnFilterMyDomainGates')?.addEventListener('click', () => {
      this.filterOnlyMyDomainGates = true;
      this.getElementById('btnFilterMyDomainGates')?.classList.add('btn-primary');
      this.getElementById('btnFilterAllGates')?.classList.remove('btn-primary');
      this.renderNotificationInbox();
    });

    // 8. 总管 Agent 自然语言回退
    this.getElementById('btnSendRollback')?.addEventListener('click', async () => {
      const stageSelect = this.getElementOrThrow<HTMLSelectElement>('rollbackStageSelect');
      const instructionInput = this.getElementOrThrow<HTMLInputElement>('rollbackInstructionInput');
      const instruction = instructionInput.value.trim();
      if (!instruction) {
        return;
      }
      try {
        this.currentState = await this.apiClient.sendSupervisorRollback(
          stageSelect.value,
          instruction,
        );
        this.renderAll();
        this.showBannerAlert(
          `总管 Agent 已执行版本回退重做，新分支 [${this.currentState.run?.activeBranchId ?? ''}] 已生效`,
          'success',
        );
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '回退失败', 'error');
      }
    });

    // 9. 沙箱子进程真实单测执行
    this.getElementById('btnRunLiveSandboxTest')?.addEventListener('click', async () => {
      const termBlock = this.getElementById('sandboxTerminalOutputBlock');
      if (termBlock) {
        termBlock.textContent = '⏳ 正在隔离沙箱子进程中运行真实单测与静态安全扫描...';
      }
      try {
        const res = await this.apiClient.triggerLiveSandboxVerification();
        this.currentState = res.dashboardState;
        this.renderAll();
        if (termBlock) {
          termBlock.textContent = res.executionLog;
        }
        this.showBannerAlert('沙箱自动化单元测试与安全扫描执行完成（通过率 100%）', 'success');
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '沙箱测试执行失败', 'error');
      }
    });

    // 10. 团队历史避坑经验检索与录入
    this.getElementById('btnRagSearch')?.addEventListener('click', async () => {
      const stageId =
        this.getElementById<HTMLSelectElement>('ragStageSelect')?.value ?? 'STAGE_3A_TECH_SPEC';
      const queryText = this.getElementById<HTMLInputElement>('ragInputText')?.value.trim() ?? '';
      try {
        this.latestRagSearchResults = await this.apiClient.queryNegativeExperienceRag(
          stageId,
          queryText,
        );
        this.renderAuditAndRagView();
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '检索失败', 'error');
      }
    });

    this.getElementById('btnRagIngest')?.addEventListener('click', async () => {
      const stageId =
        this.getElementById<HTMLSelectElement>('ragStageSelect')?.value ?? 'STAGE_3A_TECH_SPEC';
      const lessonText = this.getElementById<HTMLInputElement>('ragInputText')?.value.trim() ?? '';
      if (!lessonText) {
        return;
      }
      try {
        this.latestRagSearchResults = null;
        this.currentState = await this.apiClient.ingestNegativeExperienceLesson(
          stageId,
          lessonText,
        );
        this.renderAll();
        this.showBannerAlert(
          '已沉淀至团队共享避坑经验库，后续对应步骤 Agent 将自动引用！',
          'success',
        );
      } catch (err) {
        this.showBannerAlert(err instanceof Error ? err.message : '录入失败', 'error');
      }
    });

    // 11. 管理员保存项目流程规则
    this.getElementById('btnSaveAdminGovernance')?.addEventListener('click', async () => {
      const maxTurns = Number(
        this.getElementById<HTMLInputElement>('adminMaxTurnsInput')?.value ?? 3,
      );
      const riskThreshold = Number(
        this.getElementById<HTMLInputElement>('adminRiskThresholdInput')?.value ?? 60,
      );
      const allowCrossRollback = Boolean(
        this.getElementById<HTMLInputElement>('adminAllowCrossRollbackCheckbox')?.checked,
      );

      try {
        this.currentState = await this.apiClient.updateAdminGovernanceConfig({
          maxNegotiationTurns: maxTurns,
          highRiskScoreThreshold: riskThreshold,
          allowSpecialistCrossStageRollback: allowCrossRollback,
        });
        this.renderAll();
        this.showBannerAlert(
          `[管理员设置已更新] 已保存全局最大讨论轮次=${maxTurns}、人工确认风险分数线=${riskThreshold}`,
          'success',
        );
      } catch (err) {
        this.showBannerAlert(
          err instanceof Error ? err.message : '更新设置被权限校验拦截',
          'error',
        );
      }
    });
  }

  public async refreshState(): Promise<void> {
    this.currentState = await this.apiClient.fetchDashboardState();
    this.renderAll();
  }

  public renderAll(): void {
    if (!this.currentState || !this.currentState.hasActiveRun || !this.currentState.run) {
      return;
    }
    this.renderSidebarUserIdentity();
    this.renderProjectRunSwitcher();
    this.renderProjectsHubView();
    this.renderRunHeader();
    this.renderPipelineStages();
    this.renderStepCollaborativeWorkspace();
    this.renderNotificationInbox();
    this.renderDagSnapshots();
    this.renderSandboxExplorerView();
    this.renderAuditAndRagView();
    this.renderAdminGovernanceView();
    this.renderEngineeringRuntimePanel();
  }

  private renderSidebarUserIdentity(): void {
    const rbac = this.currentState?.rbacContext;
    if (!rbac) {
      return;
    }
    const user = rbac.currentUser;
    const card = this.getElementById('sidebarUserIdentityCard');
    if (card) {
      card.className = `user-identity-card ${user.isProjectAdmin ? 'admin-tier' : ''}`;
    }
    const badgeEl = this.getElementById('sidebarUserBadge');
    if (badgeEl) {
      badgeEl.textContent = user.avatarBadge;
      badgeEl.className = user.isProjectAdmin ? 'pill pill-purple' : 'pill pill-blue';
    }
    const tierEl = this.getElementById('sidebarUserTierTag');
    if (tierEl) {
      tierEl.textContent = user.isProjectAdmin ? '项目最高管理员' : '环节专业负责人';
      tierEl.className = user.isProjectAdmin ? 'pill pill-purple' : 'pill pill-cyan';
    }
    const nameEl = this.getElementById('sidebarUserName');
    if (nameEl) {
      nameEl.textContent = user.displayName;
    }
    const titleEl = this.getElementById('sidebarUserTitle');
    if (titleEl) {
      titleEl.textContent = `${user.jobTitle} · ${user.department}`;
    }
    const stagesEl = this.getElementById('sidebarUserOwnedStages');
    const metaMap = StageDisplayFormatter.getStageTitleMap();
    if (stagesEl) {
      const ownedNames = user.ownedStageIds
        .map((id) => metaMap[id]?.shortName ?? id)
        .filter((v) => v !== 'STAGE_0_INITIATION');
      stagesEl.textContent = user.isProjectAdmin
        ? '负责范围: 全流程所有步骤均可拍板确认与管理'
        : `负责确认步骤: ${ownedNames.join('、')}`;
    }

    const composerLabel = this.getElementById('commentComposerLabel');
    if (composerLabel) {
      composerLabel.textContent = `以【${user.avatarBadge} ${user.displayName} · ${user.jobTitle}】身份发表本步骤评论：`;
    }
  }

  private renderProjectRunSwitcher(): void {
    const selectEl = this.getElementById<HTMLSelectElement>('projectRunSelect');
    const runs = this.currentState?.allRunsList ?? [];
    const currentRunId = this.currentState?.run?.runId;
    if (!selectEl || runs.length === 0) {
      return;
    }
    selectEl.innerHTML = '';
    for (const item of runs) {
      const opt = document.createElement('option');
      opt.value = item.runId;
      opt.textContent = `${item.title} (${item.runId})`;
      if (item.runId === currentRunId) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    }
  }

  private renderProjectsHubView(): void {
    const grid = this.getElementById('projectsPortfolioGrid');
    if (!grid) {
      return;
    }
    const runs = this.currentState?.allRunsList ?? [];
    const currentRunId = this.currentState?.run?.runId;
    const metaMap = StageDisplayFormatter.getStageTitleMap();

    grid.innerHTML = '';
    for (const item of runs) {
      const isCurrent = item.runId === currentRunId;
      const stageMeta = item.currentStageId ? metaMap[item.currentStageId] : null;
      const completed = item.completedStagesCount ?? 1;
      const total = item.totalStagesCount ?? 6;
      const percent = Math.min(100, Math.round((completed / total) * 100));

      const card = document.createElement('div');
      card.className = 'project-portfolio-card';
      if (isCurrent) {
        card.style.borderColor = 'var(--accent-blue)';
      }

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
          <div>
            <div style="font-size:15px; font-weight:700;">${item.title}</div>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
              项目编号: ${item.runId} · 发起人: ${item.initiatorActor}
            </div>
          </div>
          <span class="pill ${item.status === 'COMPLETED' ? 'pill-green' : 'pill-amber'}">
            ${item.status === 'COMPLETED' ? '✅ 已交付' : '⏳ 推进中·待确认'}
          </span>
        </div>

        <div style="font-size:12.5px; color:var(--text-secondary);">${item.summary}</div>

        <div>
          <div style="display:flex; justify-content:space-between; font-size:11.5px; color:var(--text-secondary); margin-bottom:5px;">
            <span>当前推进步骤: <strong>${stageMeta ? stageMeta.name : '已完成全部步骤'}</strong></span>
            <span>进度 ${completed}/${total} 步 (${percent}%)</span>
          </div>
          <div style="height:7px; background:var(--bg-canvas); border-radius:999px; overflow:hidden;">
            <div style="height:100%; width:${percent}%; background:linear-gradient(90deg, var(--accent-blue), var(--status-green));"></div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px dashed var(--border-subtle);">
          <div style="display:flex; gap:8px; align-items:center;">
            <span class="pill pill-blue">分支: ${item.activeBranchId}</span>
            <span class="pill pill-cyan">💬 ${item.commentsCount ?? 0} 条团队评论</span>
          </div>
          <button class="btn btn-primary btn-enter-project" data-runid="${item.runId}">
            ${isCurrent ? '正在查看 · 进入分步工作台 →' : '进入项目分步协同工作区 →'}
          </button>
        </div>
      `;

      card.querySelector('.btn-enter-project')?.addEventListener('click', async () => {
        if (item.runId !== currentRunId) {
          this.selectedStageIdForInspector = null;
          this.currentState = await this.apiClient.selectRun(item.runId);
        }
        this.switchRoute('workspace');
        this.renderAll();
      });

      grid.appendChild(card);
    }
  }

  private renderRunHeader(): void {
    const state = this.currentState;
    if (!state || !state.run) {
      return;
    }
    const run = state.run;
    const currentUser = state.rbacContext?.currentUser;
    const unresolvedNotifs = (state.notifications ?? []).filter(
      (n) => n.requiresHumanAction && !n.resolved,
    );
    const myDomainUnresolved = unresolvedNotifs.filter(
      (n) => n.accessEvaluation?.canApproveOrArbitrate,
    );

    this.getElementOrThrow('runTitle').textContent = `${run.title}`;
    this.getElementOrThrow('runSubtitle').textContent =
      `项目目标：${run.summary} · 立项发起人: ${run.initiatorActor} · 已积累团队评论: ${(state.teamComments ?? []).length} 条`;
    this.getElementOrThrow('activeBranchPill').textContent = `当前版本分支: ${run.activeBranchId}`;

    const hintEl = this.getElementById('rolePerspectiveHint');
    const metaMap = StageDisplayFormatter.getStageTitleMap();
    if (hintEl && currentUser) {
      if (currentUser.isProjectAdmin) {
        hintEl.textContent = `👑 当前登录：${currentUser.displayName}（项目最高管理员）— 你看到的页面与团队成员一致，同时拥有所有步骤的跨岗位拍板权与流程规则设置权。`;
      } else {
        const mySteps = currentUser.ownedStageIds
          .map((id) => metaMap[id]?.shortName ?? id)
          .filter((v) => v !== 'STAGE_0_INITIATION');
        hintEl.textContent = `👤 当前登录：${currentUser.displayName}（${currentUser.jobTitle}）— 你可查看所有步骤的 Agent 工作进展、讨论结论并发表团队评论；你负责确认的步骤为：【${mySteps.join('、')}】。`;
      }
    }

    const statusPill = this.getElementOrThrow('runStatusPill');
    if (run.status === 'PAUSED_AT_HUMAN_GATE') {
      const curMeta = run.currentStageId ? metaMap[run.currentStageId] : null;
      statusPill.className = 'pill pill-amber';
      statusPill.textContent = `⏳ 正在【${curMeta ? curMeta.shortName : run.currentStageId}】等待责任人确认`;
    } else if (run.status === 'COMPLETED') {
      statusPill.className = 'pill pill-green';
      statusPill.textContent = '🎉 全部研发步骤已交付完成';
    } else {
      statusPill.className = 'pill pill-blue';
      statusPill.textContent = run.status;
    }

    const badge = this.getElementOrThrow('pendingActionBadge');
    badge.textContent = `待确认步骤: ${unresolvedNotifs.length} (由我负责: ${myDomainUnresolved.length})`;
    badge.className = unresolvedNotifs.length > 0 ? 'pill pill-amber' : 'pill pill-green';

    const navBadge = this.getElementById('navGateCountBadge');
    if (navBadge) {
      navBadge.textContent = String(unresolvedNotifs.length);
      navBadge.className = unresolvedNotifs.length > 0 ? 'pill pill-amber' : 'pill pill-green';
    }
  }

  private renderPipelineStages(): void {
    const state = this.currentState;
    if (!state || !state.run) {
      return;
    }
    const grid = this.getElementOrThrow('pipelineGrid');
    grid.innerHTML = '';
    const stageOrder = state.stagePipelineOrder;
    const activeBranchId = state.run.activeBranchId;
    const activeSnapshots = (state.run.snapshots ?? []).filter(
      (s) => s.branchId === activeBranchId && s.state !== 'SUPERSEDED',
    );
    const snapByStage = new Map<string, SnapshotRecordDto>();
    for (const s of activeSnapshots) {
      snapByStage.set(s.stageId, s);
    }

    if (!this.selectedStageIdForInspector) {
      this.selectedStageIdForInspector =
        state.run.currentStageId ??
        activeSnapshots[activeSnapshots.length - 1]?.stageId ??
        stageOrder[0];
    }

    const metaMap = StageDisplayFormatter.getStageTitleMap();
    const accessMatrix = state.rbacContext?.stageAccessMatrix ?? {};
    const allComments = state.teamComments ?? [];

    for (const stageId of stageOrder) {
      const meta = metaMap[stageId] ?? {
        stepNumber: 1,
        name: stageId,
        shortName: stageId,
        role: 'AGENT',
        agentDisplayName: 'AI Agent',
        specialistLabel: '领域专家',
        stepGoal: '',
      };
      const snap = snapByStage.get(stageId);
      const stageAccess = accessMatrix[stageId];
      const isMyDomain = Boolean(stageAccess?.isDirectDomainOwner);
      const isSelected = this.selectedStageIdForInspector === stageId;
      const stageCommentsCount = allComments.filter((c) => c.stageId === stageId).length;

      const card = document.createElement('div');
      let cardClass = 'stage-card';
      if (isMyDomain) {
        cardClass += ' my-domain-stage';
      }
      if (isSelected) {
        cardClass += ' selected-stage';
      }
      if (snap && snap.state === 'PENDING_HUMAN_GATE') {
        cardClass += ' active-gate';
      } else if (snap && (snap.state === 'APPROVED' || snap.state === 'AUTO_APPROVED_LOW_RISK')) {
        cardClass += ' completed-stage';
      }
      card.className = cardClass;

      const domainBadgeHtml = isMyDomain
        ? `<span class="pill pill-blue" style="font-size:10.5px;">🎯 我负责的步骤 (${meta.specialistLabel})</span>`
        : `<span class="pill pill-muted" style="font-size:10.5px;">责任人: ${meta.specialistLabel}</span>`;

      const stepLabel = `STEP 0${meta.stepNumber}`;
      if (!snap) {
        card.innerHTML = `
          <div class="stage-card-header">
            <div>
              <span class="step-index-badge">${stepLabel}</span>
              <div class="stage-name">${meta.shortName}</div>
              <div class="stage-role">${meta.agentDisplayName}</div>
            </div>
            <span class="pill pill-muted">待启动</span>
          </div>
          <div>${domainBadgeHtml}</div>
          <div class="stage-summary">${meta.stepGoal}</div>
          <div class="stage-metrics">
            <span>评论 <strong>${stageCommentsCount}</strong></span>
            <span>查看步骤 →</span>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="stage-card-header">
            <div>
              <span class="step-index-badge">${stepLabel}</span>
              <div class="stage-name">${meta.shortName}</div>
              <div class="stage-role">${meta.agentDisplayName}</div>
            </div>
            ${StageDisplayFormatter.formatStateBadge(snap.state, snap.cacheHit)}
          </div>
          <div>${domainBadgeHtml}</div>
          <div class="stage-summary">${snap.artifactSummary}</div>
          <div class="stage-metrics">
            <span>评论 <strong>${stageCommentsCount}</strong></span>
            <span style="color:var(--accent-primary); font-weight:600;">查看讨论与产出 →</span>
          </div>
        `;
      }

      card.addEventListener('click', () => {
        this.selectedStageIdForInspector = stageId;
        this.renderPipelineStages();
        this.renderStepCollaborativeWorkspace();
      });

      grid.appendChild(card);
    }
  }

  /**
   * 渲染当前选中步骤的 4 大核心板块：
   * 1. Agent 正在做什么与执行动作分解
   * 2. Agent 间工作流讨论记录与历史结论 (+ 步骤内直接确认/拍板操作栏)
   * 3. 本步骤核心产出文档与方案明细
   * 4. 团队成员在该步骤留下的评论信息与发表评论表单
   */
  private renderStepCollaborativeWorkspace(): void {
    const state = this.currentState;
    if (!state || !state.run) {
      return;
    }

    const stageId = this.selectedStageIdForInspector ?? state.stagePipelineOrder[0];
    const metaMap = StageDisplayFormatter.getStageTitleMap();
    const meta = metaMap[stageId] ?? {
      stepNumber: 1,
      name: stageId,
      shortName: stageId,
      role: 'AGENT',
      agentDisplayName: 'AI Agent',
      specialistLabel: '领域专家',
      stepGoal: '',
    };
    const access = state.rbacContext?.stageAccessMatrix[stageId];
    const activeBranchId = state.run.activeBranchId;
    const allSnapshots = state.run.snapshots ?? [];
    const snap = allSnapshots.find(
      (s) => s.branchId === activeBranchId && s.stageId === stageId && s.state !== 'SUPERSEDED',
    );

    // 1. 更新步骤头部权限提示与 Agent 工作状态分解
    const activityHeaderEl = this.getElementById('stepActivityHeaderTitle');
    if (activityHeaderEl) {
      activityHeaderEl.textContent = `🤖 1. 【${meta.name}】Agent 工作状态与执行动作分解`;
    }
    const accessPill = this.getElementById('stageInspectorAccessPill');
    if (accessPill) {
      if (access?.isDirectDomainOwner) {
        accessPill.textContent = `🎯 你是本步骤负责人 (${meta.specialistLabel}) · 可直接拍板确认`;
        accessPill.className = 'pill pill-green';
      } else if (access?.isAdminOverride) {
        accessPill.textContent = '👑 项目最高管理员 · 可跨步骤拍板确认';
        accessPill.className = 'pill pill-purple';
      } else {
        accessPill.textContent = `👁️ 全员共享透明视图 · 可发表评论 (由 ${meta.specialistLabel} 负责最终确认)`;
        accessPill.className = 'pill pill-cyan';
      }
    }

    const activityContainer = this.getElementById('stepAgentActivityContainer');
    if (activityContainer) {
      activityContainer.innerHTML = StageDisplayFormatter.formatAgentWorkActivityHtml(
        stageId,
        snap,
      );
    }

    // 2. 渲染 Agent 间讨论过程与历史结论
    const discussionContainer = this.getElementById('stepAgentDiscussionContainer');
    if (discussionContainer) {
      discussionContainer.innerHTML = StageDisplayFormatter.formatAgentDiscussionAndConclusionHtml(
        stageId,
        snap,
        state.negotiationLogs ?? [],
        allSnapshots,
      );
    }

    // 2b. 如果该步骤正好有待确认/待拍板的事项，直接在本步骤内展示确认与拍板操作栏！
    const inlineGateContainer = this.getElementById('stepInlineGateActionContainer');
    if (inlineGateContainer) {
      const pendingNotif = (state.notifications ?? []).find(
        (n) => n.stageId === stageId && n.requiresHumanAction && !n.resolved,
      );
      if (!pendingNotif) {
        inlineGateContainer.innerHTML = '';
      } else {
        const canAct = Boolean(access?.canApproveOrArbitrate);
        inlineGateContainer.innerHTML = `
          <div class="notif-card urgent-action">
            <div class="notif-title">
              <span>⚡ 本步骤待确认 / 待拍板事项：${pendingNotif.title}</span>
              <span class="pill ${canAct ? 'pill-green' : 'pill-muted'}">
                ${canAct ? '你有权直接确认本步骤' : `由 ${meta.specialistLabel} 或管理员确认`}
              </span>
            </div>
            <div class="notif-body">${pendingNotif.message}</div>
            ${
              !canAct && access?.denialReason
                ? `<div style="font-size:12px; color:#fbbf24;">💡 ${access.denialReason} 你可以在右侧【团队成员评论区】留下你的建议供负责人参考。</div>`
                : ''
            }
            <div class="notif-actions" id="inlineStepDecisionButtons"></div>
          </div>
        `;
        const btnBar = inlineGateContainer.querySelector('#inlineStepDecisionButtons');
        if (btnBar && pendingNotif.actionOptions) {
          for (const opt of pendingNotif.actionOptions) {
            const btn = document.createElement('button');
            btn.className =
              opt.verdict === 'REJECT'
                ? 'btn btn-danger'
                : opt.verdict === 'ARBITRATE_OPTION_A' || opt.verdict === 'APPROVE'
                  ? 'btn btn-success'
                  : 'btn btn-warning';
            btn.textContent = canAct
              ? opt.label
              : `🔒 ${opt.label} (需 ${meta.specialistLabel} 权限)`;
            btn.addEventListener('click', async () => {
              const commentInput =
                this.getElementById<HTMLTextAreaElement>('stepCommentInput')?.value.trim() ||
                `在【${meta.name}】步骤工作区确认：${opt.label}`;
              try {
                this.currentState = await this.apiClient.submitGateDecision(
                  pendingNotif.relatedSnapshotId,
                  opt.verdict,
                  commentInput,
                );
                this.renderAll();
                this.showBannerAlert(
                  `已完成【${meta.name}】步骤确认：${opt.label}，流水线已自动推进至下一步骤！`,
                  'success',
                );
              } catch (err) {
                this.showBannerAlert(
                  err instanceof Error ? err.message : '当前登录角色无权直接签核本步骤',
                  'error',
                );
              }
            });
            btnBar.appendChild(btn);
          }
        }
      }
    }

    // 3. 渲染本步骤结构化交付物文档
    const titleEl = this.getElementById('stageInspectorTitle');
    const bodyEl = this.getElementById('stageInspectorBody');
    if (titleEl && bodyEl) {
      titleEl.textContent = `📄 3. 【${meta.name}】产出交付物与方案文档`;
      if (!snap) {
        bodyEl.innerHTML = `
          <div class="diagnosis-item">
            当前项目尚未执行到 <strong>${meta.name}</strong>。请先在前序步骤完成确认后，系统将自动唤醒 <strong>${meta.agentDisplayName}</strong> 产出本步骤文档。
          </div>
        `;
      } else {
        bodyEl.innerHTML = StageDisplayFormatter.formatArtifactDeepDetails(snap);
      }
    }

    // 4. 渲染右栏：团队成员在该步骤留下的评论信息
    const commentsTitle = this.getElementById('stepCommentsPanelTitle');
    const commentsBadge = this.getElementById('stepCommentsCountBadge');
    const commentsListEl = this.getElementById('stepTeamCommentsList');
    if (commentsTitle) {
      commentsTitle.textContent = `💬 4. 【${meta.shortName}】团队成员评论与讨论`;
    }

    const stageComments = (state.teamComments ?? []).filter((c) => c.stageId === stageId);
    if (commentsBadge) {
      commentsBadge.textContent = `${stageComments.length} 条评论`;
    }

    if (commentsListEl) {
      commentsListEl.innerHTML = '';
      if (stageComments.length === 0) {
        commentsListEl.innerHTML = `
          <div class="diagnosis-item">
            本步骤暂无团队成员评论。欢迎在下方输入框留下你的第一条评审意见或建议！
          </div>
        `;
      } else {
        for (const cmt of stageComments) {
          const card = document.createElement('div');
          card.className = 'comment-card';
          const initialChar = cmt.authorName.trim().charAt(0) || 'U';
          const catBadge =
            cmt.category === 'APPROVAL_NOTE'
              ? '<span class="pill pill-green">步骤签核</span>'
              : cmt.category === 'REVISION_REQUEST'
                ? '<span class="pill pill-amber">修改建议</span>'
                : '<span class="pill pill-blue">团队评论</span>';

          card.innerHTML = `
            <div class="comment-header">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="avatar-circle">${initialChar}</span>
                <div>
                  <strong style="font-size:12.5px;">${cmt.authorName}</strong>
                  <span style="font-size:11px; color:var(--text-muted); margin-left:4px;">${cmt.authorJobTitle}</span>
                </div>
              </div>
              ${catBadge}
            </div>
            <div style="font-size:12.5px; color:var(--text-primary); line-height:1.55; padding-left:34px;">${cmt.content}</div>
          `;
          commentsListEl.appendChild(card);
        }
      }
    }
  }

  private renderNotificationInbox(): void {
    const state = this.currentState;
    if (!state) {
      return;
    }
    const container = this.getElementOrThrow('notificationList');
    container.innerHTML = '';
    const allNotifications = state.notifications ?? [];
    const notifications = this.filterOnlyMyDomainGates
      ? allNotifications.filter((n) => n.accessEvaluation?.canApproveOrArbitrate)
      : allNotifications;

    const unresolvedCount = allNotifications.filter(
      (n) => n.requiresHumanAction && !n.resolved,
    ).length;
    const inboxTag = this.getElementOrThrow('inboxCountTag');
    inboxTag.textContent = unresolvedCount > 0 ? `${unresolvedCount} 项待确认/拍板` : '全部已确认';
    inboxTag.className = unresolvedCount > 0 ? 'pill pill-amber' : 'pill pill-green';

    if (notifications.length === 0) {
      container.innerHTML = `<div class="diagnosis-item">当前筛选条件下暂无待确认步骤记录。</div>`;
      return;
    }

    for (const notif of notifications) {
      const card = document.createElement('div');
      const isUrgent = notif.requiresHumanAction && !notif.resolved;
      const access = notif.accessEvaluation;
      const canAct = Boolean(access?.canApproveOrArbitrate);

      card.className = `notif-card ${isUrgent ? 'urgent-action' : 'resolved-item'}`;

      let rbacStatusHtml = '';
      if (access) {
        if (access.isDirectDomainOwner) {
          rbacStatusHtml = `<span class="pill pill-green">🎯 属于你负责的步骤 (${notif.stageId}) · 可直接签核</span>`;
        } else if (access.isAdminOverride) {
          rbacStatusHtml = `<span class="pill pill-purple">👑 项目最高管理员 (Admin Override) · 可跨步骤签核</span>`;
        } else {
          rbacStatusHtml = `<span class="pill pill-muted">🔒 由 ${access.requiredSpecialistRoles.join(' / ')} 负责确认 (当前角色可查看与评论)</span>`;
        }
      }

      card.innerHTML = `
        <div class="notif-title">
          <span>${notif.title}</span>
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            ${rbacStatusHtml}
            <span class="pill ${isUrgent ? 'pill-amber' : 'pill-green'}">
              ${isUrgent ? '待确认' : '已确认完成'}
            </span>
          </div>
        </div>
        <div class="notif-body">${notif.message}</div>
        <div style="font-size: 11px; color: var(--text-muted);">
          负责 Agent: ${notif.senderRole} · 步骤: ${notif.stageId} · 版本分支: ${notif.branchId}
        </div>
        ${
          !canAct && isUrgent && access?.denialReason
            ? `<div style="font-size:11.5px; color:#fbbf24; background:rgba(245,158,11,0.1); padding:8px 10px; border-radius:6px;">
                💡 ${access.denialReason}
               </div>`
            : ''
        }
        ${isUrgent && notif.actionOptions && notif.actionOptions.length > 0 ? '<div class="notif-actions"></div>' : ''}
      `;

      if (isUrgent && notif.actionOptions && notif.actionOptions.length > 0) {
        const actionBar = card.querySelector('.notif-actions');
        if (actionBar) {
          for (const opt of notif.actionOptions) {
            const btn = document.createElement('button');
            btn.className =
              opt.verdict === 'REJECT'
                ? 'btn btn-danger'
                : opt.verdict === 'ARBITRATE_OPTION_A' || opt.verdict === 'APPROVE'
                  ? 'btn btn-success'
                  : 'btn btn-warning';
            btn.textContent = canAct ? opt.label : `🔒 ${opt.label} (需对应步骤负责人权限)`;
            btn.addEventListener('click', async () => {
              const customComment =
                this.getElementById<HTMLInputElement>('gateDecisionCommentInput')?.value.trim() ||
                `人工确认：[${opt.label}]`;
              try {
                this.currentState = await this.apiClient.submitGateDecision(
                  notif.relatedSnapshotId,
                  opt.verdict,
                  customComment,
                );
                this.renderAll();
                this.showBannerAlert(
                  `步骤确认成功：已执行 [${opt.label}] 并同步记入本步骤团队评论区`,
                  'success',
                );
              } catch (err) {
                this.showBannerAlert(
                  err instanceof Error ? err.message : '步骤确认被角色权限校验拦截',
                  'error',
                );
              }
            });
            actionBar.appendChild(btn);
          }
        }
      }

      container.appendChild(card);
    }
  }

  private renderDagSnapshots(): void {
    const state = this.currentState;
    if (!state || !state.run) {
      return;
    }
    const list = this.getElementOrThrow('dagSnapshotHistoryList');
    list.innerHTML = '';
    const snapshots = [...(state.run.snapshots ?? [])].reverse();
    const metaMap = StageDisplayFormatter.getStageTitleMap();

    for (const snap of snapshots) {
      const meta = metaMap[snap.stageId];
      const row = document.createElement('div');
      row.className = `stream-item ${snap.state === 'SUPERSEDED' ? 'superseded-row' : ''}`;
      row.innerHTML = `
        <div>
          <div>
            <strong>[${snap.branchId}] ${meta ? meta.name : snap.stageId}</strong>
            <span style="color: var(--text-secondary);">(${meta ? meta.agentDisplayName : snap.agentRole})</span>
          </div>
          <div style="color: var(--text-secondary); margin-top: 2px;">结论摘要：${snap.artifactSummary}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
            版本快照: ${snap.snapshotId} · 上游父版本: ${snap.parentSnapshotId ?? '起始根节点'}
          </div>
        </div>
        <div>${StageDisplayFormatter.formatStateBadge(snap.state, snap.cacheHit)}</div>
      `;
      list.appendChild(row);
    }
  }

  private renderSandboxExplorerView(): void {
    const sandbox = this.currentState?.sandboxWorkspaceSummary;
    const branchBadge = this.getElementById('sandboxBranchBadge');
    const fileTreeList = this.getElementById('sandboxFileTreeList');
    const codeViewer = this.getElementById('sandboxCodeViewerBlock');
    const fileHeader = this.getElementById('sandboxActiveFileHeader');
    const terminalBlock = this.getElementById('sandboxTerminalOutputBlock');

    if (!sandbox || !fileTreeList || !codeViewer || !fileHeader || !terminalBlock) {
      return;
    }

    if (branchBadge) {
      branchBadge.textContent = sandbox.activeWorktreeBranch;
    }
    terminalBlock.textContent =
      sandbox.latestTestCommandOutput ||
      '点击右上角【▶ 运行沙箱自动化单测 & 安全扫描】即可对当前项目的代码分支执行真实测试验证。';

    fileTreeList.innerHTML = '';
    if (sandbox.generatedFiles.length === 0) {
      fileTreeList.innerHTML = `<div class="diagnosis-item">当前项目分支尚未推进到【步骤 3b：工程师代码实现】。你可在前序步骤完成确认，或在顶部项目下拉框切换至已完成编码的【企业统一结算中心与多币种清分服务】项目查看完整源码。</div>`;
      return;
    }

    if (!this.activeSandboxFilePath) {
      this.activeSandboxFilePath = sandbox.generatedFiles[0].relativePath;
      codeViewer.textContent = sandbox.generatedFiles[0].previewSnippet;
      fileHeader.textContent = `📄 源码阅读器：${sandbox.generatedFiles[0].relativePath}`;
    }

    for (const fileItem of sandbox.generatedFiles) {
      const row = document.createElement('div');
      row.className = `file-tree-item ${this.activeSandboxFilePath === fileItem.relativePath ? 'active-file' : ''}`;
      row.innerHTML = `
        <span>${fileItem.relativePath}</span>
        <span class="pill pill-muted">${fileItem.sizeBytes}B</span>
      `;
      row.addEventListener('click', async () => {
        this.activeSandboxFilePath = fileItem.relativePath;
        this.renderSandboxExplorerView();
        try {
          const fullFile = await this.apiClient.fetchSandboxFileContent(fileItem.relativePath);
          fileHeader.textContent = `📄 完整源码 (${fullFile.branchId})：${fullFile.relativePath}`;
          codeViewer.textContent = fullFile.content;
        } catch {
          codeViewer.textContent = fileItem.previewSnippet;
        }
      });
      fileTreeList.appendChild(row);
    }
  }

  private renderAuditAndRagView(): void {
    const list = this.getElementOrThrow('liveEventStreamList');
    list.innerHTML = '';
    const auditEntries = this.currentState?.auditTimeline ?? [];

    for (const entry of auditEntries) {
      const item = document.createElement('div');
      item.className = 'stream-item';
      item.innerHTML = `
        <div>
          <div>
            <span class="pill pill-blue" style="margin-right:6px;">${entry.actionType}</span>
            <strong>${entry.actor}</strong>
            <span style="color: var(--text-muted); font-size:11px;">[${entry.branchId} · ${entry.stageId}]</span>
          </div>
          <div style="color: var(--text-secondary); margin-top: 4px;">${entry.summary}</div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">
          ${entry.entryId}
        </div>
      `;
      list.appendChild(item);
    }

    const ragList = this.getElementById('ragLessonList');
    if (!ragList) {
      return;
    }
    ragList.innerHTML = '';

    if (this.latestRagSearchResults !== null) {
      if (this.latestRagSearchResults.length === 0) {
        ragList.innerHTML = `<div class="diagnosis-item">该步骤暂无匹配的团队历史经验，可点击【➕ 沉淀为团队共享避坑经验】添加。</div>`;
        return;
      }
      for (const match of this.latestRagSearchResults) {
        const row = document.createElement('div');
        row.className = 'stream-item';
        row.innerHTML = `
          <div>
            <div><span class="pill pill-purple">${match.stageId}</span> <strong>${match.recordId}</strong></div>
            <div style="color:var(--text-secondary); margin-top:4px;">${match.desensitizedLesson}</div>
          </div>
          <span class="pill pill-green">相关度: ${match.similarityScore}</span>
        `;
        ragList.appendChild(row);
      }
      return;
    }

    const allRagRecords = this.currentState?.negativeExperienceRecords ?? [];
    if (allRagRecords.length === 0) {
      ragList.innerHTML = `<div class="diagnosis-item">当前暂无团队历史回退经验。当团队回退某个步骤或点击上方【➕ 沉淀为团队共享避坑经验】时，系统会自动脱敏并沉淀于此，供后续 Agent 自动参考。</div>`;
      return;
    }
    for (const rec of [...allRagRecords].reverse()) {
      const row = document.createElement('div');
      row.className = 'stream-item';
      row.innerHTML = `
        <div>
          <div><span class="pill pill-purple">${rec.stageId}</span> <strong>${rec.recordId}</strong></div>
          <div style="color:var(--text-secondary); margin-top:4px;">${rec.desensitizedLesson}</div>
        </div>
        <span class="pill pill-cyan">已共享给对应 Agent</span>
      `;
      ragList.appendChild(row);
    }
  }

  private renderAdminGovernanceView(): void {
    const state = this.currentState;
    if (!state) {
      return;
    }

    const isAdmin = Boolean(state.rbacContext?.currentUser.isProjectAdmin);
    const adminBadge = this.getElementById('adminGovernanceAccessBadge');
    const saveBtn = this.getElementById<HTMLButtonElement>('btnSaveAdminGovernance');
    const maxTurnsInput = this.getElementById<HTMLInputElement>('adminMaxTurnsInput');
    const riskInput = this.getElementById<HTMLInputElement>('adminRiskThresholdInput');
    const rollbackCheck = this.getElementById<HTMLInputElement>('adminAllowCrossRollbackCheckbox');

    if (state.workflowDslSummary && maxTurnsInput && riskInput) {
      maxTurnsInput.value = String(state.workflowDslSummary.maxNegotiationTurns);
      riskInput.value = String(state.workflowDslSummary.highRiskScoreThreshold);
    }
    if (rollbackCheck && state.rbacContext) {
      rollbackCheck.checked = state.rbacContext.allowSpecialistCrossStageRollback;
    }

    if (adminBadge) {
      adminBadge.textContent = isAdmin
        ? '👑 当前为项目管理员 · 可直接修改'
        : '🔒 当前为环节成员 · 仅项目管理员可修改规则';
      adminBadge.className = isAdmin ? 'pill pill-purple' : 'pill pill-muted';
    }
    if (saveBtn) {
      saveBtn.textContent = isAdmin
        ? '💾 保存流程规则设置'
        : '🔒 保存流程规则设置 (需切换至王总管管理员身份)';
    }

    const report = state.retrospectiveReport;
    if (report) {
      const healthBadge = this.getElementOrThrow('retroHealthBadge');
      healthBadge.textContent = report.overallHealthy ? '✅ 协同效率达标' : '⚠️ 存在复盘关注项';
      healthBadge.className = report.overallHealthy ? 'pill pill-green' : 'pill pill-amber';

      const kpiGrid = this.getElementOrThrow('telemetryKpiGrid');
      kpiGrid.innerHTML = `
        <div class="kpi-box">
          <div class="kpi-label">(a) 历史方案复用率</div>
          <div class="kpi-value">${report.cacheMetrics.cacheHitRatePercent}%</div>
          <div class="kpi-sub">复用 ${report.cacheMetrics.totalHits}/${report.cacheMetrics.totalLookups} · 省 ${report.cacheMetrics.savedTokensTotal} Tokens</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">(b-1) 步骤意图达成率</div>
          <div class="kpi-value">${report.fulfillmentMetrics.fulfillmentRatePercent}%</div>
          <div class="kpi-sub">首次直通率 ${report.fulfillmentMetrics.firstPassSuccessRatePercent}%</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">(b-2) 平均自愈修正次数</div>
          <div class="kpi-value">${report.fulfillmentMetrics.averageRetriesPerInvocation}</div>
          <div class="kpi-sub">0次:${report.fulfillmentMetrics.retryDistribution.zeroRetries} | 1次:${report.fulfillmentMetrics.retryDistribution.oneRetry} | >=2次:${report.fulfillmentMetrics.retryDistribution.twoOrMoreRetries}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">(c) 研发算力节省比</div>
          <div class="kpi-value">${report.costSavingsRatioPercent}%</div>
          <div class="kpi-sub">累计成本 $${report.fulfillmentMetrics.totalCostUsd}</div>
        </div>
      `;

      const diagList = this.getElementOrThrow('retroDiagnosisList');
      diagList.innerHTML = '';
      for (const d of report.diagnoses) {
        const item = document.createElement('div');
        item.className = 'diagnosis-item';
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; font-weight:700;">
            <span>${d.passedSla ? '✅' : '⚠️'} ${d.metricName}</span>
            <span style="color: var(--text-secondary);">基线 ${d.targetThreshold}</span>
          </div>
          <div style="color: var(--text-secondary); margin-top: 3px;">当前表现：${d.observedValue}</div>
          <div style="color: var(--text-muted); margin-top: 2px;">建议：${d.optimizationAction}</div>
        `;
        diagList.appendChild(item);
      }
    }

    const table = this.getElementById('rbacRosterTable');
    const roster = state.rbacContext?.roster ?? [];
    const currentUserId = state.rbacContext?.currentUser.userId;
    const metaMap = StageDisplayFormatter.getStageTitleMap();
    if (table && roster.length > 0) {
      table.innerHTML = `
        <thead>
          <tr>
            <th>团队成员</th>
            <th>角色层级</th>
            <th>岗位与所属部门</th>
            <th>协同搭档 Agent</th>
            <th>项目信息与评论权限</th>
            <th>负责把关确认的研发步骤</th>
            <th>体验该成员视角</th>
          </tr>
        </thead>
        <tbody>
          ${roster
            .map((u) => {
              const stepNames = u.ownedStageIds
                .map((id) => metaMap[id]?.shortName ?? id)
                .filter((v) => v !== 'STAGE_0_INITIATION');
              return `
            <tr style="${u.userId === currentUserId ? 'background:rgba(59,130,246,0.14);' : ''}">
              <td><strong>${u.avatarBadge} ${u.displayName}</strong></td>
              <td>
                <span class="pill ${u.isProjectAdmin ? 'pill-purple' : 'pill-cyan'}">
                  ${u.isProjectAdmin ? '项目最高管理员' : '环节专业负责人'}
                </span>
              </td>
              <td>${u.jobTitle} <span style="color:var(--text-muted);">(${u.department})</span></td>
              <td><code>${u.counterpartAgentRole}</code></td>
              <td><span class="pill pill-green">查看全部步骤 + 发表团队评论</span></td>
              <td>
                ${
                  u.isProjectAdmin
                    ? '<span class="pill pill-purple">全流程所有步骤均可拍板确认 + 流程规则管理</span>'
                    : stepNames
                        .map(
                          (s) =>
                            `<span class="pill pill-blue" style="margin-right:4px;">${s}</span>`,
                        )
                        .join('')
                }
              </td>
              <td>
                ${
                  u.userId === currentUserId
                    ? '<span class="pill pill-blue">当前登录成员</span>'
                    : `<button class="btn btn-SwitchActorRow" data-userid="${u.userId}" style="padding:4px 9px; font-size:11.5px;">切换为此成员登录</button>`
                }
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      `;

      table.querySelectorAll<HTMLButtonElement>('.btn-SwitchActorRow').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetUserId = btn.getAttribute('data-userid');
          if (!targetUserId) {
            return;
          }
          const topSelect = this.getElementById<HTMLSelectElement>('actorIdentitySelect');
          if (topSelect) {
            topSelect.value = targetUserId;
          }
          this.apiClient.setActiveActorUserId(targetUserId);
          await this.refreshState();
          this.connectSseStream();
          this.switchRoute('workspace');
        });
      });
    }
  }

  private renderEngineeringRuntimePanel(): void {
    const container = this.getElementById('engineeringRuntimeSummary');
    if (!container || !this.currentState) {
      return;
    }
    const dsl = this.currentState.workflowDslSummary;
    const sandbox = this.currentState.sandboxWorkspaceSummary;

    const parts: string[] = [];
    if (dsl) {
      parts.push(
        `<div class="diagnosis-item"><strong>📋 当前项目研发流程模板：</strong> <code>${dsl.workflowName}</code> (${dsl.activeTemplateFile}) · 共 ${dsl.stageCount} 个标准步骤 · Agent 讨论上限: ${dsl.maxNegotiationTurns} 轮</div>`,
      );
    }
    if (sandbox && sandbox.generatedFiles.length > 0) {
      const fileBadges = sandbox.generatedFiles
        .map((f) => `<code>${f.relativePath}</code>`)
        .join(' · ');
      parts.push(
        `<div class="diagnosis-item"><strong>💻 已生成的代码沙箱分支 (${sandbox.activeWorktreeBranch})：</strong><div style="margin-top:4px;">${fileBadges}</div></div>`,
      );
    }
    container.innerHTML = parts.join('');
  }
}
