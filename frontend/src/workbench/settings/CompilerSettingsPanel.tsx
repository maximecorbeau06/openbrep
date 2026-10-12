import type { CompilerSettings } from '../../api/types'
import { useT } from '../../i18n'

interface CompilerSettingsPanelProps {
  draft: CompilerSettings
  onChange: (settings: CompilerSettings) => void
  onBrowseCompilerFile: () => void
  onBrowseOutputDirectory: () => void
}

export function CompilerSettingsPanel({
  draft,
  onChange,
  onBrowseCompilerFile,
  onBrowseOutputDirectory,
}: CompilerSettingsPanelProps) {
  const t = useT()
  return (
    <>
      <label className="settings-row">
        <span>{t('settings.compiler.mode')}</span>
        <select
          aria-label={t('settings.compiler.modeAria')}
          value={draft.mode}
          onChange={(event) =>
            onChange({
              ...draft,
              mode: event.currentTarget.value === 'lp' ? 'lp' : 'mock',
            })
          }
        >
          <option value="mock">{t('settings.compiler.mock')}</option>
          <option value="lp">LP</option>
        </select>
      </label>
      <label className="settings-field">
        <span>LP_XMLConverter</span>
        <div className="settings-path-row">
          <input
            type="text"
            placeholder="/Applications/.../LP_XMLConverter"
            value={draft.converter_path}
            disabled={draft.mode !== 'lp'}
            onChange={(event) =>
              onChange({
                ...draft,
                converter_path: event.currentTarget.value,
              })
            }
          />
          <button type="button" disabled={draft.mode !== 'lp'} onClick={onBrowseCompilerFile}>
            {t('ui.browse')}
          </button>
        </div>
      </label>
      <label className="settings-field">
        <span>{t('settings.compiler.output')}</span>
        <div className="settings-path-row">
          <input
            type="text"
            placeholder={t('settings.compiler.outputPh')}
            value={draft.output_dir}
            onChange={(event) =>
              onChange({
                ...draft,
                output_dir: event.currentTarget.value,
              })
            }
          />
          <button type="button" onClick={onBrowseOutputDirectory}>
            {t('ui.browse')}
          </button>
        </div>
      </label>
    </>
  )
}
