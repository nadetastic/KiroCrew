import { useCallback, useContext } from 'react'
import type { AppApi } from './scopedApi'
import { AppSdkContext, apiPathAllowed } from './scopedApi'
import { COMPOSER_UPLOAD_PATH, uploadComposerFiles } from '../utils/composerUpload'
import { useComposerAttachments } from '../chat-core/composer/useComposerAttachments'
import { i18nT } from '../i18n/t'

export const EMBED_UPLOAD_PATH = COMPOSER_UPLOAD_PATH
export type EmbedAttachments = ReturnType<typeof useEmbedAttachments>
const NO_PATHS: readonly string[] = []

/** The app edge supplies permission and transport, never an implicit grant.
 *  Staging, gestures and cancellation belong to the shared Attach behavior. */
export function useEmbedAttachments(api: AppApi, slotKey: string) {
  const allowedPaths = useContext(AppSdkContext)?.info.permissions.api ?? NO_PATHS
  const granted = apiPathAllowed(allowedPaths, EMBED_UPLOAD_PATH)
  const upload = useCallback((files: File[], signal: AbortSignal) =>
    uploadComposerFiles(files, body =>
      api.raw(EMBED_UPLOAD_PATH, { method: 'POST', body, signal })), [api])
  const attachments = useComposerAttachments({
    slotKey,
    upload: granted ? upload : undefined,
    deniedNotice: i18nT('appSdk.chatEmbed.attachments_not_allowed'),
  })
  return { ...attachments, granted }
}
