<template>
  <div class="tabs-wrapper" ref="tabs-wrapper">
    <template v-if="mhs.currentTabId">
      <MatchHistoryTab
        v-for="(tab, index0) of mhs.tabs"
        :key="tab.id"
        :tab="tab"
        :index="index0"
        :sgpServerId="tab.sgpServerId"
        v-show="tab.id === mhs.currentTab?.id"
        ref="tabs-ref"
      />
    </template>
    <div v-else class="tabs-placeholder">
      <div class="centered">
        <LeagueAkariSpan bold class="akari-text" />
        <template v-if="lcs.connectionState !== 'connected'">
          <span class="disconnected">{{ t('MatchHistoryTabs.disconnected') }}</span>
          <EasyToLaunch />
        </template>
        <template v-if="lcs.summoner.me && mhs.tabs.length === 0">
          <div class="no-tab">{{ t('MatchHistoryTabs.noActiveTab') }}</div>
          <div class="shortcut" @click="()=>handleOpenSelfTab()">
            <LcuImage
              class="shortcut-profile-icon"
              :src="profileIconUri(lcs.summoner.me.profileIconId)"
            />
            <StreamerModeMaskedText>
              <template #masked>
                <span class="shortcut-game-name">{{ t('common.summoner') }}</span>
                <span class="shortcut-tag-line">#####</span>
              </template>
              <span class="shortcut-game-name">{{ lcs.summoner.me.gameName }}</span>
              <span class="shortcut-tag-line">#{{ lcs.summoner.me.tagLine }}</span>
            </StreamerModeMaskedText>
          </div>
        </template>
      </div>
    </div>
    <Transition name="bi-fade">
      <div class="drop-overlay" v-if="isOverDropZone">
        <span class="centered-hint">{{ t('MatchHistoryTabs.dropZoneRosterMember') }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import EasyToLaunch from '@renderer-shared/components/EasyToLaunch.vue'
import LcuImage from '@renderer-shared/components/LcuImage.vue'
import LeagueAkariSpan from '@renderer-shared/components/LeagueAkariSpan.vue'
import StreamerModeMaskedText from '@renderer-shared/components/StreamerModeMaskedText.vue'
import { useKeyboardCombo } from '@renderer-shared/compositions/useKeyboardCombo'
import { useInstance } from '@renderer-shared/shards'
import { useLeagueClientStore } from '@renderer-shared/shards/league-client/store'
import { profileIconUri } from '@renderer-shared/shards/league-client/utils'
import { LoggerRenderer } from '@renderer-shared/shards/logger'
import { useOngoingGameStore } from '@renderer-shared/shards/ongoing-game/store'
import { useDropZone } from '@vueuse/core'
import { useTranslation } from 'i18next-vue'
import { useMessage } from 'naive-ui'
import { computed, onActivated, onDeactivated, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { MatchHistoryTabsRenderer } from '@main-window/shards/match-history-tabs'
import { useMatchHistoryTabsStore } from '@main-window/shards/match-history-tabs/store'

import MatchHistoryTab from './MatchHistoryTab.vue'

const { t } = useTranslation()

const lcs = useLeagueClientStore()

const route = useRoute()
const router = useRouter()

const VIEW_NAMESPACE = 'view:MatchHistoryTabs'

const mhs = useMatchHistoryTabsStore()
const ogs = useOngoingGameStore()
const log = useInstance(LoggerRenderer)
const mh = useInstance(MatchHistoryTabsRenderer)

const tabsRef = useTemplateRef('tabs-ref')

const matchHistoryRoute = computed(() => {
  if (route.name !== 'match-history') {
    return null
  }
  const puuid = route.params.puuid as string || route.query.puuid as string
  const sgpServerId = route.params.sgpServerId as string

  if (typeof puuid === 'string' && typeof sgpServerId === 'string' && puuid && sgpServerId) {
    return { puuid, sgpServerId }
  }

  return null
})

watch(
  () => route.query?.puuid,
  (value) => {
    if (!value) {
      return
    }
    handleOpenSelfTab(value)
  },
  { immediate: true }
)
// 路由 ==> 页面
watch(
  () => matchHistoryRoute.value,
  (route) => {
    if (!route) {
      return navigateToTabByPuuid()
    }
    mh.setCurrentOrCreateTab(route.puuid, route.sgpServerId)
  },
  { immediate: true }
)

// 路由 <== 页面
watch(
  () => mhs.currentTabId,
  (id) => {
    if (!id) {
      router.replace({ name: 'match-history' })
      return
    }
    const { sgpServerId, puuid } = mh.parseUnionId(id)

    if (
      matchHistoryRoute.value &&
      matchHistoryRoute.value.puuid === puuid &&
      matchHistoryRoute.value.sgpServerId === sgpServerId
    ) {
      return
    }

    router.replace({
      name: 'match-history',
      params: { puuid, sgpServerId }
    })
  },
  { immediate: true }
)

const isEndOfGame = computed(
  () => lcs.gameflow.phase === 'EndOfGame' || lcs.gameflow.phase === 'PreEndOfGame'
)

// 页面在游戏结束后刷新对应 tab 的战绩
// 当该页面被 KeepAlive, 即使页面不可见也会触发
watch(
  () => isEndOfGame.value,
  (is, _prevP) => {
    if (mhs.settings.refreshTabsAfterGameEnds && is) {
      if (!ogs.teams || !tabsRef.value) {
        return
      }

      const allPlayerPuuids = Object.values(ogs.teams).flat()
      tabsRef.value.forEach((tab) => {
        if (tab && allPlayerPuuids.includes(tab.puuid)) {
          tab.refresh()
        }
      })

      log.info(VIEW_NAMESPACE, `战绩页面刷新`, allPlayerPuuids)
    }
  }
)

const { navigateToTabByPuuid } = mh.useNavigateToTab()

const handleOpenSelfTab = (puuid) => {
  const id = puuid || lcs.summoner.me?.puuid
  if (id) {
    navigateToTabByPuuid(id)
  }
}

const message = useMessage()

const { stop, start } = useKeyboardCombo('PUUID', {
  requireSameEl: true,
  onFinish: () => {
    if (mhs.currentTab) {
      navigator.clipboard.writeText(
        `${mhs.currentTab.sgpServerId}\nPUUID: ${mhs.currentTab.puuid}\nSummoner ID: ${mhs.currentTab.summoner?.summonerId}\n${mhs.currentTab.summoner?.gameName}#${mhs.currentTab.summoner?.tagLine}`
      )
      message.success(t('MatchHistoryTabs.copiedToClipboard'))
    }
  },
  immediate: false
})

onActivated(() => start())
onDeactivated(() => stop())

mh.events.on('refresh-tab', (tabId: string) => {
  const tab = tabsRef.value?.find((tab) => tab && tab.id === tabId)
  if (tab) {
    log.info(VIEW_NAMESPACE, `刷新战绩页面`, tabId)
    tab.refresh()
  }
})

mh.events.on('screenshot-tab', (tabId: string) => {
  const tab = tabsRef.value?.find((tab) => tab && tab.id === tabId)
  if (tab) {
    log.info(VIEW_NAMESPACE, `截图战绩页面`, tabId)
    tab.screenshot()
  }
})

const tabsWrapperEl = useTemplateRef('tabs-wrapper')
const { isOverDropZone } = useDropZone(tabsWrapperEl, {
  dataTypes: ['application/riot.roster-member+json'],
  onDrop: (_, event) => {
    const socialMemberData = event.dataTransfer?.getData('application/riot.roster-member+json')

    if (socialMemberData) {
      try {
        const json = JSON.parse(socialMemberData)
        const puuid = json.id.split('@')[0]
        navigateToTabByPuuid(puuid)
      } catch {}
    }
  }
})
</script>

<style lang="less" scoped>
.tabs-wrapper {
  position: relative;
  height: 100%;
  max-width: 100%;
  display: flex;
  flex-direction: column;
}

.content {
  position: relative;
  flex: 1;
  height: 0;
}

.tabs-placeholder {
  height: 100%;
  display: flex;
  position: relative;

  .akari-text {
    font-size: 22px;
  }

  .disconnected {
    font-size: 14px;
    font-weight: normal;
    color: rgba(255, 255, 255, 0.4);
  }

  .no-tab {
    font-size: 14px;
    font-weight: normal;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 8px;
  }

  .shortcut {
    display: flex;
    align-items: center;
    margin-top: 16px;
    background-color: rgba(255, 255, 255, 0.06);
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.2s ease;
    backdrop-filter: blur(4px);

    &:hover {
      background-color: rgba(255, 255, 255, 0.12);
    }

    .shortcut-profile-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
    }

    .shortcut-game-name {
      margin-left: 8px;
      font-size: 14px;
      font-weight: bold;
      color: rgba(255, 255, 255, 0.95);
    }

    .shortcut-tag-line {
      margin-left: 4px;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.4);
    }
  }
}

.drop-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 100;
  backdrop-filter: blur(4px);

  .centered-hint {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 24px;
    font-weight: bold;
  }
}

[data-theme='dark'] {
  .tabs-placeholder {
    .disconnected {
      color: rgba(255, 255, 255, 0.4);
    }

    .no-tab {
      color: rgba(255, 255, 255, 0.4);
    }

    .shortcut {
      background-color: rgba(255, 255, 255, 0.06);

      &:hover {
        background-color: rgba(255, 255, 255, 0.12);
      }

      .shortcut-game-name {
        color: rgba(255, 255, 255, 0.95);
      }

      .shortcut-tag-line {
        color: rgba(255, 255, 255, 0.4);
      }
    }
  }

  .drop-overlay {
    background-color: rgba(0, 0, 0, 0.4);

    .centered-hint {
      color: rgba(255, 255, 255, 0.95);
    }
  }
}

[data-theme='light'] {
  .tabs-placeholder {
    .disconnected {
      color: rgba(0, 0, 0, 0.4);
    }

    .no-tab {
      color: rgba(0, 0, 0, 0.4);
    }

    .shortcut {
      background-color: rgba(0, 0, 0, 0.06);

      &:hover {
        background-color: rgba(0, 0, 0, 0.12);
      }

      .shortcut-game-name {
        color: rgba(0, 0, 0, 0.95);
      }

      .shortcut-tag-line {
        color: rgba(0, 0, 0, 0.4);
      }
    }
  }

  .drop-overlay {
    background-color: rgba(255, 255, 255, 0.4);

    .centered-hint {
      color: rgba(0, 0, 0, 0.95);
    }
  }
}

.centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: absolute;
  top: 48%;
  left: 50%;
  transform: translate(-50%, -50%);
  gap: 16px;
}
</style>
