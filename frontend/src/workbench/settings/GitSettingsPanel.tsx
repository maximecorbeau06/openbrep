import type { ProjectGitStatus } from '../../api/types'
import { useT } from '../../i18n'

interface GitSettingsPanelProps {
  gitStatus: ProjectGitStatus | null
  gitBusy: boolean
  message: string
  onMessageChange: (message: string) => void
  onRefresh: () => void
  onInitialize: () => void
  onSetEnabled: (enabled: boolean) => void
  onCommit: (message: string) => void
}

export function GitSettingsPanel({
  gitStatus,
  gitBusy,
  message,
  onMessageChange,
  onRefresh,
  onInitialize,
  onSetEnabled,
  onCommit,
}: GitSettingsPanelProps) {
  const t = useT()
  return (
    <>
      <label className="settings-row">
        <span>{t('settings.git.enabled')}</span>
        <input
          type="checkbox"
          checked={Boolean(gitStatus?.enabled)}
          disabled={gitBusy || !gitStatus?.initialized}
          onChange={(event) => onSetEnabled(event.currentTarget.checked)}
        />
      </label>
      <div className="settings-metadata-grid">
        <span>{t('settings.git.repo')}</span>
        <strong>{gitStatus?.initialized ? 'Initialized' : 'Not initialized'}</strong>
        <span>{t('settings.git.status')}</span>
        <strong>{gitStatus?.dirty ? t('settings.git.changes', { count: gitStatus.changes.length }) : t('settings.git.clean')}</strong>
        <span>{t('settings.git.last')}</span>
        <strong>{gitStatus?.last_commit || '-'}</strong>
      </div>
      {gitStatus?.changes.length ? (
        <div className="settings-code-list">
          {gitStatus.changes.slice(0, 8).map((change) => (
            <code key={change}>{change}</code>
          ))}
        </div>
      ) : null}
      <label className="settings-field">
        <span>{t('settings.git.message')}</span>
        <input type="text" value={message} onChange={(event) => onMessageChange(event.currentTarget.value)} />
      </label>
      <div className="settings-submit-row">
        <button type="button" disabled={gitBusy || Boolean(gitStatus?.initialized)} onClick={onInitialize}>
          {t('settings.git.init')}
        </button>
        <button
          type="button"
          disabled={gitBusy || !gitStatus?.initialized || !gitStatus?.enabled}
          onClick={() => onCommit(message)}
        >
          {t('settings.git.commit')}
        </button>
        <button type="button" disabled={gitBusy} onClick={onRefresh}>
          {t('ui.refresh')}
        </button>
      </div>
    </>
  )
}
