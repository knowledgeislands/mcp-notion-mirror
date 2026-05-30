/**
 * Title-property discovery + cache.
 *
 * A database-parented page sets its title via the database's title-typed
 * property, whose name varies per wiki ("Page" on HNR's, "Name" elsewhere). We
 * read the schema once via `GET /v1/databases/{id}` and cache the name for the
 * server's lifetime — schemas rarely change, and a restart picks up any change.
 *
 * Page-parented pages are child pages and use Notion's reserved `title`
 * property, so they need no lookup (see notion-client `titleProperties`).
 */
import { getDatabase, NotionApiError, type NotionConfig } from '../notion-client/index.js'

const titlePropertyCache = new Map<string, string>()

/** Discover (and cache) the name of the title-typed property on a database. */
export const getDatabaseTitleProperty = async (cfg: NotionConfig, databaseId: string): Promise<string> => {
  const cached = titlePropertyCache.get(databaseId)
  if (cached !== undefined) return cached
  const db = await getDatabase(cfg, databaseId)
  const entry = Object.entries(db.properties).find(([, prop]) => prop.type === 'title')
  if (!entry) {
    throw new NotionApiError(0, '', 'no_title_property', `Database ${databaseId} has no title property — cannot set a page title.`)
  }
  titlePropertyCache.set(databaseId, entry[0])
  return entry[0]
}

/** Test-only: clear the title-property cache between cases. */
export const _clearTitlePropertyCache = (): void => titlePropertyCache.clear()
