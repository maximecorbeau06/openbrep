import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { AssistantImageAttachment, AssistantMessage, CodexModelInfo, DeliveryPresentation, LlmModelOption, LlmSettings, ModifyAcceptance, PendingExtraction, PendingPlan, SkillProposal, VerificationReport, VisionExtraction, WorkspaceInfo } from '../api/types'
import { detectChatIntent, isResumeMessage, INTENT_LABELS } from '../state/chatIntent'
import { attachmentLabel, isImagePathText, MAX_ASSISTANT_IMAGES, validateAssistantImageFile } from './assistantImage'
import { AssistantMarkdown } from './AssistantMarkdownView'
import { AssistantReferenceGallery, assistantMessageImages } from './AssistantReferenceGallery'
import { adoptReference, fetchSelectedReferences, setReferenceSelection } from '../api/client'
import { AssistantThinkingTimeline } from './AssistantThinkingTimeline'
import { DeliveryCard, shouldSuppressAutoFixLabel } from './DeliveryCard'
import { ExtractionCardList, ExtractionConfirmCard } from './ExtractionCard'
import { ModelPill } from './ModelPill'
import { PanelEmpty } from './PanelEmpty'
import { useThemedDialog } from './ThemedDialog'
import { useT } from '../i18n'

interface AssistantPanelProps {
  messages: AssistantMessage[]
  busy: boolean
  hasProject: boolean
  interruptedContext?: { message: string; intent: string } | null
  onChat: (message: string, images?: AssistantImageAttachment[], requestedMode?: 'auto' | 'plan', confirmBeforeExecute?: boolean) => void
  onProposalAction?: (id: string, action: 'select' | 'execute') => void
  onStop: () => void
  onClearHistory: () => void
  onDeleteMessages?: (indices: number[]) => void | Promise<void>
  onAdoptCode: (index: number) => void
  onReviewVisualTurn?: (turnId: string, force?: boolean) => void
  onOpenScript?: (scriptName: string) => void
  onSaveRevision?: (message: string) => Promise<boolean> | boolean
  onRevealLine?: (scriptName: string, lineNumber: number) => void
  /** ST03：delivery 卡动作 */
  onRecoverDelivery?: (presentation: DeliveryPresentation, policy: 'discard' | 'keep') => void | Promise<void>
  onViewDeliveryDiff?: (presentation: DeliveryPresentation) => Promise<string | null>
  onContinueDelivery?: (payload: {
    originRunId: string | null
    originalInstruction: string
    intent?: string
    presentation: DeliveryPresentation
  }) => void
  modelOptions?: LlmModelOption[]
  currentModel?: string
  /** D16：聊天侧模型切换 = 会话级（不写 config.toml）；slash /model 与 pill 共用 */
  onSessionModelChange?: (model: string) => Promise<void>
  /** D16 模型 pill 数据源与动作 */
  llmSettings?: LlmSettings
  codexCatalog?: { connected: boolean; models: CodexModelInfo[]; loaded: boolean }
  onResetSessionModel?: () => Promise<void>
  onLoadCodexCatalog?: () => Promise<void>
  onOpenModelSettings?: () => void
  // 计划确认门（V3）：待确认计划 + 确认/取消回调
  pendingPlan?: PendingPlan | null
  onConfirmPlan?: (approve: boolean) => void
  onRevisePlan?: (instruction: string) => void
  // 提取确认门（P5d-2）：待确认/编辑的读图提取 + 确认（带编辑后 extractions）/取消回调
  pendingExtraction?: PendingExtraction | null
  onConfirmExtraction?: (extractions: VisionExtraction[], approve: boolean) => void
  // 模式级 skill 提案（P2-d）：待确认提案 + 沉淀/忽略回调
  pendingSkillProposal?: SkillProposal | null
  onConfirmSkillProposal?: (approve: boolean) => void
  // P6a：跨项目聊天记录导入（历史抽屉入口）
  workspace?: WorkspaceInfo | null
  currentProjectPath?: string | null
  onImportAssistantHistory?: (sourcePath: string) => void
  // P6b：整理聊天记录为指令 → 填入输入框草稿（不自动发送）
  draftSeed?: string | null
  onConsumeDraftSeed?: () => void
  onDistillAssistantHistory?: () => void | Promise<void>
}

/** 面板内带 token 的已贴图片（token 与草稿里的 [图N] 对应，按 attach 顺序递增）。 */
interface AttachedImage extends AssistantImageAttachment {
  token: string
}

const SLASH_COMMANDS = [
  { id: 'model', label: '/model', description: '切换 AI 模型' },
] as const

export function AssistantPanel({
  messages,
  busy,
  hasProject,
  interruptedContext,
  onChat,
  onProposalAction,
  onStop,
  onClearHistory,
  onDeleteMessages,
  onAdoptCode,
  onReviewVisualTurn,
  onOpenScript,
  onSaveRevision,
  onRevealLine,
  onRecoverDelivery,
  onViewDeliveryDiff,
  onContinueDelivery,
  modelOptions = [],
  currentModel = '',
  onSessionModelChange,
  llmSettings,
  codexCatalog,
  onResetSessionModel,
  onLoadCodexCatalog,
  onOpenModelSettings,
  pendingPlan = null,
  onConfirmPlan,
  onRevisePlan,
  pendingExtraction = null,
  onConfirmExtraction,
  pendingSkillProposal = null,
  onConfirmSkillProposal,
  workspace = null,
  currentProjectPath = null,
  onImportAssistantHistory,
  draftSeed = null,
  onConsumeDraftSeed,
  onDistillAssistantHistory,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<AttachedImage[]>([])
  const [imageError, setImageError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmThisTurn, setConfirmThisTurn] = useState(llmSettings?.confirm_before_execute ?? false)
  const [selectedMessages, setSelectedMessages] = useState<Set<number>>(new Set())
  // P0-B/P1-A：当前采用的执行参考图（显式选择；渲染图片不自动成为参考）。
  // 采用动作经后端取回为会话参考资产（hash + 状态），下一轮执行注入允许列表。
  // F2（review）：采用/取消以后端响应为准，失败必须可见（不得静默忽略）。
  const [adoptedReference, setAdoptedReference] = useState<{ id: string; url: string } | null>(null)
  const [adoptError, setAdoptError] = useState('')
  // R3（二轮 review）：采用状态跟随项目身份刷新——项目/工作区切换后重新拉取
  // 后端选择；空列表显式清空 UI（不显示过期采用）；异步响应带发起时项目
  // 身份守卫，跨项目的迟到结果一律丢弃。
  const projectRef = useRef(currentProjectPath)
  projectRef.current = currentProjectPath
  useEffect(() => {
    let cancelled = false
    const projectAtStart = currentProjectPath
    void fetchSelectedReferences().then((assets) => {
      if (cancelled || projectRef.current !== projectAtStart) return
      if (!assets.length) {
        setAdoptedReference(null)
        return
      }
      const latest = assets[assets.length - 1]
      setAdoptedReference({ id: latest.id, url: latest.url })
    })
    return () => { cancelled = true }
  }, [currentProjectPath])
  const t = useT()
  const { confirm, dialogNode } = useThemedDialog()
  const savedConfirmDefault = llmSettings?.confirm_before_execute ?? false
  useEffect(() => setConfirmThisTurn(savedConfirmDefault), [savedConfirmDefault])

  async function adoptGalleryReference(url: string | null, alt: string) {
    setAdoptError('')
    const projectAtStart = projectRef.current
    if (!url) {
      if (adoptedReference) {
        const result = await setReferenceSelection(adoptedReference.id, false)
        // S3（三轮 review）：取消与采用同守卫——项目已切换的迟到响应丢弃，
        // 不清掉新项目的显示状态，也不把旧项目的错误显示到新项目。
        if (projectRef.current !== projectAtStart) return
        if (result.ok) setAdoptedReference(null)
        else setAdoptError(result.error || t('assistant.panel.unadoptFailed'))
      }
      return
    }
    const result = await adoptReference(url, alt)
    // R3：项目已切换 → 迟到响应丢弃（不把旧项目的采用写进新项目 UI）
    if (projectRef.current !== projectAtStart) return
    if (result.ok && result.asset) {
      // F2：单选语义以后端 replace-selection 结果为准
      setAdoptedReference({ id: result.asset.id, url: url })
    } else {
      setAdoptError(result.error || t('assistant.panel.adoptFailed'))
    }
  }

  async function deleteSelectedMessages() {
    if (!selectedMessages.size || !onDeleteMessages) return
    const ok = await confirm({
      title: t('assistant.panel.deleteTitle'),
      message: t('assistant.panel.deleteMessage', { count: selectedMessages.size }),
      confirmLabel: t('assistant.panel.deleteConfirm'),
      danger: true,
    })
    if (!ok) return
    await onDeleteMessages(Array.from(selectedMessages).sort((a, b) => a - b))
    setSelectedMessages(new Set())
  }

  // P6b：store 的整理指令草稿到达 → 填入输入框、关抽屉、聚焦，绝不自动发送
  useEffect(() => {
    if (!draftSeed || busy) return
    setDraft(draftSeed)
    setAttachments([])
    setHistoryOpen(false)
    onConsumeDraftSeed?.()
    textareaRef.current?.focus()
  }, [draftSeed, busy, onConsumeDraftSeed])

  // slash command state
  const [pickerMode, setPickerMode] = useState<null | 'commands' | 'models'>(null)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [modelSwitching, setModelSwitching] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [planOnly, setPlanOnly] = useState(false)
  const legacyEntry = llmSettings?.conversation_entry === 'legacy'

  // intent indicator: computed only for the legacy entry
  const detectedIntent = useMemo(() => {
    const t = draft.trim()
    if (!legacyEntry || !t || pickerMode !== null) return null
    return detectChatIntent(t, hasProject)
  }, [draft, hasProject, pickerMode, legacyEntry])

  // slash command derived values
  const commandQuery = pickerMode === 'commands' ? draft.slice(1).toLowerCase() : ''
  const visibleCommands = SLASH_COMMANDS.filter(
    (c) => c.id.startsWith(commandQuery) && (c.id !== 'model' || (modelOptions.length > 0 && !!onSessionModelChange)),
  )
  const modelQuery = pickerMode === 'models' ? draft.toLowerCase() : ''
  const visibleModelOptions = modelOptions.filter(
    (m) => !modelQuery || m.id.toLowerCase().includes(modelQuery) || m.label.toLowerCase().includes(modelQuery),
  )
  const customModels = visibleModelOptions.filter((m) => m.kind === 'custom')
  const officialModels = visibleModelOptions.filter((m) => m.kind === 'official')

  // ── Submit ──────────────────────────────────────────────────────────────
  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    handleSend()
  }

  function handleSend() {
    if (pickerMode !== null || busy) return
    const message = draft.trim()
    if (!message) return
    const confirmForTurn = confirmThisTurn
    setDraft('')
    setPlanOnly(false)
    setConfirmThisTurn(savedConfirmDefault)
    const outgoingImages = attachments.map(({ token: _token, ...img }) => img)
    if (llmSettings) onChat(message, outgoingImages, planOnly ? 'plan' : 'auto', confirmForTurn)
    else onChat(message, outgoingImages, planOnly ? 'plan' : 'auto')
    setAttachments([])
  }

  // P4-C 空态：示例提示词只填入输入框，不自动发送
  function fillExample(example: string) {
    setDraft(example)
    textareaRef.current?.focus()
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // ESC: stop generation or close picker
    if (event.key === 'Escape') {
      if (busy) { onStop(); event.preventDefault(); return }
      if (pickerMode !== null) { closePicker(); event.preventDefault(); return }
    }

    // Ctrl+C while busy → stop (only when no text is selected)
    if (event.key === 'c' && event.ctrlKey && busy) {
      const ta = textareaRef.current
      if (ta && ta.selectionStart === ta.selectionEnd) {
        onStop()
        event.preventDefault()
        return
      }
    }

    // Picker navigation
    if (pickerMode !== null) {
      handlePickerKeyDown(event)
      return
    }

    // Enter = send (Shift+Enter inserts newline, composition in progress = skip)
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      handleSend()
    }
  }

  // ── Draft change ──────────────────────────────────────────────────────────
  function handleDraftChange(value: string) {
    setDraft(value)
    if (pickerMode === 'models') return
    if (value.startsWith('/') && !busy) {
      if (pickerMode !== 'commands') { setPickerMode('commands'); setPickerIndex(0) }
    } else {
      setPickerMode(null)
    }
    // 输入本地路径文本：拖尾为完整绝对路径（/ ~ 或盘符开头 + 图片扩展名）→ 转 chip
    const trimmed = value.trim()
    const trailing = trimmed.split(/\s+/).pop() ?? ''
    if (trailing && isImagePathText(trailing)) {
      setDraft(trimmed.slice(0, -trailing.length).trimEnd())
      attachPathImage(trailing)
    }
  }

  // ── Picker helpers ────────────────────────────────────────────────────────
  const closePicker = useCallback(() => {
    setPickerMode(null)
    setDraft('')
    textareaRef.current?.focus()
  }, [])

  function selectCommand(id: string) {
    if (id === 'model') {
      setPickerMode('models'); setDraft(''); setPickerIndex(0)
      textareaRef.current?.focus()
    }
  }

  async function selectModel(model: string) {
    if (!onSessionModelChange) return
    setModelSwitching(true)
    try { await onSessionModelChange(model) }
    catch { /* 切换失败已写入 store.lastError，由顶栏 error pill 展示 */ }
    finally {
      setModelSwitching(false); setPickerMode(null); setDraft('')
      textareaRef.current?.focus()
    }
  }

  function handlePickerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const list = pickerMode === 'commands' ? visibleCommands : visibleModelOptions
    const listLen = list.length
    if (event.key === 'ArrowDown') { setPickerIndex((i) => (i + 1) % Math.max(listLen, 1)); event.preventDefault(); return }
    if (event.key === 'ArrowUp') { setPickerIndex((i) => (i - 1 + Math.max(listLen, 1)) % Math.max(listLen, 1)); event.preventDefault(); return }
    if (event.key === 'Enter' && listLen > 0) {
      if (pickerMode === 'commands') selectCommand(visibleCommands[Math.min(pickerIndex, visibleCommands.length - 1)].id)
      else void selectModel(visibleModelOptions[Math.min(pickerIndex, visibleModelOptions.length - 1)].id)
      event.preventDefault()
    }
  }

  // ── 多图贴图（P5a）：粘贴 / 拖入 / 本地路径 ─────────────────────────────
  /** 下一个 token 编号：取现存 token 数字后缀的最大值 + 1（删除中间项后不复用编号，避免 token 撞车）。 */
  function nextTokenBase(): number {
    return attachments.reduce((max, a) => {
      const n = Number(a.token.replace('图', ''))
      return Number.isFinite(n) ? Math.max(max, n) : max
    }, 0)
  }

  function attachPathImage(pathText: string) {
    setImageError('')
    if (attachments.length >= MAX_ASSISTANT_IMAGES) {
      setImageError(t('assistant.panel.imageMax', { max: MAX_ASSISTANT_IMAGES }))
      return
    }
    const trimmed = pathText.trim()
    const token = `图${nextTokenBase() + 1}`
    setAttachments((prev) => [
      ...prev,
      { name: trimmed, path: trimmed, mime: '', b64: '', token },
    ])
    setDraft((prev) => `${prev}[${token}]`)
  }

  async function attachFiles(files: File[] | null) {
    if (!files || !files.length) return
    setImageError('')
    const room = MAX_ASSISTANT_IMAGES - attachments.length
    if (files.length > room) {
      setImageError(
        t('assistant.panel.imageRoom', { max: MAX_ASSISTANT_IMAGES, count: attachments.length, room }),
      )
      return
    }
    const validated: AssistantImageAttachment[] = []
    for (const file of files) {
      const error = validateAssistantImageFile(file)
      if (error) {
        setImageError(`${file.name}: ${error}`)
        continue
      }
      const attachment = await readFileAsAttachment(file)
      if (attachment) validated.push(attachment)
    }
    if (!validated.length) return
    const base = nextTokenBase()
    const tokens = validated.map((_, i) => `图${base + i + 1}`)
    setAttachments((prev) => [...prev, ...validated.map((img, i) => ({ ...img, token: tokens[i] }))])
    setDraft((prev) => prev + tokens.map((token) => `[${token}]`).join(''))
  }

  function readFileAsAttachment(file: File): Promise<AssistantImageAttachment | null> {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const comma = result.indexOf(',')
        resolve({
          name: file.name,
          mime: file.type || 'image/png',
          b64: comma >= 0 ? result.slice(comma + 1) : result,
        })
      }
      reader.onerror = () => {
        setImageError('Image read failed')
        resolve(null)
      }
      reader.readAsDataURL(file)
    })
  }

  function removeAttachment(token: string) {
    setAttachments((prev) => prev.filter((a) => a.token !== token))
    setDraft((prev) => prev.replace(`[${token}]`, ''))
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length) {
      event.preventDefault()
      void attachFiles(imageFiles)
      return
    }
    const text = event.clipboardData.getData('text/plain')
    if (isImagePathText(text)) {
      event.preventDefault()
      attachPathImage(text)
    }
  }

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault()
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length) void attachFiles(files)
  }


  return (
    <aside className="assistant-panel">
      <div className="panel-heading">
        <h2>AI</h2>
        <div className="assistant-heading-actions">
          <span>{busy ? t('assistant.panel.working') : t('assistant.panel.ready')}</span>
          <button type="button" disabled={messages.length === 0} onClick={() => setHistoryOpen(true)}>
            {t('assistant.panel.history')}
          </button>
          <button type="button" disabled={busy || messages.length === 0} onClick={onClearHistory}>
            {t('assistant.panel.clear')}
          </button>
          {onDeleteMessages && selectedMessages.size > 0 ? (
            <button type="button" disabled={busy} onClick={() => void deleteSelectedMessages()}>
              {t('assistant.panel.deleteSelected', { count: selectedMessages.size })}
            </button>
          ) : null}
        </div>
      </div>
      <div className="assistant-thread">
        {messages.length ? (
          messages.map((message, index) => (
            <article
              className={`assistant-message ${message.role}${message.interrupted ? ' is-interrupted' : ''}`}
              key={`${message.role}-${index}`}
            >
              {onDeleteMessages ? (
                <input
                  type="checkbox"
                  aria-label={t('assistant.panel.selectMessage', { n: index + 1 })}
                  checked={selectedMessages.has(index)}
                  onChange={(event) => {
                    setSelectedMessages((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(index)
                      else next.delete(index)
                      return next
                    })
                  }}
                />
              ) : null}
              <span>
                {message.role === 'user' ? t('assistant.panel.you') : 'OpenBrep'}
                {message.interrupted ? (
                  <em className="assistant-error-badge assistant-interrupted">{t('assistant.panel.interrupted')}</em>
                ) : message.errorCategory ? (
                  <em className={`assistant-error-badge assistant-error-${message.errorCategory}`}>
                    {errorCategoryLabel(message.errorCategory)}
                  </em>
                ) : null}
              </span>
              {message.role === 'assistant' ? (
                <>
                  <AssistantMarkdown content={message.content} />
                  <AssistantReferenceGallery
                    images={assistantMessageImages(message.content)}
                    adoptedUrl={adoptedReference?.url ?? null}
                    onAdopt={(url, alt) => void adoptGalleryReference(url, alt)}
                  />
                </>
              ) : (
                <p>{message.content}</p>
              )}
              {message.advisor && <details><summary>{t('assistant.panel.advisorSummary')}</summary>
                {message.advisor.inspection?.checks.map((check) => <p key={check.kind}>
                  {({ static: t('assistant.panel.check.static'), parameters: t('assistant.panel.check.parameters'), preview_2d: t('assistant.panel.check.preview_2d'), preview_3d: t('assistant.panel.check.preview_3d'), recent_verification: t('assistant.panel.check.recent_verification') } as Record<string, string>)[check.kind] ?? check.kind}{t('assistant.panel.colon')}
                  {({ completed: t('assistant.panel.checkStatus.completed'), partial: t('assistant.panel.checkStatus.partial'), unavailable: t('assistant.panel.checkStatus.unavailable'), not_requested: t('assistant.panel.checkStatus.not_requested') } as Record<string, string>)[check.status] ?? check.status}
                </p>)}
                {message.advisor.omitted_sections?.length ? (
                  <p className="assistant-advisor-omitted">{t('assistant.panel.advisorOmitted', { sections: message.advisor.omitted_sections.join(t('assistant.panel.listSep')) })}</p>
                ) : null}
              </details>}
              {message.advisor?.proposals?.map((proposal) => <div className="plan-confirm-card" key={proposal.proposal_id}>
                <strong>{proposal.title}</strong><p>{proposal.goal}</p>
                {proposal.tradeoffs.map((item, i) => <p key={i}>{item}</p>)}
                <button type="button" disabled={busy} onClick={() => onProposalAction?.(proposal.proposal_id, 'select')}>{t('assistant.panel.selectProposal')}</button>
                <button type="button" disabled={busy} onClick={() => onProposalAction?.(proposal.proposal_id, 'execute')}>{t('assistant.panel.executeProposal')}</button>
              </div>)}
              {message.role === 'user' && message.images?.length ? (
                <div className="assistant-message-images">
                  {message.images.map((img, i) => (
                    <span className="assistant-message-image-chip" key={`${attachmentLabel(img)}-${i}`} title={attachmentLabel(img)}>
                      {img.b64 ? (
                        <img src={`data:${img.mime || 'image/png'};base64,${img.b64}`} alt={attachmentLabel(img)} />
                      ) : (
                        <span className="assistant-message-image-icon">📁</span>
                      )}
                      <em>{attachmentLabel(img)}</em>
                    </span>
                  ))}
                </div>
              ) : null}
              {message.role === 'assistant' && message.recordingFailed ? (
                <div className="timeline-recording-failed">{t('assistant.panel.recordingFailed')}</div>
              ) : null}
              {message.role === 'assistant' && (message.thinkingSteps || message.staleTimeline) ? (
                <AssistantThinkingTimeline
                  steps={message.thinkingSteps ?? []}
                  busy={busy && index === messages.length - 1}
                  interrupted={message.interrupted}
                  startedAt={message.createdAt}
                  stale={message.staleTimeline}
                />
              ) : null}

              {/* P5d-1：读图提取卡片（只读）——schema 名 + 字段表 + 低置信高亮 +
                   critic 修正 旧→新 + 降级标记 */}
              {message.role === 'assistant' && message.visionExtractions?.length ? (
                <ExtractionCardList extractions={message.visionExtractions} />
              ) : null}

              {message.role === 'assistant' && message.turnTaskRef?.turn_id && message.turnTaskRef.run_id &&
              (message.turnTaskRef.reference_available || (messages[index - 1]?.role === 'user' && messages[index - 1].images?.length)) ? (
                <section className="assistant-visual-review">
                  <button
                    type="button"
                    disabled={busy || message.visualReviewBusy || !onReviewVisualTurn}
                    onClick={() => onReviewVisualTurn?.(message.turnTaskRef!.turn_id, Boolean(message.visualReviewRestored))}
                  >
                    {message.visualReviewBusy ? t('assistant.panel.visualBusy') : message.visualReviewRestored || message.visualReview ? t('assistant.panel.visualAgain') : t('assistant.panel.visualCompare')}
                  </button>
                  {message.visualReviewError ? <p role="alert">{message.visualReviewError}</p> : null}
                  {message.visualReview ? (
                    <div className="assistant-visual-review-report">
                      <strong>{t('assistant.panel.visualTitle')} {message.visualReview.status === 'partial' ? t('assistant.panel.visualPartial') : t('assistant.panel.visualDone')}</strong>
                      {message.visualReviewRestored ? <p>{t('assistant.panel.visualRestored')}</p> : null}
                      <p>{t('assistant.panel.visualDisclaimer')}</p>
                      {message.visualReview.coverage.map((item) => (
                        <p key={item.target_id}>{item.target_id}：{item.status}</p>
                      ))}
                      {message.visualReview.findings.map((finding) => (
                        <div key={finding.finding_id}>
                          <p><b>{finding.outcome === 'fail' ? t('assistant.panel.findingFail') : finding.outcome === 'unknown' ? t('assistant.panel.findingUnknown') : t('assistant.panel.findingNote')}</b> · {finding.summary}</p>
                          {finding.uncertainty ? <small>{finding.uncertainty}</small> : null}
                          {finding.evidence.map((evidence) => (
                            <small key={`${finding.finding_id}-${evidence.frame_id}`}>{t('assistant.panel.evidence')}{evidence.view_id || evidence.frame_id}{evidence.note ? ` · ${evidence.note}` : ''}</small>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {message.changedFiles?.length ? (
                <div className="assistant-change-card">
                  <strong>{t('assistant.panel.changedFiles')}</strong>
                  <div className="assistant-change-files">
                    {message.changedFiles.map((file) => (
                      <button
                        type="button"
                        key={file}
                        disabled={busy || !onOpenScript}
                        title={`Open ${file} in the editor`}
                        onClick={() => onOpenScript?.(file.split('/').pop() ?? file)}
                      >
                        {file}
                      </button>
                    ))}
                  </div>
                  {onSaveRevision ? (
                    <button
                      type="button"
                      className="assistant-save-revision"
                      disabled={busy}
                      onClick={() => onSaveRevision(revisionMessageFor(messages, index))}
                    >
                      {t('assistant.panel.saveRevision')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {message.delivery ? (
                <DeliveryCard
                  delivery={message.delivery}
                  originalInstruction={message.originalInstruction || findOriginalInstruction(messages, index)}
                  busy={busy}
                  onRecover={
                    onRecoverDelivery
                      ? (policy) => onRecoverDelivery(message.delivery!, policy)
                      : undefined
                  }
                  onViewDiff={
                    onViewDeliveryDiff && message.delivery
                      ? () => onViewDeliveryDiff(message.delivery!)
                      : undefined
                  }
                  onContinue={
                    onContinueDelivery && message.delivery
                      ? () =>
                          onContinueDelivery({
                            originRunId: message.delivery!.run_id ?? message.runId ?? null,
                            originalInstruction:
                              message.originalInstruction ||
                              findOriginalInstruction(messages, index) ||
                              message.delivery!.original_instruction ||
                              '',
                            presentation: message.delivery!,
                          })
                      : undefined
                  }
                />
              ) : null}
              {message.verification ? (
                <VerificationCard
                  report={message.verification}
                  onRevealLine={onRevealLine}
                  suppressAutoFixLabel={shouldSuppressAutoFixLabel(message.delivery)}
                />
              ) : null}
              {message.acceptance ? <AcceptanceCard acceptance={message.acceptance} /> : null}
              {message.role === 'assistant' && message.content.includes('```') ? (
                <button type="button" disabled={busy} onClick={() => onAdoptCode(index)}>
                  {t('assistant.panel.adoptCode')}
                </button>
              ) : null}
            </article>
          ))
        ) : (
          <PanelEmpty icon="✦" title={t('assistant.empty.title')} hint={t('assistant.empty.hint')}>
            <div className="panel-empty-examples">
              <button type="button" onClick={() => fillExample(t('assistant.empty.example.generate'))}>
                {t('assistant.empty.example.generate')}
              </button>
              <button type="button" onClick={() => fillExample(t('assistant.empty.example.modify'))}>
                {t('assistant.empty.example.modify')}
              </button>
              <button type="button" onClick={() => fillExample(t('assistant.empty.example.explain'))}>
                {t('assistant.empty.example.explain')}
              </button>
            </div>
          </PanelEmpty>
        )}
        {pendingPlan ? <PlanConfirmCard plan={pendingPlan} busy={busy} onConfirm={onConfirmPlan} onRevise={onRevisePlan} /> : null}
        {pendingExtraction ? (
          <ExtractionConfirmCard
            extractions={pendingExtraction.extractions}
            busy={busy}
            onConfirm={(extractions) => onConfirmExtraction?.(extractions, true)}
            onCancel={() => onConfirmExtraction?.([], false)}
          />
        ) : null}
        {pendingSkillProposal ? (
          <SkillProposalCard proposal={pendingSkillProposal} busy={busy} onConfirm={onConfirmSkillProposal} />
        ) : null}
      </div>
      {dialogNode}
      <form className="assistant-input" aria-label={t('assistant.panel.inputAria')} onSubmit={submitMessage} onDragOver={handleDragOver} onDrop={handleDrop}>
        <div className="assistant-input-wrap">
          {pickerMode === 'commands' && visibleCommands.length > 0 && (
            <div className="slash-picker" role="listbox" aria-label={t('assistant.panel.commandsAria')}>
              <div className="slash-picker-header">{t('assistant.panel.commands')}</div>
              {visibleCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={i === pickerIndex % visibleCommands.length}
                  className={`slash-picker-item${i === pickerIndex % visibleCommands.length ? ' is-active' : ''}`}
                  onClick={() => selectCommand(cmd.id)}
                >
                  <span className="slash-picker-label">{cmd.label}</span>
                  <span className="slash-picker-desc">{cmd.id === 'model' ? t('assistant.panel.cmdModel') : cmd.description}</span>
                </button>
              ))}
            </div>
          )}
          {pickerMode === 'models' && (
            <div className="slash-picker slash-picker--models" role="listbox" aria-label={t('assistant.panel.modelsAria')}>
              <div className="slash-picker-header">
                {t('assistant.panel.chooseModel')}
                {modelSwitching && <span className="slash-picker-loading">{t('assistant.panel.switching')}</span>}
              </div>
              {visibleModelOptions.length === 0 ? (
                <p className="slash-picker-empty">{t('assistant.panel.noModel')}</p>
              ) : (
                <>
                  {customModels.length > 0 && (
                    <ModelGroup
                      label={t('assistant.panel.customModels')}
                      options={customModels}
                      flatOffset={0}
                      currentModel={currentModel}
                      pickerIndex={pickerIndex}
                      totalVisible={visibleModelOptions.length}
                      modelSwitching={modelSwitching}
                      onSelect={selectModel}
                    />
                  )}
                  {officialModels.length > 0 && (
                    <ModelGroup
                      label={t('assistant.panel.officialModels')}
                      options={officialModels}
                      flatOffset={customModels.length}
                      currentModel={currentModel}
                      pickerIndex={pickerIndex}
                      totalVisible={visibleModelOptions.length}
                      modelSwitching={modelSwitching}
                      onSelect={selectModel}
                    />
                  )}
                </>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={3}
            aria-label={t('assistant.panel.askAria')}
            placeholder={
              pickerMode === 'models'
                ? t('assistant.panel.filterPlaceholder')
                : busy
                  ? t('assistant.panel.busyPlaceholder')
                  : interruptedContext
                    ? t('assistant.panel.interruptedPlaceholder')
                    : t('assistant.panel.placeholder')
            }
            value={draft}
            disabled={modelSwitching}
            onChange={(event) => handleDraftChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </div>
        {attachments.length ? (
          <div className="assistant-attachment-chips">
            {attachments.map((img) => (
              <span className={`assistant-image-chip${img.path ? ' is-path' : ''}`} key={img.token}>
                {img.b64 ? (
                  <img
                    className="assistant-image-chip-thumb"
                    src={`data:${img.mime || 'image/png'};base64,${img.b64}`}
                    alt=""
                  />
                ) : (
                  <span className="assistant-image-chip-icon">📁</span>
                )}
                <span className="assistant-image-chip-label">
                  {img.token}: {attachmentLabel(img)}
                </span>
                <button
                  type="button"
                  className="assistant-image-chip-remove"
                  disabled={busy}
                  aria-label={`Remove image ${img.token}`}
                  title={t('assistant.panel.removeImage', { token: img.token })}
                  onClick={() => removeAttachment(img.token)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="assistant-attachment-row">
          <label className="assistant-attach-button">
            {t('assistant.panel.attachImage')}
            <input
              type="file"
              aria-label={t('assistant.panel.attachImage')}
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(event) => {
                void attachFiles(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ''
              }}
            />
          </label>
          {attachments.length ? (
            <span className="assistant-attach-count">{attachments.length}/{MAX_ASSISTANT_IMAGES}</span>
          ) : (
            <span>{'Paste, drop, or type a local image path'}</span>
          )}
          {imageError ? <span className="assistant-attach-error">{imageError}</span> : null}
          {adoptError ? <span className="assistant-attach-error">{adoptError}</span> : null}
        </div>
        {llmSettings && onSessionModelChange && onResetSessionModel && onOpenModelSettings ? (
          <div className="assistant-model-row">
            <ModelPill
              llmSettings={llmSettings}
              codex={codexCatalog ?? { connected: false, models: [], loaded: false }}
              disabled={busy}
              onSwitch={onSessionModelChange}
              onReset={onResetSessionModel}
              onEditVisibility={onOpenModelSettings}
              onOpen={() => void onLoadCodexCatalog?.()}
            />
          </div>
        ) : null}
        <div className="assistant-footer-row">
          {detectedIntent && !busy && (
            <span className={`chat-intent-badge intent-${detectedIntent}`}>
              → {INTENT_LABELS[detectedIntent]}
            </span>
          )}
          {interruptedContext && !busy && (
            <button
              type="button"
              className="chat-resume-btn"
              onClick={() => { onChat('继续'); }}
            >
              {t('assistant.panel.retry')}
            </button>
          )}
          {!legacyEntry && <button type="button" aria-pressed={planOnly} disabled={busy}
            onClick={() => setPlanOnly(!planOnly)}>{t('assistant.panel.planOnly')}{planOnly ? ' ✓' : ''}</button>}
          {!legacyEntry && <button type="button" aria-pressed={confirmThisTurn} disabled={busy}
            aria-label={t('assistant.panel.approvalAria')} title={t('assistant.panel.approvalTitle')}
            onClick={() => setConfirmThisTurn(!confirmThisTurn)}>
            {confirmThisTurn ? t('assistant.panel.approveThenRun') : t('assistant.panel.autoRun')}
          </button>}
          <div className="assistant-actions">
            {busy ? (
              <button type="button" className="chat-stop-btn" onClick={onStop}>
                {t('assistant.panel.stop')}
              </button>
            ) : (
              <button type="submit" className="chat-send-btn" disabled={draft.trim().length === 0}>
                {t('assistant.panel.send')}
              </button>
            )}
          </div>
        </div>
      </form>
      <AssistantHistoryDrawer
        open={historyOpen}
        messages={messages}
        busy={busy}
        hasProject={hasProject}
        workspace={workspace}
        currentProjectPath={currentProjectPath}
        onClose={() => setHistoryOpen(false)}
        onAdoptCode={onAdoptCode}
        onImportAssistantHistory={onImportAssistantHistory}
        onDistillAssistantHistory={onDistillAssistantHistory}
      />
    </aside>
  )
}

function errorCategoryLabel(category: NonNullable<AssistantMessage['errorCategory']>) {
  if (category === 'llm') return 'LLM settings'
  if (category === 'compile') return 'Compile'
  return 'Error'
}

/** ST03：continue 用的原始指令（消息字段优先，否则取最近一条 user 消息全文） */
function findOriginalInstruction(messages: AssistantMessage[], assistantIndex: number): string {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return messages[index].content.trim()
    }
  }
  return ''
}

// revision 信息取触发本次生成的用户指令（往前找最近一条 user 消息），截断防止过长
function revisionMessageFor(messages: AssistantMessage[], assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      const instruction = messages[index].content.trim()
      return `AI: ${instruction.length > 60 ? `${instruction.slice(0, 60)}…` : instruction}`
    }
  }
  return 'AI generated changes'
}

function checkIcon(status: string): string {
  if (status === 'pass') return '✅'
  if (status === 'fail') return '❌'
  if (status === 'warn') return '⚠️'
  if (status === 'skipped') return '⏭'
  return '•'
}

function AcceptanceCard({ acceptance }: { acceptance: ModifyAcceptance }) {
  const t = useT()
  const delta = acceptance.geometry_delta
  const meshFrom = delta.mesh_count?.from
  const meshTo = delta.mesh_count?.to
  const bboxFrom = delta.bbox_size?.from
  const bboxTo = delta.bbox_size?.to
  const countsFrom = delta.counts_2d?.from
  const countsTo = delta.counts_2d?.to
  const hasGeometryCompare =
    meshFrom !== undefined || meshTo !== undefined ||
    bboxFrom !== undefined || bboxTo !== undefined ||
    countsFrom !== undefined || countsTo !== undefined
  return (
    <div className="acceptance-card">
      <strong className="acceptance-title">{t('assistant.acceptance.title')}</strong>
      {acceptance.effect && acceptance.effect.status !== 'satisfied' ? (
        <p className={`acceptance-effect effect-${acceptance.effect.status}`}>
          {t('assistant.panel.effectMissed', { kind: acceptance.effect.change_kind, reason: acceptance.effect.reason })}
        </p>
      ) : null}
      {acceptance.summary_lines?.length ? (
        <ul className="acceptance-summary">
          {acceptance.summary_lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {hasGeometryCompare ? (
        <div className="acceptance-geometry">
          <strong>{t('assistant.acceptance.geometry')}</strong>
          <table className="acceptance-geometry-table">
            <thead>
              <tr>
                <th />
                <th>{t('assistant.acceptance.before')}</th>
                <th>{t('assistant.acceptance.after')}</th>
              </tr>
            </thead>
            <tbody>
              {meshFrom !== undefined || meshTo !== undefined ? (
                <tr>
                  <td>{t('assistant.acceptance.meshCount')}</td>
                  <td>{meshFrom ?? '—'}</td>
                  <td>{meshTo ?? '—'}</td>
                </tr>
              ) : null}
              {bboxFrom !== undefined || bboxTo !== undefined ? (
                <tr>
                  <td>{t('assistant.acceptance.bbox')}</td>
                  <td>{formatSize(bboxFrom)}</td>
                  <td>{formatSize(bboxTo)}</td>
                </tr>
              ) : null}
              {countsFrom !== undefined || countsTo !== undefined ? (
                <tr>
                  <td>{t('assistant.acceptance.counts2d')}</td>
                  <td>{formatCounts(countsFrom)}</td>
                  <td>{formatCounts(countsTo)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {delta.reason ? <p className="acceptance-geometry-note">{delta.reason}</p> : null}
        </div>
      ) : null}
      {acceptance.checks?.length ? (
        <ul className="acceptance-checks">
          {acceptance.checks.map((check, i) => (
            <li key={i} className={`acceptance-check status-${check.status}`}>
              <span className="acceptance-check-icon">{checkIcon(check.status)}</span>
              <span className="acceptance-check-name">{check.name}</span>
              <span className="acceptance-check-detail">{check.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function formatSize(size?: number[] | null): string {
  if (!size || !size.length) return '—'
  return size.map((v) => Number(v.toFixed(3))).join('×')
}

function formatCounts(counts?: { lines: number; polygons: number; circles: number; arcs: number } | null): string {
  if (!counts) return '—'
  return `${counts.lines}/${counts.polygons}/${counts.circles}/${counts.arcs}`
}

function PlanConfirmCard({
  plan,
  busy,
  onConfirm,
  onRevise,
}: {
  plan: PendingPlan
  busy: boolean
  onConfirm?: (approve: boolean) => void
  onRevise?: (instruction: string) => void
}) {
  const t = useT()
  const [revisionInstruction, setRevisionInstruction] = useState('')
  const planNeedsInput = (plan.typed_plan as { status?: unknown } | undefined)?.status === 'needs_input'
  return (
    <div className="plan-confirm-card" role="group" aria-label={t('assistant.plan.title')}>
      <div className="plan-confirm-header">
        <strong>{t('assistant.plan.title')}</strong>
        <span className="plan-confirm-risk">{t('assistant.plan.risk')}: {plan.risk || '无'}</span>
      </div>
      {plan.restored_display_only ? <p className="plan-confirm-risk">{t('assistant.plan.restoredReadOnly')}</p> : null}
      <p className="plan-confirm-intent">{plan.intent_summary}</p>
      {planNeedsInput ? <p className="plan-confirm-risk">{t('assistant.plan.needsInput')}</p> : null}
      {plan.user_visible_changes.length ? (
        <div className="plan-confirm-section">
          <strong>{t('assistant.plan.userChanges')}</strong>
          <ul>
            {plan.user_visible_changes.map((change, i) => (
              <li key={i}>{change}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.change_delta?.length ? (
        <div className="plan-confirm-section">
          <strong>{t('assistant.plan.delta')}</strong>
          <ul>{plan.change_delta.map((change, i) => <li key={i}>{change}</li>)}</ul>
        </div>
      ) : null}
      {plan.preserved_constraints?.length ? (
        <div className="plan-confirm-section">
          <strong>{t('assistant.plan.preserved')}</strong>
          <ul>{plan.preserved_constraints.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      ) : null}
      {plan.affected_files.length ? (
        <div className="plan-confirm-section">
          <strong>{t('assistant.plan.affectedFiles')}</strong>
          <ul>
            {plan.affected_files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {(['constraints', 'assumptions', 'acceptance_criteria'] as const).map((key) => plan[key]?.length ?
        <div className="plan-confirm-section" key={key}>
          <strong>{{ constraints: '必须遵守', assumptions: '采用的假设', acceptance_criteria: '验收条件' }[key]}</strong>
          <ul>{plan[key]!.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div> : null)}
      {plan.typed_plan || plan.object_plan ? (
        <details className="plan-confirm-section">
          <summary>{t('assistant.plan.typedDetails')}</summary>
          <pre>{JSON.stringify({ object_plan: plan.object_plan, typed_plan: plan.typed_plan }, null, 2)}</pre>
        </details>
      ) : null}
      {onRevise ? (
        <div className="plan-confirm-section">
          <label>
            <strong>{t('assistant.plan.revisionLabel')}</strong>
            <textarea
              aria-label={t('assistant.plan.revisionLabel')}
              value={revisionInstruction}
              disabled={busy}
              onChange={(event) => setRevisionInstruction(event.currentTarget.value)}
              placeholder={t('assistant.plan.revisionPlaceholder')}
              rows={2}
            />
          </label>
          <button type="button" disabled={busy || !revisionInstruction.trim()}
            onClick={() => {
              onRevise(revisionInstruction.trim())
              setRevisionInstruction('')
            }}>
            {t('assistant.plan.revise')}
          </button>
        </div>
      ) : null}
      <div className="plan-confirm-actions">
        <button type="button" className="plan-confirm-approve" disabled={busy || planNeedsInput || plan.restored_display_only} onClick={() => onConfirm?.(true)}>
          {t('assistant.plan.confirm')}
        </button>
        <button type="button" className="plan-confirm-reject" disabled={busy} onClick={() => onConfirm?.(false)}>
          {t('assistant.plan.cancel')}
        </button>
      </div>
    </div>
  )
}

function SkillProposalCard({
  proposal,
  busy,
  onConfirm,
}: {
  proposal: SkillProposal
  busy: boolean
  onConfirm?: (approve: boolean) => void
}) {
  const t = useT()
  const evidence = proposal.evidence ?? null
  const revisions = evidence?.revisions ?? []
  const evidenceNote = evidence
    ? evidence.evidence_complete
      ? t('assistant.skillProposal.evidenceComplete', { rev: revisions[0] ?? '-' })
      : t('assistant.skillProposal.evidenceIncomplete')
    : null
  return (
    <div className="skill-proposal-card" role="group" aria-label={t('assistant.skillProposal.title')}>
      <div className="skill-proposal-header">
        <strong>{t('assistant.skillProposal.title')}</strong>
        <span className="skill-proposal-type">{proposal.pattern_type}</span>
      </div>
      <p className="skill-proposal-name">{proposal.name}</p>
      {proposal.status || evidenceNote ? (
        <p className="skill-proposal-status">
          {proposal.status ? `${t('assistant.skillProposal.status')}: ${proposal.status}` : null}
          {proposal.status && evidenceNote ? ' · ' : null}
          {evidenceNote}
        </p>
      ) : null}
      {proposal.claims?.unverified?.length ? (
        <p className="skill-proposal-claims">
          ⚠ {t('assistant.skillProposal.claimsUnverified')}
          {': '}
          {(proposal.claims.unverified ?? [])
            .map((claim) => claim.snippet ?? claim.kind ?? '')
            .filter(Boolean)
            .slice(0, 2)
            .join(' / ')}
        </p>
      ) : null}
      <pre className="skill-proposal-content">{proposal.content}</pre>
      {evidence && (evidence.changed_files?.length || evidence.project || evidence.source_run_ids?.length) ? (
        <div className="skill-proposal-section">
          <strong>{t('assistant.skillProposal.evidence')}</strong>
          <ul>
            {evidence.project ? <li>{t('assistant.skillProposal.project')}: {evidence.project}</li> : null}
            {(evidence.source_run_ids ?? []).map((run, i) => (
              <li key={`${run}-${i}`}>{run}</li>
            ))}
            {(evidence.changed_files ?? []).map((file, i) => (
              <li key={`${file}-${i}`}>{file}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="skill-proposal-actions">
        {proposal.status !== 'rejecting' ? (
          <button
            type="button"
            className="plan-confirm-approve"
            disabled={busy}
            onClick={() => onConfirm?.(true)}
          >
            {t('assistant.skillProposal.approve')}
          </button>
        ) : null}
        <button
          type="button"
          className="plan-confirm-reject"
          disabled={busy}
          onClick={() => onConfirm?.(false)}
        >
          {t('assistant.skillProposal.ignore')}
        </button>
      </div>
    </div>
  )
}

function AssistantHistoryDrawer({
  open,
  messages,
  busy,
  hasProject,
  workspace,
  currentProjectPath,
  onClose,
  onAdoptCode,
  onImportAssistantHistory,
  onDistillAssistantHistory,
}: {
  open: boolean
  messages: AssistantMessage[]
  busy: boolean
  hasProject: boolean
  workspace?: WorkspaceInfo | null
  currentProjectPath?: string | null
  onClose: () => void
  onAdoptCode: (index: number) => void
  onImportAssistantHistory?: (sourcePath: string) => void
  onDistillAssistantHistory?: () => void | Promise<void>
}) {
  const t = useT()
  const { confirm, dialogNode } = useThemedDialog()
  const [importOpen, setImportOpen] = useState(false)
  const [distilling, setDistilling] = useState(false)
  if (!open) return null

  // P6a：源项目候选 = 工作区项目里排除当前项目
  const candidates = (workspace?.projects ?? []).filter((project) => project.path !== currentProjectPath)

  async function pickSource(sourcePath: string, sourceName: string) {
    setImportOpen(false)
    const confirmed = await confirm({
      title: t('assistant.history.importConfirmTitle'),
      message: t('assistant.history.importConfirmMessage', {
        source: sourceName,
        current: currentProjectPath?.split('/').filter(Boolean).pop() ?? '',
      }),
      confirmLabel: t('assistant.history.importConfirmLabel'),
    })
    if (!confirmed) return
    onImportAssistantHistory?.(sourcePath)
  }

  // P6b：LLM 整理中禁用按钮，防止重复点击；结果经 store 草稿通道填入输入框
  async function handleDistill() {
    if (distilling) return
    setDistilling(true)
    try {
      await onDistillAssistantHistory?.()
    } finally {
      setDistilling(false)
    }
  }

  return (
    <>
      <button className="history-scrim" type="button" aria-label={t('assistant.panel.closeHistoryAria')} onClick={onClose} />
      <aside className="assistant-history-drawer" role="dialog" aria-label={t('assistant.panel.historyAria')}>
        <div className="history-header-wrap">
          <div className="history-header">
            <div>
              <strong>{t('assistant.panel.history')}</strong>
              <span>{t('assistant.panel.messageCount', { count: messages.length })}</span>
            </div>
            <div className="history-header-actions">
              <button
                type="button"
                disabled={!hasProject || messages.length === 0 || distilling}
                title={
                  !hasProject
                    ? t('assistant.history.distillNoProject')
                    : messages.length === 0
                      ? t('assistant.history.distillNoHistory')
                      : t('assistant.history.distillTitle')
                }
                onClick={() => void handleDistill()}
              >
                {distilling ? t('assistant.history.distillBusy') : t('assistant.history.distill')}
              </button>
              <button
                type="button"
                disabled={!hasProject}
                title={hasProject ? t('assistant.history.importTitle') : t('assistant.history.importDisabledTitle')}
                onClick={() => setImportOpen((openImport) => !openImport)}
              >
                {t('assistant.history.import')}
              </button>
              <button type="button" onClick={onClose}>
                {t('assistant.panel.close')}
              </button>
            </div>
          </div>
          {importOpen ? (
            <div className="history-import" role="group" aria-label={t('assistant.history.importTitle')}>
              <div className="history-import-title">{t('assistant.history.importTitle')}</div>
              {!workspace ? (
                <div className="history-import-hint">{t('assistant.history.importHintNoWorkspace')}</div>
              ) : candidates.length === 0 ? (
                <div className="history-import-hint">{t('assistant.history.importNoSources')}</div>
              ) : (
                <div className="history-import-list">
                  {candidates.map((project) => (
                    <button
                      type="button"
                      key={project.path}
                      className="history-import-item"
                      aria-label={t('assistant.history.importSourceAria', { name: project.name })}
                      onClick={() => void pickSource(project.path, project.name)}
                    >
                      <span className="history-import-name">{project.name}</span>
                      <span className="history-import-path">{project.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
        <div className="history-list">
          {messages.map((message, index) => (
            <article className={`history-message ${message.role}`} key={`${message.role}-${index}`}>
              <div className="history-message-meta">
                <span>{message.role === 'user' ? t('assistant.panel.you') : 'OpenBrep'}</span>
                <em>#{index + 1}</em>
              </div>
              <AssistantMarkdown content={message.content} />
              {message.role === 'assistant' && message.content.includes('```') ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Adopt code from message ${index + 1}`}
                  onClick={() => onAdoptCode(index)}
                >
                  {t('assistant.panel.adoptCode')}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </aside>
      {dialogNode}
    </>
  )
}

// ── Model group for slash picker ─────────────────────────────────────────
function ModelGroup({
  label,
  options,
  flatOffset,
  currentModel,
  pickerIndex,
  totalVisible,
  modelSwitching,
  onSelect,
}: {
  label: string
  options: LlmModelOption[]
  flatOffset: number
  currentModel: string
  pickerIndex: number
  totalVisible: number
  modelSwitching: boolean
  onSelect: (id: string) => void
}) {
  const t = useT()
  return (
    <>
      <div className="slash-picker-group-label">{label}</div>
      {options.map((opt, localIdx) => {
        const flatIdx = flatOffset + localIdx
        const isActive = flatIdx === pickerIndex % Math.max(totalVisible, 1)
        return (
          <button
            key={opt.id}
            type="button"
            role="option"
            aria-selected={isActive}
            disabled={modelSwitching}
            className={`slash-picker-item${isActive ? ' is-active' : ''}${opt.id === currentModel ? ' is-current' : ''}`}
            onClick={() => onSelect(opt.id)}
          >
            <span className="slash-picker-label">{opt.label}</span>
            <span className="slash-picker-desc">{opt.provider}</span>
            {opt.id === currentModel && <span className="slash-picker-badge">{t('assistant.panel.current')}</span>}
          </button>
        )
      })}
    </>
  )
}

// ── Verification evidence card ────────────────────────────────────────────
// Shows the self-correcting agent's proof-oriented report: what was checked,
// pass/fail/unknown counts, compile status, confidence, and residual risks.
// Compact by design — detailed evidence stays in trace/revision files.
const STATUS_ICON: Record<string, string> = {
  pass: '✅',
  fail: '❌',
  unknown: '❓',
  not_run: '⏸️',
}

function VerificationCard({
  report,
  onRevealLine,
  suppressAutoFixLabel = false,
}: {
  report: VerificationReport
  onRevealLine?: (scriptName: string, lineNumber: number) => void
  /** ST03：delivery 表明未产生源码变化/未完成时，不显示「已修复」 */
  suppressAutoFixLabel?: boolean
}) {
  const t = useT()
  const compileCheck = report.checks.find((c) => c.check_type === 'compile')
  const isSkippedNoCompiler =
    compileCheck?.status === 'not_run' &&
    compileCheck.detail.includes('SKIPPED_NO_COMPILER')
  const compileLabel = compileCheck
    ? `${STATUS_ICON[compileCheck.status] ?? '❓'} ${
        compileCheck.status === 'pass'
          ? t('assistant.verify.compilePass')
          : compileCheck.status === 'fail'
            ? t('assistant.verify.compileFail')
            : compileCheck.status === 'not_run'
              ? isSkippedNoCompiler ? t('assistant.verify.noCompiler') : t('assistant.verify.notCompiled')
              : t('assistant.verify.unknown')
      }`
    : null
  const failedChecks = report.checks.filter((c) => c.status === 'fail')
  const unknownChecks = report.checks.filter(
    (c) => c.status === 'unknown' || (c.status === 'not_run' && !isSkippedNoCompiler),
  )
  // 编译失败时的行级错误列表
  const compileLineErrors = compileCheck?.line_errors ?? []

  return (
    <div className={`assistant-verification ${report.passed ? 'is-pass' : 'is-fail'}`}>
      <div className="assistant-verification-header">
        <strong>{t('assistant.verify.title')}</strong>
        <em className={`assistant-verification-confidence confidence-${report.confidence}`}>
          {t('assistant.verify.confidence')} {({ high: t('assistant.verify.confidence.high'), medium: t('assistant.verify.confidence.medium'), low: t('assistant.verify.confidence.low') } as Record<string, string>)[report.confidence] ?? report.confidence}
        </em>
        {report.graph_powered ? (
          <span className="assistant-verification-graph-badge" title={t('assistant.verify.graphTitle')}>
            {t('assistant.verify.graph')}
          </span>
        ) : null}
      </div>
      <div className="assistant-verification-counts">
        <span>✅ {report.counts.pass ?? 0}</span>
        <span>❌ {report.counts.fail ?? 0}</span>
        <span>❓ {report.counts.unknown ?? 0}</span>
        <span>⏸️ {report.counts.not_run ?? 0}</span>
        {compileLabel ? <span className="assistant-verification-compile">{compileLabel}</span> : null}
      </div>
      {isSkippedNoCompiler ? (
        <p className="assistant-verification-no-compiler">
          {t('assistant.verify.noCompilerHint')}
        </p>
      ) : null}
      {report.fixes_applied.length && !suppressAutoFixLabel ? (
        <p className="assistant-verification-fixes">
          {t('assistant.verify.fixed')}{report.fixes_applied.slice(0, 2).join(t('assistant.verify.sep'))}
        </p>
      ) : null}
      {failedChecks.length ? (
        <ul className="assistant-verification-fails">
          {failedChecks.slice(0, 3).map((c, i) => (
            <li key={i}>❌ {c.name}{t('assistant.panel.colon')}{c.detail}</li>
          ))}
        </ul>
      ) : null}
      {compileLineErrors.length ? (
        <ul className="assistant-verification-line-errors">
          {compileLineErrors.slice(0, 5).map((e, i) => (
            <li key={i}>
              {onRevealLine ? (
                <button
                  type="button"
                  className="verification-line-error-link"
                  onClick={() => onRevealLine('3d.gdl', e.line_number)}
                  title={t('assistant.verify.jumpLine', { line: e.line_number })}
                >
                  {t('assistant.verify.lineError', { line: e.line_number, message: e.message })}
                </button>
              ) : (
                <span>{t('assistant.verify.lineError', { line: e.line_number, message: e.message })}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {unknownChecks.length ? (
        <p className="assistant-verification-unknowns">
          {t('assistant.verify.uncovered', { count: unknownChecks.length })}
        </p>
      ) : null}
      {report.remaining_risks.length ? (
        <p className="assistant-verification-risks">
          {t('assistant.verify.risks')}{report.remaining_risks.slice(0, 2).join(t('assistant.verify.sep'))}
        </p>
      ) : null}
    </div>
  )
}
