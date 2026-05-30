/**
 * The "Mirrored from Knowledge Base" banner prepended to every published page.
 *
 * The caller passes the template (`config.bannerTemplate`). `{date}` interpolates
 * the supplied UTC date. Markdown `**bold**` / links in the template are honoured
 * via martian's inline converter. An empty template disables the banner entirely
 * — `bannerBlock` returns `undefined`, and the publish pipeline simply omits it.
 *
 * Rendered as a Notion `callout` block with the 📘 icon. (The icon is fixed; a
 * leading emoji is not expected in the template — see config DEFAULT_BANNER_TEMPLATE.)
 */
import { markdownToRichText } from '@tryfabric/martian'

const BANNER_ICON = '📘'

/** Build the banner callout for `dateStr` (YYYY-MM-DD), or `undefined` when the template is empty. */
export const bannerBlock = (bannerTemplate: string, dateStr: string): Record<string, unknown> | undefined => {
  if (bannerTemplate === '') return undefined
  const text = bannerTemplate.replaceAll('{date}', dateStr)
  return {
    object: 'block' as const,
    type: 'callout' as const,
    callout: {
      icon: { type: 'emoji' as const, emoji: BANNER_ICON },
      rich_text: markdownToRichText(text)
    }
  }
}
