import { describe, expect, test } from 'vitest'
import { useUiPrefsStore } from './uiPrefsStore'

describe('uiPrefsStore', () => {
  test('la langue par défaut de production est le français', () => {
    // getInitialState() n’est pas affecté par le setState() du setup de test.
    expect(useUiPrefsStore.getInitialState().locale).toBe('fr')
  })

  test('accepte fr, en et zh', () => {
    for (const locale of ['fr', 'en', 'zh'] as const) {
      useUiPrefsStore.getState().setLocale(locale)
      expect(useUiPrefsStore.getState().locale).toBe(locale)
    }
  })
})
