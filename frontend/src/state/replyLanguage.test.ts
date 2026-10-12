import { describe, expect, test } from 'vitest'
import { replyLanguageDirective, withReplyLanguage } from './replyLanguage'

describe('withReplyLanguage', () => {
  test('zh conserve exactement les réglages d’origine', () => {
    expect(withReplyLanguage('mes préférences', 'zh')).toBe('mes préférences')
    expect(withReplyLanguage(undefined, 'zh')).toBe('')
  })

  test('fr préfixe une consigne de réponse en français', () => {
    const out = withReplyLanguage('Style concis', 'fr')
    expect(out.startsWith(replyLanguageDirective('fr'))).toBe(true)
    expect(out.endsWith('Style concis')).toBe(true)
    expect(out).toContain('français')
  })

  test('fr sans réglages : la consigne seule', () => {
    expect(withReplyLanguage('', 'fr')).toBe(replyLanguageDirective('fr'))
  })

  test('utilise la langue courante de l’interface par défaut', () => {
    // Le setup de test force zh : aucun préfixe.
    expect(withReplyLanguage('x')).toBe('x')
  })
})
