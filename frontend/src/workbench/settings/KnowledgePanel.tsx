import type { KnowledgeStatus } from '../../api/types'
import { useT } from '../../i18n'

interface KnowledgePanelProps {
  status: KnowledgeStatus | null
  busy: boolean
  onRefresh: () => void
  onReload: () => void
}

export function KnowledgePanel({ status, busy, onRefresh, onReload }: KnowledgePanelProps) {
  const t = useT()
  return (
    <div className="knowledge-panel settings-section-body">
      <div className="knowledge-actions">
        <button
          type="button"
          className="settings-icon-btn"
          title={t('settings.knowledge.refreshTitle')}
          disabled={busy}
          onClick={onRefresh}
        >
          ↺
        </button>
        <button
          type="button"
          className="settings-save-btn"
          title={t('settings.knowledge.reloadTitle')}
          disabled={busy}
          onClick={onReload}
        >
          {busy ? t('settings.knowledge.reloading') : t('settings.knowledge.reload')}
        </button>
      </div>

      {status == null ? (
        <p className="knowledge-hint">{t('ui.loadingEn')}</p>
      ) : !status.ok ? (
        <p className="knowledge-error">{status.error ?? 'Failed to load knowledge status.'}</p>
      ) : (
        <>
          <div className="knowledge-tier-row">
            <span className="knowledge-badge knowledge-badge-free">{t('settings.knowledge.free')}</span>
            <span className="knowledge-count">{t('settings.knowledge.docs', { count: status.free_doc_count })}</span>
          </div>

          <div className="knowledge-tier-row">
            <span className={`knowledge-badge ${status.has_pro ? 'knowledge-badge-pro' : 'knowledge-badge-inactive'}`}>
              Pro {status.has_pro ? '✓' : '—'}
            </span>
            <span className="knowledge-count">{t('settings.knowledge.docs', { count: status.pro_doc_count })}</span>
          </div>

          {!status.has_pro && (
            <div className="knowledge-hint">
              <p>{t('settings.knowledge.putPro')}</p>
              <code className="knowledge-path">{status.pro_dir}</code>
            </div>
          )}

          {status.has_pro && status.pro_doc_names.length > 0 && (
            <details className="knowledge-pro-list">
              <summary>{t('settings.knowledge.proLoaded', { count: status.pro_doc_count })}</summary>
              <ul>
                {status.pro_doc_names.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}
