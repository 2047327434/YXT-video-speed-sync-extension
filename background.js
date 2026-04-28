/**
 * background.js - Service Worker，管理标签页状态与跨页面通信
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[VSS] 视频倍速同步助手已安装');
});

// 监听来自 content script 或 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 转发消息（popup <-> content）
  if (request.target === 'content') {
    // popup 发给 content，不需要 background 处理
    return false;
  }

  if (request.target === 'popup') {
    // content 发给 popup，不需要 background 处理
    return false;
  }

  // 处理全局请求
  switch (request.action) {
    case 'getAllTabsVideos':
      getAllTabsVideos().then(sendResponse);
      return true;

    default:
      sendResponse({ success: false, error: '未知全局操作' });
  }

  return true;
});

/**
 * 获取所有标签页中的视频信息
 */
async function getAllTabsVideos() {
  const tabs = await chrome.tabs.query({});
  const results = [];

  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        target: 'content',
        action: 'getVideos'
      });
      if (response && response.count > 0) {
        results.push({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          videos: response.videos
        });
      }
    } catch (e) {
      // 忽略无法通信的标签页
    }
  }

  return { success: true, tabs: results };
}

// 标签页更新时自动注入内容脚本（针对动态加载的页面）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch(() => {
      // 某些页面无法注入，忽略错误
    });
  }
});
