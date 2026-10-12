import type { RecentProject } from '../../api/types'
import { useT } from '../../i18n'

interface WorkspaceSettingsPanelProps {
  recentProjects: RecentProject[]
  onOpenProjectPath: (path: string) => void
  onExportHsfProject: () => void
  onResetCurrentProject: () => void
}

export function WorkspaceSettingsPanel({
  recentProjects,
  onOpenProjectPath,
  onExportHsfProject,
  onResetCurrentProject,
}: WorkspaceSettingsPanelProps) {
  const t = useT()
  return (
    <>
      <div className="settings-field">
        <span>{t('settings.workspace.recent')}</span>
        <div className="recent-project-list">
          {recentProjects.length ? (
            recentProjects.map((project) => (
              <button
                type="button"
                className="recent-project-item"
                disabled={!project.exists}
                key={project.path}
                onClick={() => onOpenProjectPath(project.path)}
                title={project.path}
              >
                <span>{project.name || project.path}</span>
                {project.parent_dir ? <small>{project.parent_dir}</small> : null}
                {!project.exists ? <em>{t('settings.workspace.missing')}</em> : null}
              </button>
            ))
          ) : (
            <span className="settings-empty">{t('settings.workspace.noRecent')}</span>
          )}
        </div>
      </div>
      <div className="settings-submit-row">
        <button type="button" onClick={onExportHsfProject}>
          {t('settings.workspace.export')}
        </button>
        <button
          type="button"
          onClick={onResetCurrentProject}
          title={t('settings.workspace.resetTitle')}
        >
          {t('settings.workspace.reset')}
        </button>
      </div>
    </>
  )
}
