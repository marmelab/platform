import { assertSelfHosted } from '../util'
import { FileSystemFunctionsArtifactStore } from './fileSystemStore'

export function getFunctionsArtifactStore(): FileSystemFunctionsArtifactStore | null {
  assertSelfHosted()

  if (!process.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER) return null

  return new FileSystemFunctionsArtifactStore(process.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER)
}
