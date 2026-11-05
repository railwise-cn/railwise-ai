import type { AppSettingsPatch, AppSettingsV1 } from '../shared/app-settings'
import { getManagedRuntimeSettings, mergeClawSettings, mergeManagedRuntimeSettings } from '../shared/app-settings'
import {
  type ImCredentialService,
  protectImChannelCredentials,
  removeUnreferencedImCredentials
} from './services/im-credential-service'
import { runSerialized } from './services/durable-file'

type SettingsApplicationStore = {
  patchPrepared(
    prepare: (current: AppSettingsV1) => AppSettingsPatch | Promise<AppSettingsPatch>,
    expectedRevision?: number,
    afterSave?: (previous: AppSettingsV1, saved: AppSettingsV1) => Promise<void> | void
  ): Promise<AppSettingsV1>
}

type SettingsApplicationTransactionInput = {
  store: SettingsApplicationStore
  credentialService?: ImCredentialService
  partial: AppSettingsPatch
  expectedRevision?: number
  afterPersist?: (previous: AppSettingsV1, saved: AppSettingsV1) => Promise<void> | void
}

const SETTINGS_APPLICATION_TRANSACTION_KEY = 'settings:application-transaction'

export async function applySettingsApplicationTransaction(
  input: SettingsApplicationTransactionInput
): Promise<AppSettingsV1> {
  return runSerialized(SETTINGS_APPLICATION_TRANSACTION_KEY, async () => {
    let previous: AppSettingsV1 | undefined
    let settingsPersisted = false
    const createdCredentialRefs: NonNullable<AppSettingsV1['claw']['channels'][number]['credentialRef']>[] = []
    let saved: AppSettingsV1
    try {
      saved = await input.store.patchPrepared(async (current) => {
        previous = current
        const runtime = mergeManagedRuntimeSettings(
          getManagedRuntimeSettings(current),
          input.partial.agents?.kun
        )
        return input.partial.claw?.channels && input.credentialService
          ? {
              ...input.partial,
              claw: {
                ...input.partial.claw,
                channels: await protectImChannelCredentials(
                  mergeClawSettings(
                    current.claw,
                    input.partial.claw,
                    runtime.providerId || undefined
                  ).channels,
                  input.credentialService,
                  {
                    requirePersistent: true,
                    rotate: true,
                    onProtectedCredential: (ref) => createdCredentialRefs.push(ref)
                  }
                )
              }
            }
          : input.partial
      }, input.expectedRevision, async (current, persisted) => {
        settingsPersisted = true
        if (input.credentialService) {
          await removeUnreferencedImCredentials(
            current.claw.channels,
            persisted.claw.channels,
            input.credentialService
          )
        }
      })
    } catch (error) {
      if (!settingsPersisted && input.credentialService) {
        await Promise.all(createdCredentialRefs.map((ref) => input.credentialService!.remove(ref)))
      }
      throw error
    }
    if (!previous) throw new Error('Settings transaction completed without reading current settings.')
    await input.afterPersist?.(previous, saved)
    return saved
  })
}
