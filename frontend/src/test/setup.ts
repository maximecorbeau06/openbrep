import { beforeEach } from 'vitest'
import { useUiPrefsStore } from '../state/uiPrefsStore'

/**
 * Le français est la langue par défaut de ce fork (MM STUDIO), mais les tests
 * historiques interrogent l’interface par ses libellés chinois. On les isole
 * du défaut de production : chaque test démarre en 'zh', et peut appeler
 * setLocale() lui-même s’il vérifie une autre langue.
 */
beforeEach(() => {
  useUiPrefsStore.setState({ locale: 'zh' })
})
