// Same as the storage explorer's EMPTY_FOLDER_PLACEHOLDER_FILE_NAME: the empty object that makes a folder exist.
export const FOLDER_PLACEHOLDER = '.emptyFolderPlaceholder'

/**
 * Creates the placeholder object of a folder through Studio's server, which adds the project's service key (the
 * fork uploaded it from the browser with a "temporary" key, the project's permanent service key). Errors are ignored,
 * as the fork does (e.g. a placeholder that already exists).
 */
export async function createFolderPlaceholder(projectRef: string, bucketId: string, folder: string) {
  await fetch(
    `/api/platform/storage/${projectRef}/buckets/${encodeURIComponent(bucketId)}/objects/placeholder`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder }),
    }
  )
}
