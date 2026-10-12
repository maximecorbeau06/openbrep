import { useUiPrefsStore, type Locale } from './uiPrefsStore'

/**
 * Fork MM STUDIO : la langue des réponses de l'IA suit la langue de l'interface.
 *
 * Certaines consignes système du moteur demandent d'expliquer « en chinois ».
 * On préfixe donc les « réglages assistant » envoyés par l'interface d'une
 * consigne de langue explicite. Le chinois garde le comportement d'origine
 * (aucun préfixe) ; la CLI et le benchmark ne passent pas par ici, leurs
 * prompts restent donc identiques à l'amont.
 */
const DIRECTIVES: Record<Locale, string> = {
  zh: '',
  en:
    'Reply language: always answer in English (explanations, summaries, plans, questions), ' +
    'even where other instructions ask for Chinese. Do not translate GDL code, parameter names, ' +
    'JSON keys or [FILE: ...] markers.',
  fr:
    'Langue de réponse : réponds toujours en français (explications, résumés, plans, questions), ' +
    'même si d’autres consignes demandent le chinois. Ne traduis pas le code GDL, les noms de ' +
    'paramètres, les clés JSON ni les marqueurs [FILE: ...].',
}

export function replyLanguageDirective(locale: Locale): string {
  return DIRECTIVES[locale] ?? ''
}

/** Réglages assistant de l'utilisateur, précédés de la consigne de langue courante. */
export function withReplyLanguage(settings: string | null | undefined, locale?: Locale): string {
  const base = settings ?? ''
  const directive = replyLanguageDirective(locale ?? useUiPrefsStore.getState().locale)
  if (!directive) return base
  return base.trim() ? `${directive}\n\n${base}` : directive
}
