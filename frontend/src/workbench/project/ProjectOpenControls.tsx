import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { RecentProject, WorkbenchProject } from '../../api/types'
import { useT } from '../../i18n'

interface ProjectOpenControlsProps {
  project: WorkbenchProject | null
  loading: boolean
  /** SF1：源操作进行中禁用项目切换/导入入口（handler 自身另有守卫判断） */
  sourceBusy?: boolean
  recentProjects: RecentProject[]
  onNewProject: () => void
  onLoadProjectPath: (path: string) => void
  onBrowseProjectDirectory: () => void
  onImportGdlFile: () => void
  onImportGsmFile: () => void
  onImportBlenderScript: () => void
  onSaveProjectAs: () => void
}

export function ProjectOpenControls({
  project,
  loading,
  sourceBusy = false,
  recentProjects,
  onNewProject,
  onLoadProjectPath,
  onBrowseProjectDirectory,
  onImportGdlFile,
  onImportGsmFile,
  onImportBlenderScript,
  onSaveProjectAs,
}: ProjectOpenControlsProps) {
  const t = useT()
  const [path, setPath] = useState(project?.path ?? '')
  const [open, setOpen] = useState(false)
  const controlsLocked = loading || sourceBusy

  useEffect(() => {
    setPath(project?.path ?? '')
  }, [project?.path])

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!path.trim()) return
    onLoadProjectPath(path)
    setOpen(false)
  }

  function displayName(recent: RecentProject) {
    return recent.name || recent.path.split(/[\\/]/).filter(Boolean).pop() || recent.path
  }

  function runProjectAction(action: () => void) {
    action()
    setOpen(false)
  }

  return (
    <div className="project-open-controls toolbar-menu">
      <button
        type="button"
        className="toolbar-menu-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="project-menu-panel"
        onClick={() => setOpen((value) => !value)}
      >
        {t('projectMenu.title')}
      </button>
      {open ? (
        <form id="project-menu-panel" className="toolbar-menu-panel project-menu-panel" aria-label={t('projectMenu.aria')} onSubmit={submitPath}>
          <button type="button" disabled={controlsLocked} onClick={() => runProjectAction(onNewProject)}>
            {t('projectMenu.new')}
          </button>
          <label className="project-path-field">
            <span>{t('projectMenu.path')}</span>
            <input
              id="hsf-path"
              type="text"
              aria-label={t('projectMenu.pathPh')}
              placeholder={t('projectMenu.pathPh')}
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
            />
          </label>
          <div className="project-menu-row">
            <button type="submit" disabled={controlsLocked || path.trim().length === 0}>
              {loading ? '...' : 'Ouvrir'}
            </button>
            <button
              type="button"
              disabled={controlsLocked}
              onClick={() => runProjectAction(onBrowseProjectDirectory)}
              title={t('projectMenu.browseTitle')}
              aria-label={t('projectMenu.browseTitle')}
            >
              {loading ? 'Choix…' : 'Parcourir'}
            </button>
          </div>
          <select
            aria-label={t('projectMenu.recentAria')}
            value=""
            disabled={controlsLocked || recentProjects.length === 0}
            onChange={(event) => {
              const selectedPath = event.currentTarget.value
              if (selectedPath) {
                onLoadProjectPath(selectedPath)
                setOpen(false)
              }
            }}
          >
            <option value="">{t('projectMenu.recent')}</option>
            {recentProjects.map((recent) => (
              <option key={recent.path} value={recent.path} disabled={!recent.exists}>
                {displayName(recent)}
              </option>
            ))}
          </select>
          <div className="project-menu-row">
            <button type="button" disabled={controlsLocked} onClick={() => runProjectAction(onImportGdlFile)}>
              {t('projectMenu.importGdl')}
            </button>
            <button type="button" disabled={controlsLocked} onClick={() => runProjectAction(onImportGsmFile)}>
              {t('projectMenu.importGsm')}
            </button>
            <button type="button" disabled={controlsLocked} onClick={() => runProjectAction(onImportBlenderScript)}>
              {t('projectMenu.importBlender')}
            </button>
          </div>
          <button type="button" disabled={controlsLocked || !project} onClick={() => runProjectAction(onSaveProjectAs)}>
            {t('projectMenu.saveAs')}
          </button>
        </form>
      ) : null}
    </div>
  )
}
